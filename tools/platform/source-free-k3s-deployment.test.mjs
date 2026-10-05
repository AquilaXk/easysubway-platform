import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitServiceCasWithReconciliation,
  createK3sJourneyActivationEffects,
  K3sJourneyActivationError,
  normalizePem,
  parseRunningComposeServices,
  renderK3sNginxConfig,
  runK3sJourneyActivation,
  waitForActiveEndpoint,
} from "./run-k3s-journey-activation.mjs";
import { prepareSourceFreeK3sDeployment } from "./prepare-source-free-k3s-deployment.mjs";
import { JourneyCandidateCanaryAdapterError } from "./run-journey-candidate-canary.mjs";
const digest = (value) => `sha256:${value.repeat(64)}`;
const OBSERVABILITY_CONTRACT = JSON.parse(readFileSync(new URL(
  "../../contracts/release/platform-k3s-observability-contract.json", import.meta.url,
), "utf8"));

const HOST_SCAN_FORMAT = '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}';
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
      bundleSha256: "sha256:ffbfed08c46916a6a9f7e1bf3d3de46989fe4f2517ed341bd2e2f89e02b7ce58",
      resourceSetSha256: "sha256:024e239b18364a3b1be9465cf3f9af0b3127344462c72ace7ff5071d332f48c6",
      acquisitionEvidenceDigest: digest("7"),
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
  const evidenceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: "PLATFORM_HUB_BUNDLE_ACQUISITION_EVIDENCE_V1", artifactKind: "platform-hub-bundle-acquisition-evidence",
    hubRevision: "e14964e588ef79b1cff6e01e18d8b943d7724420",
    bundleSha256: "sha256:ffbfed08c46916a6a9f7e1bf3d3de46989fe4f2517ed341bd2e2f89e02b7ce58",
    resourceSetSha256, resources: evidenceResources,
  }, null, 2)}\n`);
  await writeFile(path.join(bundleRoot, "evidence.json"), evidenceBytes);
  return {
    hubRevision: "e14964e588ef79b1cff6e01e18d8b943d7724420",
    bundleSha256: "sha256:ffbfed08c46916a6a9f7e1bf3d3de46989fe4f2517ed341bd2e2f89e02b7ce58",
    resourceSetSha256,
    acquisitionEvidenceDigest: sha256(evidenceBytes),
    runtimeContractPath: path.join(bundleRoot, "resources", "platform", "k3s-runtime-contract.json"),
    bundleRoot,
  };
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
    // 실제 effect처럼 candidate 객체 생성을 시작한 뒤 실패할 수 있으므로, step 전에 생성 시작을 알린다.
    applyCandidate: async (args) => {
      args.markCandidateCreated();
      return step("candidate.apply", proof("2", {
        deploymentName: "journey-candidate-23",
        candidateServiceName: "journey-candidate-23",
      }))();
    },
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
  const platformContractBundlePath = (await writePlatformBundle(root)).bundleRoot;
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
async function prepareStagedCandidateEnvironment({
  root,
  backendEnvironment,
  extraFiles = [],
}) {
  const activationRequest = request(root);
  activationRequest.platformBundle = await writePlatformBundle(root);
  delete activationRequest.platformBundle.bundleRoot;
  const runtimeBytes = await readFile(new URL(
    "../../contracts/release/platform-k3s-runtime-contract.json", import.meta.url,
  ));
  activationRequest.runtimeContractSha256 = sha256(runtimeBytes);
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
    ...extraFiles,
  ]);
  return activationRequest;
}

function mockCandidateRenderPlan({
  activationRequest,
  candidateToken = "candidate-23",
  configName = "journey-config-23",
  secretName = "journey-secret-23",
  configOverrides = {},
  candidateDeploymentName = "journey-candidate-23",
  candidateServiceName = "journey-candidate-23",
}) {
  return {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_RENDER_V1",
    artifactKind: "platform-k3s-candidate-render",
    releaseIdentity: {
      tupleSha256: activationRequest.releaseTuple.tupleSha256,
      candidateToken,
    },
    configPlan: {
      name: configName,
      overrides: {
        EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION:
          activationRequest.releaseTuple.deploymentRevision,
        ...configOverrides,
      },
    },
    secretPlan: { name: secretName },
    candidateObjects: [{
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "journey-backend-boundary", namespace: "easysubway-journey" },
      spec: {
        ingress: [{
          from: [
            { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "easysubway-journey" } } },
            { ipBlock: { cidr: "10.0.0.17/32" } },
            { ipBlock: { cidr: OBSERVABILITY_CONTRACT.composeNetwork.subnet } },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        }],
      },
    }],
    activationPlan: {
      requiredCasField: "metadata.resourceVersion",
      applyDuringCandidatePreparation: false,
      activeServiceTemplate: {
        spec: { clusterIP: OBSERVABILITY_CONTRACT.activeService.clusterIP, ports: [{ nodePort: 32080 }] },
      },
      candidateDeploymentName,
      candidateServiceName,
    },
  };
}

function createMockCommandRunner(rendered, createdSecrets = []) {
  return async (command, args, options = {}) => {
    if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
    if (args.includes("create")) createdSecrets.push(JSON.parse(Buffer.from(options.input).toString("utf8")));
    return { stdout: Buffer.alloc(0) };
  };
}

test("activation keeps trusted readiness identity in ConfigMap and secrets out of evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-protected-secret-"));
  const protectedToken = "p".repeat(32);
  const untrustedToken = "u".repeat(32);
  const untrustedRevision = "0".repeat(40);
  const backendEnvironment = [
    "DATABASE_PASSWORD=private-test-value",
    "SAFE_FLAG=true",
    `EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN=${untrustedToken}`,
    `EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION=${untrustedRevision}`,
    "",
  ].join("\n");
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment });
  const createdSecrets = [];
  const rendered = mockCandidateRenderPlan({
    activationRequest,
    configOverrides: { SAFE_CONFIG: "true" },
  });
  const commandRunner = createMockCommandRunner(rendered, createdSecrets);
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
    assert.doesNotMatch(
      JSON.stringify(value),
      new RegExp(`${protectedToken}|${untrustedToken}|${untrustedRevision}`),
    );
  }
  const ci = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.equal(ci.split("node --test tools/platform/source-free-k3s-deployment.test.mjs").length - 1, 1);
});

test("activation deletes and recreates secret if AlreadyExists occurs during candidate apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-already-exists-secret-"));
  const protectedToken = "p".repeat(32);
  const backendEnvironment = [
    "DATABASE_PASSWORD=private-test-value",
    "SAFE_FLAG=true",
    "",
  ].join("\n");
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment });
  const createdSecrets = [];
  const rendered = mockCandidateRenderPlan({
    activationRequest,
    configOverrides: { SAFE_CONFIG: "true" },
  });
  let firstCreate = true;
  const deletedSecrets = [];
  const commandRunner = async (command, args, options = {}) => {
    if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
    if (args.includes("create")) {
      if (firstCreate) {
        firstCreate = false;
        throw new Error('Error from server (AlreadyExists): error when creating "STDIN": secrets "journey-secret-23" already exists');
      }
      createdSecrets.push(JSON.parse(Buffer.from(options.input).toString("utf8")));
    }
    if (args.includes("delete") && args.includes("secret")) {
      deletedSecrets.push(args);
    }
    return { stdout: Buffer.alloc(0) };
  };
  const activationEffects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner,
    serviceToken: protectedToken,
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await activationEffects.verifyInputs();
  await activationEffects.applyCandidate();
  assert.equal(createdSecrets.length, 1);
  assert.equal(deletedSecrets.length, 1);
  assert.ok(deletedSecrets[0].includes("journey-secret-23"));
});
test("activation rejects a crafted Hub bundle request before it can invoke K3s", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-crafted-hub-bundle-"));
  const activationRequest = request(root);
  activationRequest.platformBundle.hubRevision = "0".repeat(40);
  const commands = [];
  assert.throws(() => createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (...args) => { commands.push(args); return { stdout: Buffer.alloc(0) }; },
    serviceToken: "p".repeat(32),
  }), (error) => error instanceof K3sJourneyActivationError && error.code === "K3S_USAGE");
  assert.deepEqual(commands, []);
});
test("activation rejects a staged evidence digest mismatch before K3s mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-staged-hub-bundle-"));
  const activationRequest = request(root);
  activationRequest.platformBundle = await writePlatformBundle(root);
  delete activationRequest.platformBundle.bundleRoot;
  activationRequest.platformBundle.acquisitionEvidenceDigest = digest("0");
  const backendEnvironment = "SAFE_FLAG=true\n";
  await Promise.all([
    writeFile(activationRequest.candidateInputPath, JSON.stringify({
      tupleSha256: activationRequest.releaseTuple.tupleSha256,
      candidateGeneration: activationRequest.candidateGeneration,
      trafficGeneration: activationRequest.trafficGeneration,
      secretIdentity: sha256(backendEnvironment), nodeInternalIp: "10.0.0.17",
    })),
    writeFile(activationRequest.backendEnvPath, backendEnvironment),
  ]);
  const commands = [];
  const activationEffects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (...args) => { commands.push(args); return { stdout: Buffer.alloc(0) }; },
    serviceToken: "p".repeat(32),
  });
  await assert.rejects(
    runK3sJourneyActivation(activationRequest, activationEffects),
    (error) => error instanceof K3sJourneyActivationError && error.code === "K3S_USAGE",
  );
  assert.deepEqual(commands, []);
  await missing(activationRequest.operationDirectory);
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
test("a failing canary probe aborts activation and its probe id and reason stay in the logged cause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activation-canary-probe-"));
  const events = [];
  const fake = effects(events);
  fake.runCandidateCanary = async () => {
    events.push("candidate.canary");
    throw new JourneyCandidateCanaryAdapterError("JOURNEY_CANARY_HTTP", 1, undefined, {
      probeId: "01K2H7Q5B7E3T19N8J4M6P0R2X", regionId: "daegu", httpStatus: 503, failureReason: "NO_CANDIDATES",
    });
  };
  await assert.rejects(
    runK3sJourneyActivation(request(root), fake, { failureNow: () => "2026-08-14T04:01:00.000Z" }),
    (error) => {
      assert.ok(error instanceof K3sJourneyActivationError);
      assert.equal(error.code, "K3S_PRECOMMIT_FAILED");
      // 활성화 CLI는 cause의 stack을 stderr에 출력한다. 첫 줄에 probe와 사유가 있어야 로그에서 보인다.
      assert.match(error.cause.stack, /Journey canary HTTP contract failed/);
      assert.match(error.cause.stack, /probeId=01K2H7Q5B7E3T19N8J4M6P0R2X regionId=daegu httpStatus=503 failureReason=NO_CANDIDATES/);
      return true;
    },
  );
  assert.ok(!events.includes("candidate.observe"));
  assert.ok(!events.some((event) => event.startsWith("active-service.")));
  assert.ok(!events.includes("nginx.switch"));
  assert.ok(events.includes("candidate.cleanup"));
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
test("candidate apply failing before any object creation does not run candidate cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-apply-before-create-"));
  const events = [];
  const fake = effects(events, []);
  fake.applyCandidate = async () => {
    events.push("candidate.apply");
    throw new Error("injected pre-create failure");
  };
  await assert.rejects(runK3sJourneyActivation(request(root), fake, { failureNow: () => "2026-08-14T04:01:00.000Z" }),
    (error) => error.code === "K3S_PRECOMMIT_FAILED");
  assert.equal(events.includes("candidate.cleanup"), false);
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
  assert.match(workflow, /platform-contracts-\$\{GITHUB_RUN_ID\}/);
  assert.doesNotMatch(workflow, /mkdir -p[^\n]*\$\{source_free_root\}/);
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

test("normalizePem strips quotes, unescapes newlines, and preserves exact PEM boundaries", () => {
  const rawQuotedEscaped = "\"-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\\n-----END PUBLIC KEY-----\\n\"";
  const normalized = normalizePem(rawQuotedEscaped);
  assert.equal(normalized, "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----");
  assert.equal(normalizePem("   '-----BEGIN PUBLIC KEY-----\\nKEY\\n-----END PUBLIC KEY-----\\n'   "), "-----BEGIN PUBLIC KEY-----\nKEY\n-----END PUBLIC KEY-----");
  assert.equal(normalizePem(null), null);
  assert.equal(normalizePem(undefined), undefined);
});

test("activation normalizes quoted public key PEM and injects startup bundle properties into Secret", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-public-key-normalize-"));
  const rawPem = "\"-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\\n-----END PUBLIC KEY-----\\n\"";
  const backendEnvironment = [
    `EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM=${rawPem}`,
    "EASYSUBWAY_TIMETABLE_SEED_ENABLED=true",
    "EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX=true",
    "SAFE_FLAG=true",
    "",
  ].join("\n");
  const descriptor = {
    publicationReceipt: { locator: { publicBaseUrl: "https://datapack.aquilaxk.site" } },
    manifest: { keyId: "test-key-v1" },
  };
  const descriptorPath = path.join(root, "server-route-bundle-publication-descriptor.json");
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment,
    extraFiles: [writeFile(descriptorPath, JSON.stringify(descriptor))],
  });
  const createdSecrets = [];
  const rendered = mockCandidateRenderPlan({
    activationRequest,
    candidateToken: "c-1",
    configName: "c-cfg",
    secretName: "c-sec",
    candidateDeploymentName: "c-dep",
    candidateServiceName: "c-svc",
  });
  const commandRunner = createMockCommandRunner(rendered, createdSecrets);
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner,
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await effects.verifyInputs();
  await effects.applyCandidate();
  const expectedPem = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----";
  assert.equal(createdSecrets[0].stringData.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM, expectedPem);
  assert.equal(createdSecrets[0].stringData.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_PUBLIC_KEY_PEM, expectedPem);
  assert.equal(createdSecrets[0].stringData.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_KEY_ID, "test-key-v1");
  assert.equal(createdSecrets[0].stringData.EASYSUBWAY_TIMETABLE_SEED_ENABLED, "false");
  assert.equal(createdSecrets[0].stringData.EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX, "false");
});

test("activateCandidate sends tupleSha256 as activationRequestIdentity matching candidate startup configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activate-candidate-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  let sentCommand;
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async () => ({ stdout: Buffer.alloc(0) }),
    serviceToken: "token".repeat(7),
    fetchImpl: async (url, options) => {
      sentCommand = JSON.parse(options.body);
      const readiness = {
        releaseTupleSha256: activationRequest.releaseTuple.tupleSha256.slice(7),
        backendImageDigest: activationRequest.releaseTuple.backendImageDigest,
        backendConfigSha256: activationRequest.releaseTuple.backendConfigDigest.slice(7),
        journeyContractSha256: activationRequest.releaseTuple.journeyContractDigest.slice(7),
        routeBundleManifestSha256: activationRequest.releaseTuple.serverRouteBundleDigest.slice(7),
        generation: activationRequest.candidateGeneration,
        evidenceSha256: "e".repeat(64),
        trafficGeneration: activationRequest.trafficGeneration,
        servingReady: true,
        draining: false,
      };
      return new Response(JSON.stringify(readiness), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const activation = await effects.activateCandidate({
    baseUrl: "http://127.0.0.1:8080",
    admission: { candidateAdmissionSha256: digest("6") },
  });
  assert.equal(sentCommand.activationRequestIdentity, activationRequest.releaseTuple.tupleSha256);
  assert.notEqual(sentCommand.activationRequestIdentity, digest("6"));
  assert.equal(sentCommand.candidateManifestSha256, activationRequest.releaseTuple.serverRouteBundleDigest.slice(7));
  assert.equal(sentCommand.candidateGeneration, activationRequest.candidateGeneration);
  assert.equal(sentCommand.expectedActiveGeneration, activationRequest.candidateGeneration - 1);
  assert.equal(sentCommand.trafficGeneration, activationRequest.trafficGeneration);
  assert.equal(activation.trafficGeneration, activationRequest.trafficGeneration);
  assert.equal(activation.activeReadinessEvidenceDigest, `sha256:${"e".repeat(64)}`);
});

test("drainOldWorkloads queries running Compose services with base compose and backend image and stops them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-drain-workloads-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  const commands = [];
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args, options) => {
      commands.push({ command, args, options });
      if (command === "docker" && args[0] === "compose" && args.includes("ps")) {
        return { stdout: "backend\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "easysubway-postgres\timresamu/postgis:16-3.5\teasysubway\tpostgres\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  const drain = await effects.drainOldWorkloads({
    candidate: { candidateToken: "c-1" },
    preparedActiveService: {},
  });
  assert.equal(drain.signal, "SIGTERM");
  assert.equal(drain.stopGracePeriodSeconds, 30);
  assert.equal(drain.oldWorkloadCount, 1);
  const psCall = commands.find((entry) => entry.command === "docker" && entry.args[0] === "compose" && entry.args.includes("ps"));
  assert.ok(psCall);
  assert.ok(!psCall.args.includes(activationRequest.candidateComposePath));
  assert.ok(!psCall.args.includes("--profile"));
  assert.ok(psCall.args.includes(activationRequest.baseComposePath));
  assert.equal(
    psCall.options.env.EASYSUBWAY_BACKEND_IMAGE,
    `ghcr.io/aquilaxk/easysubway-backend@${activationRequest.releaseTuple.backendImageDigest}`,
  );
  assert.equal(psCall.options.env.EASYSUBWAY_BACKEND_ENV_FILE, activationRequest.backendEnvPath);
  const stopCall = commands.find((entry) => entry.command === "docker" && entry.args.includes("stop"));
  assert.ok(stopCall);
  assert.ok(stopCall.args.includes("backend"));
  assert.equal(stopCall.options.timeoutMs, 35_000);
  const hostScan = commands.find((entry) => entry.command === "docker" && entry.args[0] === "ps");
  assert.ok(hostScan, "drain must scan every running docker container after stopping Compose backends");
  assert.deepEqual(hostScan.args, [
    "ps", "--all", "--filter", "status=running", "--filter", "status=restarting",
    "--no-trunc", "--format", HOST_SCAN_FORMAT,
  ]);
  assert.ok(commands.indexOf(stopCall) < commands.indexOf(hostScan));
});

test("drainOldWorkloads fails when a docker backend process outside the K3s digest keeps running", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-drain-foreign-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return {
          stdout: "easysubway-back-worker\teasysubway-backend:84f4fb94e1255df64326b90fdb8f7539f283961c\teasysubway\tback-worker\n" +
            "easysubway-postgres\timresamu/postgis:16-3.5\teasysubway\tpostgres\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await assert.rejects(
    effects.drainOldWorkloads({ candidate: { candidateToken: "c-1" }, preparedActiveService: {} }),
    /backend process outside the active K3s digest is still running: easysubway-back-worker/,
  );
});

test("drainOldWorkloads reports stopped Compose backends even when a foreign backend blocks completion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-drain-foreign-count-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args) => {
      if (command === "docker" && args[0] === "compose" && args.includes("ps")) {
        return { stdout: "backend\n", stderr: "" };
      }
      if (command === "docker" && args[0] === "ps") {
        return { stdout: "stray\teasysubway-backend:old\t\t\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await assert.rejects(
    effects.drainOldWorkloads({
      candidate: { candidateToken: "c-1" },
      preparedActiveService: { previousSelector: { "easysubway.io/candidate-token": "c-0" } },
    }),
    (error) => error.oldWorkloadCount === 2 && /stray/.test(error.message),
  );
});

test("verifyRuntime fails before any mutation when a foreign backend container runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-runtime-foreign-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  const commands = [];
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "docker" && args[0] === "ps") {
        return {
          stdout: "easysubway-back-worker\teasysubway-backend:84f4fb94\teasysubway\tback-worker\n",
          stderr: "",
        };
      }
      throw new Error("runtime verification must not continue");
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await assert.rejects(
    effects.verifyRuntime(),
    /backend process outside the active K3s digest is running: easysubway-back-worker/,
  );
  assert.deepEqual(commands, [[
    "docker", "ps", "--all", "--filter", "status=running", "--filter", "status=restarting",
    "--no-trunc", "--format", HOST_SCAN_FORMAT,
  ]]);
});

test("verifyRuntime tolerates the project's Compose drain set that activation will stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-runtime-drain-set-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return {
          stdout: `easysubway-backend\teasysubway-backend:84f4fb94\t${activationRequest.projectName}\tbackend\n` +
            `easysubway-backend-standby\teasysubway-backend:84f4fb94\t${activationRequest.projectName}\tbackend-standby\n`,
          stderr: "",
        };
      }
      throw new Error("reached runtime bootstrap verification");
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await assert.rejects(effects.verifyRuntime(), /reached runtime bootstrap verification/);
});

// Issue #221: verifyRuntime(PRECOMMIT, 읽기 전용)이 compose 네트워크 서브넷과 기존 journey-active ClusterIP를
// 관측 계약과 대조한다. 다르면 어떤 K3s 변경도 하기 전에 실패해야 한다(fail-closed).
function runtimeObservabilityRunner({ subnetConfig, activeService, commands }) {
  return async (command, args) => {
    commands.push([command, ...args]);
    if (command === "docker" && args[0] === "ps") return { stdout: "", stderr: "" };
    if (command === "docker" && args[0] === "network") {
      return { stdout: `${JSON.stringify(subnetConfig)}\n`, stderr: "" };
    }
    if (command === "sudo" && args.some((arg) => arg.endsWith("bootstrap-single-node-k3s.sh"))) {
      return { stdout: "", stderr: "" };
    }
    if (command === "sudo" && args.includes("nodes")) {
      return {
        stdout: JSON.stringify({ items: [{
          metadata: { uid: "node-uid" },
          status: { addresses: [{ type: "InternalIP", address: "10.0.0.17" }] },
        }] }),
        stderr: "",
      };
    }
    if (command === "sudo" && args.includes("namespace")) return { stdout: "namespace/easysubway-journey\n", stderr: "" };
    if (command === "sudo" && args.includes("service") && args.includes("journey-active")) {
      return { stdout: activeService === undefined ? "" : JSON.stringify(activeService), stderr: "" };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
}

async function runtimeObservabilityEffects(root, options) {
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
  return createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: runtimeObservabilityRunner(options),
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
}

function activeServiceWithClusterIp(clusterIP) {
  return {
    apiVersion: "v1", kind: "Service",
    metadata: { name: "journey-active", namespace: "easysubway-journey", resourceVersion: "17" },
    spec: { type: "NodePort", clusterIP, ports: [{ name: "http", port: 8080, targetPort: 8080, nodePort: 32080 }] },
  };
}

function assertNoK3sMutation(commands) {
  for (const command of commands) {
    for (const verb of ["apply", "create", "replace", "delete", "patch", "stop"]) {
      assert.equal(command.includes(verb), false, `unexpected mutation ${command.join(" ")}`);
    }
  }
}

test("verifyRuntime binds the compose subnet and existing active ClusterIP to the observability contract", async () => {
  const commands = [];
  const effects = await runtimeObservabilityEffects(
    await mkdtemp(path.join(tmpdir(), "k3s-runtime-observability-")),
    {
      subnetConfig: [{ Subnet: OBSERVABILITY_CONTRACT.composeNetwork.subnet, Gateway: "172.18.0.1" }],
      activeService: activeServiceWithClusterIp(OBSERVABILITY_CONTRACT.activeService.clusterIP),
      commands,
    },
  );
  const runtime = await effects.verifyRuntime();
  assert.equal(runtime.nodeInternalIp, "10.0.0.17");
  assert.ok(commands.some((command) => command.join(" ") ===
    `docker network inspect ${OBSERVABILITY_CONTRACT.composeNetwork.name} --format {{json .IPAM.Config}}`));
  assertNoK3sMutation(commands);
});

test("verifyRuntime accepts a missing active Service that activation will create with the pinned ClusterIP", async () => {
  const commands = [];
  const effects = await runtimeObservabilityEffects(
    await mkdtemp(path.join(tmpdir(), "k3s-runtime-observability-absent-")),
    {
      subnetConfig: [{ Subnet: OBSERVABILITY_CONTRACT.composeNetwork.subnet }],
      activeService: undefined,
      commands,
    },
  );
  await effects.verifyRuntime();
  assertNoK3sMutation(commands);
});

test("verifyRuntime fails closed when the compose network subnet drifts from the NetworkPolicy contract", async () => {
  const expected = OBSERVABILITY_CONTRACT.composeNetwork.subnet;
  for (const [subnetConfig, observed] of [
    [[{ Subnet: "172.19.0.0/16" }], "172.19.0.0/16"],
    [[], "none"],
    [[{ Subnet: expected }, { Subnet: "172.30.0.0/16" }], `${expected},172.30.0.0/16`],
  ]) {
    const commands = [];
    const effects = await runtimeObservabilityEffects(
      await mkdtemp(path.join(tmpdir(), "k3s-runtime-subnet-drift-")),
      {
        subnetConfig,
        activeService: activeServiceWithClusterIp(OBSERVABILITY_CONTRACT.activeService.clusterIP),
        commands,
      },
    );
    await assert.rejects(effects.verifyRuntime(), (error) => {
      assert.equal(error.message,
        `compose network subnet does not match the observability contract: expected ${expected}, observed ${observed}`);
      return true;
    });
    assertNoK3sMutation(commands);
  }
});

test("verifyRuntime fails closed when the live active Service ClusterIP drifts from the Prometheus target", async () => {
  const commands = [];
  const effects = await runtimeObservabilityEffects(
    await mkdtemp(path.join(tmpdir(), "k3s-runtime-clusterip-drift-")),
    {
      subnetConfig: [{ Subnet: OBSERVABILITY_CONTRACT.composeNetwork.subnet }],
      activeService: activeServiceWithClusterIp("10.43.0.99"),
      commands,
    },
  );
  await assert.rejects(effects.verifyRuntime(), (error) => {
    assert.equal(error.message,
      "active Service ClusterIP does not match the observability contract: " +
      `expected ${OBSERVABILITY_CONTRACT.activeService.clusterIP}, observed 10.43.0.99`);
    return true;
  });
  assertNoK3sMutation(commands);
});

test("applyCandidate rejects a render whose NetworkPolicy or active ClusterIP drifts from the contract before apply", async () => {
  for (const mutate of [
    (plan) => { plan.activationPlan.activeServiceTemplate.spec.clusterIP = "10.43.0.99"; },
    (plan) => { plan.candidateObjects[0].spec.ingress[0].from[2].ipBlock.cidr = "172.19.0.0/16"; },
    (plan) => { plan.candidateObjects[0].spec.ingress[0].ports.push({ protocol: "TCP", port: 9090 }); },
    // F1: 넓어지는 변이(전체 허용 출처, except가 붙은 subnet, 다른 포트를 여는 별도 규칙, 다른 /32)를 거부한다.
    (plan) => { plan.candidateObjects[0].spec.ingress[0].from.push({ ipBlock: { cidr: "0.0.0.0/0" } }); },
    (plan) => { plan.candidateObjects[0].spec.ingress[0].from[2].ipBlock.except = ["172.18.0.6/32"]; },
    (plan) => {
      plan.candidateObjects[0].spec.ingress.push({
        from: [{ ipBlock: { cidr: OBSERVABILITY_CONTRACT.composeNetwork.subnet } }],
        ports: [{ protocol: "TCP", port: 9090 }],
      });
    },
    (plan) => { plan.candidateObjects[0].spec.ingress[0].from.push({ ipBlock: { cidr: "10.0.0.99/32" } }); },
    (plan) => { plan.candidateObjects[0].spec.ingress[0].from.push({ namespaceSelector: {} }); },
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), "k3s-render-observability-drift-"));
    const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
    const rendered = mockCandidateRenderPlan({ activationRequest });
    mutate(rendered);
    const commands = [];
    const effects = createK3sJourneyActivationEffects({
      request: activationRequest,
      commandRunner: async (command, args) => {
        commands.push([command, ...args]);
        if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
        return { stdout: Buffer.alloc(0) };
      },
      serviceToken: "token".repeat(7),
      fetchImpl: async () => { throw new Error("not invoked"); },
    });
    await effects.verifyInputs();
    await assert.rejects(effects.applyCandidate(), /K3s candidate render is invalid/);
    assert.deepEqual(commands.map(([command]) => command), [process.execPath]);
  }
});

// Issue #228: 같은 이름의 immutable ConfigMap이 다른 data로 이미 있으면 Secret create나 apply 전에 실패한다.
// 기존 객체를 지우거나 덮어쓰지 않는다.
function existingConfigMapRunner(rendered, existingData, commands) {
  return async (command, args, options = {}) => {
    commands.push([command, ...args]);
    if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
    if (args.includes("get") && args.includes("configmap")) {
      return {
        stdout: existingData === undefined ? "" : JSON.stringify({
          apiVersion: "v1", kind: "ConfigMap",
          metadata: { name: rendered.configPlan.name, namespace: "easysubway-journey" },
          immutable: true,
          data: existingData,
        }),
      };
    }
    return { stdout: Buffer.alloc(0) };
  };
}

async function verifiedConfigMapEffects(activationRequest, rendered, existingData, commands) {
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: existingConfigMapRunner(rendered, existingData, commands),
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await effects.verifyInputs();
  return effects;
}

test("applyCandidate fails closed before any create or apply when an immutable ConfigMap name holds different data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-configmap-collision-"));
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
  const rendered = mockCandidateRenderPlan({
    activationRequest,
    configOverrides: { EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION: "37129430478" },
  });
  const existingData = {
    ...rendered.configPlan.overrides,
    EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION: "37125930222",
  };
  const commands = [];
  const effects = await verifiedConfigMapEffects(activationRequest, rendered, existingData, commands);
  await assert.rejects(effects.applyCandidate(), (error) => {
    assert.equal(error.message,
      `immutable ConfigMap ${rendered.configPlan.name} already exists with different data: ` +
      "EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION");
    return true;
  });
  for (const command of commands) {
    for (const verb of ["create", "apply", "delete", "replace", "patch"]) {
      assert.equal(command.includes(verb), false, `unexpected mutation ${command.join(" ")}`);
    }
  }
});

test("applyCandidate proceeds when the same-named ConfigMap holds identical data or is absent", async () => {
  for (const sameData of [true, false]) {
    const root = await mkdtemp(path.join(tmpdir(), "k3s-configmap-same-"));
    const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
    const rendered = mockCandidateRenderPlan({ activationRequest, configOverrides: { SAFE_CONFIG: "true" } });
    const commands = [];
    const existingData = sameData ? { ...rendered.configPlan.overrides } : undefined;
    const effects = await verifiedConfigMapEffects(activationRequest, rendered, existingData, commands);
    await effects.applyCandidate();
    assert.ok(commands.some((command) => command.includes("apply")));
  }
});

// Issue #228 리뷰 F1: 충돌 pre-check 실패는 orchestrator 실패 경로(recordActivationFailure → cleanupCandidate)를
// 거쳐도 같은 이름의 기존 객체를 지우지 않아야 한다. cleanup은 이 run이 실제로 만든 객체만 지운다.
test("orchestrated activation leaves same-named objects untouched when the ConfigMap collision pre-check fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-collision-orchestrated-"));
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
  const rendered = mockCandidateRenderPlan({
    activationRequest,
    configOverrides: { EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION: "37129430478" },
  });
  const commands = [];
  const runtimeRunner = runtimeObservabilityRunner({
    subnetConfig: [{ Subnet: OBSERVABILITY_CONTRACT.composeNetwork.subnet }],
    activeService: activeServiceWithClusterIp(OBSERVABILITY_CONTRACT.activeService.clusterIP),
    commands: [],
  });
  const collisionRunner = existingConfigMapRunner(rendered, {
    ...rendered.configPlan.overrides,
    EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION: "37125930222",
  }, []);
  const commandRunner = async (command, args, options) => {
    commands.push([command, ...args]);
    if (command === process.execPath || (args.includes("get") && args.includes("configmap"))) {
      return collisionRunner(command, args, options);
    }
    return runtimeRunner(command, args, options);
  };
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner,
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await assert.rejects(
    runK3sJourneyActivation(activationRequest, effects, { failureNow: () => "2026-10-03T14:24:33.000Z" }),
    (error) => error instanceof K3sJourneyActivationError && error.code === "K3S_PRECOMMIT_FAILED",
  );
  for (const command of commands) {
    for (const verb of ["delete", "create", "apply", "patch", "replace"]) {
      assert.equal(command.includes(verb), false, `unexpected mutation ${command.join(" ")}`);
    }
  }
  const failure = JSON.parse(await readFile(
    path.join(activationRequest.operationDirectory, "k3s-activation-failure.json"), "utf8",
  ));
  assert.equal(failure.phase, "FAILED_PRECOMMIT");
});

test("cleanupCandidate deletes only objects this run created, never pre-existing same-named objects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-cleanup-owned-"));
  const activationRequest = await prepareStagedCandidateEnvironment({ root, backendEnvironment: "SAFE_FLAG=true\n" });
  const rendered = mockCandidateRenderPlan({ activationRequest, configOverrides: { SAFE_CONFIG: "true" } });
  const commands = [];
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (command === process.execPath) return { stdout: Buffer.from(JSON.stringify(rendered)) };
      // 같은 data의 ConfigMap과 Deployment는 이미 있고, candidate Service는 없다.
      if (args.includes("get") && args.includes("configmap")) {
        return { stdout: JSON.stringify({ kind: "ConfigMap", data: { ...rendered.configPlan.overrides } }) };
      }
      if (args.includes("get") && args.includes("deployment")) return { stdout: `deployment.apps/${rendered.activationPlan.candidateDeploymentName}\n` };
      if (args.includes("get") && args.includes("service")) return { stdout: "" };
      if (args.includes("apply")) throw new Error("injected apply failure");
      return { stdout: Buffer.alloc(0) };
    },
    serviceToken: "token".repeat(7),
    fetchImpl: async () => { throw new Error("not invoked"); },
  });
  await effects.verifyInputs();
  await assert.rejects(effects.applyCandidate(), /injected apply failure/);
  commands.length = 0;
  await effects.cleanupCandidate();
  const deletes = commands.filter((command) => command.includes("delete"));
  assert.deepEqual(deletes.map((command) => command.filter((arg) => /^(secret|service|configmap|deployment)\//.test(arg))), [[
    `service/${rendered.activationPlan.candidateServiceName}`,
    `secret/${rendered.secretPlan.name}`,
  ]]);
});

test("activation failure receipt counts old workloads stopped before the drain failed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-activation-drain-count-"));
  const events = [];
  const fake = effects(events);
  fake.drainOldWorkloads = async () => {
    events.push("old-workload.drain");
    throw Object.assign(new Error("foreign backend"), { oldWorkloadCount: 2 });
  };
  await assert.rejects(
    runK3sJourneyActivation(request(root), fake, { failureNow: () => "2026-08-14T04:02:00.000Z" }),
    (error) => error instanceof K3sJourneyActivationError && error.code === "K3S_POSTSWITCH_FAILED",
  );
  const failure = JSON.parse(await readFile(
    path.join(root, "operation", "k3s-activation-failure.json"),
    "utf8",
  ));
  assert.equal(failure.mutationCounts.oldWorkload, 2);
});

test("runPublicSmoke verifies active readiness over publicBaseUrl and binds canary evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "k3s-public-smoke-"));
  const activationRequest = await prepareStagedCandidateEnvironment({
    root,
    backendEnvironment: "SAFE_FLAG=true\n",
  });
  let requestedUrl;
  let requestedHeaders;
  const effects = createK3sJourneyActivationEffects({
    request: activationRequest,
    commandRunner: async () => ({ stdout: Buffer.alloc(0) }),
    serviceToken: "token".repeat(7),
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedHeaders = options.headers;
      const readiness = {
        releaseTupleSha256: activationRequest.releaseTuple.tupleSha256.slice(7),
        backendImageDigest: activationRequest.releaseTuple.backendImageDigest,
        backendConfigSha256: activationRequest.releaseTuple.backendConfigDigest.slice(7),
        journeyContractSha256: activationRequest.releaseTuple.journeyContractDigest.slice(7),
        routeBundleManifestSha256: activationRequest.releaseTuple.serverRouteBundleDigest.slice(7),
        generation: activationRequest.candidateGeneration,
        evidenceSha256: "e".repeat(64),
        trafficGeneration: activationRequest.trafficGeneration,
        servingReady: true,
        draining: false,
      };
      return new Response(JSON.stringify(readiness), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const canaryProof = { evidenceDigest: digest("c") };
  const smoke = await effects.runPublicSmoke({ canary: canaryProof });
  assert.equal(smoke.passed, true);
  assert.equal(smoke.tupleSha256, activationRequest.releaseTuple.tupleSha256);
  assert.ok(requestedUrl.startsWith(activationRequest.publicBaseUrl));
  assert.ok(requestedUrl.endsWith("/internal/v1/journey/readiness/active"));
  assert.equal(requestedHeaders.Authorization, `Bearer ${"token".repeat(7)}`);
  assert.equal(
    smoke.evidenceDigest,
    sha256(Buffer.from(`${digest("c")}\n${"e".repeat(64)}\n`, "utf8")),
  );
});

