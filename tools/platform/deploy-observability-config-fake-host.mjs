import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { COMPOSE_NETWORK } from "./ensure-compose-network.mjs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// deploy-observability-config.test.mjs가 쓰는 가짜 호스트와 시나리오 도구. docker·git 호출을 흉내 내고 상태 전이를 만든다.
export const repoRoot = new URL("../..", import.meta.url).pathname;
export const COMMIT = "a".repeat(40);
export const PREVIOUS = "b".repeat(40);
export const IMAGE = "prom/prometheus:v3.15.0";
export const PROBE_SERVICE = "origin-certificate-probe";
export const PROBE_CONTAINER = "easysubway-origin-certificate-probe";
export const PROBE_IMAGE = "prom/blackbox-exporter:v0.28.0";
export const PROBE_COMMAND = ["--config.file=/etc/blackbox_exporter/origin-certificate.yml"];
export const PROBE_EXPIRY_SERIES = 'probe_ssl_earliest_cert_expiry{job="origin_certificate_probe"}';
export const PROBE_SUCCESS_SERIES = 'probe_success{job="origin_certificate_probe"}';
export const PROBE_SERIES = [PROBE_EXPIRY_SERIES, PROBE_SUCCESS_SERIES];
// 가짜 호스트의 시계(epoch 초). 테스트의 now()가 고정이면 이 값이고, compose up과 restart마다 CLOCK_STEP초 흐른다.
export const EPOCH0 = Date.parse("2026-10-08T01:02:03.000Z") / 1000;
const CLOCK_STEP = 5;
export const COMMAND = [
  "--config.file=/etc/prometheus/prometheus.yml",
  "--storage.tsdb.path=/prometheus",
  "--storage.tsdb.retention.time=30d",
  "--storage.tsdb.retention.size=3GB",
  "--web.enable-lifecycle",
  "--web.external-url=http://localhost:9090",
];
const PROMETHEUS_ORIGIN = "http://127.0.0.1:9090";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const RUN_URL = "https://github.com/AquilaXk/easysubway-platform/actions/runs/123";
// 이름과 서브넷은 실제 코드와 같은 계약 파일 값이다.
export const COMPOSE_NETWORK_NAME = COMPOSE_NETWORK.name;
export const COMPOSE_SUBNET = COMPOSE_NETWORK.subnet;
const HOST_GATEWAY = "host.docker.internal:host-gateway";

export function makeSourceTree(root) {
  const infra = join(root, "infra");
  mkdirSync(infra, { recursive: true });
  for (const name of ["prometheus", "alertmanager", "grafana", "loki", "alloy", "blackbox"]) cpSync(join(repoRoot, "infra", name), join(infra, name), { recursive: true });
  cpSync(join(repoRoot, "infra", "docker-compose.yml"), join(infra, "docker-compose.yml"));
  return root;
}

export function walk(root, base = root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path, base) : [path.slice(base.length + 1)];
  });
}

const scrapeJobYaml = (job, interval) => `- job_name: ${job}\n  scrape_interval: ${interval}\n`;

// 라이브·reference Prometheus가 돌려주는 응답을 만든다. 같은 설정이면 같은 값을 돌려준다.
export const snapshot = ({ jobs = ["easysubway-backend", "backend_app_metrics", "docker_runtime_probe", "origin_certificate_probe", "public_edge_probe"], revision = "new", flags = {}, targets = null, ruleHealth = "ok", jobScrapeInterval = "15s" } = {}) => ({
  version: "3.15.0",
  flags: {
    "config.file": "/etc/prometheus/prometheus.yml",
    "storage.tsdb.path": "/prometheus",
    "storage.tsdb.retention.time": "30d",
    "storage.tsdb.retention.size": "3GiB",
    "web.enable-lifecycle": "true",
    "web.external-url": "http://localhost:9090",
    ...flags,
  },
  yaml: `global:\n  scrape_interval: 15s\n  evaluation_interval: 15s\n# ${revision}\nscrape_configs:\n${jobs.map((job) => scrapeJobYaml(job, jobScrapeInterval)).join("")}`,
  rules: [{ name: "g", file: "/etc/prometheus/alerts.yml", interval: 15, rules: [{ name: `Alert-${revision}`, type: "alerting", query: "up < 1", duration: 60, labels: {}, annotations: {} }] }],
  reloadSuccessful: "1",
  lowestTimestamp: "1759000000000",
  targets: targets ?? jobs.map((job) => ({ scrapePool: job, health: "up" })),
  ruleHealth,
});

