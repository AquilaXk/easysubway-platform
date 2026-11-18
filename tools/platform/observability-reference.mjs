// platform#227·#273·#274: 관측 설정 검증용 격리 reference Prometheus 컨테이너의 수명 관리와 compose·promtool 사전 검증.
// reference 컨테이너 삭제는 평소 배포에서는 60초 제한으로 돌고, 중단 뒤에는 짧은 제한(1500ms + 250ms)과 지연 abort로 돌아
// 프로세스가 GitHub 취소 창 안에 끝나면서도 컨테이너를 남기지 않게 한다.
import { join } from "node:path";

import { fail, message } from "./observability-deploy-primitives.mjs";
import { readSnapshot, REMOVED_JOBS } from "./observability-prometheus.mjs";
import { PROMETHEUS, stageRelease } from "./observability-release.mjs";

export const DATA_MOUNT = "/prometheus";
// CI는 `promtool test rules infra/prometheus/*.test.yml`로 한 단계만 본다. 배포 게이트도 같은 집합이어야 한다.
export const RULE_TEST_PATTERN = /^prometheus\/[^/]+\.test\.yml$/u;
// 중단 뒤 떨어진 컨테이너를 다시 붙이거나 reference를 지우는 확인은 짧은 제한을 둔다. workflow 취소는 SIGINT 뒤 7.5초에 SIGTERM,
// 다시 2.5초 뒤 SIGKILL이므로 진행 중 명령 종료 뒤 남은 시간 안에 정리 명령이 끝나야 한다.
export const INTERRUPT_COMMAND_LIMITS = Object.freeze({ timeoutMs: 1500, killGraceMs: 250 });
// 평소 배포의 reference 조회·삭제는 부하가 높아도 docker 명령이 끝날 시간을 준다.
export const CLEANUP_COMMAND_LIMITS = Object.freeze({ timeoutMs: 60_000, killGraceMs: 5000 });

const REFERENCE_PREFIX = "easysubway-observability-ref-";
const REFERENCE_NAME = /^easysubway-observability-ref-[0-9a-f]{12}-(\d+)$/u;
// compose가 정의 없이 만드는 기본 네트워크의 config 출력은 {name, ipam: {}}다(Compose v2 실측). 그 밖의 속성은 compose가 네트워크를 소유한다는 뜻이다.
const IMPLICIT_NETWORK_KEYS = Object.freeze(["name", "external"]);
const isEmptyObject = (value) => value !== null && typeof value === "object" && Object.keys(value).length === 0;

/** external이 아닌 기본 네트워크 정의에서 암묵 기본값을 넘는 속성(ipam config, labels, driver, driver_opts, internal, enable_ipv6, attachable…). */
function ownedNetworkProperties(network) {
  if (!network || network.external === true) return [];
  return Object.entries(network).filter(([key, value]) => !IMPLICIT_NETWORK_KEYS.includes(key) && !(key === "ipam" && isEmptyObject(value))).map(([key]) => key);
}

/**
 * compose에 넘길 release인지 확인한다: prometheus 이미지·command와 맞출 서비스·이미지가 정의되어 있고, 기본 네트워크를 compose가 소유하지 않는다.
 * platform#250~#273 사이 main 커밋의 compose는 운영 네트워크를 external 없이 ipam으로 선언한다. 그런 정의는 compose가 운영 네트워크를 다시 만들려 하므로
 * 적용·복원 어느 쪽으로도 compose에 넘기지 않는다. 네트워크 블록이 없는 옛 compose는 암묵 기본값이라 통과한다.
 */
function assertReleaseCompose(config, services) {
  const defined = config?.services ?? {};
  const prometheus = defined[PROMETHEUS.service];
  if (typeof prometheus?.image !== "string" || prometheus.image === "" || !Array.isArray(prometheus?.command)) {
    fail("E_OBS_DEPLOY_SOURCE", "compose does not define the prometheus service image and command");
  }
  for (const name of services) {
    if (!(name in defined)) fail("E_OBS_DEPLOY_SOURCE", `compose does not define the ${name} service`);
    if (typeof defined[name]?.image !== "string" || defined[name].image === "") {
      fail("E_OBS_DEPLOY_SOURCE", `compose does not define the ${name} service image`);
    }
  }
  const owned = ownedNetworkProperties(config?.networks?.default);
  if (owned.length > 0) fail("E_OBS_DEPLOY_SOURCE", `compose declares the default network ${config.networks.default.name} with ${owned.join(",")} but not external; compose would recreate the live network (platform#273)`);
}

