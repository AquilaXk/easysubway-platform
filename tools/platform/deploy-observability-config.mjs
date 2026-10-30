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
// 호스트에서 한 번에 한 DEPLOY만 돈다는 전제(workflow concurrency group)에 기댄다. 수동 절차는 contracts/release/platform-observability-config-deploy-runbook.json.
//
// 순서: 입력 검증 → release 스테이징 → promtool check config·test rules(실패하면 여기서 종료, 아무것도 바꾸지 않음) →
// 같은 이미지의 격리 reference Prometheus로 기대 상태 수집 → release 설치 → current 전환 → release가 담은 MANAGED_UNITS 서비스만 compose up
// → 마운트 내용 확인·필요하면 재시작 → 라이브 상태(설정·규칙·target·probe 시계열·네트워크·다른 컨테이너·volume)를 기대와 대조 → receipt.
// 적용 뒤 대조가 실패하면 직전 release로 되돌리고 같은 기준으로 다시 대조한 뒤 실패로 끝난다(실패 receipt를 남김).
// 컨테이너를 맞추는 서비스는 MANAGED_UNITS(prometheus와 원 서버 인증서 만료 probe, platform#270)뿐이다. origin-certificate-probe의 내용은
// 이 도구만 맞춘다. backend 배포(tools/deploy/deploy-backend.sh)는 그 컨테이너가 없을 때 만들기만 한다.
// Alertmanager·Grafana·Loki·Alloy는 release에 담기지만 이 도구는 컨테이너를 건드리지 않는다(이슈 #227 범위 밖).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const MODES = Object.freeze(["PREVIEW", "DEPLOY"]);
const RECEIPT_SCHEMA_VERSION = "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_RECEIPT_V2";
const COMPOSE_PROJECT = "easysubway";
const COMPOSE_PROFILE = "observability";
const SERVICE = "prometheus";
const RUNBOOK_PATH = "contracts/release/platform-observability-config-deploy-runbook.json";
const CONTAINER = "easysubway-prometheus";
const DATA_VOLUME = "easysubway_prometheus-data";
const DATA_MOUNT = "/prometheus";
// release에 담기지만 이 도구가 컨테이너를 건드리지 않는 설정 디렉터리(이슈 #227 범위 밖).
const MATERIALIZED_ONLY_DIRS = Object.freeze(["alertmanager", "alloy", "grafana", "loki"]);
// 이 도구가 compose로 맞추고 마운트 내용과 라이브 상태까지 대조하는 서비스. configDirs는 그 서비스의 설정 원천 디렉터리,
// mounts는 컨테이너 안 경로와 release 안 원천 파일의 짝이다. optional unit은 그 디렉터리가 없는 트리(그 unit 이전의 main 커밋)에서
// 빠진다. 그래서 옛 커밋으로 되돌리는 DEPLOY·PREVIEW·자동 복원이 모두 같은 규칙으로 prometheus만 맞추고 probe는 건드리지 않는다.
// liveSeries는 검증 때 라이브 Prometheus에서 표본이 하나 이상 나와야 하는 PromQL이다. blackbox는 probe가 실패해도 /probe에
// 200으로 답해 target이 up이므로, probe가 실제로 원 서버 인증서를 읽었는지는 이 시계열로만 가린다(platform#270).
const MANAGED_UNITS = Object.freeze([
  Object.freeze({
    service: SERVICE,
    container: CONTAINER,
    configDirs: Object.freeze(["prometheus"]),
    optional: false,
    healthy: true,
    mounts: Object.freeze([
      ["/etc/prometheus/prometheus.yml", "prometheus/prometheus.yml"],
      ["/etc/prometheus/alerts.yml", "prometheus/alerts.yml"],
    ]),
    liveSeries: Object.freeze([]),
  }),
  Object.freeze({
    service: "origin-certificate-probe",
    container: "easysubway-origin-certificate-probe",
    configDirs: Object.freeze(["blackbox"]),
    optional: true,
    healthy: false,
    mounts: Object.freeze([["/etc/blackbox_exporter/origin-certificate.yml", "blackbox/origin-certificate.yml"]]),
    liveSeries: Object.freeze(['probe_ssl_earliest_cert_expiry{job="origin_certificate_probe"}', 'probe_success{job="origin_certificate_probe"} == 1']),
  }),
]);
const CONFIG_DIRS = Object.freeze([...MATERIALIZED_ONLY_DIRS, ...MANAGED_UNITS.flatMap((unit) => unit.configDirs)].toSorted(codepointCompare));
const OPTIONAL_DIRS = Object.freeze(MANAGED_UNITS.filter((unit) => unit.optional).flatMap((unit) => unit.configDirs));
const RULE_TEST_SUFFIX = ".test.yml";
// 이슈 #220이 레포에서 제거한 대상. 라이브에 남아 있으면 상시 경보를 내므로 reference 대조와 별개로 이름을 명시해 막는다.
const REMOVED_JOBS = Object.freeze(["back_worker"]);
// compose 해석용 값이다. compose는 프로젝트 전체를 해석하므로 backend 서비스의 필수 변수가 필요하지만(CI의 compose config 검증과 같은 방식),
// 이 도구는 prometheus 서비스 이름만 지정하고 --no-deps로 실행해 backend 컨테이너를 만들거나 바꾸지 않는다.
const COMPOSE_PARSE_ENV = Object.freeze({
  EASYSUBWAY_BACKEND_ENV_FILE: "/dev/null",
  EASYSUBWAY_BACKEND_IMAGE: "ghcr.io/aquilaxk/easysubway-backend@sha256:0000000000000000000000000000000000000000000000000000000000000000",
});
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/+-]+$/u;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const SIGNAL_EXIT_CODES = Object.freeze({ SIGTERM: 143, SIGINT: 130 });
const WAIT_ATTEMPTS = 60;
// 라이브 검증은 3초 간격으로 다시 읽고, 설정의 가장 긴 scrape·평가 주기(origin_certificate_probe의 scrape_interval 1m)의 두 배를 기다린다.
// 재시작 직후 첫 scrape가 실패해도 다음 scrape에서 통과할 수 있게 하려는 것이다. 주기가 짧은 설정도 최소 VERIFY_MIN_ATTEMPTS번은 읽는다.
const VERIFY_INTERVAL_MS = 3000;
const VERIFY_MIN_ATTEMPTS = 20;
const DURATION_UNIT_MS = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 });
const NO_SUCH_CONTAINER = /no such (?:container|object)/iu;

