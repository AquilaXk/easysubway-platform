import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const composeYml = new URL("infra/docker-compose.yml", root);
const localDepsComposeYml = new URL("infra/docker-compose.local-deps.yml", root);
const composeAllowlist = new URL("tools/deploy/compose-server-env.allowlist", root);
const envExample = new URL(".env.example", root);

function parseComposePortMappings(composeContent) {
  const lines = composeContent.split("\n");
  const portMappings = [];
  let currentService = null;
  let inPortsBlock = false;

  for (const line of lines) {
    const serviceMatch = line.match(/^ {2}([a-zA-Z0-9_-]+):/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      inPortsBlock = false;
      continue;
    }
    if (line.match(/^ {4}ports:/)) {
      inPortsBlock = true;
      continue;
    }
    if (inPortsBlock) {
      const portItemMatch = line.match(/^ {6}- "([^"]+)"/);
      if (portItemMatch) {
        portMappings.push({ service: currentService, portSpec: portItemMatch[1] });
      } else if (line.match(/^ {4}[a-zA-Z0-9_-]+:/) || line.match(/^ {2}[a-zA-Z0-9_-]+:/)) {
        inPortsBlock = false;
      }
    }
  }
  return portMappings;
}

function splitComposePort(portSpec) {
  const parts = [];
  let current = "";
  let inBraces = 0;
  for (const char of portSpec) {
    if (char === "{" && current.endsWith("$")) {
      inBraces++;
      current += char;
    } else if (char === "}" && inBraces > 0) {
      inBraces--;
      current += char;
    } else if (char === ":" && inBraces === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

test("infra/docker-compose.yml enforces 127.0.0.1 loopback bind on all published ports", () => {
  const content = readFileSync(composeYml, "utf8");
  const portMappings = parseComposePortMappings(content);

  assert.equal(portMappings.length > 0, true, "Must have defined port mappings");

  for (const { service, portSpec } of portMappings) {
    assert.doesNotMatch(
      portSpec,
      /(?:^|:)0\.0\.0\.0(?::|$)/,
      `Service ${service} must not bind to 0.0.0.0: ${portSpec}`,
    );

    const parts = splitComposePort(portSpec);
    assert.equal(
      parts.length,
      3,
      `Service ${service} port mapping "${portSpec}" must have 3 components (host_bind:host_port:container_port)`,
    );

    const hostBind = parts[0];
    assert.match(
      hostBind,
      /127\.0\.0\.1/,
      `Service ${service} host bind component "${hostBind}" must require or default to 127.0.0.1`,
    );
  }

  // Exact check for postgres and object-storage in infra/docker-compose.yml
  const postgresMapping = portMappings.filter((m) => m.service === "postgres");
  assert.equal(postgresMapping.length, 1);
  assert.equal(
    postgresMapping[0].portSpec,
    "${EASYSUBWAY_POSTGRES_BIND:-127.0.0.1}:${EASYSUBWAY_POSTGRES_PORT:-15432}:5432",
  );

  const objectStorageMappings = portMappings.filter((m) => m.service === "object-storage");
  assert.equal(objectStorageMappings.length, 2);
  assert.equal(
    objectStorageMappings[0].portSpec,
    "${EASYSUBWAY_OBJECT_STORAGE_BIND:-127.0.0.1}:${EASYSUBWAY_OBJECT_STORAGE_PORT:-9000}:9000",
  );
  assert.equal(
    objectStorageMappings[1].portSpec,
    "${EASYSUBWAY_OBJECT_STORAGE_BIND:-127.0.0.1}:${EASYSUBWAY_OBJECT_STORAGE_CONSOLE_PORT:-9001}:9001",
  );
});

test("infra/docker-compose.local-deps.yml enforces 127.0.0.1 loopback bind on all published ports", () => {
  const content = readFileSync(localDepsComposeYml, "utf8");
  const portMappings = parseComposePortMappings(content);

  assert.equal(portMappings.length > 0, true, "Must have defined port mappings in local-deps");

  for (const { service, portSpec } of portMappings) {
    const parts = splitComposePort(portSpec);
    assert.equal(
      parts.length,
      3,
      `Service ${service} port mapping "${portSpec}" in local-deps must have 3 components`,
    );

    const hostBind = parts[0];
    assert.match(
      hostBind,
      /127\.0\.0\.1/,
      `Service ${service} host bind component "${hostBind}" in local-deps must require or default to 127.0.0.1`,
    );
  }

  const postgresMapping = portMappings.filter((m) => m.service === "postgres");
  assert.equal(postgresMapping.length, 1);
  assert.equal(
    postgresMapping[0].portSpec,
    "${EASYSUBWAY_POSTGRES_BIND:-127.0.0.1}:${EASYSUBWAY_POSTGRES_PORT:-5432}:5432",
  );

  const objectStorageMappings = portMappings.filter((m) => m.service === "object-storage");
  assert.equal(objectStorageMappings.length, 2);
  assert.equal(
    objectStorageMappings[0].portSpec,
    "${EASYSUBWAY_OBJECT_STORAGE_BIND:-127.0.0.1}:${EASYSUBWAY_OBJECT_STORAGE_PORT:-9000}:9000",
  );
  assert.equal(
    objectStorageMappings[1].portSpec,
    "${EASYSUBWAY_OBJECT_STORAGE_BIND:-127.0.0.1}:${EASYSUBWAY_OBJECT_STORAGE_CONSOLE_PORT:-9001}:9001",
  );
});

test("compose-server-env.allowlist and .env.example track postgres and object-storage bind variables", () => {
  const allowlist = readFileSync(composeAllowlist, "utf8").split("\n").filter(Boolean);
  assert.equal(allowlist.includes("EASYSUBWAY_POSTGRES_BIND"), true);
  assert.equal(allowlist.includes("EASYSUBWAY_OBJECT_STORAGE_BIND"), true);

  const env = readFileSync(envExample, "utf8");
  assert.match(env, /^EASYSUBWAY_POSTGRES_BIND=127\.0\.0\.1$/m);
  assert.match(env, /^EASYSUBWAY_OBJECT_STORAGE_BIND=127\.0\.0\.1$/m);
});

test("docker-runtime-probe 최소 권한 및 Alloy 개인정보 마스킹이 적용된다", () => {
  const compose = readFileSync(composeYml, "utf8");
  const probeMatch = compose.match(/^ {2}docker-runtime-probe:\n([\s\S]*?)(?=^ {2}[a-zA-Z0-9_-]+:|\nvolumes:)/m);
  assert.ok(probeMatch, "docker-runtime-probe 서비스가 있어야 한다");
  const probeBlock = probeMatch[1];

  assert.doesNotMatch(probeBlock, /\bprivileged:\s*true\b/, "docker-runtime-probe는 privileged 모드를 쓰면 안 된다");
  assert.doesNotMatch(probeBlock, /\/dev\/kmsg\b/, "docker-runtime-probe는 /dev/kmsg 디바이스를 마운트하면 안 된다");
  assert.match(probeBlock, /no-new-privileges:true/, "no-new-privileges:true가 설정되어야 한다");
  assert.match(probeBlock, /cap_drop:\s*\n\s*-\s*ALL/, "모든 capability가 드롭되어야 한다");
  assert.match(probeBlock, /\bread_only:\s*true\b/, "read_only: true가 설정되어야 한다");

  const alloyConfig = readFileSync(new URL("infra/alloy/config.alloy", root), "utf8");
  assert.doesNotMatch(alloyConfig, /replacement\s*=\s*"local"/, "Alloy env 레이블은 local로 하드코딩되면 안 된다");
  assert.match(
    alloyConfig,
    /coalesce\(sys\.env\("EASYSUBWAY_OBSERVABILITY_ENV"\),\s*"prod"\)/,
    "Alloy env 레이블은 환경 변수 기반이어야 한다",
  );
  assert.match(
    alloyConfig,
    /loki\.source\.file\s+"edge_nginx"[^}]*forward_to\s*=\s*\[loki\.process\.edge_nginx\.receiver\]/s,
    "edge_nginx 로그는 마스킹 파이프라인을 거쳐야 한다",
  );
  assert.match(
    alloyConfig,
    /stage\.replace\s*\{[^}]*remote_addr[^}]*replace\s*=\s*"redacted"/s,
    "Alloy 파이프라인은 과거 remote_addr 필드를 마스킹해야 한다",
  );
});
