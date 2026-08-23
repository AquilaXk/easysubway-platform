import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitServiceCasWithReconciliation,
  createK3sJourneyActivationEffects,
  K3sJourneyActivationError,
  parseRunningComposeServices,
  renderK3sNginxConfig,
  runK3sJourneyActivation,
  waitForActiveEndpoint,
} from "./run-k3s-journey-activation.mjs";
import { prepareSourceFreeK3sDeployment } from "./prepare-source-free-k3s-deployment.mjs";
const digest = (value) => `sha256:${value.repeat(64)}`;
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function schemaAccepts(value, schema, root = schema) {
  if (schema.$ref) {
    const target = schema.$ref.slice("#/".length).split("/").reduce(
      (current, segment) => current?.[segment],
      root,
    );
    return target !== undefined && schemaAccepts(value, target, root);
  }
  if (schema.allOf && !schema.allOf.every((part) => schemaAccepts(value, part, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => schemaAccepts(value, part, root)).length !== 1) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((entry) => Object.is(value, entry))) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) return false;
  if (schema.type === "string" && (typeof value !== "string" ||
    value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) ||
    (schema.pattern && !(new RegExp(schema.pattern).test(value))))) return false;
  if (schema.type !== "object" && !schema.properties) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
  if (schema.minProperties && Object.keys(value).length < schema.minProperties) return false;
  for (const [key, item] of Object.entries(value)) {
    const property = schema.properties?.[key];
    if (!property && schema.additionalProperties === false) return false;
    if (!schemaAccepts(item, property ?? schema.additionalProperties ?? {}, root)) return false;
  }
  return true;
}
function failureReceipt(phase, failureCode) {
  return {
    schemaVersion: "PLATFORM_K3S_ACTIVATION_FAILURE_V1",
    artifactKind: "platform-k3s-activation-failure",
    orchestrator: "K3S",
    phase,
    operationId: digest("0"),
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/31700000000",
    failedAt: "2026-08-14T04:01:00.000Z",
    releaseIdentity: {
      tupleSha256: digest("1"), backendImageDigest: digest("2"), backendConfigDigest: digest("3"),
      journeyContractDigest: digest("4"), serverRouteBundleDigest: digest("5"),
      deploymentRevision: "6".repeat(40), environmentIdentity: "production",
      candidateGeneration: 23, trafficGeneration: 41,
    },
    mutationCounts: { activeService: 0, nginx: 0, oldWorkload: 0 },
    serviceCas: null,
    rollbackAttemptCount: 0,
    degradedSuccess: false,
    successReceiptCreated: false,
    fallbackZero: {
      legacyGraphSuccessCount: 0, localRouteInvocationCount: 0,
      staleJourneyServedCount: 0, alternateEndpointSuccessCount: 0,
    },
    failureCode,
  };
}
function request(root) {
  return {
    schemaVersion: "PLATFORM_SOURCE_FREE_K3S_ACTIVATION_REQUEST_V1",
    artifactKind: "platform-source-free-k3s-activation-request",
    operationDirectory: path.join(root, "operation"), operationId: digest("7"),
    deployRoot: root,
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/31700000000",
    generatedAt: "2026-08-14T04:00:00.000Z",
    runtimeContractSha256: digest("8"), candidateInputPath: path.join(root, "candidate-input.json"),
    tuplePath: path.join(root, "journey-release-tuple.json"), bindingPath: path.join(root, "candidate-binding.json"),
    descriptorBindingPath: path.join(root, "descriptor-binding.json"),
    composeEnvPath: path.join(root, "compose.env"), backendEnvPath: path.join(root, "backend.env"),
    baseComposePath: path.join(root, "docker-compose.yml"),
    candidateComposePath: path.join(root, "docker-compose.journey-candidate.yml"),
    projectName: "easysubway", nginxConfigPath: path.join(root, "easysubway.conf"),
    publicBaseUrl: "https://api.easysubway.kr",
    releaseTuple: {
      schemaVersion: "JOURNEY_RELEASE_TUPLE_V1", artifactKind: "journey-release-tuple",
      backendImageDigest: digest("a"), backendConfigDigest: digest("b"),
      journeyContractDigest: digest("c"), serverRouteBundleDigest: digest("d"),
      deploymentRevision: "e".repeat(40),
      environmentIdentity: "production", tupleSha256: digest("f"),
    },
    candidateGeneration: 23, trafficGeneration: 41,
    canary: {
      canaryRequestIdentity: digest("1"), requestId: "deploy-canary-113",
      originStationId: "subway-seoul-150", destinationStationId: "subway-seoul-222",
      mobilityProfile: "WHEELCHAIR", constraintMode: "STRICT",
      maxTransfers: 2, alternativeCount: 1,
    },
    platformBundle: {
      hubRevision: "e14964e588ef79b1cff6e01e18d8b943d7724420",
      bundleSha256: digest("9"), resourceSetSha256: digest("8"), acquisitionEvidenceDigest: digest("7"),
      runtimeContractPath: path.join(root, "platform-contracts", "resources", "platform", "k3s-runtime-contract.json"),
    },
  };
}
async function writePlatformBundle(root) {
  const bundleRoot = path.join(root, "platform-contracts");
  const resources = [
    ["platform/deployment-contract.json", Buffer.from(`{
  "schemaVersion": 1,
  "artifactKind": "platform-deployment-contract",
  "contractVersion": "platform-v1",
  "allowedProducerRepositories": [
    "AquilaXk/easysubway",
    "AquilaXk/easysubway-backend"
  ],
  "artifactNamePattern": "^easysubway-backend-release-[a-f0-9]{40}$",
  "imageRepository": "ghcr.io/aquilaxk/easysubway-backend",
  "platformRepository": "AquilaXk/easysubway-platform",
  "gitShaPattern": "^[a-f0-9]{40}$",
  "sha256Pattern": "^[a-f0-9]{64}$",
  "imageDigestPattern": "^sha256:[a-f0-9]{64}$",
  "issueRefPattern": "^AquilaXk/(easysubway|easysubway-data|easysubway-platform|easysubway-backend|easysubway-mobile)#[1-9][0-9]*$",
  "forbiddenInputs": [
    "branch",
    "buildContext",
    "sourceDirectory",
    "mutableImageTag"
  ]
}\n`)],
    ["platform/k3s-activation-contract.json", "../../contracts/release/platform-k3s-activation-contract.json"],
    ["platform/k3s-runtime-contract.json", "../../contracts/release/platform-k3s-runtime-contract.json"],
    ["platform/k3s-runtime-contract.schema.json", "../../contracts/release/platform-k3s-runtime-contract.schema.json"],
    ["platform/k3s-activation-receipt.schema.json", "../../contracts/release/platform-k3s-activation-receipt.schema.json"],
  ];
  const evidenceResources = [];
  for (const [resourcePath, source] of resources) {
    const bytes = Buffer.isBuffer(source) ? source : await readFile(new URL(source, import.meta.url));
    const target = path.join(bundleRoot, "resources", resourcePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    evidenceResources.push({ resourcePath, sha256: sha256(bytes) });
  }
  const resourceSetSha256 = sha256(Buffer.from(evidenceResources.map((entry) => `${entry.resourcePath}\n${entry.sha256.slice(7)}\n`).join("")));
  await writeFile(path.join(bundleRoot, "evidence.json"), `${JSON.stringify({
    schemaVersion: "PLATFORM_HUB_BUNDLE_ACQUISITION_EVIDENCE_V1", artifactKind: "platform-hub-bundle-acquisition-evidence",
    hubRevision: "e14964e588ef79b1cff6e01e18d8b943d7724420",
    bundleSha256: "sha256:ffbfed08c46916a6a9f7e1bf3d3de46989fe4f2517ed341bd2e2f89e02b7ce58",
    resourceSetSha256, resources: evidenceResources,
  }, null, 2)}\n`);
  return bundleRoot;
}
function effects(events, failAt) {
  const fails = (name) => Array.isArray(failAt) ? failAt.includes(name) : name === failAt;
  const proof = (value, fields = {}) => ({ ...fields, evidenceDigest: digest(value) });
  const step = (name, result) => async () => {
    events.push(name);
    if (fails(name)) throw new Error(`injected ${name}`);
    return structuredClone(result);
  };
  return {
    verifyInputs: step("inputs.verify", proof("0")),
    verifyRuntime: step("runtime.verify", proof("1", { nodeInternalIp: "10.0.0.17" })),
    applyCandidate: step("candidate.apply", proof("2", {
      deploymentName: "journey-candidate-23",
      candidateServiceName: "journey-candidate-23",
    })),
    openCandidatePortForward: async () => {
      events.push("candidate.port-forward.open");
      if (fails("candidate.port-forward.open")) throw new Error("candidate.port-forward.open");
      return proof("3", {
        baseUrl: "http://127.0.0.1:38113",
        close: async () => events.push("candidate.port-forward.close"),
      });
    },
    runCandidateCanary: step("candidate.canary", proof("4", {
      passed: true,
      legacyGraphSuccessCount: 0,
      localRouteInvocationCount: 0,
      staleJourneyServedCount: 0,
      alternateEndpointSuccessCount: 0,
    })),
    observeCandidate: step("candidate.observe", proof("5", {
      ready: true, tupleSha256: digest("f"),
    })),
    admitCandidate: step("candidate.admit", proof("6", {
      candidateAdmissionSha256: digest("6"),
    })),
    activateCandidate: step("candidate.activate", proof("e", {
      trafficGeneration: 41,
      activeReadinessEvidenceDigest: digest("e"),
    })),
    prepareActiveService: step("active-service.prepare", proof("7", {
      serviceExisted: false, resourceVersion: "817",
      activeServiceMutationCount: 1,
    })),
    commitActiveServiceCas: step("active-service.cas", proof("8", {
      previousResourceVersion: "817", committedResourceVersion: "818",
      selector: { "easysubway.io/candidate-generation": "23" },
    })),
    verifyActiveEndpoint: step("active-endpoint.verify", proof("9", {
      readyAddress: "10.42.0.23", nodePort: 32080,
      tupleSha256: digest("f"),
    })),
    switchNginx: step("nginx.switch", proof("a", {
      targetPort: 32080,
      nginxConfigSha256: digest("a"),
    })),
    drainOldWorkloads: step("old-workload.drain", proof("b", {
      signal: "SIGTERM", stopGracePeriodSeconds: 30,
      oldWorkloadCount: 2,
    })),
    runPublicSmoke: step("public.smoke", proof("c", {
      passed: true,
      tupleSha256: digest("f"),
    })),
    cleanupCandidateService: step("candidate-service.cleanup", proof("d", { removed: true })),
    cleanupCandidate: step("candidate.cleanup", undefined),
  };
}
async function missing(pathname) {
  await assert.rejects(access(pathname));
}
test("preparer projects validated fixed-host inputs into a distinct secret-free K3s request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-preparation-"));
  const backendEnvironment = "DATABASE_PASSWORD=private-test-value\nSAFE_FLAG=true\n";
  const identity = {
    backendImageDigest: digest("a"), backendConfigDigest: sha256(backendEnvironment),
    journeyContractDigest: digest("c"), serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40), environmentIdentity: "production",
  };
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1", artifactKind: "journey-release-tuple",
    ...identity,
    tupleSha256: sha256(`${Object.values(identity).join("\n")}\n`),
  };
  const paths = {
    tuple: path.join(root, "journey-release-tuple.json"), binding: path.join(root, "candidate-binding.json"),
    descriptorBinding: path.join(root, "descriptor-binding.json"),
    backendEnv: path.join(root, "backend.env"), fixedRequest: path.join(root, "fixed-host-request.json"),
    candidateInput: path.join(root, "k3s-candidate-input.json"),
    request: path.join(root, "k3s-request.json"),
  };
  await Promise.all([
    writeFile(paths.tuple, `${JSON.stringify(tuple, null, 2)}\n`),
    writeFile(paths.binding, JSON.stringify({
      orchestrator: "COMPOSE",
      tupleSha256: tuple.tupleSha256,
    })),
    writeFile(paths.descriptorBinding, JSON.stringify({
      tupleSha256: tuple.tupleSha256,
    })),
    writeFile(paths.backendEnv, backendEnvironment),
  ]);
  const fixedRequest = {
    schemaVersion: "PLATFORM_FIXED_HOST_ACTIVATION_REQUEST_V1", artifactKind: "platform-fixed-host-activation-request",
    operationDirectory: path.join(root, "receipts", "113"),
    operationId: digest("7"),
    deployRoot: root, runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/31700000000",
    generatedAt: "2026-08-14T04:00:00.000Z",
    bindingPath: paths.binding, descriptorBindingPath: paths.descriptorBinding,
    tuplePath: paths.tuple,
    descriptorPath: path.join(root, "descriptor.json"),
    composeEnvPath: path.join(root, "compose.env"), backendEnvPath: paths.backendEnv,
    projectName: "easysubway",
    nginxConfigPath: "/etc/nginx/sites-available/easysubway",
    baseComposePath: path.join(root, "docker-compose.yml"),
    candidateComposePath: path.join(root, "docker-compose.journey-candidate.yml"),
    candidateGeneration: 23, trafficGeneration: 41,
    canary: request(root).canary,
  };
  await writeFile(paths.fixedRequest, `${JSON.stringify(fixedRequest, null, 2)}\n`);
  const platformContractBundlePath = await writePlatformBundle(root);
  const result = await prepareSourceFreeK3sDeployment({
    mode: "PREVIEW",
    fixedHostRequestPath: paths.fixedRequest,
    candidateInputOutputPath: paths.candidateInput,
    requestOutputPath: paths.request,
    nodeInternalIp: "10.0.0.17",
    publicBaseUrl: "https://api.easysubway.kr",
    platformContractBundlePath,
  });
  const candidateInput = JSON.parse(await readFile(paths.candidateInput, "utf8"));
  const k3sRequest = JSON.parse(await readFile(paths.request, "utf8"));
  assert.equal(result.orchestrator, "K3S");
  assert.equal(result.preparationFoundation, "COMPOSE_INPUT_VALIDATION_ONLY");
  assert.equal(result.externalMutationCount, 0);
  assert.equal(result.fallbackInvocationCount, 0);
  assert.equal(candidateInput.secretIdentity, sha256(backendEnvironment));
  assert.equal(candidateInput.nodeInternalIp, "10.0.0.17");
  assert.equal(k3sRequest.releaseTuple.tupleSha256, tuple.tupleSha256);
  assert.equal(k3sRequest.platformBundle.hubRevision, "e14964e588ef79b1cff6e01e18d8b943d7724420");
  assert.match(k3sRequest.platformBundle.bundleSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(k3sRequest.platformBundle.acquisitionEvidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(k3sRequest.operationDirectory, fixedRequest.operationDirectory);
  assert.doesNotMatch(JSON.stringify(result), /private-test-value/);
  assert.doesNotMatch(JSON.stringify(k3sRequest), /private-test-value/);
});
test("activation Secret injects the protected readiness token without exposing it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-protected-secret-"));
  const protectedToken = "p".repeat(32);
  const untrustedToken = "u".repeat(32);
  const activationRequest = request(root);
  await writePlatformBundle(root);
  const runtimeBytes = await readFile(new URL(
    "../../contracts/release/platform-k3s-runtime-contract.json", import.meta.url,
  ));
  activationRequest.runtimeContractSha256 = sha256(runtimeBytes);
  const backendEnvironment = [
    "DATABASE_PASSWORD=private-test-value",
    "SAFE_FLAG=true",
    `EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN=${untrustedToken}`,
    "",
  ].join("\n");
  const candidateInput = {
    tupleSha256: activationRequest.releaseTuple.tupleSha256,
    candidateGeneration: activationRequest.candidateGeneration,
    trafficGeneration: activationRequest.trafficGeneration,
    secretIdentity: sha256(backendEnvironment),
    nodeInternalIp: "10.0.0.17",
  };
  await Promise.all([
    writeFile(activationRequest.candidateInputPath, JSON.stringify(candidateInput)),
    writeFile(activationRequest.backendEnvPath, backendEnvironment),
  ]);
  const createdSecrets = [];
  const rendered = {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_RENDER_V1",
    artifactKind: "platform-k3s-candidate-render",
    releaseIdentity: {
      tupleSha256: activationRequest.releaseTuple.tupleSha256,
      candidateToken: "candidate-23",
    },
    configPlan: { name: "journey-config-23", overrides: { SAFE_CONFIG: "true" } },
    secretPlan: { name: "journey-secret-23" },
    candidateObjects: [],
    activationPlan: {
      requiredCasField: "metadata.resourceVersion",
      applyDuringCandidatePreparation: false,
      activeServiceTemplate: { spec: { ports: [{ nodePort: 32080 }] } },
      candidateDeploymentName: "journey-candidate-23",
      candidateServiceName: "journey-candidate-23",
    },
  };
  const commandRunner = async (command, args, options = {}) => {
    if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
    if (args.includes("create")) createdSecrets.push(JSON.parse(Buffer.from(options.input).toString("utf8")));
    return { stdout: Buffer.alloc(0) };
  };
  const activationEffects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner,
    serviceToken: protectedToken,
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  const verified = await activationEffects.verifyInputs();
  const candidate = await activationEffects.applyCandidate();
  assert.deepEqual(createdSecrets, [{
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "journey-secret-23", namespace: "easysubway-journey" },
    immutable: true,
    type: "Opaque",
    stringData: {
      DATABASE_PASSWORD: "private-test-value",
      SAFE_FLAG: "true",
      EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN: protectedToken,
    },
  }]);
  for (const value of [activationRequest, verified, candidate]) {
    assert.doesNotMatch(JSON.stringify(value), new RegExp(`${protectedToken}|${untrustedToken}`));
  }
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal(ci.split("node --test tools/platform/source-free-k3s-deployment.test.mjs").length - 1, 1);
});
test("success linearizes traffic with Service resourceVersion CAS before Nginx and drain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activation-success-"));
  const events = [];
  const receipt = await runK3sJourneyActivation(request(root), effects(events));
  assert.deepEqual(events, [
    "inputs.verify", "runtime.verify", "candidate.apply", "candidate.port-forward.open",
    "candidate.canary", "candidate.observe", "candidate.admit", "candidate.activate",
    "active-service.prepare", "active-service.cas", "active-endpoint.verify",
    "nginx.switch", "old-workload.drain", "public.smoke", "candidate-service.cleanup",
    "candidate.port-forward.close",
  ]);
  assert.equal(receipt.schemaVersion, "PLATFORM_K3S_ACTIVATION_RECEIPT_V1");
  assert.equal(receipt.outcome, "ACTIVE_SERVING"); assert.equal(receipt.orchestrator, "K3S");
  assert.equal(receipt.releaseIdentity.tupleSha256, digest("f"));
  assert.equal(receipt.activation.serviceCas.previousResourceVersion, "817");
  assert.equal(receipt.activation.serviceCas.committedResourceVersion, "818");
  assert.equal(receipt.candidate.activeReadinessEvidenceDigest, digest("e"));
  assert.equal(receipt.activation.nginx.targetPort, 32080); assert.equal(receipt.activation.drain.signal, "SIGTERM");
  assert.deepEqual(Object.values(receipt.fallbackZero), [0, 0, 0, 0]);
  assert.equal(receipt.bundleAcquisitionEvidenceDigest, digest("7"));
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(root, "operation", "k3s-activation-receipt.json"),
      "utf8",
    )),
    receipt,
  );
  await missing(path.join(root, "operation", "k3s-activation-failure.json"));
});
test("Nginx cutover changes exactly three backend targets and preserves other routes", () => {
  const current = Buffer.from([
    "location = /api/v2/routes/search { proxy_pass http://127.0.0.1:8081; }",
    "location = /actuator/health/readiness { proxy_pass http://127.0.0.1:8080; }",
    "location = /actuator/health/liveness { proxy_pass http://127.0.0.1:8080; }",
    "location / { proxy_pass http://127.0.0.1:8080; }",
    "",
  ].join("\n"));
  const k3s = renderK3sNginxConfig(current);
  assert.equal(k3s.toString("utf8").match(/127\.0\.0\.1:32080/g)?.length, 3);
  assert.match(k3s.toString("utf8"), /127\.0\.0\.1:8081/);
  assert.deepEqual(renderK3sNginxConfig(k3s), k3s);
  assert.throws(() => renderK3sNginxConfig(Buffer.from(
    "proxy_pass http://127.0.0.1:8080;\n",
  )));
});
test("post-CAS helpers wait for reconciliation, recover ambiguous commit and count running Compose services", async () => {
  let reads = 0;
  const endpoint = await waitForActiveEndpoint({
    readSnapshot: async () => ({
      pods: { items: [{ metadata: { uid: "pod-23", annotations: { "easysubway.io/tuple-sha256": digest("f") } }, status: { phase: "Running", podIP: "10.42.0.23", conditions: [{ type: "Ready", status: "True" }] } }] },
      slices: { items: reads++ === 0 ? [] : [{ endpoints: [{ addresses: ["10.42.0.23"], conditions: { ready: true } }] }] },
    }),
    tupleSha256: digest("f"), attempts: 2, wait: async () => {},
  });
  assert.equal(endpoint.readyAddress, "10.42.0.23"); assert.equal(reads, 2);
  const cas = await commitServiceCasWithReconciliation({
    replace: async () => { throw new Error("response lost"); },
    readCurrent: async () => ({ metadata: { resourceVersion: "818", annotations: { release: "23" } }, spec: { selector: { release: "23" } } }),
    previousResourceVersion: "817", selector: { release: "23" }, annotations: { release: "23" },
  });
  assert.equal(cas.committedResourceVersion, "818");
  assert.deepEqual(parseRunningComposeServices("backend\nbackend-standby\n"), ["backend", "backend-standby"]);
  assert.deepEqual(parseRunningComposeServices(""), []);
});
test("precommit failure cleans only candidate and leaves active traffic surfaces untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activation-precommit-"));
  const events = [];
  await assert.rejects(
    runK3sJourneyActivation(
      request(root),
      effects(events, "candidate.observe"),
      { failureNow: () => "2026-08-14T04:01:00.000Z" },
    ),
    (error) => error instanceof K3sJourneyActivationError &&
      error.code === "K3S_PRECOMMIT_FAILED",
  );
  assert.ok(events.includes("candidate.cleanup"));
  assert.ok(events.includes("candidate.port-forward.close"));
  assert.ok(!events.some((event) => event.startsWith("active-service.")));
  assert.ok(!events.includes("nginx.switch"));
  assert.ok(!events.includes("old-workload.drain"));
  const failure = JSON.parse(await readFile(
    path.join(root, "operation", "k3s-activation-failure.json"),
    "utf8",
  ));
  assert.equal(failure.phase, "FAILED_PRECOMMIT");
  assert.deepEqual(failure.mutationCounts, {
    activeService: 0,
    nginx: 0,
    oldWorkload: 0,
  });
  assert.equal(failure.rollbackAttemptCount, 0);
  assert.equal(failure.successReceiptCreated, false);
  assert.equal(failure.bundleAcquisitionEvidenceDigest, digest("7"));
  await missing(path.join(root, "operation", "k3s-activation-receipt.json"));
});
test("partial candidate apply is cleanup-owned and cleanup failure stops terminal receipt", async () => {
  const partialRoot = await mkdtemp(path.join(tmpdir(), "k3s-partial-apply-"));
  const partialEvents = [];
  await assert.rejects(runK3sJourneyActivation(request(partialRoot), effects(partialEvents, "candidate.apply")),
    (error) => error.code === "K3S_PRECOMMIT_FAILED");
  assert.ok(partialEvents.includes("candidate.cleanup"));
  const cleanupRoot = await mkdtemp(path.join(tmpdir(), "k3s-cleanup-failure-"));
  await assert.rejects(runK3sJourneyActivation(request(cleanupRoot), effects([], ["candidate.observe", "candidate.cleanup"])),
    (error) => error.code === "K3S_RECEIPT_FAILED");
  await missing(path.join(cleanupRoot, "operation", "k3s-activation-failure.json"));
});
test("post-switch failure records typed failure and never rolls traffic back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activation-postswitch-"));
  const events = [];
  await assert.rejects(
    runK3sJourneyActivation(
      request(root),
      effects(events, "public.smoke"),
      { failureNow: () => "2026-08-14T04:02:00.000Z" },
    ),
    (error) => error instanceof K3sJourneyActivationError &&
      error.code === "K3S_POSTSWITCH_FAILED",
  );
  assert.ok(events.includes("active-service.cas"));
  assert.ok(events.includes("nginx.switch"));
  assert.ok(!events.includes("candidate.cleanup"));
  assert.ok(!events.some((event) => event.includes("rollback")));
  const failure = JSON.parse(await readFile(
    path.join(root, "operation", "k3s-activation-failure.json"),
    "utf8",
  ));
  assert.equal(failure.phase, "FAILED_POSTSWITCH");
  assert.equal(failure.mutationCounts.activeService, 2);
  assert.equal(failure.rollbackAttemptCount, 0);
  assert.equal(failure.degradedSuccess, false);
  assert.equal(failure.successReceiptCreated, false);
  await missing(path.join(root, "operation", "k3s-activation-receipt.json"));
});
test("contract and workflow keep K3s activation source-free, protected and Compose-runner-free", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../contracts/release/platform-k3s-activation-contract.json", import.meta.url),
    "utf8",
  ));
  const workflow = await readFile(
    new URL("../../.github/workflows/source-free-journey-k3s-deploy.yml", import.meta.url),
    "utf8",
  );
  assert.equal(contract.schemaVersion, "PLATFORM_K3S_ACTIVATION_CONTRACT_V1");
  assert.equal(contract.trafficCommit.linearizationPoint, "SERVICE_RESOURCE_VERSION_CAS");
  assert.equal(contract.rollback.policy, "FORBIDDEN");
  assert.equal(contract.fallback.policy, "FORBIDDEN");
  assert.match(workflow, /environment:\s*production-deploy/);
  assert.match(workflow, /prepare-source-free-fixed-host-deployment\.mjs/);
  assert.match(workflow, /acquire-platform-contract-bundle\.mjs/);
  assert.match(workflow, /prepare-source-free-k3s-deployment\.mjs/);
  assert.match(workflow, /run-k3s-journey-activation\.mjs/);
  assert.ok(workflow.indexOf("acquire-platform-contract-bundle.mjs") < workflow.indexOf("prepare-source-free-k3s-deployment.mjs"));
  assert.doesNotMatch(workflow, /run-fixed-host-journey-activation\.mjs/);
  assert.doesNotMatch(workflow, /docker compose|docker-compose/);
});
test("terminal receipts may bind one direct canonical bundle acquisition-evidence digest without breaking V1", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../../contracts/release/platform-k3s-activation-contract.json", import.meta.url),
    "utf8",
  ));
  const schema = JSON.parse(await readFile(
    new URL("../../contracts/release/platform-k3s-activation-receipt.schema.json", import.meta.url),
    "utf8",
  ));
  const field = "bundleAcquisitionEvidenceDigest";

  assert.deepEqual(contract.receipt.bundleAcquisitionEvidence, {
    field,
    digestMeaning: "DIRECT_SHA256_OF_CREATE_ONLY_CANONICAL_BUNDLE_ACQUISITION_EVIDENCE",
    requiredForV1: false,
  });
  for (const terminalKind of ["success", "failure"]) {
    const terminalReceipt = schema.$defs[terminalKind];
    assert.deepEqual(terminalReceipt.properties[field], { $ref: "#/$defs/digest" });
    assert.equal(terminalReceipt.required.includes(field), false);
  }
});
test("failure receipt schema accepts only the phase-specific terminal failure code", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../contracts/release/platform-k3s-activation-receipt.schema.json", import.meta.url),
    "utf8",
  ));
  const cases = [
    ["FAILED_PRECOMMIT", "K3S_PRECOMMIT_FAILED", true],
    ["FAILED_POSTSWITCH", "K3S_POSTSWITCH_FAILED", true],
    ["FAILED_PRECOMMIT", "K3S_POSTSWITCH_FAILED", false],
    ["FAILED_POSTSWITCH", "K3S_PRECOMMIT_FAILED", false],
  ];

  for (const [phase, failureCode, expected] of cases) {
    assert.equal(
      schemaAccepts(failureReceipt(phase, failureCode), schema.$defs.failure, schema),
      expected,
      `${phase} must ${expected ? "accept" : "reject"} ${failureCode}`,
    );
  }
});
