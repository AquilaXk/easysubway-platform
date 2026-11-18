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
// 잡은 뒤에는 호스트 명령과 release·symlink 변경마다 잠금이 아직 유지되는지 확인하고, 잠금 holder가 사라지면 진행 중인 명령을 멈추고 더 바꾸지 않는다.
// 수동 절차는 contracts/release/platform-observability-config-deploy-runbook.json.
//
// 순서: 입력 검증 → 잠금 → release 스테이징 → promtool check config·test rules(실패하면 여기서 종료, 아무것도 바꾸지 않음) →
// 같은 이미지의 격리 reference Prometheus로 기대 상태 수집 → compose 기본 네트워크 확인(없으면 생성) → 떨어진 관리 컨테이너를 다시 붙인 뒤 기준선 읽기
// → release 설치 → current 전환 → release가 담은 MANAGED_UNITS 서비스만 compose up
// → 마운트 내용 확인·필요하면 재시작 → 라이브 상태(설정·규칙·target·probe 시계열·네트워크·다른 컨테이너·volume)를 기대와 대조 → receipt.
// probe 시계열은 컨테이너 수렴이 끝난 시각보다 새 표본이어야 한다(수렴 전 마지막 scrape가 lookback 안에 남아 있는 동안은 통과시키지 않는다).
// 적용 뒤 대조가 실패하면 기본 네트워크에서 떨어진 관리 컨테이너를 먼저 다시 붙이고, 직전 release로 되돌려 같은 기준(범위·volume·네트워크 배선 포함)으로
// 다시 대조한 뒤, 연결을 한 번 더 확인하고 실패로 끝난다(실패 receipt가 정방향 원인과 복원 결과를 따로 남김). 복원은 설정·규칙·target·마운트와
// 복원한 probe가 수렴 뒤 scrape되었다는 증거(probe_success의 새 표본, 값은 무관)를 대조한다. 호스트 443 도달에 달린 값은 externalSeries로 기록만 하고
// 복원 성공 여부를 가르지 않는다. 서버에 닿지 않으면 blackbox는 probe_success 0만 내고 만료 시계열을 내지 않는다.
// 컨테이너를 맞추는 서비스는 MANAGED_UNITS(prometheus와 원 서버 인증서 만료 probe, platform#270)뿐이다. origin-certificate-probe의 내용은
// 이 도구만 맞춘다. backend 배포(tools/deploy/deploy-backend.sh)는 그 컨테이너가 없을 때 만들기만 한다.
// Alertmanager·Grafana·Loki·Alloy는 release에 담기지만 이 도구는 컨테이너를 건드리지 않는다(이슈 #227 범위 밖).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { interruptibleRunner, runCommand } from "./lib/process.mjs";
import { COMPOSE_NETWORK, dockerOperationalEnvironment, ensureComposeNetwork } from "./ensure-compose-network.mjs";
import { DeployError, fail, message, sha256 } from "./observability-deploy-primitives.mjs";
import { compareSnapshots, promData, readSnapshot, REMOVED_JOBS } from "./observability-prometheus.mjs";
import { attachmentVerdict, reattachDetached } from "./observability-network.mjs";
import { collectReference, createReferenceCleanupRunner, DATA_MOUNT, expectedFlagKeys, INTERRUPT_COMMAND_LIMITS, preflight, readReleaseCompose } from "./observability-reference.mjs";
import { atomicSymlink, describeTree, MANAGED_UNITS, MATERIALIZED_ONLY_DIRS, ORIGIN_CERTIFICATE_PROBE, processIsAlive, PROMETHEUS, readManagedLink, reapStaleArtifacts } from "./observability-release.mjs";
import { acquireSharedDeployLock } from "./shared-deploy-lock.mjs";
import { externalVerdict, isoOfEpoch, liveSeriesOf, newestSample, seriesReceipt, staleSeriesOf, unhealthySeriesOf } from "./observability-series.mjs";

const MODES = Object.freeze(["PREVIEW", "DEPLOY", "DRIFT"]);
const RECEIPT_SCHEMA_VERSION = "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_RECEIPT_V3";
const FAILURE_RECEIPT_SCHEMA_VERSION = "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_FAILURE_RECEIPT_V3";
const COMPOSE_PROJECT = "easysubway";
const COMPOSE_PROFILE = "observability";
const RUNBOOK_PATH = "contracts/release/platform-observability-config-deploy-runbook.json";
const DATA_VOLUME = "easysubway_prometheus-data";
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

// 자식에는 공용 docker 운영 허용 환경 변수만 넘긴다. 이 프로세스 환경의 secret은 상속되지 않는다.
const hostCommand = (command, args, options = {}) => runCommand(command, args, {
  ...options, env: { ...dockerOperationalEnvironment(process.env), ...options.env }, maxOutputBytes: HOST_OUTPUT_LIMIT_BYTES,
});

const lockPathOf = (deployRoot) => join(deployRoot, "deploy.lock");

/** 다른 배포가 쥐고 있으면 E_OBS_DEPLOY_LOCKED, 잠금을 걸 수 없는 환경(flock 없음, 파일을 열 수 없음, holder 준비 실패)이면 E_OBS_DEPLOY_LOCK_UNAVAILABLE. */
async function holdDeployLock(acquireDeployLock, deployRoot) {
  const lockPath = lockPathOf(deployRoot);
  try {
    return await acquireDeployLock(lockPath);
  } catch (error) {
    if (error?.contended === true) return fail("E_OBS_DEPLOY_LOCKED", `${lockPath} is held by another deploy (backend deploy or another observability DEPLOY); nothing was changed, rerun after it finishes`);
    return fail("E_OBS_DEPLOY_LOCK_UNAVAILABLE", `${lockPath} could not be locked; nothing was changed: ${message(error)}`);
  }
}

