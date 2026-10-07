#!/usr/bin/env node
// AquilaXk/easysubway-platform#227: 운영 Prometheus 설정을 platform 레포 커밋에서 배포하는 영구 경로.
//
// 운영 호스트의 Prometheus는 compose 프로젝트 `easysubway`의 `prometheus` 서비스다. 설정 파일은 파일 단위 bind mount라서
// 마운트 원천이 가리키는 파일이 곧 운영 설정이다. 이 도구는 마운트 원천을 관리 디렉터리로 옮기고 이후 갱신을 맡는다.
//
//   <deployRoot>/observability/releases/<commit>/   읽기 전용 release(infra의 5개 설정 디렉터리 + compose 파일, 레포 구조 그대로)
//   <deployRoot>/observability/current  -> releases/<commit>   마지막으로 적용·검증한 release (compose project directory)
//   <deployRoot>/observability/previous -> releases/<commit>   직전 release (자동 복원 대상)
//
// 마운트 원천 경로는 `current/...` 문자열 그대로 컨테이너에 저장된다. Docker는 컨테이너를 (재)시작할 때 symlink를 다시 해석하므로
// current를 바꾸고 컨테이너를 재시작하면 새 파일을 읽는다. 컨테이너가 이미 떠 있는 동안에는 symlink 전환이 반영되지 않으므로
// compose 수준 변경(이미지·flag)은 `compose up`이, 설정 파일만 바뀐 경우는 `docker restart`가 반영한다.
//
// 순서: 입력 검증 → release 스테이징 → promtool check config·test rules(실패하면 여기서 종료, 아무것도 바꾸지 않음) →
// 같은 이미지의 격리 reference Prometheus로 기대 상태 수집 → release 설치 → current 전환 → prometheus 서비스 하나만 compose up
// → 필요하면 재시작 → 라이브 상태를 기대와 대조 → receipt. 적용 뒤 대조가 실패하면 직전 release로 되돌리고 실패로 끝난다.
// Alertmanager·Grafana·Loki·Alloy는 release에 담기지만 이 도구는 컨테이너를 건드리지 않는다(이슈 #227 범위 밖).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

const MODES = Object.freeze(["PREVIEW", "DEPLOY"]);
const COMPOSE_PROJECT = "easysubway";
const COMPOSE_PROFILE = "observability";
const SERVICE = "prometheus";
const CONTAINER = "easysubway-prometheus";
const DATA_VOLUME = "easysubway_prometheus-data";
const DATA_MOUNT = "/prometheus";
const CONFIG_DIRS = Object.freeze(["alertmanager", "alloy", "grafana", "loki", "prometheus"]);
const APPLIED_SERVICES = Object.freeze(["prometheus"]);
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
const WAIT_ATTEMPTS = 60;
const VERIFY_ATTEMPTS = 20;

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

