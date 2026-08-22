import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "validate-deployment-input.mjs");
const gitSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const runtimeInventory = new URL("../../contracts/release/platform-deployment-runtime-input-inventory.json", import.meta.url);

test("CD preflight is main-only and bound to the protected production environment", () => {
  const root = new URL("../..", import.meta.url);
  const workflow = readFileSync(new URL(".github/workflows/cd.yml", root), "utf8");
  const workflowDispatch = workflow.match(/^  workflow_dispatch:\n(?<body>(?: {4}.*\n)+)/m);
  const preflight = workflow.match(/^  preflight:\n(?<body>(?:(?: {4,}[^\n]*)?\n)*)(?=^  \S|(?![\s\S]))/m);
  const topLevelPermissions = workflow.match(/^permissions:\n(?<body>(?: {2}[^\n]*\n)*)/m);

  assert.notEqual(workflowDispatch, null, "CD must retain manual dispatch");
  assert.equal(workflowDispatch.groups.body, [
    "    inputs:\n",
    "      backend_image:\n",
    "        description: \"ghcr.io/aquilaxk/easysubway-backend@sha256:<digest>\"\n",
    "        required: true\n",
    "        type: string\n",
  ].join(""), "manual dispatch must expose only the required immutable backend image input");
  assert.notEqual(topLevelPermissions, null, "CD must declare top-level permissions");
  assert.equal(topLevelPermissions.groups.body, "  contents: read\n", "top-level permissions must be exactly read-only contents access");
  assert.doesNotMatch(workflow, /^ {2,}permissions\s*:/m, "jobs and nested mappings must not introduce permissions");
  assert.notEqual(preflight, null, "CD must retain its preflight job");
  assert.match(preflight.groups.body, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.deepEqual([...preflight.groups.body.matchAll(/^    environment: (.+)$/gm)].map((match) => match[1]), ["production-deploy"]);
  assert.equal((workflow.match(/inputs\.backend_image/g) ?? []).length, 1, "preflight may use only the declared backend image input");
  assert.deepEqual([...preflight.groups.body.matchAll(/^          EASYSUBWAY_BACKEND_IMAGE: \$\{\{ inputs\.backend_image \}\}$/gm)].map((match) => match[0]), ["          EASYSUBWAY_BACKEND_IMAGE: ${{ inputs.backend_image }}"]);
  assert.match(preflight.groups.body, /^          EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET: preflight-only$/m, "preflight retains its non-GitHub placeholder credential");
  assert.doesNotMatch(workflow, /\bsecrets\s*(?:\.\s*[A-Za-z_][A-Za-z0-9_]*|\[\s*[^\]\n]+\s*\])/i);
  assert.doesNotMatch(workflow, /^\s*secrets\s*:/mi);
  assert.doesNotMatch(workflow, /\bgithub\s*(?:\.\s*token|\[\s*["']token["']\s*\])/i);
  assert.doesNotMatch(workflow, /^\s*token\s*:/mi);
  assert.doesNotMatch(workflow, /^\s*[A-Za-z_][A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*:/mi);
});

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
    ".github/workflows/source-free-journey-deploy.yml",
    "tools/platform/prepare-source-free-fixed-host-deployment.mjs",
    "tools/platform/run-fixed-host-journey-activation.mjs",
    "infra/docker-compose.journey-candidate.yml",
    "contracts/release/platform-k3s-runtime-contract.json",
    "infra/k3s/config.yaml",
    "infra/k3s/easysubway-k3s.service",
    "infra/k3s/deployer-rbac.json",
    "tools/platform/bootstrap-single-node-k3s.sh",
    "tools/platform/render-journey-kubernetes-candidate.mjs",
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
    ["source-free.workflow.artifact-identities", ".github/workflows/source-free-journey-deploy.yml", "TARGET_JOURNEY_V3_REQUIRED", ["backend_artifact_id:", "data_artifact_id:", "skip-decompress: true"]],
    ["source-free.workflow.closed-modes", ".github/workflows/source-free-journey-deploy.yml", "TARGET_JOURNEY_V3_REQUIRED", ["--mode PREVIEW", "prepare-source-free-fixed-host-deployment.mjs"]],
    ["source-free.prepare.exact-producer-inputs", "tools/platform/prepare-source-free-fixed-host-deployment.mjs", "TARGET_JOURNEY_V3_REQUIRED", ["backend-component-manifest.json", "journey-v3-contract-bundle-v2-receipt.json", "server-route-bundle-publication-descriptor.json"]],
    ["source-free.runner.fixed-host-lifecycle", "tools/platform/run-fixed-host-journey-activation.mjs", "TARGET_JOURNEY_V3_REQUIRED", ["switchNginx", "drainAndRecreateCanonical", "removeStandby", "writeFailureReceipt", "activation-receipt.json", "reserveOperationDirectory"]],
    ["source-free.compose.exact-journey-environment", "infra/docker-compose.journey-candidate.yml", "TARGET_JOURNEY_V3_REQUIRED", ["EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: backend", "EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: backend-standby"]],
    ["k3s.runtime.single-node-contract", "contracts/release/platform-k3s-runtime-contract.json", "TARGET_JOURNEY_V3_REQUIRED", ["\"version\": \"v1.36.3+k3s1\"", "\"activeServiceNodePort\": 32080", "\"multiHostHighAvailabilityClaim\": false", "\"result\": \"TYPED_NONZERO_OUTPUT_ZERO\""]],
    ["k3s.config.loopback-nodeport", "infra/k3s/config.yaml", "TARGET_JOURNEY_V3_REQUIRED", ["secrets-encryption: true", "  - traefik", "proxy-mode=iptables", "nodeport-addresses=127.0.0.0/8"]],
    ["k3s.service.pinned-server", "infra/k3s/easysubway-k3s.service", "TARGET_JOURNEY_V3_REQUIRED", ["ExecStart=/usr/local/bin/k3s server --config /etc/rancher/k3s/config.yaml", "Restart=on-failure", "TimeoutStopSec=45s"]],
    ["k3s.rbac.namespace-deployer", "infra/k3s/deployer-rbac.json", "TARGET_JOURNEY_V3_REQUIRED", ["\"kind\": \"Role\"", "\"pods/portforward\"", "\"namespace\": \"easysubway-journey\""]],
    ["k3s.bootstrap.exact-binary", "tools/platform/bootstrap-single-node-k3s.sh", "TARGET_JOURNEY_V3_REQUIRED", ["K3S_BINARY_SHA256=\"c9a209103f480f163b7c6a56f00862b4481927b284dc29a3716bb70d886691a8\"", "for attempt in $(seq 1 60)", "kubectl apply --server-side=true", "verify_runtime"]],
    ["k3s.renderer.immutable-candidate", "tools/platform/render-journey-kubernetes-candidate.mjs", "TARGET_JOURNEY_V3_REQUIRED", ["PLATFORM_K3S_CANDIDATE_RENDER_V1", "readOnlyRootFilesystem: true", "nodePort: 32080", "applyDuringCandidatePreparation: false"]],
  ];
  assert.deepEqual(Object.keys(inventory), ["schemaVersion", "artifactKind", "sourcePaths", "entries"]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.artifactKind, "platform-deployment-runtime-input-inventory-v1");
  assert.deepEqual(inventory.sourcePaths, sourcePaths);
  assert.equal(inventory.entries.length, 31);
  assert.equal(inventory.entries.filter(({ journeyV3Disposition }) => journeyV3Disposition === "TARGET_JOURNEY_V3_REQUIRED").length, 15);
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
  assert.match(deploy, /\[\[ ! "\$\{DEPLOY_IMAGE_DIGEST\}" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/);
  assert.doesNotMatch(deploy, /EASYSUBWAY_BACKEND_IMAGE_TAG/);
  assert.doesNotMatch(allowlist, /EASYSUBWAY_BACKEND_IMAGE(?:_TAG)?/);
});

test("legacy backend presence fails closed before deployment mutation without restore paths", () => {
  const root = new URL("../..", import.meta.url);
  const deploy = readFileSync(new URL("tools/deploy/deploy-backend.sh", root), "utf8");
  const preflight = deploy.indexOf("preflight_legacy_backend_absence() {");
  const candidateMutation = deploy.indexOf('timeout 600 docker compose');
  const promotion = deploy.indexOf('write_phase "promoting"');
  const trafficMutation = deploy.indexOf("install_route_v2_host_ingress");

  assert.equal(preflight >= 0, true, "legacy presence needs a dedicated fail-closed preflight");
  assert.equal(candidateMutation >= 0, true, "candidate mutation anchor must exist");
  assert.equal(promotion >= 0, true, "promotion anchor must exist");
  assert.equal(trafficMutation >= 0, true, "traffic mutation anchor must exist");
  assert.equal(deploy.indexOf("preflight_legacy_backend_absence\n") < candidateMutation, true, "legacy preflight must run before the candidate can mutate runtime state");
  assert.equal(preflight < candidateMutation, true);
  assert.equal(candidateMutation < promotion, true);
  assert.equal(candidateMutation < trafficMutation, true);
  assert.match(deploy, /local unit="easysubway-backend\.service"/);
  assert.match(deploy, /systemctl list-unit-files "\$\{unit\}"/);
  assert.match(deploy, /systemctl is-active --quiet "\$\{unit\}"/);
  assert.match(deploy, /systemctl is-enabled --quiet "\$\{unit\}"/);
  assert.match(deploy, /pgrep -f/);
  assert.match(deploy, /write_result "blocked" "legacy_backend_(unit|jar)_detected"/);
  assert.doesNotMatch(deploy, /LEGACY_BACKEND_(?:UNIT|JAR)/);
  assert.doesNotMatch(deploy, /restore_legacy_backend_service|restore_legacy_on_/);
  assert.doesNotMatch(deploy, /legacy_backend_was_(?:active|enabled)|legacy_restore_on_error/);
  assert.doesNotMatch(deploy, /trap [^\n]*(?:legacy|restore)[^\n]*(?:ERR|INT|TERM|HUP)/i);
  assert.doesNotMatch(deploy, /systemctl (?:enable|start) "(?:easysubway-backend\.service|\$\{unit\})"/);
});

test("legacy backend probe resolves each Java -jar argument before deciding legacy ownership", (t) => {
  const root = new URL("../..", import.meta.url);
  const procFixture = mkdtempSync(join(tmpdir(), "platform-legacy-proc-"));
  const existingProcRoot = join(procFixture, "existing");
  const missingProcRoot = join(procFixture, "missing");
  mkdirSync(join(existingProcRoot, "101"), { recursive: true });
  mkdirSync(missingProcRoot);
  t.after(() => rmSync(procFixture, { recursive: true, force: true }));
  const deploy = readFileSync(new URL("tools/deploy/deploy-backend.sh", root), "utf8");
  const match = deploy.match(/preflight_legacy_backend_absence\(\)\s*\{[\s\S]*?\n\}\s*\npreflight_legacy_backend_absence\b/);
  assert.notEqual(match, null);
  const functionSource = match[0].replace(/\s*\npreflight_legacy_backend_absence$/, "");
  const harness = `
set -euo pipefail
DEPLOY_ROOT=/opt/easysubway
PROC_FS_ROOT="\${PROC_FS_ROOT:?PROC_FS_ROOT is required}"
write_result() { printf '%s %s\\n' "$1" "$2"; }
systemctl() {
  case "$1" in
    list-unit-files)
      case "\${SYSTEMCTL_MODE}" in
        error) return 5 ;;
        unit) printf '%s\\n' 'easysubway-backend.service enabled'; return 0 ;;
        *) return 0 ;;
      esac
      ;;
    is-active) [[ "\${SYSTEMCTL_MODE}" == active ]] && return 0; [[ "\${SYSTEMCTL_MODE}" == active-error ]] && return 5; return 3 ;;
    is-enabled) [[ "\${SYSTEMCTL_MODE}" == enabled ]] && return 0; [[ "\${SYSTEMCTL_MODE}" == enabled-error ]] && return 5; return 1 ;;
  esac
}
pgrep() {
  case "\${PGREP_MODE}" in
    error) return 2 ;;
    absent) return 1 ;;
    *) printf '%s\\n' 101; return 0 ;;
  esac
}
cat() {
  case "\${PGREP_MODE}" in
    unreadable-proc|exited-proc) return 1 ;;
    options) printf 'java\\0-Xms512m\\0-jar\\0/opt/easysubway/easysubway-backend.jar\\0' ;;
    relative|unreadable-cwd|exited-cwd) printf 'java\\0-jar\\0easysubway-backend.jar\\0' ;;
    symlink) printf 'java\\0-jar\\0/srv/legacy/application.jar\\0' ;;
    other-jar) printf 'java\\0-jar\\0/srv/other/application.jar\\0' ;;
    no-jar) printf 'java\\0-Xms512m\\0-XX:+UseG1GC\\0' ;;
    *) return 1 ;;
  esac
}
readlink() {
  local path="\${!#}"
  case "\${PGREP_MODE}:\${path}" in
    unreadable-cwd:\${PROC_FS_ROOT}/101/cwd|exited-cwd:\${PROC_FS_ROOT}/101/cwd) return 1 ;;
    *:\${PROC_FS_ROOT}/101/cwd) printf '%s\\n' /opt/easysubway ;;
    *:/opt/easysubway/easysubway-backend.jar) printf '%s\\n' /opt/easysubway/easysubway-backend.jar ;;
    relative:/opt/easysubway/easysubway-backend.jar) printf '%s\\n' /opt/easysubway/easysubway-backend.jar ;;
    symlink:/srv/legacy/application.jar) printf '%s\\n' /opt/easysubway/easysubway-backend.jar ;;
    other-jar:/srv/other/application.jar) printf '%s\\n' /srv/other/application.jar ;;
    *) return 1 ;;
  esac
}
${functionSource}
preflight_legacy_backend_absence
`;
  const runProbe = (systemctlMode, pgrepMode) => spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      SYSTEMCTL_MODE: systemctlMode,
      PGREP_MODE: pgrepMode,
      PROC_FS_ROOT: ["exited-proc", "exited-cwd"].includes(pgrepMode) ? missingProcRoot : existingProcRoot,
    },
  });

  const absent = runProbe("absent", "absent");
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "");
  for (const mode of ["unit", "active", "enabled"]) {
    const detected = runProbe(mode, "absent");
    assert.equal(detected.status, 1, mode);
    assert.match(detected.stdout, /^blocked legacy_backend_unit_detected\n$/, mode);
  }
  for (const mode of ["active-error", "enabled-error"]) {
    const failed = runProbe(mode, "absent");
    assert.equal(failed.status, 1, mode);
    assert.match(failed.stdout, /^blocked legacy_backend_probe_failed\n$/, mode);
  }
  for (const result of [runProbe("error", "absent"), runProbe("absent", "error")]) {
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^blocked legacy_backend_probe_failed\n$/);
  }
  const options = runProbe("absent", "options");
  assert.equal(options.status, 1);
  assert.match(options.stdout, /^blocked legacy_backend_jar_detected\n$/);
  for (const mode of ["relative", "symlink"]) {
    const detected = runProbe("absent", mode);
    assert.equal(detected.status, 1, mode);
    assert.match(detected.stdout, /^blocked legacy_backend_jar_detected\n$/, mode);
  }
  for (const mode of ["other-jar", "no-jar"]) {
    const allowed = runProbe("absent", mode);
    assert.equal(allowed.status, 0, mode);
    assert.equal(allowed.stdout, "", mode);
  }
  for (const mode of ["exited-proc", "exited-cwd"]) {
    const allowed = runProbe("absent", mode);
    assert.equal(allowed.status, 0, mode);
    assert.equal(allowed.stdout, "", mode);
  }
  for (const mode of ["unreadable-proc", "unreadable-cwd"]) {
    const failed = runProbe("absent", mode);
    assert.equal(failed.status, 1, mode);
    assert.match(failed.stdout, /^blocked legacy_backend_probe_failed\n$/, mode);
  }
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