/** 잠금 상실 오류. cause가 있으면(잠금을 잃은 뒤 드러난 오류) 그 원인을 문장 끝에 남긴다. */
function lockLostError(cause = null) {
  if (cause?.code === "E_OBS_DEPLOY_LOCK_LOST") return cause;
  const forward = cause === null ? "" : `; forward failure ${forwardOf(cause).code}: ${forwardOf(cause).detail}`;
  return new DeployError("E_OBS_DEPLOY_LOCK_LOST", `the deploy.lock holder exited, so another deploy may be running; stopped before the next host change (runbook: ${RUNBOOK_PATH})${forward}`);
}

async function lockHeld(lock) {
  try {
    await lock.verify();
    return true;
  } catch {
    return false;
  }
}

/** 잠금이 유지되는 동안만 runner를 부른다. 잠금을 잃으면 그 명령을 시작하지 않고 E_OBS_DEPLOY_LOCK_LOST로 거부한다. */
const lockedRunner = (lock, runner) => async (command, args, options) => {
  if (!(await lockHeld(lock))) throw lockLostError();
  return runner(command, args, options);
};

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
      return JSON.parse(stdout);
    },
    composeUp: (projectDirectory, envFile, services) => docker(
      [...composeArgs(projectDirectory, envFile), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", ...services],
      { env: COMPOSE_PARSE_ENV, timeoutMs: 300_000 },
    ),
  };
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
  const network = {
    networks: Object.keys(container.NetworkSettings?.Networks ?? {}).sort(codepointCompare),
    extraHosts: [...(container.HostConfig?.ExtraHosts ?? [])].sort(codepointCompare),
  };
  return { ...(await readScope(docker)), network };
}

/** 범위 검사의 대상: 데이터 volume 정체와 프로젝트 컨테이너 전부. prometheus가 멈춰 있어도 읽히므로 복원 전 확인에 쓴다. */
async function readScope(docker) {
  const [volume] = await docker.json(["volume", "inspect", DATA_VOLUME]);
  return { volume: { mountpoint: volume.Mountpoint, createdAt: volume.CreatedAt }, projectContainers: await readProjectContainers(docker) };
}

/**
 * 배포 전 기준선. 지난 실패가 관리 컨테이너를 기본 네트워크에서 떼어 둔 채 끝났을 수 있으므로, 이 release가 맞추는 unit 중 배포 전에 있던 것
 * (managedBefore ∩ units)을 먼저 다시 붙이고 facts.baselineAttachment에 기록한 뒤 호스트 상태를 읽는다.
 * 그래야 readHostState나 배선 판정이 실패해도 NOT_STARTED 영수증에 기준선 연결 증거가 남고, 이 release가 다루지 않는 컨테이너는 복구 대상에서도 빠진다.
 */
async function readBaseline(docker, units, facts) {
  const containers = await readProjectContainers(docker);
  const managedBefore = MANAGED_UNITS.filter((unit) => unit.container in containers && units.includes(unit));
  const attachment = await reattachDetached(docker, managedBefore);
  if (facts) facts.baselineAttachment = attachment;
  const before = await readHostState(docker);
  const verdict = attachmentVerdict({ reattach: attachment, recheck: null });
  if (verdict.unattached) fail("E_OBS_DEPLOY_NETWORK", `managed containers are not attached to ${COMPOSE_NETWORK.name}: ${verdict.notes.join("; ")}`);
  return { before, attachment, managedBefore };
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
  // 컨테이너 조작은 순서가 의미를 가지므로(prometheus가 먼저 끝난 뒤에야 probe를 건드린다) 병렬로 하지 않고 차례대로 맞춘다.
  const converged = [];
  for (const unit of units) {
    converged.push(await convergeUnit({ docker, sleep, files, unit, idBefore: idsBefore[unit.service], idAfter: idsAfter[unit.service] }));
  }
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
  try {
    const { result } = await promData(docker, PROMETHEUS.container, `/api/v1/query?query=${encodeURIComponent(query)}`);
    return { ...spec, ...newestSample(result) };
  } catch (error) {
    throw new Error(`${spec.selector}: ${message(error)}`);
  }
}

// 라이브 컨테이너 하나에 docker exec로 질의하므로 병렬로 띄우지 않고 selector 순서대로 읽는다. 앞 selector가 실패하면 뒤 selector는 질의하지 않는다.
async function readSeriesAll(docker, series) {
  const readings = [];
  for (const spec of series) readings.push(await readSeries(docker, spec));
  return readings;
}

const unreadable = (error) => `live prometheus was not readable: ${message(error)}`;

/**
 * 라이브 Prometheus를 검증 창 동안 다시 읽는 유일한 poll. 설정·규칙·target은 기대와 대조하고(configProblems), freshness의 시계열은
 * notBefore 뒤의 새 표본인지(staleSeries)와 기대한 값인지(unhealthySeries)를 가른다. 셋이 모두 비면 done이다.
 * freshness는 필수다: series 배열(시계열이 없는 옛 release면 빈 배열)과 수렴 시각 notBefore가 반드시 함께 와야 신선도 검사가 조용히 꺼지지 않는다.
 */