class HostCommandError extends Error {}

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
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new HostCommandError(`host command failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
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

/** 트리의 파일 digest(경로 순서)와 디렉터리별·전체 digest. */
function describeTree(root) {
  const files = ["docker-compose.yml", ...CONFIG_DIRS.flatMap((dir) => listFiles(root, dir).map((file) => file))];
  for (const dir of CONFIG_DIRS) if (!existsSync(join(root, dir))) fail("E_OBS_DEPLOY_SOURCE", `missing ${dir}`);
  if (!existsSync(join(root, "docker-compose.yml"))) fail("E_OBS_DEPLOY_SOURCE", "missing docker-compose.yml");
  const fileDigests = digestFiles(root, files);
  const directoryDigests = Object.fromEntries(CONFIG_DIRS.map((dir) => [
    dir,
    manifestDigest(Object.fromEntries(Object.entries(fileDigests).filter(([file]) => file.startsWith(`${dir}/`)).map(([file, digest]) => [file.slice(dir.length + 1), digest]))),
  ]));
  return { files: fileDigests, directoryDigests, configDigest: manifestDigest(fileDigests) };
}

function stageRelease(sourceRoot, stagingDir) {
  const infra = join(sourceRoot, "infra");
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
  const sources = [["docker-compose.yml", join(infra, "docker-compose.yml")]];
  if (!existsSync(join(infra, "docker-compose.yml"))) fail("E_OBS_DEPLOY_SOURCE", "infra/docker-compose.yml is missing");
  for (const dir of CONFIG_DIRS) {
    if (!existsSync(join(infra, dir))) fail("E_OBS_DEPLOY_SOURCE", `infra/${dir} is missing`);
    for (const file of listFiles(infra, dir)) sources.push([file, join(infra, file)]);
  }
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
    composeConfig: async (projectDirectory, envFile) => {
      const { stdout } = await docker([...composeArgs(projectDirectory, envFile), "config", "--format", "json", SERVICE], { env: COMPOSE_PARSE_ENV });
      const service = JSON.parse(stdout)?.services?.[SERVICE];
      if (typeof service?.image !== "string" || !Array.isArray(service?.command)) fail("E_OBS_DEPLOY_SOURCE", "compose does not define the prometheus service image and command");
      return { image: service.image, command: service.command };
    },
    composeUp: (projectDirectory, envFile) => docker(
      [...composeArgs(projectDirectory, envFile), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", SERVICE],
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

const jobsOf = (yaml) => [...yaml.matchAll(/^- job_name: ["']?([^"'\n]+?)["']?\s*$/gmu)].map((match) => match[1]).sort(codepointCompare);

async function readSnapshot(docker, target) {
  const data = async (path) => {
    const parsed = JSON.parse(await promGet(docker, target, path));
    if (parsed.status !== "success") throw new Error(`prometheus ${path} did not succeed`);
    return parsed.data;
  };
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

const metricToken = (text, name) => new RegExp(`^${name} (\\S+)$`, "mu").exec(text)?.[1] ?? null;

async function waitFor(sleep, attempts, check, interval = 2000) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw last ?? new Error("condition was not met in time");
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

async function validateWithPromtool({ docker, image, stagedPrometheus }) {
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
    await run("test", "rules", "/etc/prometheus/alerts.test.yml");
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
  return { containerId: container.Id, volume: { mountpoint: volume.Mountpoint, createdAt: volume.CreatedAt }, projectContainers, network };
}

async function readProjectContainers(docker) {
  const { stdout } = await docker.docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${COMPOSE_PROJECT}`]);
  const ids = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (ids.length === 0) return {};
  const records = await docker.json(["inspect", "--type", "container", ...ids]);
  return Object.fromEntries(records.map((record) => [String(record.Name).replace(/^\//u, ""), { id: record.Id, image: record.Image, startedAt: record.State?.StartedAt ?? null }]));
}

async function waitHealthy(docker, sleep) {
  await waitFor(sleep, WAIT_ATTEMPTS, async () => {
    const [container] = await docker.json(["inspect", "--type", "container", CONTAINER]);
    return container?.State?.Running && container.State.Health?.Status === "healthy";
  });
}

async function verifyLive({ docker, sleep, expected, flagKeys }) {
  let problems = ["live prometheus was not readable"];
  let live;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    try {
      live = await readSnapshot(docker, CONTAINER);
      problems = compareSnapshots(expected, live, flagKeys);
      if (problems.length === 0) break;
    } catch (error) {
      problems = [`live prometheus was not readable: ${message(error)}`];
    }
    await sleep(3000);
  }
  if (problems.length > 0) fail("E_OBS_DEPLOY_VERIFY", problems.join("; "));
  return { live, hostAfter: await readHostState(docker) };
}

function compareSnapshots(expected, live, flagKeys) {
  const problems = [];
  if (live.version !== expected.version) problems.push(`version ${live.version} != ${expected.version}`);
  for (const key of flagKeys) if (live.flags[key] !== expected.flags[key]) problems.push(`flag ${key}: ${JSON.stringify(live.flags[key])} != ${JSON.stringify(expected.flags[key])}`);
  if (live.statusConfigSha256 !== expected.statusConfigSha256) problems.push("/api/v1/status/config differs from the deployed commit");
  if (live.rulesSha256 !== expected.rulesSha256) problems.push("/api/v1/rules differs from the deployed commit");
  if (JSON.stringify(live.jobs) !== JSON.stringify(expected.jobs)) problems.push(`jobs [${live.jobs.join(",")}] != [${expected.jobs.join(",")}]`);
  for (const job of REMOVED_JOBS) if (live.jobs.includes(job)) problems.push(`removed job ${job} is still configured`);
  // reference는 네트워크가 없어 scrape할 수 없으므로 target·규칙 health는 라이브만 본다. 첫 scrape·첫 평가는 검증 반복이 기다린다.
  for (const job of expected.jobs) {
    const own = live.targets.filter((target) => target.job === job);
    if (own.length === 0) problems.push(`job ${job} has no active target`);
    else if (own.some((target) => target.health !== "up")) problems.push(`job ${job} target is not up (${own.map((target) => target.health).join(",")})`);
  }
  if (live.unhealthyRules.length > 0) problems.push(`rule health is not ok: ${live.unhealthyRules.join(",")}`);
  if (live.reloadSuccessful !== "1") problems.push("prometheus_config_last_reload_successful is not 1");
  return problems;
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
    if (typeof runId !== "string" || !/^[0-9]+$/u.test(runId)) fail("E_OBS_DEPLOY_USAGE", "run id must be digits");
    if (typeof runUrl !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/[0-9]+$/u.test(runUrl)) fail("E_OBS_DEPLOY_USAGE", "run url must be a GitHub Actions run URL");
  }
  return { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId };
}

/* ------------------------------------------------------------------ 본체 */

export async function deployObservabilityConfig(options = {}) {
  const { mode, commit, sourceRoot, deployRoot, composeEnvFile, runUrl, runId } = readOptions(options);
  const { commandRunner = runCommand, sleep = defaultSleep, now = () => new Date(), stagingRoot } = options;
  if (typeof commandRunner !== "function") fail("E_OBS_DEPLOY_USAGE", "commandRunner must be a function");
  const docker = createDocker(commandRunner);

  const head = (await commandRunner("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {})).stdout.trim();
  if (head !== commit) fail("E_OBS_DEPLOY_SOURCE", `source checkout is at ${head}, expected ${commit}`);

  const deploying = mode === "DEPLOY";
  const root = deploying ? join(deployRoot, "observability") : null;
  if (deploying) mkdirSync(join(root, "releases"), { recursive: true, mode: 0o755 });
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
    appliedServices: [...APPLIED_SERVICES],
    materializedOnly: CONFIG_DIRS.filter((dir) => !APPLIED_SERVICES.includes(dir)),
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
  return applyRelease({ docker, sleep, now, root, deployRoot, composeEnvFile, runUrl, runId, commit, stagingDir, preview, result });
}

async function preflight({ docker, commit, sourceRoot, stagingDir, composeEnvFile, sleep }) {
  const tree = stageRelease(sourceRoot, stagingDir);
  const { image, command } = await docker.composeConfig(stagingDir, composeEnvFile);
  const stagedPrometheus = join(stagingDir, "prometheus");
  const validation = await validateWithPromtool({ docker, image, stagedPrometheus });
  const expected = await collectReference({ docker, image, command, stagedPrometheus, commit, sleep });
  if (REMOVED_JOBS.some((job) => expected.jobs.includes(job))) fail("E_OBS_DEPLOY_VALIDATE", `the commit still configures a removed job: ${REMOVED_JOBS.join(",")}`);
  return { tree, image, command, flagKeys: expectedFlagKeys(command), validation, expected };
}

async function applyRelease({ docker, sleep, now, root, deployRoot, composeEnvFile, runUrl, runId, commit, stagingDir, preview, result }) {
  const releaseDir = join(root, "releases", commit);
  let installedNow = false;
  let switched = false;
  try {
    const previousCommit = readManagedLink(root, "current");
    const before = await readHostState(docker);
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
    const configChanged = previousCommit === null || describePrometheusDirectory(root, previousCommit) !== preview.tree.directoryDigests.prometheus;

    if (previousCommit !== null && previousCommit !== commit) atomicSymlink(root, "previous", join("releases", previousCommit));
    atomicSymlink(root, "current", join("releases", commit));
    switched = true;

    let action;
    let verified;
    let containerIdAfter;
    try {
      await docker.composeUp(join(root, "current"), composeEnvFile);
      containerIdAfter = (await docker.json(["inspect", "--type", "container", CONTAINER]))[0].Id;
      action = containerIdAfter === before.containerId ? "unchanged" : "recreated";
      if (action === "unchanged" && configChanged) {
        await docker.docker(["restart", CONTAINER]);
        action = "restarted";
      }
      await waitHealthy(docker, sleep);
      verified = await verifyLive({ docker, sleep, expected: preview.expected, flagKeys: preview.flagKeys });
      assertScopeAndVolume(before, verified.hostAfter);
      assertRuntimeWiring(before, verified.hostAfter);
    } catch (error) {
      const outcome = await restorePrevious({ docker, sleep, root, composeEnvFile, previousCommit, commit, error });
      writeFailureReceipt({ deployRoot, runId, runUrl, commit, previousCommit, now, error: outcome.error, restore: outcome.restore, configDigest: result.configDigest });
      throw outcome.error;
    }

    const verification = finishVerification({ before, verified, lowestBefore, preview });
    const receipt = {
      schemaVersion: "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_RECEIPT_V1",
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
      container: { name: CONTAINER, idBefore: before.containerId, idAfter: containerIdAfter, action },
      verification,
    };
    writeFileSync(join(receiptDirectory(deployRoot, commit, runId), "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return receipt;
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    // current가 이 release로 넘어가기 전에 실패했다면 방금 설치한 release는 어디에서도 참조되지 않는다.
    if (installedNow && !switched) rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  }
}

function describePrometheusDirectory(root, commit) {
  try {
    return describeTree(join(root, "releases", commit)).directoryDigests.prometheus;
  } catch {
    return null;
  }
}

/** prometheus 서비스 하나만 바뀌었는지 확인한다: 다른 프로젝트 컨테이너(ID·이미지·시작 시각)와 데이터 volume 정체. */
function assertScopeAndVolume(before, hostAfter) {
  const others = (state) => Object.fromEntries(Object.entries(state.projectContainers).filter(([name]) => name !== CONTAINER));
  const beforeOthers = others(before);
  const afterOthers = others(hostAfter);
  for (const [name, expected] of Object.entries(beforeOthers)) {
    const actual = afterOthers[name];
    if (!actual) fail("E_OBS_DEPLOY_SCOPE", `${name} disappeared during the prometheus-only deploy`);
    for (const field of ["id", "image", "startedAt"]) {
      if (actual[field] !== expected[field]) fail("E_OBS_DEPLOY_SCOPE", `${name} ${field} changed during the prometheus-only deploy (${expected[field]} -> ${actual[field]})`);
    }
  }
  for (const name of Object.keys(afterOthers)) if (!(name in beforeOthers)) fail("E_OBS_DEPLOY_SCOPE", `${name} appeared during the prometheus-only deploy`);
  if (hostAfter.volume.mountpoint !== before.volume.mountpoint || hostAfter.volume.createdAt !== before.volume.createdAt) {
    fail("E_OBS_DEPLOY_VOLUME", `${DATA_VOLUME} identity changed (${before.volume.mountpoint} ${before.volume.createdAt} -> ${hostAfter.volume.mountpoint} ${hostAfter.volume.createdAt})`);
  }
}

/** 재생성된 컨테이너가 기존 컨테이너와 같은 네트워크·extra_hosts를 쓰는지(scrape 경로가 같은지) 확인한다. */
function assertRuntimeWiring(before, hostAfter) {
  if (JSON.stringify(hostAfter.network.networks) !== JSON.stringify(before.network.networks)) fail("E_OBS_DEPLOY_VERIFY", `network changed (${before.network.networks.join(",")} -> ${hostAfter.network.networks.join(",")})`);
  if (JSON.stringify(hostAfter.network.extraHosts) !== JSON.stringify(before.network.extraHosts)) fail("E_OBS_DEPLOY_VERIFY", `extra_hosts changed (${before.network.extraHosts.join(",")} -> ${hostAfter.network.extraHosts.join(",")})`);
}

function finishVerification({ before, verified, lowestBefore, preview }) {
  const afterOthers = Object.keys(verified.hostAfter.projectContainers).filter((name) => name !== CONTAINER);
  return {
    version: verified.live.version,
    flags: Object.fromEntries(preview.flagKeys.map((key) => [key, verified.live.flags[key]])),
    statusConfigSha256: verified.live.statusConfigSha256,
    expectedStatusConfigSha256: preview.expected.statusConfigSha256,
    rulesSha256: verified.live.rulesSha256,
    expectedRulesSha256: preview.expected.rulesSha256,
    jobs: verified.live.jobs,
    absentJobs: [...REMOVED_JOBS],
    targets: verified.live.targets,
    ruleHealth: verified.live.ruleHealth,
    configReloadSuccessful: verified.live.reloadSuccessful,
    untouchedContainers: afterOthers.sort(codepointCompare),
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
    return { error: new DeployError(code, `${cause}; no managed previous release to restore (first rollout): follow the manual rollback runbook`), restore: "NO_MANAGED_PREVIOUS" };
  }
  if (previousCommit === commit) {
    return { error: new DeployError(code, `${cause}; current already was this commit, nothing to restore`), restore: "SAME_COMMIT" };
  }
  try {
    atomicSymlink(root, "current", join("releases", previousCommit));
    const [before] = await docker.json(["inspect", "--type", "container", CONTAINER]);
    await docker.composeUp(join(root, "current"), composeEnvFile);
    const [after] = await docker.json(["inspect", "--type", "container", CONTAINER]);
    if (after.Id === before.Id) await docker.docker(["restart", CONTAINER]);
    await waitHealthy(docker, sleep);
  } catch (restoreError) {
    return { error: new DeployError("E_OBS_DEPLOY_RESTORE", `${cause}; restoring previous release ${previousCommit} also failed: ${message(restoreError)}`), restore: "FAILED" };
  }
  return { error: new DeployError(code, `${cause}; restored previous release ${previousCommit}`), restore: "RESTORED" };
}

function receiptDirectory(deployRoot, commit, runId) {
  const directory = join(deployRoot, "release-receipts", `observability-config-${commit.slice(0, 12)}-${runId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function writeFailureReceipt({ deployRoot, runId, runUrl, commit, previousCommit, now, error, restore, configDigest }) {
  const receipt = {
    schemaVersion: "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_FAILURE_RECEIPT_V1",
    mode: "DEPLOY",
    outcome: "FAILED",
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

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" }, commit: { type: "string" }, "source-root": { type: "string" }, "deploy-root": { type: "string" },
      "compose-env": { type: "string" }, "run-url": { type: "string" }, "run-id": { type: "string" }, "staging-root": { type: "string" },
    },
    strict: true,
  });
  const result = await deployObservabilityConfig({
    mode: values.mode, commit: values.commit, sourceRoot: values["source-root"], deployRoot: values["deploy-root"],
    composeEnvFile: values["compose-env"], runUrl: values["run-url"], runId: values["run-id"], stagingRoot: values["staging-root"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof DeployError ? error.message : `E_OBS_DEPLOY_FAILED: ${message(error)}`}\n`);
    process.exitCode = 1;
  }
}