function httpBody(path, data) {
  if (path === "/api/v1/status/buildinfo") return JSON.stringify({ status: "success", data: { version: data.version } });
  if (path === "/api/v1/status/flags") return JSON.stringify({ status: "success", data: data.flags });
  if (path === "/api/v1/status/config") return JSON.stringify({ status: "success", data: { yaml: data.yaml } });
  if (path === "/api/v1/rules") {
    return JSON.stringify({ status: "success", data: { groups: data.rules.map((group) => ({ ...group, rules: group.rules.map((rule) => ({ ...rule, health: data.ruleHealth ?? "ok", lastEvaluation: "2026-10-08T00:00:00Z", evaluationTime: 0.001, state: "inactive" })) })) } });
  }
  if (path === "/api/v1/targets?state=active") return JSON.stringify({ status: "success", data: { activeTargets: data.targets.map((target) => ({ ...target, scrapeUrl: `${PROMETHEUS_ORIGIN}/metrics` })), droppedTargets: [] } });
  if (path === "/metrics") return `# HELP prometheus_config_last_reload_successful x\n# TYPE prometheus_config_last_reload_successful gauge\nprometheus_config_last_reload_successful ${data.reloadSuccessful}\nprometheus_tsdb_lowest_timestamp ${data.lowestTimestamp}\n`;
  if (path === "/-/ready") return "Prometheus Server is Ready.\n";
  throw new Error(`unexpected prometheus path ${path}`);
}

const ok = (stdout) => ({ stdout, stderr: "" });
const QUERY_PATH = "/api/v1/query?query=";

function hostContext({
  existingContainerId = "1".repeat(64), recreateOnUp = true, restartFixesLive = true, promtoolFails = null,
  liveAfter = null, liveBefore = snapshot({ revision: "old" }), expected = snapshot(), health = "healthy",
  headCommit = COMMIT, projectContainers = null, volumeAfter = null, upFails = false, composeCommand = COMMAND, containerMissing = false,
  mounts = [{ Type: "volume", Name: "easysubway_prometheus-data", Destination: "/prometheus" }], changeOthersOnUp = null, liveWarmupReads = 0, networksAfterUp = null, extraHostsAfterUp = null, mountedBefore = "stale", liveAfterRestore = null, probeExistingId = "a".repeat(64), probeMountedBefore = "current", composeDefines = ["prometheus", PROBE_SERVICE],
  seriesWarmupReads = 0, missingSeries = [], staleSeriesReads = 0, staleSampleAt = EPOCH0 - 20, probeSuccessValue = "1", restoreSeries = {},
  composeNetwork = { exists: true, subnet: COMPOSE_SUBNET }, detachOnFailedUp = false, connectFails = false, composeNetworkConfig = undefined, changeOnRestoreUp = null,
  forwardUpFails = false, detachedBefore = false, restoreComposeNetworkConfig = undefined, leftoverReferences = [], probeRunning = true, probeDetached = false,
} = {}) {
  const state = {
    containerId: existingContainerId, live: liveBefore, generation: 0, warmup: 0, queries: [], reads: {}, restoreReads: {}, clock: EPOCH0, mounted: mountedBefore,
    probe: { id: probeExistingId, mounted: probeMountedBefore, networks: probeDetached ? [] : [COMPOSE_NETWORK_NAME], running: probeRunning }, dirs: {}, upAttempts: 0, networks: detachedBefore ? [] : [COMPOSE_NETWORK_NAME], extraHosts: [HOST_GATEWAY],
    composeNetwork: { ...composeNetwork }, detachedReads: 0, references: new Set(leftoverReferences),
  };
  const volume = { Name: "easysubway_prometheus-data", Mountpoint: "/var/lib/easysubway-data/docker/volumes/easysubway_prometheus-data/_data", CreatedAt: "2026-06-30T18:05:00Z", Labels: { "com.docker.compose.project": "easysubway", "com.docker.compose.volume": "prometheus-data" } };
  const others = projectContainers ?? [
    { name: "easysubway-postgres", id: "2".repeat(64), image: "sha256:postgres", startedAt: "2026-06-30T00:00:00Z" },
    { name: "easysubway-alertmanager", id: "3".repeat(64), image: "sha256:alertmanager", startedAt: "2026-06-30T00:00:01Z" },
    { name: "easysubway-grafana", id: "4".repeat(64), image: "sha256:grafana", startedAt: "2026-06-30T00:00:02Z" },
  ];
  // 시계열 질의는 `selector[5m]` 범위 질의 하나다. 적용 중(첫 compose up 시도까지)과 복원 중(두 번째 시도부터)의 라이브 시계열 상태를 따로 흉내 낸다.
  // 각 단계는 첫 표본이 늦게 나오는 회차(warmupReads), 사라진 시계열(missing), 수렴 전 표본만 남은 회차(staleReads), probe_success 값,
  // 질의 실패(unreadable)를 가진다. 적용 단계는 위 옵션으로, 복원 단계는 restoreSeries로 정하고 복원한 직전 release의 probe는 기본이 정상이다.
  // 서버에 닿지 않으면(probe_success 0) blackbox는 만료 시계열을 내지 않으므로 그 단계에서 만료 시계열은 비어 있다.
  const applyBehavior = { warmupReads: seriesWarmupReads, missing: missingSeries, staleReads: staleSeriesReads, successValue: probeSuccessValue, unreadable: [] };
  const restoreBehavior = { warmupReads: 0, missing: [], staleReads: 0, successValue: probeSuccessValue, unreadable: [], ...restoreSeries };
  const config = { recreateOnUp, restartFixesLive, promtoolFails, liveAfter, expected, health, headCommit, volumeAfter, upFails, composeCommand, containerMissing, mounts, changeOthersOnUp, liveWarmupReads, networksAfterUp, extraHostsAfterUp, liveAfterRestore, composeDefines, staleSampleAt, applyBehavior, restoreBehavior, detachOnFailedUp, connectFails, composeNetworkConfig, changeOnRestoreUp, forwardUpFails, restoreComposeNetworkConfig };
  return { calls: [], state, volume, others, config, reference: null };
}

