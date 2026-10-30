#!/usr/bin/env node
// AquilaXk/easysubway-platform#227: 운영 Prometheus 설정을 platform 레포 커밋에서 배포하는 영구 경로.
//
// 운영 호스트의 Prometheus는 compose 프로젝트 `easysubway`의 `prometheus` 서비스다. 설정 파일은 파일 단위 bind mount라서
// 마운트 원천이 가리키는 파일이 곧 운영 설정이다. 이 도구는 마운트 원천을 관리 디렉터리로 옮기고 이후 갱신을 맡는다.
//
//   <deployRoot>/observability/releases/<commit>/   읽기 전용 release(infra의 설정 디렉터리 + compose 파일, 레포 구조 그대로)
//   <deployRoot>/observability/current  -> releases/<commit>   마지막으로 적용·검증한 release (compose project directory)
//   <deployRoot>/observability/previous -> releases/<commit>   직전 release (자동 복원 대상)
//
// 마운트 원천 경로는 `current/...` 문자열 그대로 컨테이너에 저장된다. Docker는 컨테이너를 (재)시작할 때 symlink를 다시 해석하므로
// current를 바꾸고 컨테이너를 재시작하면 새 파일을 읽는다. 컨테이너가 이미 떠 있는 동안에는 symlink 전환이 반영되지 않으므로
// compose 수준 변경(이미지·flag)은 `compose up`이 반영하고, 설정 파일만 바뀐 경우는 컨테이너가 실제로 마운트한 파일 내용(sha256sum)이
// release와 다를 때 `docker restart`가 반영한다. 재시작 판단이 symlink 이력이 아니라 컨테이너 내용이라 중단 후 재시도도 수렴한다.
// DEPLOY는 backend 배포(tools/deploy/deploy-backend.sh)와 같은 `<deployRoot>/deploy.lock`을 잡고, 다른 쪽이 쥐고 있으면 아무것도 바꾸지 않고 바로 실패한다(platform#273).
// 수동 절차는 contracts/release/platform-observability-config-deploy-runbook.json.
//
// 순서: 입력 검증 → 잠금 → release 스테이징 → promtool check config·test rules(실패하면 여기서 종료, 아무것도 바꾸지 않음) →
// 같은 이미지의 격리 reference Prometheus로 기대 상태 수집 → compose 기본 네트워크 확인(없으면 생성) → release 설치 → current 전환 → release가 담은 MANAGED_UNITS 서비스만 compose up
// → 마운트 내용 확인·필요하면 재시작 → 라이브 상태(설정·규칙·target·probe 시계열·네트워크·다른 컨테이너·volume)를 기대와 대조 → receipt.
// probe 시계열은 컨테이너 수렴이 끝난 시각보다 새 표본이어야 한다(수렴 전 마지막 scrape가 lookback 안에 남아 있는 동안은 통과시키지 않는다).
// 적용 뒤 대조가 실패하면 직전 release로 되돌리고 같은 기준(범위·volume·네트워크 배선 포함)으로 다시 대조한 뒤, 기본 네트워크에서 떨어진 관리 컨테이너를
// 다시 붙이고 실패로 끝난다(실패 receipt가 정방향 원인과 복원 결과를 따로 남김). 복원은 설정·규칙·target·마운트와
// 복원한 probe가 수렴 뒤 scrape되었다는 증거(probe_success의 새 표본, 값은 무관)를 대조한다. 호스트 443 도달에 달린 값은 externalSeries로 기록만 하고
// 복원 성공 여부를 가르지 않는다. 서버에 닿지 않으면 blackbox는 probe_success 0만 내고 만료 시계열을 내지 않는다.
// 컨테이너를 맞추는 서비스는 MANAGED_UNITS(prometheus와 원 서버 인증서 만료 probe, platform#270)뿐이다. origin-certificate-probe의 내용은
// 이 도구만 맞춘다. backend 배포(tools/deploy/deploy-backend.sh)는 그 컨테이너가 없을 때 만들기만 한다.
// Alertmanager·Grafana·Loki·Alloy는 release에 담기지만 이 도구는 컨테이너를 건드리지 않는다(이슈 #227 범위 밖).
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { interruptibleRunner, runCommand } from "./lib/process.mjs";
import { DeployError, fail, message, sha256 } from "./observability-deploy-primitives.mjs";
import { compareSnapshots, promData, readSnapshot, REMOVED_JOBS } from "./observability-prometheus.mjs";
import { attachmentVerdict, ensureComposeNetwork, reattachDetached } from "./observability-network.mjs";
import { acquireSharedDeployLock } from "./shared-deploy-lock.mjs";
import { externalVerdict, isoOfEpoch, liveSeriesOf, newestSample, seriesReceipt, staleSeriesOf, unhealthySeriesOf } from "./observability-series.mjs";

