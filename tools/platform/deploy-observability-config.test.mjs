import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deployObservabilityConfig } from "./deploy-observability-config.mjs";

// AquilaXk/easysubway-platform#227: 운영 Prometheus 설정을 platform 레포 커밋에서 배포하는 영구 경로의 계약.
// PREVIEW는 호스트를 읽지도 쓰지도 않고 검증·기대값만 만든다. DEPLOY는 promtool 검증을 통과한 설정만 release 디렉터리에 놓고
// current symlink를 바꾼 뒤 prometheus 서비스 하나만 compose로 맞춘다. 검증 실패는 current·컨테이너를 바꾸지 않고 실패한다.
const repoRoot = new URL("../..", import.meta.url).pathname;
const COMMIT = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const IMAGE = "prom/prometheus:v3.15.0";
const COMMAND = [
  "--config.file=/etc/prometheus/prometheus.yml",
  "--storage.tsdb.path=/prometheus",
  "--storage.tsdb.retention.time=30d",
  "--storage.tsdb.retention.size=3GB",
  "--web.enable-lifecycle",
  "--web.external-url=http://localhost:9090",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const RUN_URL = "https://github.com/AquilaXk/easysubway-platform/actions/runs/123";

function makeSourceTree(root) {
  const infra = join(root, "infra");
  mkdirSync(infra, { recursive: true });
  for (const name of ["prometheus", "alertmanager", "grafana", "loki", "alloy"]) cpSync(join(repoRoot, "infra", name), join(infra, name), { recursive: true });
  cpSync(join(repoRoot, "infra", "docker-compose.yml"), join(infra, "docker-compose.yml"));
  return root;
}

function walk(root, base = root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? walk(path, base) : [path.slice(base.length + 1)];
  });
}

// 라이브·reference Prometheus가 돌려주는 응답을 만든다. 같은 설정이면 같은 값을 돌려준다.
const snapshot = ({ jobs = ["easysubway-backend", "backend_app_metrics", "docker_runtime_probe", "public_edge_probe"], revision = "new", flags = {} } = {}) => ({
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
  yaml: `global:\n  scrape_interval: 15s\n# ${revision}\nscrape_configs:\n${jobs.map((job) => `- job_name: ${job}\n`).join("")}`,
  rules: [{ name: "g", file: "/etc/prometheus/alerts.yml", interval: 15, rules: [{ name: `Alert-${revision}`, type: "alerting", query: "up < 1", duration: 60, labels: {}, annotations: {} }] }],
  reloadSuccessful: "1",
  lowestTimestamp: "1759000000000",
});

function httpBody(path, data) {
  if (path === "/api/v1/status/buildinfo") return JSON.stringify({ status: "success", data: { version: data.version } });
  if (path === "/api/v1/status/flags") return JSON.stringify({ status: "success", data: data.flags });
  if (path === "/api/v1/status/config") return JSON.stringify({ status: "success", data: { yaml: data.yaml } });
  if (path === "/api/v1/rules") {
    return JSON.stringify({ status: "success", data: { groups: data.rules.map((group) => ({ ...group, rules: group.rules.map((rule) => ({ ...rule, health: "ok", lastEvaluation: "2026-10-08T00:00:00Z", evaluationTime: 0.001, state: "inactive" })) })) } });
  }
  if (path === "/metrics") return `# HELP prometheus_config_last_reload_successful x\n# TYPE prometheus_config_last_reload_successful gauge\nprometheus_config_last_reload_successful ${data.reloadSuccessful}\nprometheus_tsdb_lowest_timestamp ${data.lowestTimestamp}\n`;
  if (path === "/-/ready") return "Prometheus Server is Ready.\n";
  throw new Error(`unexpected prometheus path ${path}`);
}

