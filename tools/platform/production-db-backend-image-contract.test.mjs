import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isBackendImageReference,
  PRODUCTION_DB_COMPOSE_BACKEND_SERVICES,
  scanForeignBackendContainers,
} from "./run-k3s-journey-activation.mjs";

// Issue #219: 운영 DB에 붙는 backend 프로세스는 K3s 활성 digest 하나여야 한다.
// K3s 활성화는 PRODUCTION_DB_COMPOSE_BACKEND_SERVICES만 drain하므로, compose가 운영 DB에
// 붙이는 backend 서비스는 이 집합과 정확히 같아야 한다. 집합 밖 서비스(예: 레거시 back-worker)는
// drain되지 않고 옛 이미지로 운영 DB에 계속 기록한다.

const root = new URL("../..", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), "utf8");

function topLevelBlocks(content) {
  const blocks = [];
  let current;
  for (const line of content.split("\n")) {
    if (/^\S/.test(line)) {
      current = { header: line, lines: [] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return blocks;
}

function composeAnchors(content) {
  const anchors = new Map();
  for (const block of topLevelBlocks(content)) {
    const anchor = block.header.match(/&([A-Za-z0-9_.-]+)\s*$/);
    if (anchor) anchors.set(anchor[1], block.lines);
  }
  return anchors;
}

function composeServiceBlocks(content) {
  const blocks = new Map();
  const services = topLevelBlocks(content).find((block) => /^services:\s*$/.test(block.header));
  let current;
  for (const line of services?.lines ?? []) {
    const service = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (service) {
      current = service[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current).push(line);
  }
  return blocks;
}

const DB_SETTING_KEY = /^\s*(?:-\s*)?(?:EASYSUBWAY_DATASOURCE_|SPRING_DATASOURCE_)[A-Z0-9_]*\s*[:=]/;

function serviceAttachesProductionDb(lines, anchors) {
  let section;
  for (const line of lines) {
    const key = line.match(/^ {4}([A-Za-z0-9_]+):\s*(.*)$/);
    if (key) {
      section = key[1];
      const value = key[2].trim().replace(/^["']|["']$/g, "");
      if (section === "image" &&
        (value.startsWith("${EASYSUBWAY_BACKEND_IMAGE") || isBackendImageReference(value))) {
        return true;
      }
      if (section === "env_file" && /EASYSUBWAY_BACKEND_ENV_FILE|backend\.env/.test(value)) return true;
      continue;
    }
    if (section === "env_file" && /EASYSUBWAY_BACKEND_ENV_FILE|backend\.env/.test(line)) return true;
    if (section === "environment") {
      if (DB_SETTING_KEY.test(line)) return true;
      const merge = line.match(/^\s+<<:\s*\*([A-Za-z0-9_.-]+)\s*$/);
      if (merge && (anchors.get(merge[1]) ?? []).some((entry) => DB_SETTING_KEY.test(entry))) return true;
    }
  }
  return false;
}

function productionDbBackendServices(content) {
  const anchors = composeAnchors(content);
  return [...composeServiceBlocks(content)]
    .filter(([, lines]) => serviceAttachesProductionDb(lines, anchors))
    .map(([name]) => name)
    .sort();
}

const COMPOSE_FILES = Object.freeze([
  "infra/docker-compose.yml",
  "infra/docker-compose.journey-candidate.yml",
]);

function productionDbBackendServicesAcross(contents) {
  return [...new Set(contents.flatMap((content) => productionDbBackendServices(content)))].sort();
}

test("compose backend services attached to the production DB are exactly the K3s drain set", () => {
  assert.deepEqual(
    productionDbBackendServicesAcross(COMPOSE_FILES.map(read)),
    [...PRODUCTION_DB_COMPOSE_BACKEND_SERVICES].sort(),
  );
});

test("compose parser detects a production DB service outside the drain set", () => {
  const fixture = [
    "services:",
    "  backend:",
    "    image: ${EASYSUBWAY_BACKEND_IMAGE:?set immutable backend image}",
    "  back-worker:",
    "    environment:",
    "      EASYSUBWAY_DATASOURCE_URL: jdbc:postgresql://postgres:5432/easysubway",
    "  prometheus:",
    "    image: prom/prometheus:v3.5.4",
    "volumes:",
    "  data:",
  ].join("\n");
  assert.deepEqual(productionDbBackendServices(fixture), ["back-worker", "backend"]);
});

test("compose parser detects literal backend images and backend env_file consumers under any name", () => {
  const fixture = [
    "services:",
    "  postgres:",
    "    image: imresamu/postgis:18-3.6",
    "    environment:",
    "      POSTGRES_PASSWORD: ${EASYSUBWAY_POSTGRES_PASSWORD:-easysubway_local}",
    "  legacy-worker:",
    `    image: ghcr.io/aquilaxk/easysubway-backend@sha256:${"a".repeat(64)}`,
    "    env_file:",
    "      - ${EASYSUBWAY_BACKEND_ENV_FILE:-../.env.example}",
    "  renamed-worker:",
    "    image: easysubway-backend-legacy:84f4fb94",
    "  env-only-job:",
    "    image: busybox:1.38.0",
    "    env_file:",
    "      - ${EASYSUBWAY_BACKEND_ENV_FILE:-../.env.example}",
    "  spring-job:",
    "    image: busybox:1.38.0",
    "    environment:",
    "      - SPRING_DATASOURCE_URL=jdbc:postgresql://postgres:5432/easysubway",
    "  prometheus:",
    "    image: prom/prometheus:v3.5.4",
  ].join("\n");
  assert.deepEqual(productionDbBackendServices(fixture), [
    "env-only-job", "legacy-worker", "renamed-worker", "spring-job",
  ]);
});

test("compose parser resolves overlay anchors that carry production DB settings", () => {
  const fixture = [
    "x-shared: &shared",
    "  EASYSUBWAY_DATASOURCE_URL: jdbc:postgresql://postgres:5432/easysubway",
    "",
    "services:",
    "  overlay-worker:",
    "    environment:",
    "      <<: *shared",
    "  unrelated:",
    "    environment:",
    "      OTHER: value",
  ].join("\n");
  assert.deepEqual(productionDbBackendServices(fixture), ["overlay-worker"]);
});

test("legacy compose deploy never (re)starts a backend outside the drain set", () => {
  const deploy = read("tools/deploy/deploy-backend.sh");
  const runtime = deploy.match(/^RUNTIME_SERVICES=\(([^)]*)\)$/m);
  assert.ok(runtime, "RUNTIME_SERVICES must be declared");
  const services = runtime[1].trim().split(/\s+/);
  for (const service of services) {
    assert.ok(
      PRODUCTION_DB_COMPOSE_BACKEND_SERVICES.includes(service),
      `RUNTIME_SERVICES must not include ${service}`,
    );
  }
  assert.doesNotMatch(deploy, /back-worker/);
});

test("observability no longer expects a back-worker process", () => {
  assert.doesNotMatch(read("infra/prometheus/prometheus.yml"), /back[-_]worker/);
  assert.doesNotMatch(read("infra/prometheus/alerts.yml"), /back[-_]worker|BackWorker/);
  assert.doesNotMatch(read("infra/docker-compose.yml"), /back-worker/);
});

const HOST_SCAN_ARGS = Object.freeze([
  "ps", "--all", "--filter", "status=running", "--filter", "status=restarting",
  "--no-trunc", "--format",
  '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
]);

function hostRunner({ ps, inspect = {} }) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "docker" && args[0] === "ps") return { stdout: ps, stderr: "" };
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      const result = inspect[args[2]];
      if (result === undefined) throw new Error("No such image");
      return { stdout: JSON.stringify(result), stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  return { runner, calls };
}

test("isBackendImageReference matches any repository whose last path segment starts with easysubway-backend", () => {
  for (const image of [
    "easysubway-backend:84f4fb94e1255df64326b90fdb8f7539f283961c",
    `ghcr.io/aquilaxk/easysubway-backend@sha256:${"a".repeat(64)}`,
    "easysubway-backend-legacy:tag",
    "registry.local:5000/team/easysubway-backend-worker:1",
    "easysubway-backend",
  ]) {
    assert.equal(isBackendImageReference(image), true, image);
  }
  for (const image of [
    "imresamu/postgis:16-3.5",
    "prom/prometheus:v3.5.4",
    "easysubway-backend-logs/busybox:1.38.0",
  ]) {
    assert.equal(isBackendImageReference(image), false, image);
  }
});

test("scanForeignBackendContainers scans running and restarting containers host-wide", async () => {
  const { runner, calls } = hostRunner({
    ps: [
      "easysubway-back-worker\teasysubway-backend:84f4fb94e1255df64326b90fdb8f7539f283961c\teasysubway\tback-worker",
      "renamed\teasysubway-backend-legacy:tag\t\t",
      "easysubway-postgres\timresamu/postgis:16-3.5\teasysubway\tpostgres",
      "",
    ].join("\n"),
  });
  assert.deepEqual(await scanForeignBackendContainers(runner), ["easysubway-back-worker", "renamed"]);
  assert.deepEqual(calls, [["docker", ...HOST_SCAN_ARGS]]);
});

test("scanForeignBackendContainers resolves untagged image ids through docker image inspect", async () => {
  const backendId = `sha256:${"b".repeat(64)}`;
  const legacyLabelId = `sha256:${"c".repeat(64)}`;
  const unrelatedId = `sha256:${"d".repeat(64)}`;
  const unknownId = `sha256:${"e".repeat(64)}`;
  const { runner, calls } = hostRunner({
    ps: [
      `backend-by-digest\t${backendId}\t\t`,
      `backend-by-label\t${legacyLabelId}\t\t`,
      `unrelated\t${unrelatedId}\t\t`,
      `uninspectable\t${unknownId}\t\t`,
    ].join("\n"),
    inspect: {
      [backendId]: [{
        RepoTags: [],
        RepoDigests: [`ghcr.io/aquilaxk/easysubway-backend@sha256:${"b".repeat(64)}`],
        Config: { Labels: { "org.opencontainers.image.title": "ubuntu" } },
      }],
      [legacyLabelId]: [{
        RepoTags: [],
        RepoDigests: [],
        Config: { Labels: { "org.opencontainers.image.source": "https://github.com/AquilaXk/easysubway-backend" } },
      }],
      [unrelatedId]: [{
        RepoTags: [],
        RepoDigests: [`grafana/alloy@sha256:${"d".repeat(64)}`],
        Config: { Labels: { "org.opencontainers.image.source": "https://github.com/grafana/alloy" } },
      }],
    },
  });
  assert.deepEqual(await scanForeignBackendContainers(runner), [
    "backend-by-digest", "backend-by-label", "uninspectable",
  ]);
  assert.deepEqual(
    calls.filter((call) => call[1] === "image").map((call) => call[3]),
    [backendId, legacyLabelId, unrelatedId, unknownId],
  );
});

test("scanForeignBackendContainers fails closed on unparseable inspect output", async () => {
  const id = `sha256:${"f".repeat(64)}`;
  const runner = async (command, args) => args[0] === "ps"
    ? { stdout: `odd\t${id}\t\t\n` }
    : { stdout: "not-json" };
  assert.deepEqual(await scanForeignBackendContainers(runner), ["odd"]);
});

test("scanForeignBackendContainers accepts Buffer output and ignores unrelated images", async () => {
  const { runner } = hostRunner({ ps: "" });
  assert.deepEqual(await scanForeignBackendContainers(runner), []);
  const bufferRunner = async () => ({ stdout: Buffer.from("easysubway-alloy\tgrafana/alloy:v1.17.1\teasysubway\talloy\n") });
  assert.deepEqual(await scanForeignBackendContainers(bufferRunner), []);
});

test("scanForeignBackendContainers rejects malformed docker output", async () => {
  await assert.rejects(scanForeignBackendContainers(async () => ({ stdout: undefined })),
    /docker container output is invalid/);
  await assert.rejects(scanForeignBackendContainers(async () => ({ stdout: "no-tab-here\n" })),
    /docker container identity is invalid/);
  await assert.rejects(scanForeignBackendContainers(async () => ({ stdout: "name\timage\n" })),
    /docker container identity is invalid/);
});
