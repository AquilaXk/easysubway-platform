import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const renderer = new URL("tools/platform/render-journey-kubernetes-candidate.mjs", root);
const digest = (character) => `sha256:${character.repeat(64)}`;

test("K3s runtime contract pins one practical single-node serving boundary", () => {
  const contract = readJson("contracts/release/platform-k3s-runtime-contract.json");
  const schema = readJson("contracts/release/platform-k3s-runtime-contract.schema.json");
  const config = readText("infra/k3s/config.yaml");
  const service = readText("infra/k3s/easysubway-k3s.service");
  const rbac = readJson("infra/k3s/deployer-rbac.json");
  const bootstrap = readText("tools/platform/bootstrap-single-node-k3s.sh");
  const workflow = readText(".github/workflows/ci.yml");

  assert.equal(contract.schemaVersion, "PLATFORM_K3S_RUNTIME_CONTRACT_V1");
  assert.equal(contract.issueRef.issueNumber, 111);
  assert.deepEqual(contract.distribution, {
    name: "K3S",
    version: "v1.36.3+k3s1",
    architecture: "arm64",
    binaryUrl: "https://github.com/k3s-io/k3s/releases/download/v1.36.3%2Bk3s1/k3s-arm64",
    binarySha256: "c9a209103f480f163b7c6a56f00862b4481927b284dc29a3716bb70d886691a8",
  });
  assert.deepEqual(contract.packagedComponents.disabled, ["traefik", "servicelb", "metrics-server", "local-storage"]);
  assert.deepEqual(contract.networking, {
    edgeOwner: "HOST_NGINX",
    kubeProxyMode: "iptables",
    nodePortAddresses: ["127.0.0.0/8"],
    activeServiceNodePort: 32080,
    publicNodePortCount: 0,
    ingressControllerCount: 0,
  });
  assert.equal(contract.capacity.nodeCount, 1);
  assert.equal(contract.capacity.activeReplicaCount, 1);
  assert.equal(contract.capacity.maximumTransientCandidateReplicas, 1);
  assert.equal(contract.capacity.multiHostHighAvailabilityClaim, false);
  assert.equal(contract.state.postgres.mode, "SAME_HOST_EXTERNAL_COMPOSE_SERVICE");
  assert.equal(contract.state.objectStorage.mode, "SAME_HOST_EXTERNAL_COMPOSE_SERVICE");
  assert.equal(contract.state.hostPathCount, 0);
  assert.equal(contract.state.persistentVolumeClaimCount, 0);
  assert.deepEqual(schema.const, contract);

  for (const component of contract.packagedComponents.disabled) assert.match(config, new RegExp(`  - ${component}\\n`));
  assert.match(config, /secrets-encryption: true/);
  assert.match(config, /proxy-mode=iptables/);
  assert.match(config, /nodeport-addresses=127\.0\.0\.0\/8/);
  assert.match(service, /^ExecStart=\/usr\/local\/bin\/k3s server --config \/etc\/rancher\/k3s\/config\.yaml$/m);
  assert.match(service, /^Restart=on-failure$/m);

  const role = rbac.items.find(({ kind }) => kind === "Role");
  assert.equal(role.metadata.namespace, "easysubway-journey");
  assert.equal(rbac.items.some(({ kind }) => ["ClusterRole", "ClusterRoleBinding"].includes(kind)), false);
  assert.equal(JSON.stringify(role.rules).includes("*"), false);
  assert.equal(JSON.stringify(role.rules).includes("nodes"), false);

  assert.match(bootstrap, /v1\.36\.3\+k3s1/);
  assert.match(bootstrap, /c9a209103f480f163b7c6a56f00862b4481927b284dc29a3716bb70d886691a8/);
  assert.match(bootstrap, /--proto '=https' --tlsv1\.2/);
  assert.doesNotMatch(bootstrap, /curl[^\n]*\|\s*(?:sh|bash)/);
  assert.doesNotMatch(bootstrap, /latest|sleep\s+[0-9]+\s*;\s*done/i);
  assert.match(bootstrap, /for attempt in \$\(seq 1 60\)/);
  assert.match(bootstrap, /--mode (?:INSTALL|VERIFY)/);
  assert.doesNotMatch(bootstrap, /kubectl auth can-i[^\n]*\|\s*grep/);
  assert.match(bootstrap, /E_K3S_RBAC_NAMESPACE_SCOPE/);
  assert.match(bootstrap, /E_K3S_RBAC_CLUSTER_SCOPE/);
  assert.ok(
    bootstrap.indexOf("systemctl stop easysubway-k3s.service")
      < bootstrap.indexOf('install -D -m 0755 "${temporary}" "${K3S_BINARY}"'),
  );
  assert.match(bootstrap, /systemctl enable easysubway-k3s\.service/);
  assert.match(bootstrap, /systemctl restart easysubway-k3s\.service/);
  assert.match(workflow, /node --test tools\/platform\/single-node-k3s-foundation\.test\.mjs/);
  assert.match(workflow, /bash -n tools\/platform\/bootstrap-single-node-k3s\.sh/);
});