// docker·git 호출을 흉내 내는 호스트. calls에 순서대로 남기고, 시나리오 값으로 실패와 상태 전이를 만든다.
function createHost({
  existingContainerId = "1".repeat(64), recreateOnUp = true, restartFixesLive = true, promtoolFails = null,
  liveAfter = null, liveBefore = snapshot({ revision: "old" }), expected = snapshot(), health = "healthy",
  headCommit = COMMIT, projectContainers = null, volumeAfter = null, upFails = false, composeCommand = COMMAND, containerMissing = false,
} = {}) {
  const calls = [];
  const state = { containerId: existingContainerId, live: liveBefore, generation: 0 };
  const volume = { Name: "easysubway_prometheus-data", Mountpoint: "/var/lib/easysubway-data/docker/volumes/easysubway_prometheus-data/_data", CreatedAt: "2026-06-30T18:05:00Z", Labels: { "com.docker.compose.project": "easysubway", "com.docker.compose.volume": "prometheus-data" } };
  const others = projectContainers ?? [["easysubway-postgres", "2".repeat(12)], ["easysubway-alertmanager", "3".repeat(12)], ["easysubway-grafana", "4".repeat(12)]];
  let reference = null;
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    const line = `${command} ${args.join(" ")}`;
    if (command === "git") return { stdout: `${headCommit}\n`, stderr: "" };
    assert.equal(command, "docker", line);
    const [verb] = args;
    if (verb === "pull") return { stdout: "", stderr: "" };
    if (verb === "compose") {
      if (args.includes("config")) return { stdout: JSON.stringify({ services: { prometheus: { image: IMAGE, command: composeCommand } } }), stderr: "" };
      if (args.includes("up")) {
        if (upFails) throw new Error("compose up failed");
        if (recreateOnUp) {
          state.generation += 1;
          state.containerId = String(8 + state.generation).repeat(64);
          state.live = liveAfter ?? expected;
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
      assert.equal(tool, "wget");
      const path = url.replace("http://127.0.0.1:9090", "");
      if (target === reference) return { stdout: httpBody(path, expected), stderr: "" };
      assert.equal(target, "easysubway-prometheus");
      return { stdout: httpBody(path, state.live), stderr: "" };
    }
    if (verb === "restart") {
      assert.equal(args[1], "easysubway-prometheus");
      if (restartFixesLive) state.live = liveAfter ?? expected;
      return { stdout: "", stderr: "" };
    }
    if (verb === "inspect") {
      if (containerMissing) throw new Error("No such object: easysubway-prometheus");
      return {
        stdout: JSON.stringify([{
          Id: state.containerId, Name: "/easysubway-prometheus", Config: { Image: IMAGE },
          State: { Running: true, Health: { Status: health } },
          Mounts: [{ Type: "volume", Name: "easysubway_prometheus-data", Destination: "/prometheus" }],
        }]),
        stderr: "",
      };
    }
    if (verb === "ps") {
      const rows = [["easysubway-prometheus", state.containerId.slice(0, 12)], ...others];
      return { stdout: rows.map((row) => row.join("\t")).join("\n"), stderr: "" };
    }
    if (verb === "volume") {
      assert.deepEqual(args.slice(0, 2), ["volume", "inspect"]);
      return { stdout: JSON.stringify([volumeAfter && calls.some((call) => call.args.includes("up")) ? volumeAfter : volume]), stderr: "" };
    }
    assert.fail(`unexpected docker command: ${line}`);
    return null;
  };
  return { calls, runner, state, volume };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "obs-deploy-test-"));
  const sourceRoot = makeSourceTree(join(root, "source"));
  const deployRoot = join(root, "deploy");
  mkdirSync(join(deployRoot, "release-receipts"), { recursive: true });
  return { root, sourceRoot, deployRoot, observability: join(deployRoot, "observability"), stagingRoot: join(root, "staging"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const base = (box, host, overrides = {}) => ({
  commit: COMMIT, sourceRoot: box.sourceRoot, deployRoot: box.deployRoot, stagingRoot: box.stagingRoot,
  composeEnvFile: "/opt/easysubway/shared/current-env/compose.env", runUrl: RUN_URL, runId: "123",
  commandRunner: host.runner, sleep: async () => {}, now: () => new Date("2026-10-08T01:02:03.000Z"), ...overrides,
});
const verbs = (host) => host.calls.map(({ command, args }) => (command === "git" ? "git" : args[0] === "compose" ? `compose:${args.includes("up") ? "up" : "config"}` : args[0] === "run" ? (args.includes("promtool") ? `promtool:${args.includes("check") ? "check" : "test"}` : "run:reference") : args[0] === "volume" ? "volume" : args[0]));

// 이미 배포된 직전 release 하나를 만들고 current가 그것을 가리키게 한다.
function seedPreviousRelease(box, { commit = PREVIEW_COMMIT_FOR_SEED } = {}) {
  const release = join(box.observability, "releases", commit);
  mkdirSync(join(box.observability, "releases"), { recursive: true });
  cpSync(join(box.sourceRoot, "infra"), release, { recursive: true });
  writeFileSync(join(release, "prometheus", "alerts.yml"), `${readFileSync(join(release, "prometheus", "alerts.yml"), "utf8")}\n# previous\n`);
  symlinkSync(join("releases", commit), join(box.observability, "current"));
  return release;
}
const PREVIEW_COMMIT_FOR_SEED = PREVIOUS;

test("PREVIEW는 호스트를 읽지도 쓰지도 않고 promtool 검증과 reference 기대값만 만든다", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    const result = await deployObservabilityConfig(base(box, host, { mode: "PREVIEW", deployRoot: undefined }));
    const trail = verbs(host);
    assert.deepEqual(trail.slice(0, 6), ["git", "compose:config", "pull", "promtool:check", "promtool:test", "run:reference"]);
    assert.ok(trail.slice(6, -1).every((verb) => verb === "exec"), "reference는 exec로 읽기만 한다");
    for (const forbidden of ["inspect", "ps", "volume", "restart", "compose:up"]) assert.equal(verbs(host).includes(forbidden), false, forbidden);
    assert.equal(trail.at(-1), "rm");
    assert.equal(result.mode, "PREVIEW");
    assert.equal(result.hostMutationCount, 0);
    assert.equal(result.commit, COMMIT);
    assert.equal(result.image, IMAGE);
    assert.deepEqual(result.validation, { checkConfig: "passed", testRules: "passed" });
    assert.equal(result.expected.statusConfigSha256, sha256(snapshot().yaml));
    assert.deepEqual(result.expected.jobs, ["backend_app_metrics", "docker_runtime_probe", "easysubway-backend", "public_edge_probe"]);
    assert.equal(existsSync(box.observability), false, "PREVIEW는 관리 디렉터리를 만들지 않는다");
    assert.deepEqual(readdirSync(box.stagingRoot), [], "staging 디렉터리는 끝나면 지운다");
  } finally {
    box.cleanup();
  }
});