export async function pollLive({ docker, sleep, expected, flagKeys, freshness }) {
  if (!Array.isArray(freshness?.series) || !Number.isFinite(freshness?.notBefore)) {
    fail("E_OBS_DEPLOY_USAGE", "freshness must carry a series array and the numeric notBefore of the convergence");
  }
  const { series, notBefore } = freshness;
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

/**
 * 복원 뒤 외부 상태에 달린 시계열을 한 번 읽어 기록한다. 게이트가 아니다. 읽지 못해도 설정한 selector는 표본 없음으로 남긴다.
 * 복원 poll이 이미 읽은 scrapeProof 표본(knownReadings)은 다시 질의하지 않고 재사용한다.
 */
async function recordExternalSeries({ docker, series, knownReadings = [], notBefore }) {
  if (series.length === 0) return null;
  const knownBySelector = new Map(knownReadings.map((reading) => [reading.selector, reading]));
  try {
    const readings = [];
    for (const spec of series) {
      const known = knownBySelector.get(spec.selector);
      readings.push(known ? { ...known, expectedValue: spec.expectedValue } : await readSeries(docker, spec));
    }
    return { ...externalVerdict(readings, notBefore), series: seriesReceipt(readings) };
  } catch (error) {
    return { ok: false, detail: unreadable(error), series: seriesReceipt(series.map((spec) => ({ ...spec, sampleTime: null, value: null }))) };
  }
}

/* ------------------------------------------------------------------ 입력 */

function readOptions(options) {
  const { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl = null, runId = null } = options;
  if (!MODES.includes(mode)) fail("E_OBS_DEPLOY_USAGE", "mode must be PREVIEW, DEPLOY, or DRIFT");
  if (typeof sourceRoot !== "string" || !SAFE_ABSOLUTE_PATH.test(sourceRoot) || sourceRoot.includes("..")) fail("E_OBS_DEPLOY_USAGE", "source root must be a safe absolute path");
  if (mode === "DRIFT") {
    if (deployRoot !== undefined && deployRoot !== null && (typeof deployRoot !== "string" || !SAFE_ABSOLUTE_PATH.test(deployRoot) || deployRoot.includes(".."))) {
      fail("E_OBS_DEPLOY_USAGE", "deploy root must be a safe absolute path");
    }
    return { mode, commit: null, sourceRoot, deployRoot: deployRoot ?? null, composeEnvFile: null, runUrl: null, runId: null };
  }
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) fail("E_OBS_DEPLOY_USAGE", "commit must be a 40-character lowercase git SHA");
  if (mode === "DEPLOY") {
    for (const [label, value] of [["deploy root", deployRoot], ["compose env file", composeEnvFile]]) {
      if (typeof value !== "string" || !SAFE_ABSOLUTE_PATH.test(value) || value.includes("..")) fail("E_OBS_DEPLOY_USAGE", `${label} must be a safe absolute path`);
    }
    if (typeof runId !== "string" || !/^\d+$/u.test(runId)) fail("E_OBS_DEPLOY_USAGE", "run id must be digits");
    if (typeof runUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d+$/u.test(runUrl)) fail("E_OBS_DEPLOY_USAGE", "run url must be a GitHub Actions run URL");
  }
  return { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId };
}

/**
 * 병합 뒤 호스트에서 실행 중인 origin-certificate-probe 컨테이너가 실제로 마운트한 설정 파일 digest와
 *(deployRoot가 주어졌으면 observability/current의 파일 digest도 함께) main 체크아웃의 infra/blackbox/origin-certificate.yml을 대조한다(#272).
 */
export async function checkOriginCertificateProbeDrift({ sourceRoot, deployRoot = null, commandRunner = hostCommand } = {}) {
  readOptions({ mode: "DRIFT", sourceRoot, deployRoot });
  if (typeof commandRunner !== "function") fail("E_OBS_DEPLOY_USAGE", "commandRunner must be a function");
  const [containerPath, releaseRelative] = ORIGIN_CERTIFICATE_PROBE.mounts[0];
  const sourcePath = `infra/${releaseRelative}`;
  const sourceFile = join(sourceRoot, sourcePath);
  if (!existsSync(sourceFile) || lstatSync(sourceFile).isSymbolicLink() || !lstatSync(sourceFile).isFile()) {
    fail("E_OBS_DEPLOY_SOURCE", `missing regular file: ${sourcePath}`);
  }
  const expectedSha256 = sha256(readFileSync(sourceFile));
  const docker = createDocker(commandRunner);
  let container;
  try {
    [container] = await docker.json(["inspect", "--type", "container", ORIGIN_CERTIFICATE_PROBE.container]);
  } catch (error) {
    fail("E_OBS_DEPLOY_DRIFT", `${ORIGIN_CERTIFICATE_PROBE.container} cannot be inspected: ${message(error)}`);
  }
  if (!container?.State?.Running) fail("E_OBS_DEPLOY_DRIFT", `${ORIGIN_CERTIFICATE_PROBE.container} is not running`);
  const mounted = await readMountedDigests(docker, ORIGIN_CERTIFICATE_PROBE);
  const mountedSha256 = mounted[releaseRelative] ?? null;
  let currentSha256 = null;
  if (deployRoot) {
    const currentFile = join(deployRoot, "observability", "current", releaseRelative);
    if (!existsSync(currentFile)) fail("E_OBS_DEPLOY_DRIFT", `missing current release file: ${currentFile}`);
    currentSha256 = sha256(readFileSync(currentFile));
  }
  if (mountedSha256 !== expectedSha256 || (currentSha256 !== null && currentSha256 !== expectedSha256)) {
    fail("E_OBS_DEPLOY_DRIFT", `${ORIGIN_CERTIFICATE_PROBE.container} config digest drifted from ${sourcePath} (mounted: ${mountedSha256}, current: ${currentSha256 ?? "unchecked"}, expected: ${expectedSha256}); run observability config DEPLOY`);
  }
  return { container: ORIGIN_CERTIFICATE_PROBE.container, sourcePath, containerPath, expectedSha256, mountedSha256, currentSha256, drifted: false };
}