test("renderer produces deterministic source-free candidate objects and an inactive Service CAS plan", () => {
  const input = validInput();
  const first = runRenderer(input);
  const second = runRenderer(input);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, "");

  const rendered = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(rendered), [
    "schemaVersion",
    "artifactKind",
    "releaseIdentity",
    "configPlan",
    "secretPlan",
    "candidateObjects",
    "activationPlan",
  ]);
  assert.equal(rendered.schemaVersion, "PLATFORM_K3S_CANDIDATE_RENDER_V1");
  assert.equal(rendered.releaseIdentity.tupleSha256, expectedTupleSha256(input.releaseTuple));
  assert.equal(rendered.releaseIdentity.candidateGeneration, 7);
  assert.equal(rendered.releaseIdentity.trafficGeneration, 12);
  assert.equal(rendered.configPlan.immutable, true);
  assert.deepEqual(rendered.configPlan.internalEndpoints.objectStorage, {
    scheme: "HTTP",
    host: "journey-object-storage.easysubway-journey.svc",
    port: 9000,
  });
  assert.equal(
    rendered.configPlan.overrides.EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION,
    input.releaseTuple.deploymentRevision,
  );
  assert.equal(rendered.secretPlan.immutable, true);
  assert.equal(rendered.secretPlan.requiredKeyProjection, "EXACT_VALIDATED_BACKEND_ENV_ALLOWLIST");
  assert.equal(rendered.secretPlan.serializedValueCount, 0);

  const objects = rendered.candidateObjects;
  assert.deepEqual(objects.map(({ kind, metadata }) => `${kind}/${metadata.name}`), [
    "Namespace/easysubway-journey",
    "ServiceAccount/journey-backend",
    "Service/journey-postgres",
    "EndpointSlice/journey-postgres-v1",
    "Service/journey-object-storage",
    "EndpointSlice/journey-object-storage-v1",
    `Deployment/${rendered.activationPlan.candidateDeploymentName}`,
    `Service/${rendered.activationPlan.candidateServiceName}`,
    "NetworkPolicy/journey-backend-boundary",
  ]);

  const deployment = objects.find(({ kind }) => kind === "Deployment");
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.progressDeadlineSeconds, 360);
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.terminationGracePeriodSeconds, 30);
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } });
  assert.equal(container.image, `ghcr.io/aquilaxk/easysubway-backend@${input.releaseTuple.backendImageDigest}`);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(container.resources, {
    requests: { cpu: "250m", memory: "1Gi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1500m", memory: "4Gi", "ephemeral-storage": "1Gi" },
  });
  assert.deepEqual(container.envFrom, [
    { configMapRef: { name: rendered.configPlan.name } },
    { secretRef: { name: rendered.secretPlan.name } },
  ]);
  for (const probe of [container.startupProbe, container.readinessProbe, container.livenessProbe]) {
    assert.equal(probe.httpGet.port, 8080);
  }
  const startupBudgetSeconds = container.startupProbe.initialDelaySeconds
    + (container.startupProbe.periodSeconds * container.startupProbe.failureThreshold);
  assert.ok(startupBudgetSeconds < deployment.spec.progressDeadlineSeconds);

  const postgresSlice = objects.find(({ kind, metadata }) => kind === "EndpointSlice" && metadata.name === "journey-postgres-v1");
  const objectSlice = objects.find(({ kind, metadata }) => kind === "EndpointSlice" && metadata.name === "journey-object-storage-v1");
  assert.deepEqual(postgresSlice.endpoints, [{ addresses: [input.nodeInternalIp] }]);
  assert.equal(postgresSlice.ports[0].port, 15432);
  assert.equal(objectSlice.ports[0].port, 9000);

  assert.equal(rendered.activationPlan.activeServiceTemplate.spec.type, "NodePort");
  assert.equal(rendered.activationPlan.activeServiceTemplate.spec.ports[0].nodePort, 32080);
  assert.deepEqual(rendered.activationPlan.nodePortAddresses, ["127.0.0.0/8"]);
  assert.equal(
    rendered.activationPlan.candidateProbeBoundary,
    readJson("contracts/release/platform-k3s-runtime-contract.json").activationBoundary.candidateProbeBoundary,
  );
  assert.equal(rendered.activationPlan.selectorPatch["easysubway.io/candidate-token"], rendered.releaseIdentity.candidateToken);
  assert.equal(rendered.activationPlan.applyDuringCandidatePreparation, false);
  assert.equal(first.stdout.includes("synthetic-secret-value"), false);
});