test("release 디렉터리는 infra의 다섯 설정 디렉터리와 compose 파일을 그대로 담고 digest가 receipt와 일치한다", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    const result = await deployObservabilityConfig(base(box, host, { mode: "DEPLOY" }));
    const release = join(box.observability, "releases", COMMIT);
    const expectedFiles = ["docker-compose.yml", ...["alertmanager", "alloy", "grafana", "loki", "prometheus"].flatMap((dir) => walk(join(box.sourceRoot, "infra", dir)).map((file) => `${dir}/${file}`))].sort();
    assert.deepEqual(walk(release).sort(), expectedFiles);
    assert.deepEqual(Object.keys(result.files), expectedFiles, "files는 경로 순서");
    for (const file of expectedFiles) {
      assert.equal(result.files[file], sha256(readFileSync(join(release, file))), file);
      assert.equal(sha256(readFileSync(join(release, file))), sha256(readFileSync(join(box.sourceRoot, "infra", file))), file);
    }
    assert.deepEqual(Object.keys(result.directoryDigests), ["alertmanager", "alloy", "grafana", "loki", "prometheus"]);
    assert.match(result.configDigest, /^[0-9a-f]{64}$/u);
    assert.equal(lstatSync(join(release, "prometheus", "prometheus.yml")).mode & 0o222, 0, "release 파일은 읽기 전용이다");
  } finally {
    box.cleanup();
  }
});