/* ------------------------------------------------------------------ 본체 */

export async function deployObservabilityConfig(options = {}) {
  const { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId } = readOptions(options);
  const {
    commandRunner = hostCommand, sleep = defaultSleep, now = () => new Date(), stagingRoot, isProcessAlive = processIsAlive, signalSource = process, exit = (code) => process.exit(code),
    acquireDeployLock = (lockPath) => acquireSharedDeployLock({ lockPath }), warn = (line) => process.stderr.write(`${line}\n`),
  } = options;
  if (typeof commandRunner !== "function") fail("E_OBS_DEPLOY_USAGE", "commandRunner must be a function");
  if (mode === "DRIFT") return checkOriginCertificateProbeDrift({ sourceRoot, deployRoot, commandRunner });
  const children = interruptibleRunner(commandRunner);
  // 중단 signal은 어느 단계에서 와도 진행 중인 명령(자기 프로세스 그룹의 자식)을 멈춘다. 무엇을 치우고 남길지는 그 단계의 catch가 정한다.
  const guard = installInterruptGuard({ signalSource, onSignal: () => children.stop() });
  // docker 호출은 네 가지다:
  // - scratchDocker: 잠금을 확인하지 않고 중단에 끊긴다(사전 검증·reference 기동).
  // - cleanupDocker: 잠금을 확인하지 않고 reference rm을 수행한다(평소 60s, 중단 뒤 시작 시 1.5s 제한, rm 도중 중단 시 1.5s 지연 abort).
  // - docker: 잠금 확인 + 중단에 끊긴다(DEPLOY의 호스트 상태 읽기·적용·복원).
  // - recoveryDocker: 잠금 확인 + 중단과 무관한 1.5s 제한(중단 마무리에서 떨어진 관리 컨테이너 재연결).
  const boundedRunner = (command, args, callOptions) => commandRunner(command, args, { ...callOptions, ...INTERRUPT_COMMAND_LIMITS });
  const runners = {
    children, boundedRunner, scratchDocker: createDocker(children.run),
    cleanupDocker: createDocker(createReferenceCleanupRunner(commandRunner, children.signal)),
  };
  try {
    const head = (await children.run("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {})).stdout.trim();
    if (head !== commit) fail("E_OBS_DEPLOY_SOURCE", `source checkout is at ${head}, expected ${commit}`);
    if (mode === "PREVIEW") return await previewRelease({ ...runners, commit, sourceRoot, stagingRoot, composeEnvFile, sleep: abortableSleep(sleep, children.signal), isProcessAlive, warn });
    const lock = await holdDeployLock(acquireDeployLock, deployRoot);
    // holder가 사라지면 커널 잠금이 풀려 다른 배포가 시작할 수 있다. 진행 중인 명령을 멈춰 겹치는 시간을 줄인다(다음 명령은 lockedRunner가 막는다).
    lock.closed.then(() => children.stop());
    const context = {
      ...runners, docker: createDocker(lockedRunner(lock, children.run)), recoveryDocker: createDocker(lockedRunner(lock, boundedRunner)),
      lock, guard, exit, warn, sleep: abortableSleep(sleep, children.signal), now,
    };
    return await releaseAfter(lock, () => deployRelease({ ...context, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId, isProcessAlive }));
  } catch (error) {
    const final = guard.signal !== null && !(error instanceof InterruptedDeploy) && !error?.settledSignal
      ? new InterruptedDeploy(guard.signal, `${guard.signal} received before any host change`)
      : error;
    if (final instanceof InterruptedDeploy) exit(final.exitCode);
    throw final;
  } finally {
    guard.dispose();
  }
}

async function releaseAfter(lock, work) {
  try {
    return await work();
  } finally {
    await lock.close();
  }
}

/** 중단되면(signal·잠금 상실) 다음 대기에서 멈춘다. 검증 poll이 읽기 실패를 삼키며 다시 기다리는 동안에도 중단이 전해지게 한다. */
const abortableSleep = (sleep, signal) => async (milliseconds) => {
  if (signal.aborted) throw new Error("host command interrupted");
  await sleep(milliseconds);
  if (signal.aborted) throw new Error("host command interrupted");
};

class InterruptedDeploy extends DeployError {
  constructor(signal, detail) {
    super("E_OBS_DEPLOY_INTERRUPTED", detail);
    this.exitCode = SIGNAL_EXIT_CODES[signal];
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
  staleReferenceCleanup: preview.staleReferenceCleanup,
});

async function previewRelease({ scratchDocker, cleanupDocker, commit, sourceRoot, stagingRoot, composeEnvFile, sleep, isProcessAlive, warn }) {
  const ownedStagingBase = stagingRoot === undefined ? mkdtempSync(join(tmpdir(), "obs-deploy-")) : null;
  const stagingBase = stagingRoot ?? ownedStagingBase;
  mkdirSync(stagingBase, { recursive: true });
  const stagingDir = stagingDirOf(stagingBase, commit);
  try {
    const preview = await preflight({ docker: scratchDocker, cleanup: cleanupDocker, commit, sourceRoot, stagingDir, composeEnvFile, sleep, waitFor, isProcessAlive, warn });
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

/**
 * 검증(preflight)이 커밋을 거부하면 호스트를 바꾸지 않았으므로 receipt 없이 끝난다. 중단·잠금 상실로 끊긴 실행과 current 전환 전의 실패는
 * restore NOT_STARTED로, 전환 뒤의 실패는 settleFailedApply가 FAILED나 INTERRUPTED로 남긴다.
 */
async function deployRelease({ commit, sourceRoot, deployRoot, composeEnvFile, isProcessAlive, runId, runUrl, ...context }) {
  const root = join(deployRoot, "observability");
  mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
  reapStaleArtifacts(root, isProcessAlive);
  const stagingDir = stagingDirOf(join(root, "releases"), commit);
  const facts = { previousCommit: null, composeNetwork: null, baselineAttachment: null, configDigest: null, staleReferenceCleanup: null };
  const receipts = receiptsFor({ deployRoot, runId, runUrl, commit, now: context.now, facts });
  const notStarted = async (error, { verdictIsFinal }) => {
    rmSync(stagingDir, { recursive: true, force: true });
    const aborted = await abortCause(context, error);
    if (aborted === null && verdictIsFinal) return error;
    receipts.failure({ outcome: "FAILED", error: forwardOf(aborted ?? error), restore: "NOT_STARTED" });
    return aborted ?? error;
  };
  let preview;
  try {
    preview = await preflight({ docker: context.scratchDocker, cleanup: context.cleanupDocker, commit, sourceRoot, stagingDir, composeEnvFile, sleep: context.sleep, waitFor, isProcessAlive, warn: context.warn, facts });
  } catch (error) {
    throw await notStarted(error, { verdictIsFinal: true });
  }
  facts.configDigest = preview.tree.configDigest;
  let prepared;
  try {
    prepared = await prepareSwitch({ ...context, root, commit, stagingDir, preview, facts });
  } catch (error) {
    throw await notStarted(error, { verdictIsFinal: false });
  }
  return switchAndVerify({ ...context, root, commit, composeEnvFile, runUrl, preview, prepared, receipts });
}

/** 중단·잠금 상실 판정의 단일 우선순위: 종료 코드와 직결되는 OS signal이 먼저고, 그다음이 잠금 상실이다. */
async function interruptionOf({ lock, guard }) {
  if (guard.signal !== null) return "SIGNAL";
  if (!(await lockHeld(lock))) return "LOCK_LOST";
  return null;
}

/**
 * current 전환 전 실패가 중단 signal이나 잠금 상실 때문이면 그 원인으로 바꾼 오류, 아니면 null. 진행 중인 명령이 끝나기를 기다린 뒤 판정한다.
 * 잠금을 잃은 뒤 나온 오류(검증·네트워크·reference 무엇이든)는 모두 E_OBS_DEPLOY_LOCK_LOST다.
 */
async function abortCause(context, error) {
  const kind = await interruptionOf(context);
  if (kind === "SIGNAL") {
    const stopped = await context.guard.stopped;
    return new InterruptedDeploy(context.guard.signal, `${context.guard.signal} received before the release switch; ${stoppedNote(stopped)}; current was not switched; rerun the same DEPLOY (runbook: ${RUNBOOK_PATH})`);
  }
  if (kind === "LOCK_LOST") {
    await context.children.stop();
    return lockLostError(error);
  }
  return null;
}

const stoppedNote = (stopped) => (stopped ? "in-flight host commands were stopped" : "in-flight host commands did not stop within the deadline");

/** 파일 변경(release 설치·current 전환) 직전 확인. 잠금을 잃었거나 중단되었으면 바꾸지 않는다. */
async function assertMayChange({ lock, children }) {
  if (!(await lockHeld(lock))) throw lockLostError();
  if (children.signal.aborted) throw new Error("host command interrupted");
}

async function ensureNetwork(docker) {
  try {
    return await ensureComposeNetwork(docker.docker, COMPOSE_PROJECT);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    return fail("E_OBS_DEPLOY_NETWORK", `compose default network is not usable: ${message(error)}`);
  }
}

async function readLowestTimestamp(docker) {
  try {
    return (await readSnapshot(docker, PROMETHEUS.container)).lowestTimestamp;
  } catch {
    // 증거용 값일 뿐이다. 라이브 Prometheus가 응답하지 않아도 설정 배포는 계속하고 receipt에 null로 남긴다.
    return null;
  }
}

/** release를 설치한다. 같은 커밋 release가 이미 있어도 전환 전 중단·잠금 상실을 먼저 확인하고, 내용이 같을 때만 그대로 쓴다. */
async function installRelease({ context, releaseDir, stagingDir, files, commit }) {
  await assertMayChange(context);
  if (existsSync(releaseDir)) {
    if (JSON.stringify(describeTree(releaseDir).files) !== JSON.stringify(files)) fail("E_OBS_DEPLOY_RELEASE_IMMUTABLE", `releases/${commit} already exists with different content`);
    rmSync(stagingDir, { recursive: true, force: true });
    return;
  }
  renameSync(stagingDir, releaseDir);
}

/**
 * 복원이 되돌릴 직전 release 커밋. 평소는 current가 가리키는 커밋이지만, 이전 실행이 current를 새 커밋으로 바꾼 뒤
 * 죽어 같은 커밋을 다시 배포하는 경우에는 previous가 가리키는 직전 검증 release로 되돌려야 한다.
 */
function readRestoreTarget(root, commit) {
  const current = readManagedLink(root, "current");
  if (current !== commit) return current;
  return readManagedLink(root, "previous") ?? current;
}

/**
 * current를 바꾸기 전의 준비: 복원 대상 커밋 기록, 기본 네트워크 보장, 기준선(떨어진 관리 컨테이너를 다시 붙인 뒤), release 설치.
 * previousCommit을 가장 먼저 읽어 네트워크·기준선 단계가 실패해도 NOT_STARTED 영수증에 직전 커밋이 남는다.
 */
async function prepareSwitch({ root, commit, stagingDir, preview, facts, ...context }) {
  const { docker } = context;
  facts.previousCommit = readRestoreTarget(root, commit);
  facts.composeNetwork = await ensureNetwork(docker);
  const baseline = await readBaseline(docker, preview.tree.units, facts);
  const lowestBefore = await readLowestTimestamp(docker);
  await installRelease({ context, releaseDir: join(root, "releases", commit), stagingDir, files: preview.tree.files, commit });
  return { ...baseline, lowestBefore, previousCommit: facts.previousCommit, composeNetwork: facts.composeNetwork };
}

/** SIGTERM·SIGINT(workflow 취소·타임아웃)를 받으면 진행 중인 명령을 멈추게만 한다. 무엇을 되돌리고 남길지는 그 단계의 catch가 정한다. */
function installInterruptGuard({ signalSource, onSignal }) {
  const guard = { signal: null, stopped: null, dispose: null };
  const listeners = Object.keys(SIGNAL_EXIT_CODES).map((name) => [name, () => {
    if (guard.signal !== null) return;
    guard.signal = name;
    guard.stopped = onSignal();
  }]);
  for (const [signal, listener] of listeners) signalSource.on(signal, listener);
  guard.dispose = () => { for (const [signal, listener] of listeners) signalSource.removeListener(signal, listener); };
  return guard;
}

async function switchAndVerify(context) {
  const { root, commit, prepared } = context;
  try {
    await assertMayChange(context);
    if (prepared.previousCommit !== null && prepared.previousCommit !== commit) atomicSymlink(root, "previous", join("releases", prepared.previousCommit));
    atomicSymlink(root, "current", join("releases", commit));
    return await convergeAndRecord(context);
  } catch (error) {
    throw await settleFailedApply(context, error);
  }
}

async function convergeAndRecord({ docker, sleep, now, root, composeEnvFile, commit, runUrl, preview, prepared, receipts }) {
  const { units } = preview.tree;
  const { before } = prepared;
  const converged = await convergeContainers({ docker, sleep, root, composeEnvFile, files: preview.tree.files, units, idsBefore: containerIds(before.projectContainers, units) });
  const convergedAt = epochSeconds(now());
  const settled = await pollLive({ docker, sleep, expected: preview.expected, flagKeys: preview.flagKeys, freshness: { series: liveSeriesOf(units), notBefore: convergedAt } });
  if (!settled.done) fail("E_OBS_DEPLOY_VERIFY", unsettledProblems(settled).join("; "));
  const verified = { live: settled.live, readings: settled.readings, hostAfter: await readHostState(docker) };
  assertScopeAndVolume(before, verified.hostAfter, units);
  assertRuntimeWiring(before, verified.hostAfter);
  const summary = releaseSummary(preview);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    mode: "DEPLOY",
    commit,
    previousCommit: prepared.previousCommit,
    runUrl,
    deployedAt: now().toISOString(),
    image: summary.image,
    composeProject: COMPOSE_PROJECT,
    appliedServices: summary.appliedServices,
    materializedOnly: summary.materializedOnly,
    validation: summary.validation,
    files: summary.files,
    directoryDigests: summary.directoryDigests,
    configDigest: summary.configDigest,
    staleReferenceCleanup: summary.staleReferenceCleanup,
    composeNetwork: prepared.composeNetwork,
    baselineAttachment: prepared.attachment,
    units: converged,
    verification: finishVerification({ before, verified, convergedAt, lowestBefore: prepared.lowestBefore, preview }),
  };
  receipts.success(receipt);
  return receipt;
}

const forwardOf = (error) => ({ code: error instanceof DeployError ? error.code : "E_OBS_DEPLOY_VERIFY", detail: message(error) });

/**
 * current 전환 뒤 실패의 단 한 곳. 신호·잠금 판정은 interruptionOf 우선순위를 따른다.
 * - 복원 시작 전 signal이면 finishInterrupted로 INTERRUPTED를 남기고, 잠금을 잃었으면 복원하지 않고 LOCK_LOST를 남긴다.
 * - 복원 뒤 signal이 왔어도 복원 검증이 이미 RESTORED로 끝났으면 검증된 RESTORED 판정을 보존하고 종료 코드만 signal로 맞춘다.
 * - 복원 도중 잠금을 잃었으면 영수증 error도 E_OBS_DEPLOY_LOCK_LOST(정방향 원인 포함)로 맞춘다.
 */
async function settleFailedApply(context, error) {
  const { receipts, guard, exit } = context;
  const beforeRecovery = await interruptionOf(context);
  if (beforeRecovery === "SIGNAL") return finishInterrupted(context, { forward: null });
  if (beforeRecovery === "LOCK_LOST") {
    const lost = lockLostError(error);
    receipts.failure({ outcome: "FAILED", error: forwardOf(lost), restore: "LOCK_LOST", restoreError: forwardOf(lost) });
    return lost;
  }
  const recovery = await recoverFailedApply(context, error);
  const afterRecovery = await interruptionOf(context);
  if (afterRecovery === "SIGNAL") {
    if (!recovery.verifiedRestore) return finishInterrupted(context, { forward: recovery.receipt.error });
    await guard.stopped;
    receipts.failure({ outcome: "FAILED", ...recovery.receipt });
    exit(SIGNAL_EXIT_CODES[guard.signal]);
    return Object.assign(recovery.error, { settledSignal: true });
  }
  if (afterRecovery === "LOCK_LOST") {
    const lost = lockLostError(error);
    receipts.failure({ outcome: "FAILED", ...recovery.receipt, error: forwardOf(lost) });
    return lost;
  }
  receipts.failure({ outcome: "FAILED", ...recovery.receipt });
  return recovery.error;
}

/** 되돌릴 직전 release가 없으면 그 이유의 라벨, 있으면 null. */
function nothingToRestore(previousCommit, commit) {
  if (previousCommit === null) return "NO_MANAGED_PREVIOUS";
  return previousCommit === commit ? "SAME_COMMIT" : null;
}

function interruptRestoreLabel({ previousCommit, commit, held }) {
  return nothingToRestore(previousCommit, commit) ?? (held ? "LINK_RESTORED" : "LOCK_LOST");
}

/**
 * 중단의 마무리. 진행 중인 명령이 끝나기를(제한 시간까지) 기다린 뒤 current를 마지막으로 검증된 직전 release로 되돌리고, 중단 signal과 무관한
 * 제한된 연결 확인으로 떨어진 관리 컨테이너를 다시 붙이고, INTERRUPTED를 남긴다. 컨테이너 상태는 알 수 없으므로 같은 DEPLOY를 다시 실행하라고 알린다.
 * forward는 복원 도중 중단이면 정방향 실패, 적용 도중 중단이면 null이다(그때는 중단 자체가 error다).
 */
async function finishInterrupted({ lock, root, commit, prepared, recoveryDocker, receipts, guard }, { forward }) {
  const allStopped = await guard.stopped;
  const held = await lockHeld(lock);
  const { previousCommit } = prepared;
  const restore = interruptRestoreLabel({ previousCommit, commit, held });
  if (restore === "LINK_RESTORED") atomicSymlink(root, "current", join("releases", previousCommit));
  const reattach = await reattachDetached(recoveryDocker, prepared.managedBefore);
  const detail = `${guard.signal} received while ${forward === null ? "applying" : "restoring"}; ${stoppedNote(allStopped)}; container state is unknown; rerun the same DEPLOY to converge (runbook: ${RUNBOOK_PATH})`;
  const interrupted = { code: "E_OBS_DEPLOY_INTERRUPTED", detail };
  receipts.failure({
    outcome: "INTERRUPTED", error: forward ?? interrupted, restore, restoreError: forward === null ? null : interrupted, networkAttachment: { reattach, recheck: null },
  });
  return new InterruptedDeploy(guard.signal, detail);
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

/** 재생성된 컨테이너가 계약 네트워크에 붙어 있고 기존 컨테이너와 같은 네트워크·extra_hosts를 쓰는지(scrape 경로가 같은지) 확인한다. */
function assertRuntimeWiring(before, hostAfter) {
  const { networks } = hostAfter.network;
  if (!networks.includes(COMPOSE_NETWORK.name)) fail("E_OBS_DEPLOY_VERIFY", `${PROMETHEUS.container} is not attached to the network ${COMPOSE_NETWORK.name} (attached: ${networks.join(",") || "none"})`);
  if (JSON.stringify(networks) !== JSON.stringify(before.network.networks)) fail("E_OBS_DEPLOY_VERIFY", `network changed (${before.network.networks.join(",")} -> ${networks.join(",")})`);
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

const NOTHING_TO_RESTORE = Object.freeze({
  NO_MANAGED_PREVIOUS: `no managed previous release to restore (first rollout): follow firstRolloutRollback in ${RUNBOOK_PATH}`,
  SAME_COMMIT: "current already was this commit, nothing to restore",
});

/**
 * 직전 release로 되돌리고 적용과 같은 기준으로 대조한다: release compose 확인, reference·라이브 대조, 마운트 내용, 그리고 배포 전 상태 대비
 * 범위·volume·prometheus 네트워크 배선. 결과는 restore 라벨과, 복원이 실패하거나 건너뛰었으면 그 원인(restoreError)이다. 정방향 실패 원인은 호출자가 남긴다.
 */
async function restorePrevious(context) {
  const { lock, root, commit, prepared } = context;
  const { previousCommit } = prepared;
  const nothing = nothingToRestore(previousCommit, commit);
  if (nothing !== null) return { restore: nothing, restoreError: null, externalSeries: null, note: NOTHING_TO_RESTORE[nothing] };
  try {
    if (!(await lockHeld(lock))) throw lockLostError();
    atomicSymlink(root, "current", join("releases", previousCommit));
    return await convergePrevious(context);
  } catch (restoreError) {
    const lost = !(await lockHeld(lock));
    const fallbackCode = restoreError instanceof DeployError ? restoreError.code : "E_OBS_DEPLOY_RESTORE";
    const code = lost ? "E_OBS_DEPLOY_LOCK_LOST" : fallbackCode;
    return { restore: "FAILED", restoreError: { code, detail: `restore verification failed for previous release ${previousCommit}: ${message(restoreError)} (runbook: ${RUNBOOK_PATH})` }, externalSeries: null, note: null };
  }
}

/**
 * current가 직전 release를 가리킨 뒤 컨테이너를 맞추고 대조한다. 맞추기 전에 관리 unit 밖의 호스트(다른 컨테이너·volume)가 이미 바뀌었으면
 * 복원으로 되돌릴 수 없으므로 컨테이너를 건드리지 않고 SKIPPED_SCOPE_CHANGED로 남긴다(current는 직전 release를 가리킨 채다).
 */
async function convergePrevious({ docker, scratchDocker, cleanupDocker, sleep, now, root, composeEnvFile, preview, prepared }) {
  const { previousCommit, before } = prepared;
  const previousDir = join(root, "releases", previousCommit);
  const previousTree = describeTree(previousDir);
  const { units } = previousTree;
  const scopedUnits = unitsOf(preview.tree.units, units);
  const scope = await readScope(docker);
  try {
    assertScopeAndVolume(before, scope, scopedUnits);
  } catch (scopeError) {
    return { restore: "SKIPPED_SCOPE_CHANGED", restoreError: { code: scopeError.code, detail: `restore of previous release ${previousCommit} was skipped, current points at it but its containers were not converged, because the host outside the managed units already changed: ${message(scopeError)} (runbook: ${RUNBOOK_PATH})` }, externalSeries: null, note: null };
  }
  const { image, command } = await readReleaseCompose(docker, join(root, "current"), composeEnvFile, units);
  const expected = await collectReference({ docker: scratchDocker, cleanup: cleanupDocker, image, command, stagedPrometheus: join(previousDir, "prometheus"), commit: previousCommit, sleep, waitFor });
  await convergeContainers({ docker, sleep, root, composeEnvFile, files: previousTree.files, units, idsBefore: containerIds(scope.projectContainers, units) });
  const convergedAt = epochSeconds(now());
  const series = liveSeriesOf(units);
  // 복원이 요구하는 것은 복원한 probe가 수렴 뒤 scrape되었다는 증거(값은 무관)뿐이다. 만료 시계열과 성공 값은 호스트 443에 달려 있어 기록만 한다.
  const scrapeProof = series.filter((spec) => spec.scrapeProof).map((spec) => ({ ...spec, expectedValue: null }));
  const settled = await pollLive({ docker, sleep, expected, flagKeys: expectedFlagKeys(command), freshness: { series: scrapeProof, notBefore: convergedAt } });
  if (!settled.done) fail("E_OBS_DEPLOY_VERIFY", [...settled.configProblems, ...settled.staleSeries.map((problem) => `the restored probe is not being scraped (${problem})`)].join("; "));
  const hostAfter = await readHostState(docker);
  assertScopeAndVolume(before, hostAfter, scopedUnits);
  assertRuntimeWiring(before, hostAfter);
  const externalSeries = await recordExternalSeries({ docker, series, knownReadings: settled.readings, notBefore: convergedAt });
  const unconfirmed = externalSeries?.ok === false ? `; the restored probe series are not confirmed: ${externalSeries.detail}` : "";
  return { restore: "RESTORED", restoreError: null, externalSeries, note: `restored previous release ${previousCommit}${unconfirmed}` };
}

/**
 * 적용이 실패한 뒤: 배포 전에 있던 관리 컨테이너가 기본 네트워크에 붙어 떠 있는지 먼저 보고 떨어졌으면 다시 붙인다. 복원의 compose up은 떨어진
 * 컨테이너를 다시 시작만 하고 붙이지 않으므로(2026-10-30 사고) 붙이지 않은 채 복원하면 복원 대조가 모든 target down을 보고 실패한다.
 * 그다음 직전 release로 복원하고, 복원이 다시 떼어 냈을 수 있으므로 연결을 한 번 더 확인한다. 판정은 그 마지막 확인으로 한다.
 * receipt는 정방향 원인(error)과 복원 원인(restoreError)·두 번의 연결 확인을 따로 남기고, 던질 오류는 그 모두를 이름으로 적는다.
 */
async function recoverFailedApply(context, error) {
  const { docker, prepared } = context;
  const forward = forwardOf(error);
  const reattach = await reattachDetached(docker, prepared.managedBefore);
  const restored = await restorePrevious(context);
  const networkAttachment = { reattach, recheck: await reattachDetached(docker, prepared.managedBefore) };
  const attachment = attachmentVerdict(networkAttachment);
  const notes = [restored.note ?? restored.restoreError.detail, ...attachment.notes];
  const failed = restored.restoreError !== null || attachment.failed;
  const detail = failed ? `forward failure ${forward.code}: ${forward.detail}; ${notes.join("; ")}` : `${forward.detail}; ${notes.join("; ")}`;
  return {
    error: new DeployError(failed ? "E_OBS_DEPLOY_RESTORE" : forward.code, detail),
    verifiedRestore: !failed && restored.restore === "RESTORED",
    receipt: { error: forward, restore: restored.restore, restoreError: restored.restoreError, networkAttachment, externalSeries: restored.externalSeries },
  };
}

function receiptDirectory(deployRoot, commit, runId) {
  const directory = join(deployRoot, "release-receipts", `observability-config-${commit.slice(0, 12)}-${runId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/** 이 실행의 receipt 디렉터리에 성공 receipt.json과 실패 failure-receipt.json을 쓴다. 실패 receipt의 필드 집합은 outcome과 무관하게 같다. */
function receiptsFor({ deployRoot, runId, runUrl, commit, now, facts }) {
  const write = (name, receipt) => writeFileSync(join(receiptDirectory(deployRoot, commit, runId), name), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return {
    success: (receipt) => write("receipt.json", receipt),
    failure: ({ outcome, error, restore, restoreError = null, networkAttachment = null, externalSeries = null }) => write("failure-receipt.json", {
      schemaVersion: FAILURE_RECEIPT_SCHEMA_VERSION,
      mode: "DEPLOY",
      outcome,
      commit,
      previousCommit: facts.previousCommit,
      runUrl,
      recordedAt: now().toISOString(),
      error,
      restore,
      restoreError,
      networkAttachment,
      externalSeries,
      composeNetwork: facts.composeNetwork,
      baselineAttachment: facts.baselineAttachment,
      configDigest: facts.configDigest,
      staleReferenceCleanup: facts.staleReferenceCleanup,
    }),
  };
}

/* ------------------------------------------------------------------ CLI */

// 경로·커밋·run 정보는 인자가 아니라 환경 변수로 받는다(workflow가 env로 넘긴다). 인자는 `--mode PREVIEW|DEPLOY|DRIFT` 하나뿐이다.
async function main(argv, env) {
  if (argv.length !== 2 || argv[0] !== "--mode") fail("E_OBS_DEPLOY_USAGE", "expected exactly --mode PREVIEW|DEPLOY|DRIFT");
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

function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(new URL(metaUrl));
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
}