test("renderer rejects malformed or mutable identity and secret-bearing input with output zero", () => {
  const input = validInput();
  const invalid = [
    { ...input, unexpected: true },
    { ...input, tupleSha256: digest("f") },
    { ...input, candidateGeneration: 0 },
    { ...input, trafficGeneration: 0 },
    { ...input, trafficGeneration: -1 },
    { ...input, nodeInternalIp: "127.0.0.1" },
    { ...input, postgresPort: 5432 },
    { ...input, objectStoragePort: 80 },
    { ...input, secretIdentity: "latest" },
    { ...input, secretValue: "synthetic-secret-value" },
    { ...input, releaseTuple: { ...input.releaseTuple, backendImageDigest: "latest" } },
    { ...input, releaseTuple: { ...input.releaseTuple, environmentIdentity: "production\n" } },
  ];

  for (const value of invalid) {
    const result = runRenderer(value);
    assert.equal(result.status, 2, JSON.stringify(value));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^E_K3S_RENDER_(?:INPUT|IDENTITY|NETWORK)\b/);
  }
});

test("renderer has no provider, Kubernetes API, shell, or ambient environment side effect", () => {
  const source = readText("tools/platform/render-journey-kubernetes-candidate.mjs");
  assert.doesNotMatch(source, /\b(?:fetch|kubectl|curl|docker|gh)\b/);
  assert.doesNotMatch(source, /node:child_process|process\.env|https?:\/\//);
  assert.doesNotMatch(source, /(?:^|[,{]\s*)(?:data|stringData)\s*:/m);
});

test("runtime inventory records the K3s foundation as target-only input", () => {
  const inventory = readJson("contracts/release/platform-deployment-runtime-input-inventory.json");
  const ids = inventory.entries.filter(({ id }) => id.startsWith("k3s.")).map(({ id }) => id);
  assert.deepEqual(ids, [
    "k3s.runtime.single-node-contract",
    "k3s.config.loopback-nodeport",
    "k3s.service.pinned-server",
    "k3s.rbac.namespace-deployer",
    "k3s.bootstrap.exact-binary",
    "k3s.renderer.immutable-candidate",
  ]);
  for (const entry of inventory.entries.filter(({ id }) => id.startsWith("k3s."))) {
    assert.equal(entry.journeyV3Disposition, "TARGET_JOURNEY_V3_REQUIRED");
  }
});

function validInput() {
  const releaseTuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("a"),
    backendConfigDigest: digest("b"),
    journeyContractDigest: digest("c"),
    serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
  };
  return {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_INPUT_V1",
    artifactKind: "platform-k3s-candidate-input",
    releaseTuple,
    tupleSha256: expectedTupleSha256(releaseTuple),
    candidateGeneration: 7,
    trafficGeneration: 12,
    nodeInternalIp: "10.0.0.12",
    postgresPort: 15432,
    objectStoragePort: 9000,
    secretIdentity: digest("9"),
  };
}

function expectedTupleSha256(tuple) {
  const fields = ["backendImageDigest", "backendConfigDigest", "journeyContractDigest", "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity"];
  return `sha256:${createHash("sha256").update(`${fields.map((field) => tuple[field]).join("\n")}\n`).digest("hex")}`;
}

function runRenderer(value) {
  const temporary = mkdtempSync(join(tmpdir(), "platform-k3s-render-"));
  const input = join(temporary, "input.json");
  try {
    writeFileSync(input, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return spawnSync(process.execPath, [renderer.pathname, "--input", input], { encoding: "utf8" });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(new URL(path, root), "utf8");
}