function seriesSamples({ state, config }, query) {
  const range = /^(.+)\[5m\]$/u.exec(query);
  assert.ok(range, `시계열 질의는 범위 질의 하나다: ${query}`);
  const selector = range[1];
  const restoring = state.upAttempts >= 2;
  const behavior = restoring ? config.restoreBehavior : config.applyBehavior;
  const reads = restoring ? state.restoreReads : state.reads;
  reads[selector] = (reads[selector] ?? 0) + 1;
  if (behavior.unreadable.includes(selector)) throw new Error("host command failed (1): prometheus query failed");
  const noExpiry = selector === PROBE_EXPIRY_SERIES && behavior.successValue === "0";
  if (reads[selector] <= behavior.warmupReads || behavior.missing.includes(selector) || noExpiry) return [];
  const value = selector === PROBE_SUCCESS_SERIES ? behavior.successValue : "1728360";
  const fresh = reads[selector] > behavior.staleReads;
  const samples = fresh ? [[config.staleSampleAt, value], [state.clock + 1, value]] : [[config.staleSampleAt, value]];
  return [{ metric: {}, values: samples }];
}

const dockerPull = () => ok("");

function dockerCompose(ctx, args, line) {
  if (args.includes("config")) return composeConfig(ctx.config, ctx.state.upAttempts >= 1 ? "restore" : "apply");
  if (args.includes("up")) return composeUp(ctx, args);
  return assert.fail(`unexpected compose subcommand ${line}`);
}

// compose config 출력. 기본 네트워크 정의는 적용 단계와 복원 단계(첫 compose up 시도 뒤)에 따로 정할 수 있다.
function composeConfig({ composeDefines, composeCommand, composeNetworkConfig, restoreComposeNetworkConfig }, phase) {
  const services = Object.fromEntries(composeDefines.map((name) => [name, name === "prometheus" ? { image: IMAGE, command: composeCommand } : { image: PROBE_IMAGE, command: PROBE_COMMAND }]));
  const network = phase === "restore" && restoreComposeNetworkConfig !== undefined ? restoreComposeNetworkConfig : composeNetworkConfig;
  return ok(JSON.stringify({ services, ...(network ? { networks: { default: network } } : {}) }));
}