const MODES = Object.freeze(["PREVIEW", "DEPLOY"]);
const RECEIPT_SCHEMA_VERSION = "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_RECEIPT_V2";
const FAILURE_RECEIPT_SCHEMA_VERSION = "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_FAILURE_RECEIPT_V3";
const COMPOSE_PROJECT = "easysubway";
const COMPOSE_PROFILE = "observability";
const RUNBOOK_PATH = "contracts/release/platform-observability-config-deploy-runbook.json";
const DATA_VOLUME = "easysubway_prometheus-data";
const DATA_MOUNT = "/prometheus";
// release에 담기지만 이 도구가 컨테이너를 건드리지 않는 설정 디렉터리(이슈 #227 범위 밖).
const MATERIALIZED_ONLY_DIRS = Object.freeze(["alertmanager", "alloy", "grafana", "loki"]);
// 이 도구가 compose로 맞추고 마운트 내용과 라이브 상태까지 대조하는 서비스. configDirs는 그 서비스의 설정 원천 디렉터리,
// mounts는 컨테이너 안 경로와 release 안 원천 파일의 짝이다. optional unit은 그 디렉터리가 없는 트리(그 unit 이전의 main 커밋)에서
// 빠진다. 그래서 옛 커밋으로 되돌리는 DEPLOY·PREVIEW·자동 복원이 모두 같은 규칙으로 prometheus만 맞추고 probe는 건드리지 않는다.
// job은 그 unit이 읽히는 Prometheus job으로, release의 prometheus.yml이 담아야 한다. liveSeries는 검증 때 라이브 Prometheus에서
// 컨테이너 수렴 뒤의 새 표본이 나와야 하는 시계열이다({metric, value?}, value가 있으면 그 값이어야 하고 selector는 job으로 만든다).
// scrapeProof는 호스트 상태와 무관하게 exporter가 scrape마다 내는 metric으로, 복원이 요구하는 것은 이 새 표본의 존재뿐이다.
// blackbox는 probe가 실패해도 /probe에 200으로 답해 target이 up이므로, probe가 실제로 원 서버 인증서를 읽었는지는 liveSeries로만 가린다(platform#270).
const PROMETHEUS = Object.freeze({
  service: "prometheus",
  container: "easysubway-prometheus",
  configDirs: Object.freeze(["prometheus"]),
  optional: false,
  healthy: true,
  mounts: Object.freeze([
    ["/etc/prometheus/prometheus.yml", "prometheus/prometheus.yml"],
    ["/etc/prometheus/alerts.yml", "prometheus/alerts.yml"],
  ]),
  job: null,
  scrapeProof: null,
  liveSeries: Object.freeze([]),
});
const MANAGED_UNITS = Object.freeze([
  PROMETHEUS,
  Object.freeze({
    service: "origin-certificate-probe",
    container: "easysubway-origin-certificate-probe",
    configDirs: Object.freeze(["blackbox"]),
    optional: true,
    healthy: false,
    mounts: Object.freeze([["/etc/blackbox_exporter/origin-certificate.yml", "blackbox/origin-certificate.yml"]]),
    job: "origin_certificate_probe",
    scrapeProof: "probe_success",
    liveSeries: Object.freeze([Object.freeze({ metric: "probe_ssl_earliest_cert_expiry" }), Object.freeze({ metric: "probe_success", value: "1" })]),
  }),
]);
const CONFIG_DIRS = Object.freeze([...MATERIALIZED_ONLY_DIRS, ...MANAGED_UNITS.flatMap((unit) => unit.configDirs)].toSorted(codepointCompare));
const OPTIONAL_DIRS = Object.freeze(MANAGED_UNITS.filter((unit) => unit.optional).flatMap((unit) => unit.configDirs));
// CI는 `promtool test rules infra/prometheus/*.test.yml`로 한 단계만 본다. 배포 게이트도 같은 집합이어야 한다.
const RULE_TEST_PATTERN = /^prometheus\/[^/]+\.test\.yml$/u;
// compose 해석용 값이다. compose는 프로젝트 전체를 해석하므로 backend 서비스의 필수 변수가 필요하지만(CI의 compose config 검증과 같은 방식),
// 이 도구는 prometheus 서비스 이름만 지정하고 --no-deps로 실행해 backend 컨테이너를 만들거나 바꾸지 않는다.
const COMPOSE_PARSE_ENV = Object.freeze({
  EASYSUBWAY_BACKEND_ENV_FILE: "/dev/null",
  EASYSUBWAY_BACKEND_IMAGE: "ghcr.io/aquilaxk/easysubway-backend@sha256:0000000000000000000000000000000000000000000000000000000000000000",
});
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/+-]+$/u;
const HOST_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const SIGNAL_EXIT_CODES = Object.freeze({ SIGTERM: 143, SIGINT: 130 });
const WAIT_ATTEMPTS = 60;
// 라이브 검증은 3초 간격으로 다시 읽고, 설정의 가장 긴 scrape·평가 주기(origin_certificate_probe의 scrape_interval 1m)의 두 배를 기다린다.
// 재시작 직후 첫 scrape가 실패해도 다음 scrape에서 통과할 수 있게 하려는 것이다. 주기가 짧은 설정도 최소 VERIFY_MIN_ATTEMPTS번은 읽는다.
const VERIFY_INTERVAL_MS = 3000;
const VERIFY_MIN_ATTEMPTS = 20;
const DURATION_UNIT_MS = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 });

const defaultSleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

// 자식에는 PATH와 HOME(docker CLI 설정)만 넘긴다. 이 프로세스 환경의 secret은 상속되지 않는다.
const hostCommand = (command, args, options = {}) => runCommand(command, args, {
  ...options, env: { ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...options.env }, maxOutputBytes: HOST_OUTPUT_LIMIT_BYTES,
});

const lockPathOf = (deployRoot) => join(deployRoot, "deploy.lock");

async function holdDeployLock(acquireDeployLock, deployRoot) {
  try {
    return await acquireDeployLock(lockPathOf(deployRoot));
  } catch (error) {
    return fail("E_OBS_DEPLOY_LOCKED", `${lockPathOf(deployRoot)} is held by another deploy (backend deploy or another observability DEPLOY); nothing was changed, rerun after it finishes: ${message(error)}`);
  }
}

/* ------------------------------------------------------------------ 파일·digest */

function listFiles(root, prefix = "") {
  const found = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const stat = lstatSync(join(root, relative));
    if (stat.isSymbolicLink()) fail("E_OBS_DEPLOY_SOURCE", `symlink is not allowed: ${relative}`);
    if (stat.isDirectory()) found.push(...listFiles(root, relative));
    else if (stat.isFile()) found.push(relative);
    else fail("E_OBS_DEPLOY_SOURCE", `not a regular file: ${relative}`);
  }
  return found;
}

function digestFiles(root, files) {
  const sorted = [...files].sort(codepointCompare);
  return Object.fromEntries(sorted.map((file) => [file, sha256(readFileSync(join(root, file)))]));
}

const manifestDigest = (entries) => sha256(Object.entries(entries).map(([file, digest]) => `${digest}  ${file}\n`).join(""));

/** 트리(source의 infra 또는 release)가 담은 설정 디렉터리와 그 트리가 배포하는 unit. 빠져도 되는 것은 optional unit의 디렉터리뿐이다. */
function treeLayout(root) {
  if (!existsSync(join(root, "docker-compose.yml"))) fail("E_OBS_DEPLOY_SOURCE", "missing docker-compose.yml");
  const dirs = CONFIG_DIRS.filter((dir) => existsSync(join(root, dir)));
  const missing = CONFIG_DIRS.filter((dir) => !dirs.includes(dir) && !OPTIONAL_DIRS.includes(dir));
  if (missing.length > 0) fail("E_OBS_DEPLOY_SOURCE", `missing ${missing.join(",")}`);
  return { dirs, units: MANAGED_UNITS.filter((unit) => unit.configDirs.every((dir) => dirs.includes(dir))) };
}

/** 트리의 파일 digest(경로 순서)와 디렉터리별·전체 digest, 그리고 그 트리가 배포하는 unit. */
function describeTree(root) {
  const { dirs, units } = treeLayout(root);
  const fileDigests = digestFiles(root, ["docker-compose.yml", ...dirs.flatMap((dir) => listFiles(root, dir))]);
  const directoryDigests = Object.fromEntries(dirs.map((dir) => [
    dir,
    manifestDigest(Object.fromEntries(Object.entries(fileDigests).filter(([file]) => file.startsWith(`${dir}/`)).map(([file, digest]) => [file.slice(dir.length + 1), digest]))),
  ]));
  return { files: fileDigests, directoryDigests, configDigest: manifestDigest(fileDigests), units };
}

