import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findForeignBackendContainers,
  PRODUCTION_DB_COMPOSE_BACKEND_SERVICES,
} from "./run-k3s-journey-activation.mjs";

// Issue #219: 운영 DB에 붙는 backend 프로세스는 K3s 활성 digest 하나여야 한다.
// K3s 활성화는 PRODUCTION_DB_COMPOSE_BACKEND_SERVICES만 drain하므로, compose가 운영 DB에
// 붙이는 backend 서비스는 이 집합과 정확히 같아야 한다. 집합 밖 서비스(예: 레거시 back-worker)는
// drain되지 않고 옛 이미지로 운영 DB에 계속 기록한다.

const root = new URL("../..", import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), "utf8");

function composeServiceBlocks(content) {
  const blocks = new Map();
  let inServices = false;
  let current;
  for (const line of content.split("\n")) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      current = undefined;
      continue;
    }
    if (!inServices) continue;
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

function productionDbBackendServices(content) {
  return [...composeServiceBlocks(content)]
    .filter(([, lines]) => lines.some((line) =>
      /^\s+EASYSUBWAY_DATASOURCE_URL:/.test(line) ||
      /^\s+image:\s*\$\{EASYSUBWAY_BACKEND_IMAGE\b/.test(line)))
    .map(([name]) => name)
    .sort();
}

test("compose backend services attached to the production DB are exactly the K3s drain set", () => {
  assert.deepEqual(
    [...PRODUCTION_DB_COMPOSE_BACKEND_SERVICES].sort(),
    ["backend", "backend-standby"],
  );
  assert.deepEqual(
    productionDbBackendServices(read("infra/docker-compose.yml")),
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

test("findForeignBackendContainers flags every running docker backend process", () => {
  const output = [
    "easysubway-back-worker\teasysubway-backend:84f4fb94e1255df64326b90fdb8f7539f283961c",
    `easysubway-backend\tghcr.io/aquilaxk/easysubway-backend@sha256:${"a".repeat(64)}`,
    `orphan\tsha256:${"b".repeat(64)}`,
    "easysubway-postgres\timresamu/postgis:16-3.5",
    "easysubway-prometheus\tprom/prometheus:v3.5.4",
    "easysubway-backend-logs-helper\tbusybox:1.38.0",
    "",
  ].join("\n");
  assert.deepEqual(findForeignBackendContainers(output), [
    "easysubway-back-worker",
    "easysubway-backend",
    "orphan",
  ]);
  assert.deepEqual(findForeignBackendContainers(""), []);
  assert.deepEqual(
    findForeignBackendContainers("easysubway-alloy\tgrafana/alloy:v1.17.1\n"),
    [],
  );
});

test("findForeignBackendContainers rejects malformed docker output", () => {
  assert.throws(() => findForeignBackendContainers(undefined), /docker container output is invalid/);
  assert.throws(() => findForeignBackendContainers("no-tab-here\n"), /docker container identity is invalid/);
});