// 2026-10-30 사고: 실패한 compose up이 네트워크를 다시 만들려다 prometheus를 떼어 낸 채 끝났다. detachOnFailedUp이 그 상태를 흉내 낸다.
// upFails는 모든 시도를, forwardUpFails는 첫 시도(적용)만 실패시킨다. 성공한 up은 떨어진 컨테이너를 재생성할 때만 다시 붙인다.
function composeUp(ctx, args) {
  const { state, config } = ctx;
  state.upAttempts += 1;
  if (config.upFails || (config.forwardUpFails && state.upAttempts === 1)) {
    if (config.detachOnFailedUp) state.networks = [];
    throw new Error("compose up failed: error while removing network: network easysubway_default has active endpoints");
  }
  state.clock += CLOCK_STEP;
  if (config.changeOthersOnUp && state.upAttempts === 1) config.changeOthersOnUp(ctx.others);
  if (config.recreateOnUp) recreatePrometheus(ctx);
  if (args.includes(PROBE_SERVICE)) upProbe(state, config.recreateOnUp);
  if (config.changeOnRestoreUp && state.upAttempts === 2) config.changeOnRestoreUp(ctx);
  return ok("");
}

function recreatePrometheus({ state, config }) {
  state.generation += 1;
  state.containerId = String(8 + state.generation).repeat(64);
  state.mounted = realpathSync(state.dirs.current);
  const liveAfterUp = state.upAttempts >= 2 ? config.liveAfterRestore : config.liveAfter;
  state.live = liveAfterUp ?? config.expected;
  // 적용(첫 up)만 시나리오의 배선을 쓰고, 복원은 직전 release의 compose대로 원래 배선으로 돌아간다.
  const applying = state.upAttempts === 1;
  state.networks = applying && config.networksAfterUp ? config.networksAfterUp : [COMPOSE_NETWORK_NAME];
  state.extraHosts = applying && config.extraHostsAfterUp ? config.extraHostsAfterUp : [HOST_GATEWAY];
}

function upProbe(state, recreated) {
  state.probe.running = true;
  if (state.probe.id === null || recreated) state.probe.id = (9 + state.generation).toString(16).repeat(64);
  if (recreated) state.probe.mounted = realpathSync(state.dirs.current);
}

function dockerRun(ctx, args) {
  if (args.includes("promtool")) {
    const kind = args.includes("check") ? "check" : "test";
    if (ctx.config.promtoolFails === kind) throw new Error(`promtool ${kind} failed: rule evaluation error`);
    return ok("SUCCESS");
  }
  ctx.reference = args[args.indexOf("--name") + 1];
  ctx.state.references.add(ctx.reference);
  return ok("refid\n");
}

// 삭제는 reference 컨테이너(이번 실행의 것과 지난 실행이 남긴 것)만 허용한다. 남아 있는 reference는 state.references로 본다.
function dockerRm(ctx, args, line) {
  assert.deepEqual(args.slice(0, 3), ["rm", "-f", "-v"], line);
  for (const name of args.slice(3)) {
    assert.ok(ctx.state.references.has(name), `삭제는 reference 컨테이너만: ${line}`);
    ctx.state.references.delete(name);
  }
  return ok("");
}

function mountedPath(dirs, mounted) {
  if (mounted === "current") return dirs.current;
  if (mounted === "commit") return dirs.commit;
  return mounted;
}

function mountedDigests({ state }, target, paths) {
  assert.ok([PROBE_CONTAINER, "easysubway-prometheus"].includes(target), target);
  const mounted = target === PROBE_CONTAINER ? state.probe.mounted : state.mounted;
  const mountedDir = mounted === "stale" ? null : realpathSync(mountedPath(state.dirs, mounted));
  const sourceOf = (path) => (target === PROBE_CONTAINER ? "blackbox/origin-certificate.yml" : `prometheus/${path.split("/").at(-1)}`);
  const digestOf = (path) => (mountedDir === null ? "0".repeat(64) : sha256(readFileSync(join(mountedDir, sourceOf(path)))));
  return ok(paths.map((path) => `${digestOf(path)}  ${path}`).join("\n") + "\n");
}

function dockerExec(ctx, args) {
  const [, target, tool, , url] = args;
  if (tool === "sha256sum") return mountedDigests(ctx, target, args.slice(3));
  assert.equal(tool, "wget");
  const path = url.replace(PROMETHEUS_ORIGIN, "");
  const { expected } = ctx.config;
  if (target === ctx.reference) return ok(httpBody(path, { ...expected, targets: expected.targets.map((item) => ({ ...item, health: "down" })) }));
  assert.equal(target, "easysubway-prometheus");
  return ok(liveBody(ctx, path));
}

