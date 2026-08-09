import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "validate-deployment-input.mjs");
const gitSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const runtimeInventory = new URL("../../contracts/release/platform-deployment-runtime-input-inventory.json", import.meta.url);

test("deployment runtime input inventory is closed and source-literal backed", () => {
  const bytes = readFileSync(runtimeInventory, "utf8");
  assert.equal(bytes.includes("\r"), false);
  assert.equal(bytes.startsWith("\uFEFF"), false);
  assert.equal(bytes, `${bytes.trimEnd()}\n`);

  const inventory = JSON.parse(bytes);
  const sourcePaths = [
    ".github/workflows/cd.yml",
    "tools/deploy/deploy-backend.sh",
    "tools/deploy/backend-app-env.allowlist",
    "tools/deploy/compose-server-env.allowlist",
    "infra/docker-compose.yml",
    "infra/nginx/route-v2-entrypoint.sh",
    "infra/nginx/route-v2-gateway.conf.template",
    "infra/nginx/route-v2-proxy-headers.conf.template",
    "infra/nginx/host-route-v2-proxy.conf",
    "infra/nginx/host-easysubway.conf.template",
  ];
  const entries = [
    ["cd.backend-image-digest", ".github/workflows/cd.yml", "TARGET_JOURNEY_V3_REQUIRED", ["backend_image:", "EASYSUBWAY_BACKEND_IMAGE:", "backend_image must be an immutable EasySubway backend digest"]],
    ["cd.route-v2-preflight-secret", ".github/workflows/cd.yml", "LEGACY_NOT_JOURNEY_V3", ["EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET: preflight-only"]],
    ["deploy.backend-image-digest", "tools/deploy/deploy-backend.sh", "TARGET_JOURNEY_V3_REQUIRED", ["DEPLOY_IMAGE_DIGEST", "backend_image=\"ghcr.io/aquilaxk/easysubway-backend@${DEPLOY_IMAGE_DIGEST}\""]],
    ["deploy.hub-source-checkout", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["DEPLOY_REPO_URL=\"${DEPLOY_REPO_URL:-https://github.com/AquilaXk/easysubway.git}\"", "git clone \"${DEPLOY_REPO_URL}\"", "timeout 120 git fetch origin main", "git checkout --detach \"${DEPLOY_SHA}\""]],
    ["deploy.bundled-timetable-evidence", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["SNAPSHOT_EVIDENCE_PATH=\"backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json\"", "check-snapshot-freshness-precheck.mjs"]],
    ["deploy.route-v2-runtime-services", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["RUNTIME_SERVICES=(backend back-worker route-v2-gateway)"]],
    ["deploy.route-v2-ingress-toggle", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["EASYSUBWAY_ROUTE_V2_INGRESS_ENABLED", "route_v2_host_action", "route-v2-canary-rollback-lock.json"]],
    ["deploy.route-v2-host-ingress", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["install_route_v2_host_ingress()", "__ROUTE_V2_ACTION__", "easysubway-route-v2-proxy.conf"]],
    ["deploy.route-v2-gateway-finalize", "tools/deploy/deploy-backend.sh", "LEGACY_NOT_JOURNEY_V3", ["force-recreate back-worker route-v2-gateway", "runtime_services_hardened back-worker route-v2-gateway"]],
    ["backend-env.route-v2-ingress-session", "tools/deploy/backend-app-env.allowlist", "LEGACY_NOT_JOURNEY_V3", ["EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET", "EASYSUBWAY_ROUTE_V2_SESSION_MAX_REQUESTS", "EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256", "EASYSUBWAY_PLAY_INTEGRITY_CREDENTIALS_BASE64"]],
    ["backend-env.legacy-datapack-delivery", "tools/deploy/backend-app-env.allowlist", "LEGACY_NOT_JOURNEY_V3", ["EASYSUBWAY_DATAPACK_CATALOG_BASE_URL", "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM", "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID", "EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN", "EASYSUBWAY_TIMETABLE_SEED_ENABLED", "EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX"]],
    ["compose-env.route-v2-gateway-controls", "tools/deploy/compose-server-env.allowlist", "LEGACY_NOT_JOURNEY_V3", ["EASYSUBWAY_ROUTE_V2_GATEWAY_PORT", "EASYSUBWAY_ROUTE_V2_INGRESS_ENABLED", "EASYSUBWAY_ROUTE_V2_SESSION_RATE_PER_MINUTE", "EASYSUBWAY_ROUTE_V2_SESSION_BURST", "EASYSUBWAY_ROUTE_V2_SEARCH_RATE_PER_MINUTE", "EASYSUBWAY_ROUTE_V2_SEARCH_BURST", "EASYSUBWAY_ROUTE_V2_TRUSTED_PROXY_CIDR"]],
    ["compose.backend-image", "infra/docker-compose.yml", "TARGET_JOURNEY_V3_REQUIRED", ["backend:", "backend-standby:", "image: ${EASYSUBWAY_BACKEND_IMAGE:?set immutable backend image}"]],
    ["compose.route-v2-gateway", "infra/docker-compose.yml", "LEGACY_NOT_JOURNEY_V3", ["route-v2-gateway:", "EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET", "EASYSUBWAY_ROUTE_V2_GATEWAY_PORT"]],
    ["nginx.entrypoint.route-v2-template", "infra/nginx/route-v2-entrypoint.sh", "LEGACY_NOT_JOURNEY_V3", ["/tmp/nginx-conf.d", "/docker-entrypoint.sh"]],
    ["nginx.gateway.route-v2-endpoints", "infra/nginx/route-v2-gateway.conf.template", "LEGACY_NOT_JOURNEY_V3", ["/api/v2/routes/session", "/api/v2/routes/search", "route_session_ip", "route_search_token", "ROUTE_RATE_LIMITED"]],
    ["nginx.gateway.route-v2-origin-header", "infra/nginx/route-v2-proxy-headers.conf.template", "LEGACY_NOT_JOURNEY_V3", ["X-EasySubway-Origin-Verify", "EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET"]],
    ["nginx.host.route-v2-proxy", "infra/nginx/host-route-v2-proxy.conf", "LEGACY_NOT_JOURNEY_V3", ["CF-Connecting-IP $remote_addr", "real_ip_header CF-Connecting-IP"]],
    ["nginx.host.route-v2-endpoints", "infra/nginx/host-easysubway.conf.template", "LEGACY_NOT_JOURNEY_V3", ["/api/v2/routes/session", "/api/v2/routes/search", "__ROUTE_V2_ACTION__"]],
    ["nginx.host.readiness-proxy", "infra/nginx/host-easysubway.conf.template", "TARGET_JOURNEY_V3_REQUIRED", ["/actuator/health/readiness", "proxy_pass http://127.0.0.1:__BACKEND_PORT__;"]],
  ];
  assert.deepEqual(Object.keys(inventory), ["schemaVersion", "artifactKind", "sourcePaths", "entries"]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.artifactKind, "platform-deployment-runtime-input-inventory-v1");
  assert.deepEqual(inventory.sourcePaths, sourcePaths);
  assert.equal(inventory.entries.length, 20);
  assert.equal(inventory.entries.filter(({ journeyV3Disposition }) => journeyV3Disposition === "TARGET_JOURNEY_V3_REQUIRED").length, 4);
  assert.equal(inventory.entries.filter(({ journeyV3Disposition }) => journeyV3Disposition === "LEGACY_NOT_JOURNEY_V3").length, 16);
  assert.deepEqual(inventory.entries.map(({ id, sourcePath, journeyV3Disposition, evidenceTokens }) => [id, sourcePath, journeyV3Disposition, evidenceTokens]), entries);

  const root = new URL("../..", import.meta.url);
  const ids = new Set();
  const tokens = new Set();
  for (const entry of inventory.entries) {
    assert.deepEqual(Object.keys(entry), ["id", "sourcePath", "member", "evidenceTokens", "journeyV3Disposition", "rationaleKo"]);
    assert.equal(ids.has(entry.id), false);
    ids.add(entry.id);
    assert.equal(typeof entry.member, "string");
    assert.equal(entry.member.length > 0, true);
    assert.equal(typeof entry.rationaleKo, "string");
    assert.equal(entry.rationaleKo.length > 0, true);
    assert.equal(Array.isArray(entry.evidenceTokens), true);
    assert.equal(entry.evidenceTokens.length > 0, true);
    assert.equal(["TARGET_JOURNEY_V3_REQUIRED", "LEGACY_NOT_JOURNEY_V3"].includes(entry.journeyV3Disposition), true);
    const source = readFileSync(new URL(entry.sourcePath, root), "utf8");
    for (const token of entry.evidenceTokens) {
      assert.equal(typeof token, "string");
      assert.equal(token.length > 0, true);
      assert.equal(tokens.has(`${entry.sourcePath}\0${token}`), false);
      tokens.add(`${entry.sourcePath}\0${token}`);
      assert.equal(source.includes(token), true, `${entry.id} must retain ${token}`);
      if (entry.journeyV3Disposition === "TARGET_JOURNEY_V3_REQUIRED") assert.doesNotMatch(token, /route-v2|route_v2|ROUTE_V2|\/api\/v2\/routes/i);
    }
  }
  assert.deepEqual(Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, inventory.entries.filter((entry) => entry.sourcePath === sourcePath).map((entry) => entry.id)])), Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, entries.filter(([, path]) => path === sourcePath).map(([id]) => id)])));
  const legacyTokens = inventory.entries.filter(({ journeyV3Disposition }) => journeyV3Disposition === "LEGACY_NOT_JOURNEY_V3").flatMap(({ evidenceTokens }) => evidenceTokens);
  for (const marker of ["DEPLOY_REPO_URL", "SNAPSHOT_EVIDENCE_PATH", "route-v2-gateway", "EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET", "EASYSUBWAY_ROUTE_V2_INGRESS_ENABLED", "/api/v2/routes/session", "/api/v2/routes/search", "__ROUTE_V2_ACTION__"]) assert.equal(legacyTokens.some((token) => token.includes(marker)), true);
});