test("처음 배포: 검증 → release 설치 → current 전환 → prometheus 하나만 compose up → 읽기 대조 → receipt", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    const result = await deployObservabilityConfig(base(box, host, { mode: "DEPLOY" }));
    const trail = verbs(host);
    const up = trail.indexOf("compose:up");
    assert.deepEqual(trail.slice(0, 6), ["git", "compose:config", "pull", "promtool:check", "promtool:test", "run:reference"]);
    assert.ok(trail.indexOf("promtool:test") < trail.indexOf("inspect") && trail.indexOf("inspect") < up, "검증과 읽기가 상태 변경보다 먼저");
    assert.equal(trail.filter((verb) => verb === "compose:up").length, 1);
    assert.equal(trail.includes("restart"), false, "컨테이너가 재생성되면 재시작하지 않는다");
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", COMMIT));
    assert.equal(existsSync(join(box.observability, "previous")), false);

    const upCall = host.calls.find((call) => call.args.includes("up"));
    assert.deepEqual(upCall.args, [
      "compose", "-p", "easysubway", "--project-directory", join(box.observability, "current"), "-f", join(box.observability, "current", "docker-compose.yml"),
      "--env-file", "/opt/easysubway/shared/current-env/compose.env", "--profile", "observability",
      "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "prometheus",
    ]);
    assert.equal(upCall.env.EASYSUBWAY_BACKEND_ENV_FILE, "/dev/null");
    assert.match(upCall.env.EASYSUBWAY_BACKEND_IMAGE, /^\S+$/u, "backend 이미지는 compose 해석용 값이고 backend는 건드리지 않는다");

    assert.equal(result.mode, "DEPLOY");
    assert.equal(result.container.action, "recreated");
    assert.equal(result.container.idBefore, "1".repeat(64));
    assert.equal(result.container.idAfter, "9".repeat(64));
    assert.equal(result.previousCommit, null);
    assert.equal(result.verification.statusConfigSha256, result.verification.expectedStatusConfigSha256);
    assert.equal(result.verification.rulesSha256, result.verification.expectedRulesSha256);
    assert.deepEqual(result.verification.absentJobs, ["back_worker"]);
    assert.deepEqual(result.verification.flags["storage.tsdb.retention.time"], "30d");
    assert.deepEqual(result.verification.flags["storage.tsdb.retention.size"], "3GiB");
    assert.deepEqual(result.verification.untouchedContainers, ["easysubway-alertmanager", "easysubway-grafana", "easysubway-postgres"]);
    assert.deepEqual(result.verification.volume, { name: "easysubway_prometheus-data", mountpointBefore: host.volume.Mountpoint, mountpointAfter: host.volume.Mountpoint, createdAtBefore: host.volume.CreatedAt, createdAtAfter: host.volume.CreatedAt, tsdbLowestTimestampBefore: "1759000000000", tsdbLowestTimestampAfter: "1759000000000" });
    assert.deepEqual(result.appliedServices, ["prometheus"]);
    assert.deepEqual(result.materializedOnly, ["alertmanager", "alloy", "grafana", "loki"]);

    const receiptPath = join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`, "receipt.json");
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), result);
    assert.equal(lstatSync(receiptPath).mode & 0o077, 0, "receipt는 소유자만 읽는다");
    assert.equal(result.runUrl, RUN_URL);
    assert.equal(result.deployedAt, "2026-10-08T01:02:03.000Z");
  } finally {
    box.cleanup();
  }
});

test("receipt는 닫힌 필드 집합이고 compose.env 값이나 secret이 들어가지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    const result = await deployObservabilityConfig(base(box, host, { mode: "DEPLOY" }));
    assert.deepEqual(Object.keys(result), [
      "schemaVersion", "mode", "commit", "previousCommit", "runUrl", "deployedAt", "image", "composeProject", "appliedServices", "materializedOnly",
      "validation", "files", "directoryDigests", "configDigest", "container", "verification",
    ]);
    assert.equal(result.schemaVersion, "PLATFORM_OBSERVABILITY_CONFIG_DEPLOY_RECEIPT_V1");
    assert.equal(result.composeProject, "easysubway");
    assert.deepEqual(Object.keys(result.container), ["name", "idBefore", "idAfter", "action"]);
    assert.deepEqual(Object.keys(result.verification), ["version", "flags", "statusConfigSha256", "expectedStatusConfigSha256", "rulesSha256", "expectedRulesSha256", "jobs", "absentJobs", "configReloadSuccessful", "untouchedContainers", "volume"]);
  } finally {
    box.cleanup();
  }
});

test("promtool check config가 실패하면 current·release·컨테이너를 바꾸지 않고 실패한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ promtoolFails: "check" });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VALIDATE/u);
    for (const forbidden of ["inspect", "ps", "volume", "restart", "compose:up", "run:reference"]) assert.equal(verbs(host).includes(forbidden), false, forbidden);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false);
    assert.deepEqual(readdirSync(join(box.observability, "releases")), [PREVIOUS], "staging 잔여물도 남기지 않는다");
    assert.equal(existsSync(join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`)), false);
  } finally {
    box.cleanup();
  }
});