// 기본 네트워크에서 떨어진 prometheus는 scrape 대상에 닿지 못한다(사고 때 4개 대상 모두 down). 떨어진 채 읽힌 횟수를 detachedReads에 남긴다.
function liveBody(ctx, path) {
  const { state } = ctx;
  if (!state.networks.includes(COMPOSE_NETWORK_NAME) && path.startsWith("/api/v1/targets")) {
    state.detachedReads += 1;
    return httpBody(path, { ...state.live, targets: state.live.targets.map((item) => ({ ...item, health: "down" })) });
  }
  if (path.startsWith(QUERY_PATH)) {
    const query = decodeURIComponent(path.slice(QUERY_PATH.length));
    state.queries.push(query);
    return JSON.stringify({ status: "success", data: { resultType: "matrix", result: seriesSamples(ctx, query) } });
  }
  if (isWarmingUp(ctx, path)) {
    if (path === "/api/v1/rules") state.warmup += 1;
    return httpBody(path, { ...state.live, targets: state.live.targets.map((item) => ({ ...item, health: "unknown" })), ruleHealth: "unknown" });
  }
  return httpBody(path, state.live);
}

const isWarmingUp = ({ state, config }, path) => (path.startsWith("/api/v1/targets") || path === "/api/v1/rules") && state.generation > 0 && state.warmup < config.liveWarmupReads;

function dockerRestart({ state, config }, args) {
  state.clock += CLOCK_STEP;
  if (args[1] === PROBE_CONTAINER) {
    state.probe.mounted = realpathSync(state.dirs.current);
    return ok("");
  }
  assert.equal(args[1], "easysubway-prometheus");
  if (state.upAttempts >= 2) state.live = config.liveAfterRestore ?? config.expected;
  else if (config.restartFixesLive) state.live = config.liveAfter ?? config.expected;
  state.mounted = realpathSync(state.dirs.current);
  return ok("");
}

function prometheusRecord({ state, config }) {
  return {
    Id: state.containerId, Name: "/easysubway-prometheus", Image: "sha256:prometheus", Config: { Image: IMAGE, Labels: { "com.docker.compose.service": "prometheus" } },
    State: { Running: true, StartedAt: "2026-10-08T00:00:00Z", Health: { Status: config.health } },
    Mounts: config.mounts,
    HostConfig: { ExtraHosts: state.extraHosts },
    NetworkSettings: { Networks: Object.fromEntries(state.networks.map((name) => [name, {}])) },
  };
}

const probeRecord = ({ state }) => ({ Id: state.probe.id, Name: `/${PROBE_CONTAINER}`, Image: "sha256:blackbox", Config: { Image: PROBE_IMAGE, Labels: { "com.docker.compose.service": PROBE_SERVICE } }, State: { Running: state.probe.running, StartedAt: "2026-10-08T00:00:01Z" }, NetworkSettings: { Networks: Object.fromEntries(state.probe.networks.map((name) => [name, {}])) } });

const otherRecord = (other) => ({ Id: other.id, Name: `/${other.name}`, Image: other.image, Config: { Image: other.image }, State: { Running: true, StartedAt: other.startedAt } });

function dockerInspect(ctx, args) {
  const targets = args.slice(args.indexOf("container") + 1);
  const prometheus = prometheusRecord(ctx);
  const probe = probeRecord(ctx);
  if (targets.length === 1 && targets[0] === "easysubway-prometheus") {
    if (ctx.config.containerMissing) throw new Error("host command failed (1): No such container: easysubway-prometheus");
    return ok(JSON.stringify([prometheus]));
  }
  if (targets.length === 1 && targets[0] === PROBE_CONTAINER) return ok(JSON.stringify([probe]));
  const all = [prometheus, ...(ctx.state.probe.id === null ? [] : [probe]), ...ctx.others.map(otherRecord)];
  return ok(JSON.stringify(targets.map((target) => all.find((item) => item.Id === target || item.Id.startsWith(target)))));
}

function dockerPs({ state, others }, args) {
  if (args.some((arg) => arg.startsWith("name="))) {
    assert.deepEqual(args, ["ps", "-a", "--filter", "name=^easysubway-observability-ref-", "--format", "{{.Names}}"], "이름으로 찾는 것은 reference 컨테이너뿐이다");
    return ok([...state.references].map((name) => `${name}\n`).join(""));
  }
  const probeShown = state.probe.id !== null;
  if (args.includes("-q")) return ok([state.containerId, ...(probeShown ? [state.probe.id] : []), ...others.map((other) => other.id)].join("\n"));
  const rows = [["easysubway-prometheus", state.containerId.slice(0, 12)], ...(probeShown ? [[PROBE_CONTAINER, state.probe.id.slice(0, 12)]] : []), ...others.map((other) => [other.name, other.id.slice(0, 12)])];
  return ok(rows.map((row) => row.join("\t")).join("\n"));
}