test("accepts an exact producer artifact and immutable image digest", () => {
  const fixture = makeFixture();
  try {
    const result = JSON.parse(run(fixture));
    assert.deepEqual(result, {
      repository: "AquilaXk/easysubway",
      runId: 42,
      artifactName: `easysubway-backend-release-${gitSha}`,
      artifactSha256: "c".repeat(64),
      backendGitSha: gitSha,
      image: `ghcr.io/aquilaxk/easysubway-backend@${digest}`,
      imageDigest: digest,
      evidenceSha256: fixture.evidenceSha256,
    });
  } finally {
    fixture.cleanup();
  }
});

test("rejects mutable images, wrong identity, and changed evidence", () => {
  for (const options of [
    { imageDigest: "latest" },
    { repository: "AquilaXk/easysubway-mobile" },
    { artifactName: "easysubway-backend-release-main" },
    { artifactSha256: "bad" },
    { evidenceSha256: "0".repeat(64) },
  ]) {
    const fixture = makeFixture(options);
    try {
      assert.throws(() => run(fixture));
    } finally {
      fixture.cleanup();
    }
  }
});

test("deploy adapter derives the full image from the verified digest", () => {
  const root = new URL("../..", import.meta.url);
  const deploy = readFileSync(new URL("tools/deploy/deploy-backend.sh", root), "utf8");
  const allowlist = readFileSync(new URL("tools/deploy/compose-server-env.allowlist", root), "utf8");
  assert.match(deploy, /backend_image="ghcr\.io\/aquilaxk\/easysubway-backend@\$\{DEPLOY_IMAGE_DIGEST\}"/);
  assert.doesNotMatch(deploy, /EASYSUBWAY_BACKEND_IMAGE_TAG/);
  assert.doesNotMatch(allowlist, /EASYSUBWAY_BACKEND_IMAGE(?:_TAG)?/);
});

function makeFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-deploy-"));
  const evidence = join(directory, "release-metadata.txt");
  const evidenceBytes = "verified backend release\n";
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  const imageDigest = options.imageDigest ?? digest;
  const manifest = join(directory, "backend-component-manifest.json");
  const contract = join(directory, "deployment-contract.json");
  writeFileSync(evidence, evidenceBytes);
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "platform-deployment-contract",
    contractVersion: "platform-v1",
    allowedProducerRepositories: ["AquilaXk/easysubway", "AquilaXk/easysubway-backend"],
    artifactNamePattern: "^easysubway-backend-release-[a-f0-9]{40}$",
    imageRepository: "ghcr.io/aquilaxk/easysubway-backend",
    gitShaPattern: "^[a-f0-9]{40}$",
    sha256Pattern: "^[a-f0-9]{64}$",
    imageDigestPattern: "^sha256:[a-f0-9]{64}$",
    issueRefPattern: "^AquilaXk/(easysubway|easysubway-data|easysubway-platform|easysubway-backend|easysubway-mobile)#[1-9][0-9]*$",
  })}\n`);
  writeFileSync(manifest, `${JSON.stringify({
    schemaVersion: 1,
    component: "backend",
    repository: options.repository ?? "AquilaXk/easysubway",
    gitSha,
    artifactIdentity: { imageDigest, apiContractVersion: "1.0.0" },
    contractVersion: "1.0.0",
    evidenceSha256: options.evidenceSha256 ?? evidenceSha256,
    issueRefs: ["AquilaXk/easysubway#2712"],
  })}\n`);
  return {
    directory,
    manifest,
    evidence,
    contract,
    evidenceSha256,
    repository: options.repository ?? "AquilaXk/easysubway",
    artifactName: options.artifactName ?? `easysubway-backend-release-${gitSha}`,
    artifactSha256: options.artifactSha256 ?? "c".repeat(64),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function run(fixture) {
  return execFileSync(process.execPath, [
    script,
    "--contract", fixture.contract,
    "--manifest", fixture.manifest,
    "--evidence", fixture.evidence,
    "--producer-repository", fixture.repository,
    "--run-id", "42",
    "--artifact-name", fixture.artifactName,
    "--artifact-sha256", fixture.artifactSha256,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8", stdio: "pipe" });
}