class DeployError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => { throw new DeployError(code, detail); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const defaultSleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const message = (error) => String(error?.detail ?? error?.message ?? error).slice(0, 600);

export class HostCommandError extends Error {
  constructor(detail, stderr = "") {
    super(detail);
    this.stderr = stderr;
  }
}

// 자식에는 PATH와 HOME(docker CLI 설정)만 넘긴다. 이 프로세스 환경의 secret은 상속되지 않는다.
export function runCommand(command, args, { env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { PATH: SAFE_PATH, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => reject(new HostCommandError("host command output exceeded the limit")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorText });
      else reject(new HostCommandError(`host command failed (${code}): ${errorText.slice(0, 1000)}`, errorText));
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new HostCommandError("host command timed out")));
    }, timeoutMs);
  });
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
 * pid가 살아 있으면 다른 실행이 쓰는 중으로 보고 건드리지 않는다. 같은 호스트에서 한 번에 한 DEPLOY만 돈다는 전제(workflow concurrency group
 * observability-config-production, cancel-in-progress false)에 기대며, pid 재사용으로 못 지우는 경우는 남겨 두는 쪽(무해)으로 실패한다.
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
      const defined = JSON.parse(stdout)?.services ?? {};
      const service = defined[SERVICE];
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

const promUrl = (path) => `http://127.0.0.1:9090${path}`;

async function promGet(docker, target, path) {
  const { stdout } = await docker.docker(["exec", target, "wget", "-qO-", promUrl(path)]);
  return stdout;
}