test("promtool test rules가 실패해도 같은 방식으로 아무것도 바꾸지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ promtoolFails: "test" });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VALIDATE.*test rules/su);
    assert.equal(verbs(host).includes("compose:up"), false);
    assert.equal(verbs(host).includes("restart"), false);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
  } finally {
    box.cleanup();
  }
});

test("PREVIEW도 promtool이 실패하면 실패로 끝나고 reference 컨테이너를 만들지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ promtoolFails: "check" });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "PREVIEW", deployRoot: undefined })), /E_OBS_DEPLOY_VALIDATE/u);
    assert.equal(verbs(host).includes("run:reference"), false);
    assert.deepEqual(readdirSync(box.stagingRoot), []);
  } finally {
    box.cleanup();
  }
});

test("직전 release가 있으면 previous를 남기고, 설정이 바뀌었는데 컨테이너가 그대로면 재시작한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ recreateOnUp: false });
    const result = await deployObservabilityConfig(base(box, host, { mode: "DEPLOY" }));
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", COMMIT));
    assert.equal(readlinkSync(join(box.observability, "previous")), join("releases", PREVIOUS));
    assert.equal(result.previousCommit, PREVIOUS);
    const trail = verbs(host);
    assert.ok(trail.indexOf("compose:up") < trail.indexOf("restart"));
    assert.equal(result.container.action, "restarted");
    assert.equal(result.container.idBefore, result.container.idAfter);
    assert.deepEqual(host.calls.find((call) => call.args[0] === "restart").args, ["restart", "easysubway-prometheus"]);
  } finally {
    box.cleanup();
  }
});