function dockerVolume({ calls, config, volume }, args) {
  assert.deepEqual(args.slice(0, 2), ["volume", "inspect"]);
  const changed = config.volumeAfter && calls.some((call) => call.args.includes("up"));
  return ok(JSON.stringify([changed ? config.volumeAfter : volume]));
}

function dockerNetwork({ state, config }, args, line) {
  const network = state.composeNetwork;
  const named = args.at(-1) === COMPOSE_NETWORK_NAME;
  if (args[1] === "ls") return ok(network.exists ? `${COMPOSE_NETWORK_NAME}\n` : "");
  if (args[1] === "inspect" && named && network.exists) return ok(JSON.stringify([{ Name: COMPOSE_NETWORK_NAME, IPAM: { Config: [{ Subnet: network.subnet }] } }]));
  if (args[1] === "create" && named && !network.exists) {
    Object.assign(network, { exists: true, subnet: args[args.indexOf("--subnet") + 1], labels: args.filter((_, index) => args[index - 1] === "--label") });
    return ok("netid\n");
  }
  if (args[1] === "connect") {
    if (config.connectFails) throw new Error("host command failed (1): Error response from daemon: endpoint create failed");
    const target = args.at(-1) === PROBE_CONTAINER ? state.probe.networks : state.networks;
    target.push(args.at(-2));
    state.connected = [...(state.connected ?? []), args.slice(2)];
    return ok("");
  }
  return assert.fail(`unexpected docker network command: ${line}`);
}

const DOCKER_VERBS = new Map([["pull", dockerPull], ["compose", dockerCompose], ["run", dockerRun], ["rm", dockerRm], ["exec", dockerExec], ["restart", dockerRestart], ["inspect", dockerInspect], ["ps", dockerPs], ["volume", dockerVolume], ["network", dockerNetwork]]);

// docker·git 호출을 흉내 내는 호스트. calls에 순서대로 남기고, 시나리오 값으로 실패와 상태 전이를 만든다.
export function createHost(options) {
  const ctx = hostContext(options);
  const runner = async (command, args, callOptions = {}) => {
    // lib/process.mjs의 runCommand처럼 이미 중단된 signal로 부른 명령은 시작하지 않는다.
    if (callOptions.signal?.aborted) throw new Error("host command interrupted before it started");
    ctx.calls.push({ command, args, env: callOptions.env });
    const line = `${command} ${args.join(" ")}`;
    if (command === "git") return ok(`${ctx.config.headCommit}\n`);
    assert.equal(command, "docker", line);
    const handler = DOCKER_VERBS.get(args[0]);
    if (!handler) assert.fail(`unexpected docker command: ${line}`);
    return handler(ctx, args, line);
  };
  // deploy.lock 대역. 잡은 경로와 해제 횟수를 남기고, 잡는 순간까지의 호출 수로 잠금이 어떤 호스트 호출보다 먼저인지 보게 한다.
  // lose()는 holder가 죽은 상태를 만든다: 그 뒤 verify()는 거부하고 closed가 끝난다.
  const lock = { paths: [], callsAtAcquire: [], closed: 0, lose: () => {} };
  const acquireDeployLock = async (lockPath) => {
    lock.paths.push(lockPath);
    lock.callsAtAcquire.push(ctx.calls.length);
    let held = true;
    let markClosed;
    const closed = new Promise((resolve) => { markClosed = resolve; });
    lock.lose = () => {
      held = false;
      markClosed();
    };
    return {
      verify: async () => { if (!held) throw new Error("shared deploy lock was lost"); },
      close: async () => {
        lock.closed += 1;
        markClosed();
      },
      closed,
    };
  };
  return { calls: ctx.calls, runner, state: ctx.state, volume: ctx.volume, others: ctx.others, lock, acquireDeployLock };
}