const rulesProjection = (groups) => groups.map((group) => ({
  name: group.name,
  file: group.file,
  interval: group.interval ?? null,
  rules: (group.rules ?? []).map((rule) => ({
    name: rule.name, type: rule.type, query: rule.query, duration: rule.duration ?? null, keepFiringFor: rule.keepFiringFor ?? null, labels: rule.labels ?? {}, annotations: rule.annotations ?? {},
  })),
}));

const JOB_PREFIX = "- job_name: ";
const jobsOf = (yaml) => yaml.split("\n")
  .filter((line) => line.startsWith(JOB_PREFIX))
  .map((line) => line.slice(JOB_PREFIX.length).trim().replace(/^["']|["']$/gu, ""))
  .toSorted(codepointCompare);

async function promData(docker, target, path) {
  const parsed = JSON.parse(await promGet(docker, target, path));
  if (parsed.status !== "success") throw new Error(`prometheus ${path} did not succeed`);
  return parsed.data;
}

async function readSnapshot(docker, target) {
  const data = (path) => promData(docker, target, path);
  const ready = await promGet(docker, target, "/-/ready");
  if (!ready.includes("Ready")) throw new Error("prometheus is not ready");
  const [build, flags, config, rules] = [
    await data("/api/v1/status/buildinfo"), await data("/api/v1/status/flags"), await data("/api/v1/status/config"), await data("/api/v1/rules"),
  ];
  const targets = (await data("/api/v1/targets?state=active")).activeTargets.map((target) => ({ job: target.scrapePool, health: target.health })).sort((a, b) => codepointCompare(a.job, b.job) || codepointCompare(a.health, b.health));
  const allRules = rules.groups.flatMap((group) => (group.rules ?? []).map((rule) => ({ name: rule.name, health: rule.health })));
  // Prometheus가 자기 자신을 scrape하지 않으므로(prometheus.yml에 self job 없음) PromQL이 아니라 /metrics 본문에서 읽는다.
  const metrics = await promGet(docker, target, "/metrics");
  const projected = rulesProjection(rules.groups);
  return {
    version: build.version,
    flags,
    yaml: config.yaml,
    statusConfigSha256: sha256(config.yaml),
    rulesSha256: sha256(JSON.stringify(projected)),
    jobs: jobsOf(config.yaml),
    targets,
    ruleHealth: { total: allRules.length, ok: allRules.filter((rule) => rule.health === "ok").length },
    unhealthyRules: allRules.filter((rule) => rule.health !== "ok").map((rule) => `${rule.name}=${rule.health}`),
    reloadSuccessful: metricToken(metrics, "prometheus_config_last_reload_successful"),
    lowestTimestamp: metricToken(metrics, "prometheus_tsdb_lowest_timestamp"),
  };
}

const metricToken = (text, name) => text.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? null;

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

/** promtool test rules에 넘길 규칙 시험 파일. release의 prometheus 디렉터리에 있는 *.test.yml 전부다(커밋마다 있는 파일이 다르다). */
const ruleTestsOf = (files) => Object.keys(files)
  .filter((file) => file.startsWith("prometheus/") && file.endsWith(RULE_TEST_SUFFIX))
  .map((file) => `/etc/${file}`);

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
    [container] = await docker.json(["inspect", "--type", "container", CONTAINER]);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    return fail("E_OBS_DEPLOY_STATE", `${CONTAINER} cannot be inspected: ${message(error)}`);
  }
  if (!container?.State?.Running) fail("E_OBS_DEPLOY_STATE", `${CONTAINER} is not running`);
  const mount = (container.Mounts ?? []).find((item) => item.Destination === DATA_MOUNT);
  if (mount?.Type !== "volume" || mount.Name !== DATA_VOLUME) fail("E_OBS_DEPLOY_VOLUME", `${CONTAINER} does not mount ${DATA_VOLUME} at ${DATA_MOUNT}`);
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

/** 아직 없는 optional unit의 컨테이너(그 unit의 처음 배포)는 null이다. 시간 초과 같은 다른 inspect 실패와 필수 unit의 부재는 그대로 던진다. */
async function containerIdOf(docker, { container, optional }) {
  try {
    return (await docker.json(["inspect", "--type", "container", container]))[0].Id;
  } catch (error) {
    if (optional && error instanceof HostCommandError && NO_SUCH_CONTAINER.test(error.stderr)) return null;
    throw error;
  }
}

const containerIdsOf = async (docker, units) => Object.fromEntries(await Promise.all(units.map(async (unit) => [unit.service, await containerIdOf(docker, unit)])));

/**
 * compose up 뒤 컨테이너가 release의 설정 파일을 실제로 읽고 있는지 확인하고, 아니면(재생성되지 않아 옛 inode를 잡고 있는 경우) 재시작한다.
 * 재시작 판단은 current symlink의 과거 값이 아니라 컨테이너 내용이므로 중단 후 같은 커밋 재시도도 수렴한다.
 * 한 번의 compose up이 units의 서비스를 모두 올리고, 확인·재시작은 컨테이너마다 한다. 결과는 서비스 이름별이다.
 */
async function convergeContainers({ docker, sleep, root, composeEnvFile, files, units, idsBefore }) {
  await docker.composeUp(join(root, "current"), composeEnvFile, units.map((unit) => unit.service));
  const converged = {};
  for (const unit of units) {
    const idAfter = await containerIdOf(docker, unit);
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
    const idBefore = idsBefore[unit.service];
    let action = idAfter === idBefore ? "unchanged" : "recreated";
    if (restarted) action = "restarted";
    converged[unit.service] = { container: unit.container, idBefore, idAfter, action };
  }
  return converged;
}

const durationMs = (text) => [...text.matchAll(/(\d+)(ms|[smhdwy])/gu)].reduce((sum, [, value, unit]) => sum + Number(value) * DURATION_UNIT_MS[unit], 0);

/** 라이브 검증 반복 횟수. 기대 설정(/api/v1/status/config는 job마다 주기를 채워 준다)의 가장 긴 scrape·평가 주기 두 배를 덮는다. */
function verifyAttempts(statusConfigYaml) {
  const intervals = [...statusConfigYaml.matchAll(/^\s*(?:scrape|evaluation)_interval: (\S+)$/gmu)].map(([, value]) => durationMs(value));
  return Math.max(VERIFY_MIN_ATTEMPTS, Math.ceil((2 * Math.max(0, ...intervals)) / VERIFY_INTERVAL_MS) + 1);
}

async function seriesProblems(docker, queries) {
  const problems = [];
  for (const query of queries) {
    const { result } = await promData(docker, CONTAINER, `/api/v1/query?query=${encodeURIComponent(query)}`);
    if (result.length === 0) problems.push(`query ${query} returned no sample`);
  }
  return problems;
}

async function verifyLive({ docker, sleep, expected, flagKeys, units }) {
  const queries = units.flatMap((unit) => unit.liveSeries);
  const result = await poll(sleep, verifyAttempts(expected.yaml), VERIFY_INTERVAL_MS, async () => {
    try {
      const live = await readSnapshot(docker, CONTAINER);
      const problems = [...compareSnapshots(expected, live, flagKeys), ...await seriesProblems(docker, queries)];
      return { done: problems.length === 0, live, problems };
    } catch (error) {
      return { done: false, live: null, problems: [`live prometheus was not readable: ${message(error)}`] };
    }
  });
  if (!result.done) fail("E_OBS_DEPLOY_VERIFY", result.problems.join("; "));
  return { live: result.live, hostAfter: await readHostState(docker) };
}

function compareSnapshots(expected, live, flagKeys) {
  const problems = [];
  if (live.version !== expected.version) problems.push(`version ${live.version} != ${expected.version}`);
  for (const key of flagKeys) if (live.flags[key] !== expected.flags[key]) problems.push(`flag ${key}: ${JSON.stringify(live.flags[key])} != ${JSON.stringify(expected.flags[key])}`);
  if (live.statusConfigSha256 !== expected.statusConfigSha256) problems.push("/api/v1/status/config differs from the deployed commit");
  if (live.rulesSha256 !== expected.rulesSha256) problems.push("/api/v1/rules differs from the deployed commit");
  if (JSON.stringify(live.jobs) !== JSON.stringify(expected.jobs)) problems.push(`jobs [${live.jobs.join(",")}] != [${expected.jobs.join(",")}]`);
  for (const job of REMOVED_JOBS) if (live.jobs.includes(job)) problems.push(`removed job ${job} is still configured`);
  problems.push(...runtimeProblems(expected, live));
  return problems;
}

// reference는 네트워크가 없어 scrape할 수 없으므로 target·규칙 health는 라이브만 본다. 첫 scrape·첫 평가는 검증 반복이 기다린다.
function runtimeProblems(expected, live) {
  const problems = expected.jobs.map((job) => targetProblem(job, live.targets.filter((target) => target.job === job))).filter(Boolean);
  if (live.unhealthyRules.length > 0) problems.push(`rule health is not ok: ${live.unhealthyRules.join(",")}`);
  if (live.reloadSuccessful !== "1") problems.push("prometheus_config_last_reload_successful is not 1");
  return problems;
}

function targetProblem(job, own) {
  if (own.length === 0) return `job ${job} has no active target`;
  if (own.some((target) => target.health !== "up")) return `job ${job} target is not up (${own.map((target) => target.health).join(",")})`;
  return null;
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
  const { commandRunner = runCommand, sleep = defaultSleep, now = () => new Date(), stagingRoot, isProcessAlive = processIsAlive, signalSource = process, exit = (code) => process.exit(code) } = options;
  if (typeof commandRunner !== "function") fail("E_OBS_DEPLOY_USAGE", "commandRunner must be a function");
  const docker = createDocker(commandRunner);

  const head = (await commandRunner("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {})).stdout.trim();
  if (head !== commit) fail("E_OBS_DEPLOY_SOURCE", `source checkout is at ${head}, expected ${commit}`);

  const deploying = mode === "DEPLOY";
  const root = deploying ? join(deployRoot, "observability") : null;
  if (deploying) {
    mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
    reapStaleArtifacts(root, isProcessAlive);
  }
  const ownedStagingBase = !deploying && stagingRoot === undefined ? mkdtempSync(join(tmpdir(), "obs-deploy-")) : null;
  const stagingBase = deploying ? join(root, "releases") : (stagingRoot ?? ownedStagingBase);
  mkdirSync(stagingBase, { recursive: true });
  const stagingDir = join(stagingBase, `.staging-${commit.slice(0, 12)}-${process.pid}`);

  let preview;
  try {
    preview = await preflight({ docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep });
  } catch (error) {
    rmSync(ownedStagingBase ?? stagingDir, { recursive: true, force: true });
    throw error;
  }
  const result = {
    mode,
    commit,
    image: preview.image,
    appliedServices: preview.tree.units.map((unit) => unit.service),
    materializedOnly: [...MATERIALIZED_ONLY_DIRS],
    validation: preview.validation,
    files: preview.tree.files,
    directoryDigests: preview.tree.directoryDigests,
    configDigest: preview.tree.configDigest,
  };
  if (!deploying) {
    rmSync(ownedStagingBase ?? stagingDir, { recursive: true, force: true });
    return {
      schemaVersion: "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_PREVIEW_V1",
      mode,
      commit: result.commit,
      image: result.image,
      appliedServices: result.appliedServices,
      materializedOnly: result.materializedOnly,
      validation: result.validation,
      files: result.files,
      directoryDigests: result.directoryDigests,
      configDigest: result.configDigest,
      expected: {
        version: preview.expected.version,
        flags: Object.fromEntries(preview.flagKeys.map((key) => [key, preview.expected.flags[key]])),
        statusConfigSha256: preview.expected.statusConfigSha256,
        rulesSha256: preview.expected.rulesSha256,
        jobs: preview.expected.jobs,
      },
      hostMutationCount: 0,
    };
  }
  return applyRelease({ docker, sleep, now, root, deployRoot, composeEnvFile, runUrl, runId, commit, stagingDir, preview, result, signalSource, exit });
}

async function preflight({ docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep }) {
  const tree = stageRelease(sourceRoot, stagingDir);
  const { image, command } = await docker.composeConfig(stagingDir, composeEnvFile, tree.units.map((unit) => unit.service));
  const stagedPrometheus = join(stagingDir, "prometheus");
  const validation = await validateWithPromtool({ docker, image, stagedPrometheus, ruleTests: ruleTestsOf(tree.files) });
  const expected = await collectReference({ docker, image, command, stagedPrometheus, commit, sleep });
  if (REMOVED_JOBS.some((job) => expected.jobs.includes(job))) fail("E_OBS_DEPLOY_VALIDATE", `the commit still configures a removed job: ${REMOVED_JOBS.join(",")}`);
  return { tree, image, command, flagKeys: expectedFlagKeys(command), validation, expected };
}

/**
 * 적용 도중 SIGTERM·SIGINT(workflow 취소·타임아웃)를 받으면, current를 마지막으로 검증된 직전 release로 되돌리고(가능할 때)
 * 중단 receipt를 동기적으로 남긴 뒤 종료한다. 컨테이너 상태는 알 수 없으므로 같은 DEPLOY를 다시 실행해 수렴시키라고 알린다.
 */
function interruptRestoreLabel(canRestore, previousCommit) {
  if (canRestore) return "LINK_RESTORED";
  return previousCommit === null ? "NO_MANAGED_PREVIOUS" : "SAME_COMMIT";
}

function installInterruptGuard({ signalSource, exit, onInterrupt }) {
  const state = { handled: false };
  const listeners = Object.keys(SIGNAL_EXIT_CODES).map((signal) => [signal, () => {
    if (state.handled) return;
    state.handled = true;
    try {
      onInterrupt(signal);
    } finally {
      exit(SIGNAL_EXIT_CODES[signal]);
    }
  }]);
  for (const [signal, listener] of listeners) signalSource.on(signal, listener);
  return { state, dispose: () => { for (const [signal, listener] of listeners) signalSource.removeListener(signal, listener); } };
}

async function applyRelease({ docker, sleep, now, root, deployRoot, composeEnvFile, runUrl, runId, commit, stagingDir, preview, result, signalSource, exit }) {
  const releaseDir = join(root, "releases", commit);
  let installedNow = false;
  let switched = false;
  let guard = null;
  try {
    const previousCommit = readManagedLink(root, "current");
    const before = await readHostState(docker);
    const { units } = preview.tree;
    const idsBefore = await containerIdsOf(docker, units);
    let lowestBefore = null;
    try {
      lowestBefore = (await readSnapshot(docker, CONTAINER)).lowestTimestamp;
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

    guard = installInterruptGuard({
      signalSource,
      exit,
      onInterrupt: (signal) => {
        const canRestore = previousCommit !== null && previousCommit !== commit;
        if (canRestore) atomicSymlink(root, "current", join("releases", previousCommit));
        writeFailureReceipt({
          deployRoot, runId, runUrl, commit, previousCommit, now, outcome: "INTERRUPTED", configDigest: result.configDigest,
          error: new DeployError("E_OBS_DEPLOY_INTERRUPTED", `${signal} received while applying; container state is unknown; rerun the same DEPLOY to converge (runbook: ${RUNBOOK_PATH})`),
          restore: interruptRestoreLabel(canRestore, previousCommit),
        });
      },
    });
    if (previousCommit !== null && previousCommit !== commit) atomicSymlink(root, "previous", join("releases", previousCommit));
    atomicSymlink(root, "current", join("releases", commit));
    switched = true;

    let converged;
    let verified;
    try {
      converged = await convergeContainers({ docker, sleep, root, composeEnvFile, files: preview.tree.files, units, idsBefore });
      verified = await verifyLive({ docker, sleep, expected: preview.expected, flagKeys: preview.flagKeys, units });
      assertScopeAndVolume(before, verified.hostAfter, units);
      assertRuntimeWiring(before, verified.hostAfter);
    } catch (error) {
      if (guard.state.handled) throw error;
      const outcome = await restorePrevious({ docker, sleep, root, composeEnvFile, previousCommit, commit, error });
      writeFailureReceipt({ deployRoot, runId, runUrl, commit, previousCommit, now, outcome: "FAILED", error: outcome.error, restore: outcome.restore, configDigest: result.configDigest });
      throw outcome.error;
    }

    const verification = finishVerification({ before, verified, lowestBefore, preview, units });
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

function finishVerification({ before, verified, lowestBefore, preview, units }) {
  const afterOthers = Object.keys(othersOf(verified.hostAfter.projectContainers, units));
  return {
    version: verified.live.version,
    flags: Object.fromEntries(preview.flagKeys.map((key) => [key, verified.live.flags[key]])),
    statusConfigSha256: verified.live.statusConfigSha256,
    expectedStatusConfigSha256: preview.expected.statusConfigSha256,
    rulesSha256: verified.live.rulesSha256,
    expectedRulesSha256: preview.expected.rulesSha256,
    jobs: verified.live.jobs,
    absentJobs: [...REMOVED_JOBS],
    liveSeries: units.flatMap((unit) => unit.liveSeries),
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

async function restorePrevious({ docker, sleep, root, composeEnvFile, previousCommit, commit, error }) {
  const cause = message(error);
  const code = error instanceof DeployError ? error.code : "E_OBS_DEPLOY_VERIFY";
  if (previousCommit === null) {
    return { error: new DeployError(code, `${cause}; no managed previous release to restore (first rollout): follow firstRolloutRollback in ${RUNBOOK_PATH}`), restore: "NO_MANAGED_PREVIOUS" };
  }
  if (previousCommit === commit) {
    return { error: new DeployError(code, `${cause}; current already was this commit, nothing to restore`), restore: "SAME_COMMIT" };
  }
  try {
    atomicSymlink(root, "current", join("releases", previousCommit));
    const previousDir = join(root, "releases", previousCommit);
    const previousTree = describeTree(previousDir);
    const { units } = previousTree;
    const { image, command } = await docker.composeConfig(join(root, "current"), composeEnvFile, units.map((unit) => unit.service));
    // 복원도 처음 배포와 같은 기준으로 확인한다: 직전 release의 reference와 라이브를 대조하고 마운트 내용을 맞춘다.
    const expected = await collectReference({ docker, image, command, stagedPrometheus: join(previousDir, "prometheus"), commit: previousCommit, sleep });
    const idsBefore = await containerIdsOf(docker, units);
    await convergeContainers({ docker, sleep, root, composeEnvFile, files: previousTree.files, units, idsBefore });
    await verifyLive({ docker, sleep, expected, flagKeys: expectedFlagKeys(command), units });
  } catch (restoreError) {
    return { error: new DeployError("E_OBS_DEPLOY_RESTORE", `${cause}; restore verification failed for previous release ${previousCommit}: ${message(restoreError)} (runbook: ${RUNBOOK_PATH})`), restore: "FAILED" };
  }
  return { error: new DeployError(code, `${cause}; restored previous release ${previousCommit}`), restore: "RESTORED" };
}

function receiptDirectory(deployRoot, commit, runId) {
  const directory = join(deployRoot, "release-receipts", `observability-config-${commit.slice(0, 12)}-${runId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function writeFailureReceipt({ deployRoot, runId, runUrl, commit, previousCommit, now, outcome, error, restore, configDigest }) {
  const receipt = {
    schemaVersion: "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_FAILURE_RECEIPT_V1",
    mode: "DEPLOY",
    outcome,
    commit,
    previousCommit,
    runUrl,
    recordedAt: now().toISOString(),
    error: { code: error.code ?? "E_OBS_DEPLOY_FAILED", detail: message(error) },
    restore,
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