test("같은 커밋을 다시 배포하면 이미 맞는 컨테이너를 재시작하지 않고 receipt만 새로 남긴다", async () => {
  const box = sandbox();
  try {
    const first = createHost();
    await deployObservabilityConfig(base(box, first, { mode: "DEPLOY" }));
    const again = createHost({ recreateOnUp: false, liveBefore: snapshot(), existingContainerId: "9".repeat(64) });
    const result = await deployObservabilityConfig(base(box, again, { mode: "DEPLOY", runId: "124" }));
    assert.equal(verbs(again).includes("restart"), false);
    assert.equal(result.container.action, "unchanged");
    assert.ok(existsSync(join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-124`, "receipt.json")));
  } finally {
    box.cleanup();
  }
});

test("같은 커밋 release 디렉터리가 이미 있는데 내용이 다르면 덮어쓰지 않고 실패한다", async () => {
  const box = sandbox();
  try {
    const release = join(box.observability, "releases", COMMIT);
    mkdirSync(release, { recursive: true });
    cpSync(join(box.sourceRoot, "infra"), release, { recursive: true });
    writeFileSync(join(release, "prometheus", "alerts.yml"), "groups: []\n");
    const host = createHost();
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_RELEASE_IMMUTABLE/u);
    assert.equal(verbs(host).includes("compose:up"), false);
    assert.equal(readFileSync(join(release, "prometheus", "alerts.yml"), "utf8"), "groups: []\n");
  } finally {
    box.cleanup();
  }
});

test("적용 뒤 라이브 설정이 기대와 다르면 직전 release로 되돌리고 실패로 끝나며 receipt를 남기지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const stale = snapshot({ revision: "old" });
    const host = createHost({ liveAfter: stale });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*restored previous release/su);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(verbs(host).filter((verb) => verb === "compose:up").length, 2, "복원도 compose를 거친다");
    assert.equal(existsSync(join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`)), false);
  } finally {
    box.cleanup();
  }
});

test("처음 배포가 검증에서 실패하면 자동 복원하지 않고 수동 rollback 절차를 알리며 실패한다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ liveAfter: snapshot({ revision: "old" }) });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*no managed previous release/su);
    assert.equal(verbs(host).filter((verb) => verb === "compose:up").length, 1);
  } finally {
    box.cleanup();
  }
});

test("제거된 대상(back_worker)이 라이브에 남아 있으면 실패한다", async () => {
  const box = sandbox();
  try {
    const live = snapshot({ jobs: ["easysubway-backend", "backend_app_metrics", "docker_runtime_probe", "public_edge_probe", "back_worker"] });
    const host = createHost({ liveAfter: live });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*back_worker/su);
  } finally {
    box.cleanup();
  }
});

test("보존 flag가 라이브에 적용되지 않으면 실패한다", async () => {
  const box = sandbox();
  try {
    const live = snapshot({ flags: { "storage.tsdb.retention.time": "15d" } });
    const host = createHost({ liveAfter: live });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VERIFY.*storage\.tsdb\.retention\.time/su);
  } finally {
    box.cleanup();
  }
});

test("prometheus 외 프로젝트 컨테이너가 바뀌거나 사라지면 실패한다", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    const original = host.runner;
    let psCount = 0;
    const runner = async (command, args, options) => {
      if (command === "docker" && args[0] === "ps") {
        psCount += 1;
        if (psCount === 2) return { stdout: ["easysubway-prometheus\t999999999999", "easysubway-postgres\tffffffffffff", "easysubway-alertmanager\t333333333333", "easysubway-grafana\t444444444444"].join("\n"), stderr: "" };
      }
      return original(command, args, options);
    };
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY", commandRunner: runner })), /E_OBS_DEPLOY_SCOPE.*easysubway-postgres/su);
  } finally {
    box.cleanup();
  }
});

test("데이터 volume 정체가 바뀌면 실패한다", async () => {
  const box = sandbox();
  try {
    const probe = createHost();
    const changed = { ...probe.volume, CreatedAt: "2026-10-08T00:00:00Z" };
    const host = createHost({ volumeAfter: changed });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_VOLUME/u);
  } finally {
    box.cleanup();
  }
});

