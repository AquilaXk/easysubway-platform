import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const RUN_URL = "https://github.com/AquilaXk/easysubway-platform/actions/runs/123";

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
  yaml: `global:\n  scrape_interval: 15s\n  evaluation_interval: 15s\n# ${revision}\nscrape_configs:\n${jobs.map((job) => `- job_name: ${job}\n  scrape_interval: ${jobScrapeInterval}\n`).join("")}`,
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
  if (path === "/api/v1/targets?state=active") return JSON.stringify({ status: "success", data: { activeTargets: data.targets.map((target) => ({ ...target, scrapeUrl: "http://x" })), droppedTargets: [] } });
  if (path === "/metrics") return `# HELP prometheus_config_last_reload_successful x\n# TYPE prometheus_config_last_reload_successful gauge\nprometheus_config_last_reload_successful ${data.reloadSuccessful}\nprometheus_tsdb_lowest_timestamp ${data.lowestTimestamp}\n`;
  if (path === "/-/ready") return "Prometheus Server is Ready.\n";
  throw new Error(`unexpected prometheus path ${path}`);
}

// docker·git 호출을 흉내 내는 호스트. calls에 순서대로 남기고, 시나리오 값으로 실패와 상태 전이를 만든다.
export function createHost({
  existingContainerId = "1".repeat(64), recreateOnUp = true, restartFixesLive = true, promtoolFails = null,
  liveAfter = null, liveBefore = snapshot({ revision: "old" }), expected = snapshot(), health = "healthy",
  headCommit = COMMIT, projectContainers = null, volumeAfter = null, upFails = false, composeCommand = COMMAND, containerMissing = false,
  mounts = [{ Type: "volume", Name: "easysubway_prometheus-data", Destination: "/prometheus" }], changeOthersOnUp = null, liveWarmupReads = 0, networksAfterUp = null, extraHostsAfterUp = null, mountedBefore = "stale", liveAfterRestore = null, probeExistingId = "a".repeat(64), probeMountedBefore = "current", composeDefines = ["prometheus", PROBE_SERVICE],
  seriesWarmupReads = 0, missingSeries = [], staleSeriesReads = 0, staleSampleAt = EPOCH0 - 20, probeSuccessValue = "1",
} = {}) {
  const calls = [];
  const state = { containerId: existingContainerId, live: liveBefore, generation: 0, warmup: 0, queries: [], reads: {}, clock: EPOCH0, mounted: mountedBefore, probe: { id: probeExistingId, mounted: probeMountedBefore }, dirs: {}, upCount: 0, networks: ["easysubway_default"], extraHosts: ["host.docker.internal:host-gateway"] };
  const volume = { Name: "easysubway_prometheus-data", Mountpoint: "/var/lib/easysubway-data/docker/volumes/easysubway_prometheus-data/_data", CreatedAt: "2026-06-30T18:05:00Z", Labels: { "com.docker.compose.project": "easysubway", "com.docker.compose.volume": "prometheus-data" } };
  const others = projectContainers ?? [
    { name: "easysubway-postgres", id: "2".repeat(64), image: "sha256:postgres", startedAt: "2026-06-30T00:00:00Z" },
    { name: "easysubway-alertmanager", id: "3".repeat(64), image: "sha256:alertmanager", startedAt: "2026-06-30T00:00:01Z" },
    { name: "easysubway-grafana", id: "4".repeat(64), image: "sha256:grafana", startedAt: "2026-06-30T00:00:02Z" },
  ];
  // timestamp(selector)는 표본 시각을, selector는 값을 돌려준다. 시각 질의가 selector마다 검증 회차당 한 번 오므로 그 횟수를 회차로 센다.
  // 적용 중(upCount <= 1)에는 사라진 시계열(missingSeries)과 수렴 전 표본(staleSeriesReads회차)을 흉내 낸다. 복원한 직전 release의 probe는 정상이다.
  const seriesSamples = (query) => {
    const timestamped = /^timestamp\((.+)\)$/u.exec(query);
    const selector = timestamped ? timestamped[1] : query;
    if (timestamped) state.reads[selector] = (state.reads[selector] ?? 0) + 1;
    const round = state.reads[selector];
    const applying = state.upCount <= 1;
    if (round <= seriesWarmupReads || (applying && missingSeries.includes(selector))) return [];
    const sampleTime = applying && round <= staleSeriesReads ? staleSampleAt : state.clock + 1;
    const value = selector === PROBE_SUCCESS_SERIES ? probeSuccessValue : "1728360";
    return [{ metric: {}, value: [0, timestamped ? String(sampleTime) : value] }];
  };
  let reference = null;
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    const line = `${command} ${args.join(" ")}`;
    if (command === "git") return { stdout: `${headCommit}\n`, stderr: "" };
    assert.equal(command, "docker", line);
    const [verb] = args;
    if (verb === "pull") return { stdout: "", stderr: "" };
    if (verb === "compose") {
      if (args.includes("config")) return { stdout: JSON.stringify({ services: Object.fromEntries(composeDefines.map((name) => [name, name === "prometheus" ? { image: IMAGE, command: composeCommand } : { image: PROBE_IMAGE, command: PROBE_COMMAND }])) }), stderr: "" };
      if (args.includes("up")) {
        if (upFails) throw new Error("compose up failed");
        state.upCount += 1;
        state.clock += CLOCK_STEP;
        if (changeOthersOnUp && state.upCount === 1) changeOthersOnUp(others);
        if (recreateOnUp) {
          state.generation += 1;
          state.containerId = String(8 + state.generation).repeat(64);
          state.mounted = realpathSync(state.dirs.current);
          state.live = state.upCount >= 2 ? (liveAfterRestore ?? expected) : (liveAfter ?? expected);
          if (networksAfterUp && state.upCount === 1) state.networks = networksAfterUp;
          if (extraHostsAfterUp && state.upCount === 1) state.extraHosts = extraHostsAfterUp;
        }
        if (args.includes(PROBE_SERVICE)) {
          if (state.probe.id === null || recreateOnUp) state.probe.id = (9 + state.generation).toString(16).repeat(64);
          if (recreateOnUp) state.probe.mounted = realpathSync(state.dirs.current);
        }
        return { stdout: "", stderr: "" };
      }
      assert.fail(`unexpected compose subcommand ${line}`);
    }
    if (verb === "run") {
      if (args.includes("promtool")) {
        const kind = args.includes("check") ? "check" : "test";
        if (promtoolFails === kind) throw new Error(`promtool ${kind} failed: rule evaluation error`);
        return { stdout: "SUCCESS", stderr: "" };
      }
      reference = args[args.indexOf("--name") + 1];
      return { stdout: "refid\n", stderr: "" };
    }
    if (verb === "rm") {
      assert.deepEqual(args.slice(0, 3), ["rm", "-f", "-v"], line);
      assert.equal(args[3], reference, `삭제는 reference 컨테이너만: ${line}`);
      return { stdout: "", stderr: "" };
    }
    if (verb === "exec") {
      const [, target, tool, , url] = args;
      if (tool === "sha256sum") {
        assert.ok([PROBE_CONTAINER, "easysubway-prometheus"].includes(target), target);
        const mounted = target === PROBE_CONTAINER ? state.probe.mounted : state.mounted;
        const mountedDir = mounted === "stale" ? null : realpathSync(mounted === "current" ? state.dirs.current : mounted === "commit" ? state.dirs.commit : mounted);
        const sourceOf = (path) => (target === PROBE_CONTAINER ? "blackbox/origin-certificate.yml" : `prometheus/${path.split("/").at(-1)}`);
        const digestOf = (path) => (mountedDir === null ? "0".repeat(64) : sha256(readFileSync(join(mountedDir, sourceOf(path)))));
        return { stdout: args.slice(3).map((path) => `${digestOf(path)}  ${path}`).join("\n") + "\n", stderr: "" };
      }
      assert.equal(tool, "wget");
      const path = url.replace("http://127.0.0.1:9090", "");
      if (target === reference) return { stdout: httpBody(path, { ...expected, targets: expected.targets.map((item) => ({ ...item, health: "down" })) }), stderr: "" };
      assert.equal(target, "easysubway-prometheus");
      if (path.startsWith("/api/v1/query?query=")) {
        const query = decodeURIComponent(path.slice("/api/v1/query?query=".length));
        state.queries.push(query);
        return { stdout: JSON.stringify({ status: "success", data: { resultType: "vector", result: seriesSamples(query) } }), stderr: "" };
      }
      if ((path.startsWith("/api/v1/targets") || path === "/api/v1/rules") && state.generation > 0 && state.warmup < liveWarmupReads) {
        if (path === "/api/v1/rules") state.warmup += 1;
        return { stdout: httpBody(path, { ...state.live, targets: state.live.targets.map((item) => ({ ...item, health: "unknown" })), ruleHealth: "unknown" }), stderr: "" };
      }
      return { stdout: httpBody(path, state.live), stderr: "" };
    }
    if (verb === "restart" && args[1] === PROBE_CONTAINER) {
      state.clock += CLOCK_STEP;
      state.probe.mounted = realpathSync(state.dirs.current);
      return { stdout: "", stderr: "" };
    }
    if (verb === "restart") {
      assert.equal(args[1], "easysubway-prometheus");
      state.clock += CLOCK_STEP;
      if (state.upCount >= 2) state.live = liveAfterRestore ?? expected;
      else if (restartFixesLive) state.live = liveAfter ?? expected;
      state.mounted = realpathSync(state.dirs.current);
      return { stdout: "", stderr: "" };
    }
    if (verb === "inspect") {
      const targets = args.slice(args.indexOf("container") + 1);
      const prometheus = {
        Id: state.containerId, Name: "/easysubway-prometheus", Image: "sha256:prometheus", Config: { Image: IMAGE },
        State: { Running: true, StartedAt: "2026-10-08T00:00:00Z", Health: { Status: health } },
        Mounts: mounts,
        HostConfig: { ExtraHosts: state.extraHosts },
        NetworkSettings: { Networks: Object.fromEntries(state.networks.map((name) => [name, {}])) },
      };
      const probe = { Id: state.probe.id, Name: `/${PROBE_CONTAINER}`, Image: "sha256:blackbox", Config: { Image: PROBE_IMAGE }, State: { Running: true, StartedAt: "2026-10-08T00:00:01Z" } };
      if (targets.length === 1 && targets[0] === "easysubway-prometheus") {
        if (containerMissing) throw new Error("host command failed (1): No such container: easysubway-prometheus");
        return { stdout: JSON.stringify([prometheus]), stderr: "" };
      }
      if (targets.length === 1 && targets[0] === PROBE_CONTAINER) {
        return { stdout: JSON.stringify([probe]), stderr: "" };
      }
      const all = [prometheus, ...(state.probe.id === null ? [] : [probe]), ...others.map((other) => ({ Id: other.id, Name: `/${other.name}`, Image: other.image, Config: { Image: other.image }, State: { Running: true, StartedAt: other.startedAt } }))];
      return { stdout: JSON.stringify(targets.map((target) => all.find((item) => item.Id === target || item.Id.startsWith(target)))), stderr: "" };
    }
    if (verb === "ps") {
      if (args.includes("-q")) return { stdout: [state.containerId, ...(state.probe.id === null ? [] : [state.probe.id]), ...others.map((other) => other.id)].join("\n"), stderr: "" };
      const rows = [["easysubway-prometheus", state.containerId.slice(0, 12)], ...(state.probe.id === null ? [] : [[PROBE_CONTAINER, state.probe.id.slice(0, 12)]]), ...others.map((other) => [other.name, other.id.slice(0, 12)])];
      return { stdout: rows.map((row) => row.join("\t")).join("\n"), stderr: "" };
    }
    if (verb === "volume") {
      assert.deepEqual(args.slice(0, 2), ["volume", "inspect"]);
      return { stdout: JSON.stringify([volumeAfter && calls.some((call) => call.args.includes("up")) ? volumeAfter : volume]), stderr: "" };
    }
    assert.fail(`unexpected docker command: ${line}`);
    return null;
  };
  return { calls, runner, state, volume, others };
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
  commandRunner: host.runner, sleep: async () => {}, now: () => new Date("2026-10-08T01:02:03.000Z"), ...overrides,
});
export const verbs = (host) => host.calls.map(({ command, args }) => (command === "git" ? "git" : args[0] === "compose" ? `compose:${args.includes("up") ? "up" : "config"}` : args[0] === "run" ? (args.includes("promtool") ? `promtool:${args.includes("check") ? "check" : "test"}` : "run:reference") : args[0] === "volume" ? "volume" : args[0]));

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

// 재시작 여부는 symlink 이력이 아니라 컨테이너가 실제로 마운트한 파일 내용으로 정한다(F1).
export function seedCurrentRelease(box, commit = COMMIT) {
  const release = join(box.observability, "releases", commit);
  mkdirSync(join(box.observability, "releases"), { recursive: true });
  cpSync(join(box.sourceRoot, "infra"), release, { recursive: true });
  symlinkSync(join("releases", commit), join(box.observability, "current"));
}