/** release의 compose를 해석하고 확인한 뒤 prometheus 이미지·command와 적용 unit 이미지 목록(순서 보존 중복 제거)을 돌려준다. preflight와 복원이 같은 확인을 거친다. */
export async function readReleaseCompose(docker, projectDirectory, composeEnvFile, units) {
  const services = units.map((unit) => unit.service);
  const config = await docker.composeConfig(projectDirectory, composeEnvFile, services);
  assertReleaseCompose(config, services);
  const { image, command } = config.services[PROMETHEUS.service];
  const unitImages = [...new Set(services.map((name) => config.services[name].image))];
  return { image, command, unitImages };
}

export function expectedFlagKeys(command) {
  return command.filter((item) => item.startsWith("--")).map((item) => item.slice(2).split("=")[0]);
}

/**
 * reference 컨테이너 삭제 전용 runner.
 * - 시작 시점에 이미 중단(interruptSignal.aborted)되었으면 중단된 signal을 넘기지 않고 짧은 제한(1500ms)으로 실행한다.
 * - 실행 도중에 중단이 오면 바로 끊지 않고 지연 abort(1500ms)를 보내 docker rm이 정상 완료될 짧은 유예를 준다.
 */
export function createReferenceCleanupRunner(commandRunner, interruptSignal) {
  return async (command, args, callOptions = {}) => {
    if (interruptSignal?.aborted) {
      return commandRunner(command, args, { ...callOptions, ...INTERRUPT_COMMAND_LIMITS, signal: undefined });
    }
    const delayed = new AbortController();
    let timer = null;
    const onAbort = () => {
      timer = setTimeout(() => delayed.abort(), INTERRUPT_COMMAND_LIMITS.timeoutMs);
      timer.unref?.();
    };
    interruptSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await commandRunner(command, args, {
        ...callOptions,
        timeoutMs: CLEANUP_COMMAND_LIMITS.timeoutMs,
        killGraceMs: INTERRUPT_COMMAND_LIMITS.killGraceMs,
        signal: delayed.signal,
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      interruptSignal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * 강제 종료된 지난 실행이 남긴 reference 컨테이너를 지운다. 이름 형식이 맞고 이름의 pid가 죽은 것만 지운다.
 * try/catch는 docker 호출로만 좁혀 프로그래밍 오류는 그대로 드러내고, 정리 실패는 경고와 반환값(영수증 기록용)으로 남긴다.
 */
export async function reapStaleReferences({ docker, cleanup, isProcessAlive, warn = () => {} }) {
  let stdout;
  try {
    ({ stdout } = await docker.docker(["ps", "-a", "--filter", `name=^${REFERENCE_PREFIX}`, "--format", "{{.Names}}"], CLEANUP_COMMAND_LIMITS));
  } catch (error) {
    const detail = message(error);
    warn(`stale reference cleanup failed: ${detail}`);
    return { removed: [], error: detail };
  }
  const stale = stdout.split("\n").map((line) => line.trim()).filter((name) => {
    const match = REFERENCE_NAME.exec(name);
    return match !== null && !isProcessAlive(Number(match[1]));
  });
  if (stale.length === 0) return { removed: [], error: null };
  try {
    await cleanup.docker(["rm", "-f", "-v", ...stale]);
    return { removed: stale, error: null };
  } catch (error) {
    const detail = message(error);
    warn(`stale reference cleanup failed (${stale.join(",")}): ${detail}`);
    return { removed: [], error: detail };
  }
}

/** reference 컨테이너 삭제는 cleanup runner로 한다. 중단·잠금 상실로 끊긴 뒤에도 돌아야 자기 컨테이너를 남기지 않는다. */
export async function collectReference({ docker, cleanup, image, command, stagedPrometheus, commit, sleep, waitFor }) {
  const name = `${REFERENCE_PREFIX}${commit.slice(0, 12)}-${process.pid}`;
  let snapshot;
  let primary = null;
  try {
    // reference는 네트워크 없이 같은 이미지·같은 flag로 설정 파일만 읽는다. /prometheus는 tmpfs라 이미지의 익명 volume이 생기지 않는다.
    await docker.docker(["run", "-d", "--name", name, "--network", "none", "--tmpfs", `${DATA_MOUNT}:rw,nosuid,nodev,mode=1777`, "--entrypoint", "prometheus", "-v", `${stagedPrometheus}:/etc/prometheus:ro`, image, ...command]);
    snapshot = await waitFor(sleep, 30, async () => {
      const value = await readSnapshot(docker, name);
      return value.jobs.length > 0 ? value : null;
    }, 1000);
  } catch (error) {
    primary = error;
  }
  let removal = null;
  try {
    await cleanup.docker(["rm", "-f", "-v", name]);
  } catch (error) {
    removal = error;
  }
  if (primary) fail("E_OBS_DEPLOY_REFERENCE", message(primary));
  if (removal) fail("E_OBS_DEPLOY_REFERENCE", `reference container ${name} was not removed: ${message(removal)}`);
  return snapshot;
}

/** promtool test rules에 넘길 규칙 시험 파일. release의 prometheus 디렉터리 바로 아래 *.test.yml 전부다(커밋마다 있는 파일이 다르다). */
export const ruleTestsOf = (files) => Object.keys(files).filter((file) => RULE_TEST_PATTERN.test(file)).map((file) => `/etc/${file}`);

export async function validateWithPromtool({ docker, image, unitImages, stagedPrometheus, ruleTests }) {
  const run = (...args) => docker.docker(["run", "--rm", "--network", "none", "--entrypoint", "promtool", "-v", `${stagedPrometheus}:/etc/prometheus:ro`, image, ...args]);
  // compose up은 --pull never로 돌므로 적용할 모든 unit 이미지를 검증 단계에서 차례대로 미리 받는다(platform#270).
  for (const unitImage of unitImages) {
    try {
      await docker.docker(["pull", unitImage], { timeoutMs: 300_000 });
    } catch (error) {
      fail("E_OBS_DEPLOY_VALIDATE", `image pull failed (${unitImage}): ${message(error)}`);
    }
  }
  try {
    await run("check", "config", "/etc/prometheus/prometheus.yml");
  } catch (error) {
    fail("E_OBS_DEPLOY_VALIDATE", `promtool check config failed: ${message(error)}`);
  }
  try {
    await run("test", "rules", ...ruleTests);
  } catch (error) {
    fail("E_OBS_DEPLOY_VALIDATE", `promtool test rules failed: ${message(error)}`);
  }
  return { checkConfig: "passed", testRules: "passed" };
}

export async function preflight({ docker, cleanup, commit, sourceRoot, stagingDir, composeEnvFile, sleep, waitFor, isProcessAlive, warn, facts }) {
  const staleReferenceCleanup = await reapStaleReferences({ docker, cleanup, isProcessAlive, warn });
  if (facts) facts.staleReferenceCleanup = staleReferenceCleanup;
  const tree = stageRelease(sourceRoot, stagingDir);
  if (facts) facts.configDigest = tree.configDigest;
  const { image, command, unitImages } = await readReleaseCompose(docker, stagingDir, composeEnvFile, tree.units);
  const stagedPrometheus = join(stagingDir, "prometheus");
  const validation = await validateWithPromtool({ docker, image, unitImages, stagedPrometheus, ruleTests: ruleTestsOf(tree.files) });
  const expected = await collectReference({ docker, cleanup, image, command, stagedPrometheus, commit, sleep, waitFor });
  if (REMOVED_JOBS.some((job) => expected.jobs.includes(job))) fail("E_OBS_DEPLOY_VALIDATE", `the commit still configures a removed job: ${REMOVED_JOBS.join(",")}`);
  const unscraped = tree.units.map((unit) => unit.job).filter((job) => job !== null && !expected.jobs.includes(job));
  if (unscraped.length > 0) fail("E_OBS_DEPLOY_VALIDATE", `the release deploys a unit whose prometheus job is not configured: ${unscraped.join(",")}`);
  return { tree, image, command, flagKeys: expectedFlagKeys(command), validation, expected, staleReferenceCleanup };
}