test("명령 목록은 허용된 동사만 쓰고 down·rm(운영)·volume 삭제·remove-orphans·force-recreate를 쓰지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ recreateOnUp: false });
    await deployObservabilityConfig(base(box, host, { mode: "DEPLOY" }));
    const allowed = new Set(["pull", "run", "exec", "rm", "inspect", "ps", "volume", "restart", "compose"]);
    for (const { command, args } of host.calls) {
      if (command === "git") {
        assert.deepEqual(args, ["-C", box.sourceRoot, "rev-parse", "HEAD"]);
        continue;
      }
      assert.ok(allowed.has(args[0]), args.join(" "));
      for (const forbidden of ["down", "stop", "kill", "prune", "--remove-orphans", "--force-recreate", "rmi", "network"]) assert.equal(args.includes(forbidden), false, `${forbidden}: ${args.join(" ")}`);
      if (args[0] === "compose") {
        const sub = args[args.indexOf("--profile") + 2];
        assert.ok(["config", "up"].includes(sub), args.join(" "));
        if (sub === "up") assert.equal(args.at(-1), "prometheus");
      }
    }
    const rmCalls = host.calls.filter((call) => call.args[0] === "rm");
    assert.equal(rmCalls.length, 1);
    assert.match(rmCalls[0].args[3], /^easysubway-observability-ref-/u);
    assert.equal(rmCalls[0].args[3] === "easysubway-prometheus", false);
  } finally {
    box.cleanup();
  }
});

test("기존 prometheus 컨테이너가 없으면 생성하지 않고 실패한다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ containerMissing: true });
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_STATE/u);
    assert.equal(verbs(host).includes("compose:up"), false);
  } finally {
    box.cleanup();
  }
});

test("current가 관리 release가 아닌 것을 가리키면 건드리지 않고 실패한다", async () => {
  const box = sandbox();
  try {
    mkdirSync(box.observability, { recursive: true });
    symlinkSync("/etc", join(box.observability, "current"));
    const host = createHost();
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_STATE/u);
    assert.equal(readlinkSync(join(box.observability, "current")), "/etc");
    assert.equal(verbs(host).includes("compose:up"), false);
  } finally {
    box.cleanup();
  }
});

test("입력 검증: 커밋 형식, checkout HEAD 일치, 절대경로, 모드", async () => {
  const box = sandbox();
  try {
    const cases = [
      [{ commit: "main" }, /E_OBS_DEPLOY_USAGE/u],
      [{ commit: COMMIT.toUpperCase() }, /E_OBS_DEPLOY_USAGE/u],
      [{ mode: "APPLY" }, /E_OBS_DEPLOY_USAGE/u],
      [{ deployRoot: "relative/root" }, /E_OBS_DEPLOY_USAGE/u],
      [{ deployRoot: `${box.deployRoot}/../x` }, /E_OBS_DEPLOY_USAGE/u],
      [{ runId: "12a" }, /E_OBS_DEPLOY_USAGE/u],
      [{ composeEnvFile: "relative.env" }, /E_OBS_DEPLOY_USAGE/u],
    ];
    for (const [override, pattern] of cases) {
      const host = createHost();
      await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY", ...override })), pattern, JSON.stringify(override));
      assert.equal(verbs(host).includes("compose:up"), false);
    }
    const mismatch = createHost({ headCommit: PREVIOUS });
    await assert.rejects(deployObservabilityConfig(base(box, mismatch, { mode: "DEPLOY" })), /E_OBS_DEPLOY_SOURCE/u);
    assert.deepEqual(verbs(mismatch), ["git"]);
  } finally {
    box.cleanup();
  }
});

test("source에 symlink가 있으면 release에 복사하지 않고 실패한다", async () => {
  const box = sandbox();
  try {
    symlinkSync("/etc/passwd", join(box.sourceRoot, "infra", "prometheus", "leak.yml"));
    const host = createHost();
    await assert.rejects(deployObservabilityConfig(base(box, host, { mode: "DEPLOY" })), /E_OBS_DEPLOY_SOURCE/u);
    assert.equal(verbs(host).includes("promtool:check"), false);
  } finally {
    box.cleanup();
  }
});