function stageRelease(sourceRoot, stagingDir) {
  const infra = join(sourceRoot, "infra");
  const { dirs } = treeLayout(infra);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
  const sources = [["docker-compose.yml", join(infra, "docker-compose.yml")]];
  for (const dir of dirs) for (const file of listFiles(infra, dir)) sources.push([file, join(infra, file)]);
  for (const [relative, source] of sources) {
    const target = join(stagingDir, relative);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(target, readFileSync(source));
    chmodSync(target, 0o444);
  }
  for (const dir of listDirectories(stagingDir)) chmodSync(join(stagingDir, dir), 0o755);
  chmodSync(stagingDir, 0o755);
  return describeTree(stagingDir);
}

function listDirectories(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return [relative, ...listDirectories(root, relative)];
  });
}

function atomicSymlink(root, name, target) {
  const temporary = join(root, `.${name}.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, join(root, name));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * 강제 종료된 이전 실행이 남긴 `.staging-<sha12>-<pid>` 디렉터리와 `.current|previous.tmp-<pid>` symlink를 지운다.
 * pid가 살아 있으면 다른 실행이 쓰는 중으로 보고 건드리지 않는다. 호출 시점에 이 실행이 deploy.lock을 쥐고 있어 다른 DEPLOY는 돌지 않으며,
 * pid 재사용으로 못 지우는 경우는 남겨 두는 쪽(무해)으로 실패한다.
 */
function reapStaleArtifacts(root, isProcessAlive) {
  const candidates = [
    [join(root, "releases"), /^\.staging-[0-9a-f]{12}-(\d+)$/u],
    [root, /^\.(?:current|previous)\.tmp-(\d+)$/u],
  ];
  const reaped = [];
  for (const [directory, pattern] of candidates) {
    for (const entry of readdirSync(directory)) {
      const match = pattern.exec(entry);
      if (!match || isProcessAlive(Number(match[1]))) continue;
      rmSync(join(directory, entry), { recursive: true, force: true });
      reaped.push(entry);
    }
  }
  return reaped;
}

function readManagedLink(root, name) {
  const path = join(root, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) fail("E_OBS_DEPLOY_STATE", `${name} is not a symlink`);
  const match = /^releases\/([0-9a-f]{40})$/u.exec(readlinkSync(path));
  if (!match || !existsSync(join(root, "releases", match[1]))) fail("E_OBS_DEPLOY_STATE", `${name} does not point at a managed release`);
  return match[1];
}

/* ------------------------------------------------------------------ docker 호출 */

function createDocker(commandRunner) {
  const docker = (args, { env, timeoutMs } = {}) => commandRunner("docker", args, { env, timeoutMs });
  const json = async (args) => {
    const { stdout } = await docker(args);
    try {
      return JSON.parse(stdout);
    } catch {
      return fail("E_OBS_DEPLOY_STATE", `docker ${args[0]} did not return JSON`);
    }
  };
  const composeArgs = (projectDirectory, envFile) => [
    "compose", "-p", COMPOSE_PROJECT, "--project-directory", projectDirectory, "-f", join(projectDirectory, "docker-compose.yml"),
    ...(envFile ? ["--env-file", envFile] : []), "--profile", COMPOSE_PROFILE,
  ];
  return {
    docker,
    json,
    composeConfig: async (projectDirectory, envFile, services) => {
      const { stdout } = await docker([...composeArgs(projectDirectory, envFile), "config", "--format", "json", ...services], { env: COMPOSE_PARSE_ENV });
      const parsed = JSON.parse(stdout);
      const defined = parsed?.services ?? {};
      const service = defined[PROMETHEUS.service];
      assertNetworkNotOwned(parsed?.networks?.default);
      if (typeof service?.image !== "string" || !Array.isArray(service?.command)) fail("E_OBS_DEPLOY_SOURCE", "compose does not define the prometheus service image and command");
      for (const name of services) if (!(name in defined)) fail("E_OBS_DEPLOY_SOURCE", `compose does not define the ${name} service`);
      return { image: service.image, command: service.command };
    },
    composeUp: (projectDirectory, envFile, services) => docker(
      [...composeArgs(projectDirectory, envFile), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", ...services],
      { env: COMPOSE_PARSE_ENV, timeoutMs: 300_000 },
    ),
  };
}

/**
 * platform#250~#273 사이 main 커밋의 compose는 운영 네트워크를 external 없이 ipam으로 선언한다. compose는 그 정의를 운영 네트워크의 config-hash와
 * 달리 보고 연결된 컨테이너를 떼어 내며 네트워크를 다시 만들려 한다(2026-10-30 사고). 그런 release는 적용·복원 어느 쪽으로도 compose에 넘기지 않는다.
 * 네트워크 블록이 없는 옛 compose는 그 네트워크를 만든 정의와 같아 다시 만들지 않는다.
 */
function assertNetworkNotOwned(network) {
  if (network && network.external !== true && (network.ipam?.config ?? []).length > 0) {
    fail("E_OBS_DEPLOY_SOURCE", `compose declares the default network ${network.name} with ipam but not external; compose would recreate the live network (platform#273)`);
  }
}

/** step()이 {done: true}를 돌려줄 때까지 attempts번 반복한다. 마지막 결과를 그대로 돌려준다. */
async function poll(sleep, attempts, interval, step) {
  const result = await step();
  if (result.done || attempts <= 1) return result;
  await sleep(interval);
  return poll(sleep, attempts - 1, interval, step);
}

async function waitFor(sleep, attempts, check, interval = 2000) {
  const result = await poll(sleep, attempts, interval, async () => {
    try {
      const value = await check();
      return value ? { done: true, value } : { done: false, error: null };
    } catch (error) {
      return { done: false, error };
    }
  });
  if (result.done) return result.value;
  throw result.error ?? new Error("condition was not met in time");
}

function expectedFlagKeys(command) {
  return command.filter((item) => item.startsWith("--")).map((item) => item.slice(2).split("=")[0]);
}

async function collectReference({ docker, image, command, stagedPrometheus, commit, sleep }) {
  const name = `easysubway-observability-ref-${commit.slice(0, 12)}-${process.pid}`;
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
  let cleanup = null;
  try {
    await docker.docker(["rm", "-f", "-v", name]);
  } catch (error) {
    cleanup = error;
  }
  if (primary) fail("E_OBS_DEPLOY_REFERENCE", message(primary));
  if (cleanup) fail("E_OBS_DEPLOY_REFERENCE", `reference container ${name} was not removed: ${message(cleanup)}`);
  return snapshot;
}

/** promtool test rules에 넘길 규칙 시험 파일. release의 prometheus 디렉터리 바로 아래 *.test.yml 전부다(커밋마다 있는 파일이 다르다). */
const ruleTestsOf = (files) => Object.keys(files).filter((file) => RULE_TEST_PATTERN.test(file)).map((file) => `/etc/${file}`);

async function validateWithPromtool({ docker, image, stagedPrometheus, ruleTests }) {
  const run = (...args) => docker.docker(["run", "--rm", "--network", "none", "--entrypoint", "promtool", "-v", `${stagedPrometheus}:/etc/prometheus:ro`, image, ...args]);
  try {
    await docker.docker(["pull", image], { timeoutMs: 300_000 });
  } catch (error) {
    fail("E_OBS_DEPLOY_VALIDATE", `image pull failed: ${message(error)}`);
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

/* ------------------------------------------------------------------ 호스트 상태 */

async function readHostState(docker) {
  let container;
  try {
    [container] = await docker.json(["inspect", "--type", "container", PROMETHEUS.container]);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    return fail("E_OBS_DEPLOY_STATE", `${PROMETHEUS.container} cannot be inspected: ${message(error)}`);
  }
  if (!container?.State?.Running) fail("E_OBS_DEPLOY_STATE", `${PROMETHEUS.container} is not running`);
  const mount = (container.Mounts ?? []).find((item) => item.Destination === DATA_MOUNT);
  if (mount?.Type !== "volume" || mount.Name !== DATA_VOLUME) fail("E_OBS_DEPLOY_VOLUME", `${PROMETHEUS.container} does not mount ${DATA_VOLUME} at ${DATA_MOUNT}`);
  const [volume] = await docker.json(["volume", "inspect", DATA_VOLUME]);
  const projectContainers = await readProjectContainers(docker);
  const network = {
    networks: Object.keys(container.NetworkSettings?.Networks ?? {}).sort(codepointCompare),
    extraHosts: [...(container.HostConfig?.ExtraHosts ?? [])].sort(codepointCompare),
  };
  return { volume: { mountpoint: volume.Mountpoint, createdAt: volume.CreatedAt }, projectContainers, network };
}

async function readProjectContainers(docker) {
  const { stdout } = await docker.docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`]);
  const ids = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (ids.length === 0) return {};
  const records = await docker.json(["inspect", "--type", "container", ...ids]);
  return Object.fromEntries(records.map((record) => [String(record.Name).replace(/^\//u, ""), { id: record.Id, image: record.Image, startedAt: record.State?.StartedAt ?? null }]));
}

async function waitReady(docker, sleep, { container, healthy }) {
  await waitFor(sleep, WAIT_ATTEMPTS, async () => {
    const [record] = await docker.json(["inspect", "--type", "container", container]);
    return record?.State?.Running && (!healthy || record.State.Health?.Status === "healthy");
  });
}

/** 컨테이너가 실제로 마운트한 설정 파일의 sha256, release 원천 파일 경로별. symlink 이력이 아니라 컨테이너 안에서 읽은 내용이다. */
async function readMountedDigests(docker, target) {
  const { stdout } = await docker.docker(["exec", target.container, "sha256sum", ...target.mounts.map(([path]) => path)]);
  const sources = Object.fromEntries(target.mounts);
  return Object.fromEntries(stdout.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const [digest, path] = line.trim().split(/\s+/u);
    return [sources[path], digest];
  }));
}

const mountMismatch = (mounted, files, target) => target.mounts.map(([, source]) => source).filter((source) => mounted[source] !== files[source]);

/** unit별 컨테이너 ID. 호스트에 아직 없는 컨테이너(그 unit의 처음 배포)는 프로젝트 컨테이너 목록에 없으므로 null이다. */
const containerIds = (projectContainers, units) => Object.fromEntries(units.map((unit) => [unit.service, projectContainers[unit.container]?.id ?? null]));

/**
 * compose up 뒤 컨테이너가 release의 설정 파일을 실제로 읽고 있는지 확인하고, 아니면(재생성되지 않아 옛 inode를 잡고 있는 경우) 재시작한다.
 * 재시작 판단은 current symlink의 과거 값이 아니라 컨테이너 내용이므로 중단 후 같은 커밋 재시도도 수렴한다.
 * 한 번의 compose up이 units의 서비스를 모두 올리고, 확인·재시작은 컨테이너마다 한다. 결과는 서비스 이름별이다.
 */
async function convergeContainers({ docker, sleep, root, composeEnvFile, files, units, idsBefore }) {
  await docker.composeUp(join(root, "current"), composeEnvFile, units.map((unit) => unit.service));
  const idsAfter = containerIds(await readProjectContainers(docker), units);
  const converged = await inOrder(units, (unit) => convergeUnit({ docker, sleep, files, unit, idBefore: idsBefore[unit.service], idAfter: idsAfter[unit.service] }));
  return Object.fromEntries(converged);
}

async function convergeUnit({ docker, sleep, files, unit, idBefore, idAfter }) {
  await waitReady(docker, sleep, unit);
  let restarted = false;
  let stale = mountMismatch(await readMountedDigests(docker, unit), files, unit);
  if (stale.length > 0) {
    await docker.docker(["restart", unit.container]);
    restarted = true;
    await waitReady(docker, sleep, unit);
    stale = mountMismatch(await readMountedDigests(docker, unit), files, unit);
    if (stale.length > 0) fail("E_OBS_DEPLOY_VERIFY", `mounted config files differ from the release after restart (${unit.container}: ${stale.join(",")})`);
  }
  let action = idAfter === idBefore ? "unchanged" : "recreated";
  if (restarted) action = "restarted";
  return [unit.service, { container: unit.container, idBefore, idAfter, action }];
}

/** 앞 항목이 끝난 뒤 다음 항목을 시작한다. docker 조작은 컨테이너마다 순서가 의미를 가지므로 병렬로 하지 않는다. */
const inOrder = (items, step) => items.reduce(async (previous, item) => [...(await previous), await step(item)], Promise.resolve([]));

const durationMs = (text) => [...text.matchAll(/(?<!\d)(\d+)(ms|[smhdwy])/gu)].reduce((sum, [, value, unit]) => sum + Number(value) * DURATION_UNIT_MS[unit], 0);

/** 라이브 검증 반복 횟수. 기대 설정(/api/v1/status/config는 job마다 주기를 채워 준다)의 가장 긴 scrape·평가 주기 두 배를 덮는다. */
function verifyAttempts(statusConfigYaml) {
  const intervals = [...statusConfigYaml.matchAll(/^[ \t]*(?:scrape|evaluation)_interval: (\S+)$/gmu)].map(([, value]) => durationMs(value));
  return Math.max(VERIFY_MIN_ATTEMPTS, Math.ceil((2 * Math.max(0, ...intervals)) / VERIFY_INTERVAL_MS) + 1);
}

const epochSeconds = (date) => date.getTime() / 1000;

// Prometheus의 표본 lookback과 같은 5분. 이보다 오래된 표본은 현재 시계열이 아니다.
const SAMPLE_LOOKBACK = "5m";

/** 시계열 하나의 가장 최근 표본. `selector[5m]` 범위 질의 하나가 표본의 실제 scrape 시각과 값을 함께 돌려준다. */
async function readSeries(docker, spec) {
  const query = `${spec.selector}[${SAMPLE_LOOKBACK}]`;
  const { result } = await promData(docker, PROMETHEUS.container, `/api/v1/query?query=${encodeURIComponent(query)}`);
  return { ...spec, ...newestSample(result) };
}

const readSeriesAll = (docker, series) => inOrder(series, (spec) => readSeries(docker, spec));

const unreadable = (error) => `live prometheus was not readable: ${message(error)}`;

/**
 * 라이브 Prometheus를 검증 창 동안 다시 읽는 유일한 poll. 설정·규칙·target은 기대와 대조하고(configProblems), freshness의 시계열은
 * notBefore 뒤의 새 표본인지(staleSeries)와 기대한 값인지(unhealthySeries)를 가른다. 셋이 모두 비면 done이다.
 * freshness는 필수다: 시계열 검증이 없으면 null, 있으면 notBefore가 반드시 따라와야 한다(없으면 신선도 검사가 조용히 꺼진다).
 */
export async function pollLive({ docker, sleep, expected, flagKeys, freshness }) {
  if (freshness !== null && !Number.isFinite(freshness?.notBefore)) fail("E_OBS_DEPLOY_USAGE", "freshness must be null or carry the numeric notBefore of the convergence");
  const { series = [], notBefore = 0 } = freshness ?? {};
  return poll(sleep, verifyAttempts(expected.yaml), VERIFY_INTERVAL_MS, async () => {
    try {
      const live = await readSnapshot(docker, PROMETHEUS.container);
      const readings = await readSeriesAll(docker, series);
      const result = { live, readings, configProblems: compareSnapshots(expected, live, flagKeys), staleSeries: staleSeriesOf(readings, notBefore), unhealthySeries: unhealthySeriesOf(readings) };
      return { ...result, done: unsettledProblems(result).length === 0 };
    } catch (error) {
      return { done: false, live: null, readings: [], configProblems: [unreadable(error)], staleSeries: [], unhealthySeries: [] };
    }
  });
}

const unsettledProblems = ({ configProblems, staleSeries, unhealthySeries }) => [...configProblems, ...staleSeries, ...unhealthySeries];

/** 복원 뒤 외부 상태에 달린 시계열을 한 번 읽어 기록한다. 게이트가 아니다. 읽지 못해도 설정한 selector는 표본 없음으로 남긴다. */
async function recordExternalSeries({ docker, series, notBefore }) {
  if (series.length === 0) return null;
  try {
    const readings = await readSeriesAll(docker, series);
    return { ...externalVerdict(readings, notBefore), series: seriesReceipt(readings) };
  } catch (error) {
    return { ok: false, detail: unreadable(error), series: seriesReceipt(series.map((spec) => ({ ...spec, sampleTime: null, value: null }))) };
  }
}

/* ------------------------------------------------------------------ 입력 */

function readOptions(options) {
  const { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl = null, runId = null } = options;
  if (!MODES.includes(mode)) fail("E_OBS_DEPLOY_USAGE", "mode must be PREVIEW or DEPLOY");
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) fail("E_OBS_DEPLOY_USAGE", "commit must be a 40-character lowercase git SHA");
  if (typeof sourceRoot !== "string" || !SAFE_ABSOLUTE_PATH.test(sourceRoot) || sourceRoot.includes("..")) fail("E_OBS_DEPLOY_USAGE", "source root must be a safe absolute path");
  if (mode === "DEPLOY") {
    for (const [label, value] of [["deploy root", deployRoot], ["compose env file", composeEnvFile]]) {
      if (typeof value !== "string" || !SAFE_ABSOLUTE_PATH.test(value) || value.includes("..")) fail("E_OBS_DEPLOY_USAGE", `${label} must be a safe absolute path`);
    }
    if (typeof runId !== "string" || !/^\d+$/u.test(runId)) fail("E_OBS_DEPLOY_USAGE", "run id must be digits");
    if (typeof runUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/u.test(runUrl)) fail("E_OBS_DEPLOY_USAGE", "run url must be a GitHub Actions run URL");
  }
  return { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId };
}

/* ------------------------------------------------------------------ 본체 */

export async function deployObservabilityConfig(options = {}) {
  const { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId } = readOptions(options);
  const {
    commandRunner = hostCommand, sleep = defaultSleep, now = () => new Date(), stagingRoot, isProcessAlive = processIsAlive, signalSource = process, exit = (code) => process.exit(code),
    acquireDeployLock = (lockPath) => acquireSharedDeployLock({ lockPath }),
  } = options;
  if (typeof commandRunner !== "function") fail("E_OBS_DEPLOY_USAGE", "commandRunner must be a function");
  const children = interruptibleRunner(commandRunner);
  const docker = createDocker(children.run);

  const head = (await children.run("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {})).stdout.trim();
  if (head !== commit) fail("E_OBS_DEPLOY_SOURCE", `source checkout is at ${head}, expected ${commit}`);

  if (mode === "PREVIEW") return previewRelease({ docker, commit, sourceRoot, stagingRoot, composeEnvFile, sleep });
  const lock = await holdDeployLock(acquireDeployLock, deployRoot);
  try {
    return await deployRelease({ docker, children, sleep, now, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId, isProcessAlive, signalSource, exit });
  } finally {
    await lock.close();
  }
}

const stagingDirOf = (base, commit) => join(base, `.staging-${commit.slice(0, 12)}-${process.pid}`);

const releaseSummary = (preview) => ({
  image: preview.image,
  appliedServices: preview.tree.units.map((unit) => unit.service),
  materializedOnly: [...MATERIALIZED_ONLY_DIRS],
  validation: preview.validation,
  files: preview.tree.files,
  directoryDigests: preview.tree.directoryDigests,
  configDigest: preview.tree.configDigest,
});

async function previewRelease({ docker, commit, sourceRoot, stagingRoot, composeEnvFile, sleep }) {
  const ownedStagingBase = stagingRoot === undefined ? mkdtempSync(join(tmpdir(), "obs-deploy-")) : null;
  const stagingBase = stagingRoot ?? ownedStagingBase;
  mkdirSync(stagingBase, { recursive: true });
  const stagingDir = stagingDirOf(stagingBase, commit);
  try {
    const preview = await preflight({ docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep });
    return {
      schemaVersion: "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_PREVIEW_V1",
      mode: "PREVIEW",
      commit,
      ...releaseSummary(preview),
      expected: {
        version: preview.expected.version,
        flags: Object.fromEntries(preview.flagKeys.map((key) => [key, preview.expected.flags[key]])),
        statusConfigSha256: preview.expected.statusConfigSha256,
        rulesSha256: preview.expected.rulesSha256,
        jobs: preview.expected.jobs,
      },
      hostMutationCount: 0,
    };
  } finally {
    rmSync(ownedStagingBase ?? stagingDir, { recursive: true, force: true });
  }
}

async function deployRelease({ commit, sourceRoot, deployRoot, composeEnvFile, isProcessAlive, ...context }) {
  const root = join(deployRoot, "observability");
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
  reapStaleArtifacts(root, isProcessAlive);
  const stagingDir = stagingDirOf(join(root, "releases"), commit);
  let preview;
  try {
    preview = await preflight({ docker: context.docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep: context.sleep });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return applyRelease({ ...context, root, deployRoot, composeEnvFile, commit, stagingDir, preview, result: { mode: "DEPLOY", commit, ...releaseSummary(preview) } });
}

async function preflight({ docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep }) {
  const tree = stageRelease(sourceRoot, stagingDir);
  const { image, command } = await docker.composeConfig(stagingDir, composeEnvFile, tree.units.map((unit) => unit.service));
  const stagedPrometheus = join(stagingDir, "prometheus");
  const validation = await validateWithPromtool({ docker, image, stagedPrometheus, ruleTests: ruleTestsOf(tree.files) });
  const expected = await collectReference({ docker, image, command, stagedPrometheus, commit, sleep });
  if (REMOVED_JOBS.some((job) => expected.jobs.includes(job))) fail("E_OBS_DEPLOY_VALIDATE", `the commit still configures a removed job: ${REMOVED_JOBS.join(",")}`);
  const unscraped = tree.units.map((unit) => unit.job).filter((job) => job !== null && !expected.jobs.includes(job));
  if (unscraped.length > 0) fail("E_OBS_DEPLOY_VALIDATE", `the release deploys a unit whose prometheus job is not configured: ${unscraped.join(",")}`);
  return { tree, image, command, flagKeys: expectedFlagKeys(command), validation, expected };
}

/**
 * 적용 도중 SIGTERM·SIGINT(workflow 취소·타임아웃)를 받으면, 진행 중인 docker·git 자식을 멈추고 끝날 때까지 기다린 뒤 current를 마지막으로 검증된
 * 직전 release로 되돌리고(가능할 때) 중단 receipt를 남기고 종료한다. 컨테이너 상태는 알 수 없으므로 같은 DEPLOY를 다시 실행해 수렴시키라고 알린다.
 * state.done은 그 처리가 끝나는 promise라, 시그널로 끊긴 적용 경로는 이를 기다린 뒤에 실패를 전한다.
 */
function interruptRestoreLabel(canRestore, previousCommit) {
  if (canRestore) return "LINK_RESTORED";
  return previousCommit === null ? "NO_MANAGED_PREVIOUS" : "SAME_COMMIT";
}

function installInterruptGuard({ signalSource, exit, onInterrupt }) {
  const state = { handled: false, done: null };
  const listeners = Object.keys(SIGNAL_EXIT_CODES).map((signal) => [signal, () => {
    if (state.handled) return;
    state.handled = true;
    state.done = Promise.resolve()
      .then(() => onInterrupt(signal))
      .catch((error) => { process.stderr.write(`E_OBS_DEPLOY_INTERRUPTED: interrupt handling failed: ${message(error)}\n`); })
      .finally(() => exit(SIGNAL_EXIT_CODES[signal]));
  }]);
  for (const [signal, listener] of listeners) signalSource.on(signal, listener);
  return { state, dispose: () => { for (const [signal, listener] of listeners) signalSource.removeListener(signal, listener); } };
}

async function ensureNetwork(docker) {
  try {
    return await ensureComposeNetwork(docker, COMPOSE_PROJECT);
  } catch (error) {
    return fail("E_OBS_DEPLOY_NETWORK", `compose default network is not usable: ${message(error)}`);
  }
}

async function applyRelease({ docker, children, sleep, now, root, deployRoot, composeEnvFile, runUrl, runId, commit, stagingDir, preview, result, signalSource, exit }) {
  const releaseDir = join(root, "releases", commit);
  let installedNow = false;
  let switched = false;
  let guard = null;
  try {
    await ensureNetwork(docker);
    const previousCommit = readManagedLink(root, "current");
    const before = await readHostState(docker);
    const { units } = preview.tree;
    const idsBefore = containerIds(before.projectContainers, units);
    let lowestBefore = null;
    try {
      lowestBefore = (await readSnapshot(docker, PROMETHEUS.container)).lowestTimestamp;
    } catch {
      // 증거용 값일 뿐이다. 라이브 Prometheus가 응답하지 않아도 설정 배포는 계속하고 receipt에 null로 남긴다.
      lowestBefore = null;
    }

    if (existsSync(releaseDir)) {
      const existing = describeTree(releaseDir);
      if (JSON.stringify(existing.files) !== JSON.stringify(preview.tree.files)) fail("E_OBS_DEPLOY_RELEASE_IMMUTABLE", `releases/${commit} already exists with different content`);
      rmSync(stagingDir, { recursive: true, force: true });
    } else {
      renameSync(stagingDir, releaseDir);
      installedNow = true;
    }

    const receiptBase = { deployRoot, runId, runUrl, commit, previousCommit, now, configDigest: result.configDigest };
    guard = installInterruptGuard({
      signalSource,
      exit,
      onInterrupt: async (signal) => {
        await children.stop();
        const canRestore = previousCommit !== null && previousCommit !== commit;
        if (canRestore) atomicSymlink(root, "current", join("releases", previousCommit));
        writeFailureReceipt({
          ...receiptBase,
          outcome: "INTERRUPTED",
          error: { code: "E_OBS_DEPLOY_INTERRUPTED", detail: `${signal} received while applying; in-flight host commands were stopped; container state is unknown; rerun the same DEPLOY to converge (runbook: ${RUNBOOK_PATH})` },
          restore: interruptRestoreLabel(canRestore, previousCommit),
        });
      },
    });
    if (previousCommit !== null && previousCommit !== commit) atomicSymlink(root, "previous", join("releases", previousCommit));
    atomicSymlink(root, "current", join("releases", commit));
    switched = true;

    let converged;
    let convergedAt;
    let verified;
    try {
      converged = await convergeContainers({ docker, sleep, root, composeEnvFile, files: preview.tree.files, units, idsBefore });
      convergedAt = epochSeconds(now());
      const settled = await pollLive({ docker, sleep, expected: preview.expected, flagKeys: preview.flagKeys, freshness: { series: liveSeriesOf(units), notBefore: convergedAt } });
      if (!settled.done) fail("E_OBS_DEPLOY_VERIFY", unsettledProblems(settled).join("; "));
      verified = { live: settled.live, readings: settled.readings, hostAfter: await readHostState(docker) };
      assertScopeAndVolume(before, verified.hostAfter, units);
      assertRuntimeWiring(before, verified.hostAfter);
    } catch (error) {
      const recovery = guard.state.handled ? null : await recoverFailedApply({ docker, sleep, now, root, composeEnvFile, previousCommit, commit, before, units, error });
      if (guard.state.handled) {
        await guard.state.done;
        throw error;
      }
      writeFailureReceipt({ ...receiptBase, outcome: "FAILED", ...recovery.receipt });
      throw recovery.error;
    }

    const verification = finishVerification({ before, verified, convergedAt, lowestBefore, preview });
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      mode: "DEPLOY",
      commit,
      previousCommit,
      runUrl,
      deployedAt: now().toISOString(),
      image: result.image,
      composeProject: COMPOSE_PROJECT,
      appliedServices: result.appliedServices,
      materializedOnly: result.materializedOnly,
      validation: result.validation,
      files: result.files,
      directoryDigests: result.directoryDigests,
      configDigest: result.configDigest,
      units: converged,
      verification,
    };
    writeFileSync(join(receiptDirectory(deployRoot, commit, runId), "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return receipt;
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    // current가 이 release로 넘어가기 전에 실패했다면 방금 설치한 release는 어디에서도 참조되지 않는다.
    if (installedNow && !switched) rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  } finally {
    guard?.dispose();
  }
}

const othersOf = (projectContainers, units) => Object.fromEntries(Object.entries(projectContainers).filter(([name]) => !units.some((unit) => unit.container === name)));

/** 이 release가 맞추는 unit 외에 바뀐 것이 없는지 확인한다: 다른 프로젝트 컨테이너(ID·이미지·시작 시각)와 데이터 volume 정체. */
function assertScopeAndVolume(before, hostAfter, units) {
  const others = (state) => othersOf(state.projectContainers, units);
  const beforeOthers = others(before);
  const afterOthers = others(hostAfter);
  for (const [name, expected] of Object.entries(beforeOthers)) {
    const actual = afterOthers[name];
    if (!actual) fail("E_OBS_DEPLOY_SCOPE", `${name} disappeared during the observability config deploy`);
    for (const field of ["id", "image", "startedAt"]) {
      if (actual[field] !== expected[field]) fail("E_OBS_DEPLOY_SCOPE", `${name} ${field} changed during the observability config deploy (${expected[field]} -> ${actual[field]})`);
    }
  }
  for (const name of Object.keys(afterOthers)) if (!(name in beforeOthers)) fail("E_OBS_DEPLOY_SCOPE", `${name} appeared during the observability config deploy`);
  if (hostAfter.volume.mountpoint !== before.volume.mountpoint || hostAfter.volume.createdAt !== before.volume.createdAt) {
    fail("E_OBS_DEPLOY_VOLUME", `${DATA_VOLUME} identity changed (${before.volume.mountpoint} ${before.volume.createdAt} -> ${hostAfter.volume.mountpoint} ${hostAfter.volume.createdAt})`);
  }
}

/** 재생성된 컨테이너가 기존 컨테이너와 같은 네트워크·extra_hosts를 쓰는지(scrape 경로가 같은지) 확인한다. */
function assertRuntimeWiring(before, hostAfter) {
  if (JSON.stringify(hostAfter.network.networks) !== JSON.stringify(before.network.networks)) fail("E_OBS_DEPLOY_VERIFY", `network changed (${before.network.networks.join(",")} -> ${hostAfter.network.networks.join(",")})`);
  if (JSON.stringify(hostAfter.network.extraHosts) !== JSON.stringify(before.network.extraHosts)) fail("E_OBS_DEPLOY_VERIFY", `extra_hosts changed (${before.network.extraHosts.join(",")} -> ${hostAfter.network.extraHosts.join(",")})`);
}

function finishVerification({ before, verified, convergedAt, lowestBefore, preview }) {
  const afterOthers = Object.keys(othersOf(verified.hostAfter.projectContainers, preview.tree.units));
  return {
    version: verified.live.version,
    flags: Object.fromEntries(preview.flagKeys.map((key) => [key, verified.live.flags[key]])),
    statusConfigSha256: verified.live.statusConfigSha256,
    expectedStatusConfigSha256: preview.expected.statusConfigSha256,
    rulesSha256: verified.live.rulesSha256,
    expectedRulesSha256: preview.expected.rulesSha256,
    jobs: verified.live.jobs,
    absentJobs: [...REMOVED_JOBS],
    convergedAt: isoOfEpoch(convergedAt),
    liveSeries: seriesReceipt(verified.readings),
    targets: verified.live.targets,
    ruleHealth: verified.live.ruleHealth,
    configReloadSuccessful: verified.live.reloadSuccessful,
    untouchedContainers: afterOthers.toSorted(codepointCompare),
    volume: {
      name: DATA_VOLUME,
      mountpointBefore: before.volume.mountpoint,
      mountpointAfter: verified.hostAfter.volume.mountpoint,
      createdAtBefore: before.volume.createdAt,
      createdAtAfter: verified.hostAfter.volume.createdAt,
      tsdbLowestTimestampBefore: lowestBefore,
      tsdbLowestTimestampAfter: verified.live.lowestTimestamp,
    },
    network: verified.hostAfter.network,
  };
}

/** 적용과 복원이 compose로 맞추는 unit 전부. 둘 중 하나라도 맞춘 컨테이너는 범위 검사의 "다른 컨테이너"가 아니다. */
const unitsOf = (...lists) => MANAGED_UNITS.filter((unit) => lists.some((list) => list.includes(unit)));

/**
 * 직전 release로 되돌리고 적용과 같은 기준으로 대조한다: reference·라이브 대조, 마운트 내용, 그리고 배포 전 상태 대비 범위·volume·prometheus 네트워크 배선.
 * 결과는 restore 라벨과, 복원이 실패했으면 그 원인(restoreError)이다. 정방향 실패 원인은 호출자가 따로 남긴다.
 */
async function restorePrevious({ docker, sleep, now, root, composeEnvFile, previousCommit, commit, before, appliedUnits }) {
  if (previousCommit === null) {
    return { restore: "NO_MANAGED_PREVIOUS", restoreError: null, externalSeries: null, note: `no managed previous release to restore (first rollout): follow firstRolloutRollback in ${RUNBOOK_PATH}` };
  }
  if (previousCommit === commit) return { restore: "SAME_COMMIT", restoreError: null, externalSeries: null, note: "current already was this commit, nothing to restore" };
  let externalSeries;
  try {
    atomicSymlink(root, "current", join("releases", previousCommit));
    const previousDir = join(root, "releases", previousCommit);
    const previousTree = describeTree(previousDir);
    const { units } = previousTree;
    const { image, command } = await docker.composeConfig(join(root, "current"), composeEnvFile, units.map((unit) => unit.service));
    const expected = await collectReference({ docker, image, command, stagedPrometheus: join(previousDir, "prometheus"), commit: previousCommit, sleep });
    const idsBefore = containerIds(await readProjectContainers(docker), units);
    await convergeContainers({ docker, sleep, root, composeEnvFile, files: previousTree.files, units, idsBefore });
    const convergedAt = epochSeconds(now());
    const series = liveSeriesOf(units);
    // 복원이 요구하는 것은 복원한 probe가 수렴 뒤 scrape되었다는 증거(값은 무관)뿐이다. 만료 시계열과 성공 값은 호스트 443에 달려 있어 기록만 한다.
    const scrapeProof = series.filter((spec) => spec.scrapeProof).map((spec) => ({ ...spec, expectedValue: null }));
    const settled = await pollLive({ docker, sleep, expected, flagKeys: expectedFlagKeys(command), freshness: { series: scrapeProof, notBefore: convergedAt } });
    if (!settled.done) fail("E_OBS_DEPLOY_VERIFY", [...settled.configProblems, ...settled.staleSeries.map((problem) => `the restored probe is not being scraped (${problem})`)].join("; "));
    const hostAfter = await readHostState(docker);
    assertScopeAndVolume(before, hostAfter, unitsOf(appliedUnits, units));
    assertRuntimeWiring(before, hostAfter);
    externalSeries = await recordExternalSeries({ docker, series, notBefore: convergedAt });
  } catch (restoreError) {
    const code = restoreError instanceof DeployError ? restoreError.code : "E_OBS_DEPLOY_RESTORE";
    return { restore: "FAILED", restoreError: { code, detail: `restore verification failed for previous release ${previousCommit}: ${message(restoreError)} (runbook: ${RUNBOOK_PATH})` }, externalSeries: null, note: null };
  }
  const unconfirmed = externalSeries?.ok === false ? `; the restored probe series are not confirmed: ${externalSeries.detail}` : "";
  return { restore: "RESTORED", restoreError: null, externalSeries, note: `restored previous release ${previousCommit}${unconfirmed}` };
}

/**
 * 적용이 실패한 뒤: 직전 release로 복원하고, 배포 전에 있던 관리 컨테이너가 기본 네트워크에 붙어 떠 있는지 확인해 떨어졌으면 다시 붙인다.
 * receipt는 정방향 원인(error)과 복원 원인(restoreError)·네트워크 확인 결과를 따로 남기고, 던질 오류는 그 모두를 이름으로 적는다.
 */
async function recoverFailedApply({ before, units, error, ...restoreContext }) {
  const forward = { code: error instanceof DeployError ? error.code : "E_OBS_DEPLOY_VERIFY", detail: message(error) };
  const restored = await restorePrevious({ ...restoreContext, before, appliedUnits: units });
  const networkAttachment = await reattachDetached(restoreContext.docker, MANAGED_UNITS.filter((unit) => unit.container in before.projectContainers));
  const attachment = attachmentVerdict(networkAttachment);
  const notes = [restored.note ?? restored.restoreError.detail, ...attachment.notes];
  const failed = restored.restoreError !== null || attachment.failed;
  const detail = failed ? `forward failure ${forward.code}: ${forward.detail}; ${notes.join("; ")}` : `${forward.detail}; ${notes.join("; ")}`;
  return {
    error: new DeployError(failed ? "E_OBS_DEPLOY_RESTORE" : forward.code, detail),
    receipt: { error: forward, restore: restored.restore, restoreError: restored.restoreError, networkAttachment, externalSeries: restored.externalSeries },
  };
}

function receiptDirectory(deployRoot, commit, runId) {
  const directory = join(deployRoot, "release-receipts", `observability-config-${commit.slice(0, 12)}-${runId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function writeFailureReceipt({ deployRoot, runId, runUrl, commit, previousCommit, now, outcome, error, restore, restoreError = null, networkAttachment = null, externalSeries = null, configDigest }) {
  const receipt = {
    schemaVersion: FAILURE_RECEIPT_SCHEMA_VERSION,
    mode: "DEPLOY",
    outcome,
    commit,
    previousCommit,
    runUrl,
    recordedAt: now().toISOString(),
    error,
    restore,
    restoreError,
    networkAttachment,
    externalSeries,
    configDigest,
  };
  writeFileSync(join(receiptDirectory(deployRoot, commit, runId), "failure-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

/* ------------------------------------------------------------------ CLI */

// 경로·커밋·run 정보는 인자가 아니라 환경 변수로 받는다(workflow가 env로 넘긴다). 인자는 `--mode PREVIEW|DEPLOY` 하나뿐이다.
async function main(argv, env) {
  if (argv.length !== 2 || argv[0] !== "--mode") fail("E_OBS_DEPLOY_USAGE", "expected exactly --mode PREVIEW|DEPLOY");
  const result = await deployObservabilityConfig({
    mode: argv[1],
    commit: env.OBSERVABILITY_COMMIT,
    sourceRoot: env.OBSERVABILITY_SOURCE_ROOT,
    deployRoot: env.OBSERVABILITY_DEPLOY_ROOT,
    composeEnvFile: env.OBSERVABILITY_COMPOSE_ENV,
    runUrl: env.OBSERVABILITY_RUN_URL,
    runId: env.OBSERVABILITY_RUN_ID,
    stagingRoot: env.OBSERVABILITY_STAGING_ROOT,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function describeFailure(error) {
  return error instanceof DeployError ? error.message : `E_OBS_DEPLOY_FAILED: ${message(error)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
}