export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "obs-deploy-test-"));
  const sourceRoot = makeSourceTree(join(root, "source"));
  const deployRoot = join(root, "deploy");
  mkdirSync(join(deployRoot, "release-receipts"), { recursive: true });
  return { root, sourceRoot, deployRoot, observability: join(deployRoot, "observability"), stagingRoot: join(root, "staging"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const base = (box, host, overrides = {}) => ({
  ...(Object.assign(host.state.dirs, { current: join(box.observability, "current"), commit: join(box.observability, "releases", COMMIT) }), {}),
  commit: COMMIT, sourceRoot: box.sourceRoot, deployRoot: box.deployRoot, stagingRoot: box.stagingRoot,
  composeEnvFile: "/opt/easysubway/shared/current-env/compose.env", runUrl: RUN_URL, runId: "123",
  commandRunner: host.runner, acquireDeployLock: host.acquireDeployLock, sleep: async () => {}, now: () => new Date("2026-10-08T01:02:03.000Z"), ...overrides,
});
function runVerb(args) {
  if (!args.includes("promtool")) return "run:reference";
  return args.includes("check") ? "promtool:check" : "promtool:test";
}

function verbOf({ command, args }) {
  if (command === "git") return "git";
  if (args[0] === "compose") return `compose:${args.includes("up") ? "up" : "config"}`;
  if (args[0] === "run") return runVerb(args);
  if (args[0] === "network") return `network:${args[1]}`;
  if (args[0] === "ps" && args.some((arg) => arg.startsWith("name="))) return "ps:reference";
  return args[0];
}

export const verbs = (host) => host.calls.map(verbOf);

export const receiptPath = (box, name = "receipt.json") => join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`, name);
export const failureReceipt = (box) => JSON.parse(readFileSync(receiptPath(box, "failure-receipt.json"), "utf8"));

// 이미 배포된 직전 release 하나를 만들고 current가 그것을 가리키게 한다.
export function seedPreviousRelease(box, { commit = PREVIEW_COMMIT_FOR_SEED } = {}) {
  const release = join(box.observability, "releases", commit);
  mkdirSync(join(box.observability, "releases"), { recursive: true });
  cpSync(join(box.sourceRoot, "infra"), release, { recursive: true });
  writeFileSync(join(release, "prometheus", "alerts.yml"), `${readFileSync(join(release, "prometheus", "alerts.yml"), "utf8")}\n# previous\n`);
  symlinkSync(join("releases", commit), join(box.observability, "current"));
  return release;
}
export const PREVIEW_COMMIT_FOR_SEED = PREVIOUS;

// now()를 가짜 호스트의 시계로 돌린다. 수렴 시각이 compose up·restart마다 흐르는 시계 위에서 정해지는 시험에 쓴다.
export const clockOf = (host) => () => new Date(host.state.clock * 1000);

// 재시작 여부는 symlink 이력이 아니라 컨테이너가 실제로 마운트한 파일 내용으로 정한다(F1).
export function seedCurrentRelease(box, commit = COMMIT) {
  const release = join(box.observability, "releases", commit);
  mkdirSync(join(box.observability, "releases"), { recursive: true });
  cpSync(join(box.sourceRoot, "infra"), release, { recursive: true });
  symlinkSync(join("releases", commit), join(box.observability, "current"));
}

export const referenceName = (commit, pid = process.pid) => `easysubway-observability-ref-${commit.slice(0, 12)}-${pid}`;

/**
 * predicate에 맞는 첫 호출을 붙잡는 runner. 그 호출이 시작되면 onPause()를 부르고, 중단 signal을 받을 때까지 끝나지 않는다(실제 명령처럼 signal을
 * 따른다). 중단이 오지 않으면 PAUSE_LIMIT_MS 뒤 거부해 시험이 멈추지 않는다. 나머지 호출은 가짜 호스트로 보낸다. paused는 붙잡힌 호출의 인자다.
 */
const PAUSE_LIMIT_MS = 10_000;

export function pauseOn(host, predicate, onPause) {
  const paused = [];
  const runner = (command, args, options = {}) => {
    if (paused.length > 0 || !predicate(command, args)) return host.runner(command, args, options);
    host.calls.push({ command, args, env: options.env });
    paused.push(args);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("paused host command was never interrupted")), PAUSE_LIMIT_MS);
      const interrupted = () => {
        clearTimeout(timer);
        reject(new Error("host command interrupted"));
      };
      if (options.signal?.aborted) interrupted();
      options.signal?.addEventListener("abort", interrupted, { once: true });
      setImmediate(onPause);
    });
  };
  return { runner, paused };
}