// 실제 레포 파일과 deploy 도구가 가정하는 계약. 도구와 레포가 따로 어긋나면 여기서 실패한다.
test("레포의 prometheus 서비스는 current 상대 경로·보존 flag·고정 volume을 가진다", () => {
  const compose = readFileSync(join(repoRoot, "infra", "docker-compose.yml"), "utf8");
  const service = compose.split(/\n  prometheus:\n/u)[1].split(/\n  [a-z-]+:\n/u)[0];
  assert.match(service, /image: prom\/prometheus:v3\.\d+\.\d+\n/u);
  assert.match(service, /--storage\.tsdb\.retention\.time=30d/u);
  assert.match(service, /--storage\.tsdb\.retention\.size=3GB/u);
  assert.match(service, /- \.\/prometheus\/prometheus\.yml:\/etc\/prometheus\/prometheus\.yml:ro/u);
  assert.match(service, /- \.\/prometheus\/alerts\.yml:\/etc\/prometheus\/alerts\.yml:ro/u);
  assert.match(service, /- prometheus-data:\/prometheus/u);
  assert.match(service, /profiles:\n\s+- observability/u);
  assert.doesNotMatch(service, /container_name: (?!easysubway-prometheus\n)/u);
  assert.match(service, /container_name: easysubway-prometheus\n/u);
});

test("레포의 prometheus.yml에는 제거된 back_worker 대상이 없고 rule_files가 마운트 경로를 가리킨다", () => {
  const config = readFileSync(join(repoRoot, "infra", "prometheus", "prometheus.yml"), "utf8");
  assert.equal(/job_name:\s*"?back_worker"?/u.test(config), false);
  assert.match(config, /rule_files:\n\s+- \/etc\/prometheus\/alerts\.yml/u);
});

// 호스트 실측(2026-10-08): 컨테이너 easysubway-prometheus, volume easysubway_prometheus-data(compose project easysubway). 레포 compose를 실제 compose로
// 해석했을 때 같은 이름이 나와야 새 위치에서 compose를 실행해도 TSDB volume이 그대로 이어진다. docker compose가 없는 환경에서는 건너뛰고, CI에는 있다.
const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test("실제 compose 해석: 프로젝트 easysubway에서 prometheus 서비스는 같은 컨테이너 이름·volume 이름·current 상대 마운트를 낳는다", { skip: composeAvailable ? false : "docker compose is not installed in this environment" }, () => {
  const box = sandbox();
  try {
    const current = join(box.root, "current");
    symlinkSync(join(box.sourceRoot, "infra"), current);
    const { stdout } = spawnSync("docker", [
      "compose", "-p", "easysubway", "--project-directory", current, "-f", join(current, "docker-compose.yml"), "--profile", "observability", "config", "--format", "json", "prometheus",
    ], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, EASYSUBWAY_BACKEND_ENV_FILE: "/dev/null", EASYSUBWAY_BACKEND_IMAGE: "ghcr.io/aquilaxk/easysubway-backend@sha256:0000000000000000000000000000000000000000000000000000000000000000" } });
    const config = JSON.parse(stdout);
    assert.deepEqual(Object.keys(config.services), ["prometheus"]);
    const service = config.services.prometheus;
    assert.equal(service.container_name, "easysubway-prometheus");
    assert.equal(config.volumes["prometheus-data"].name, "easysubway_prometheus-data");
    const sources = service.volumes.filter((volume) => volume.type === "bind").map((volume) => [volume.source, volume.target]);
    assert.deepEqual(sources, [
      [join(current, "prometheus", "prometheus.yml"), "/etc/prometheus/prometheus.yml"],
      [join(current, "prometheus", "alerts.yml"), "/etc/prometheus/alerts.yml"],
    ], "마운트 원천은 symlink 해석 전의 current 경로 문자열이다");
    assert.deepEqual(service.volumes.filter((volume) => volume.type === "volume").map((volume) => [volume.source, volume.target]), [["prometheus-data", "/prometheus"]]);
  } finally {
    box.cleanup();
  }
});
