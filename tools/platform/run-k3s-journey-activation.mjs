#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runJourneyCandidateCanary } from "./run-journey-candidate-canary.mjs";
import {
  absolutePath,
  digest,
  exactObject,
  jsonBytes,
  readStableRegularFile,
  validPublicBaseUrl,
} from "./prepare-source-free-k3s-deployment.mjs";
import { BUNDLE_SHA256, HUB_REVISION, inspectStagedPlatformContractBundle } from "./acquire-platform-contract-bundle.mjs";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const NAMESPACE = "easysubway-journey";
const DEPLOYER = "system:serviceaccount:easysubway-journey:journey-deployer";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const RESOURCE_VERSION = /^[1-9]\d*$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9]\d*$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
// Issue #219: Compose 서비스 중 운영 DB에 붙는 backend는 이 집합뿐이며, K3s 활성화가 모두 drain한다.
const OBSERVABILITY_CONTRACT_PATH = path.join(
  REPOSITORY_ROOT, "contracts/release/platform-k3s-observability-contract.json",
);
export const PRODUCTION_DB_COMPOSE_BACKEND_SERVICES = Object.freeze(["backend", "backend-standby"]);
const UNRESOLVED_IMAGE_ID = /^(?:sha256:)?[a-f0-9]{12,64}$/;
const BACKEND_IMAGE_SOURCE = /^https:\/\/github\.com\/AquilaXk\/easysubway(?:-backend)?$/i;
const HOST_BACKEND_SCAN_ARGS = Object.freeze([
  "ps", "--all", "--filter", "status=running", "--filter", "status=restarting",
  "--no-trunc", "--format",
  '{{.Names}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
]);
const FALLBACK_ZERO = Object.freeze({
  legacyGraphSuccessCount: 0,
  localRouteInvocationCount: 0,
  staleJourneyServedCount: 0,
  alternateEndpointSuccessCount: 0,
});
const REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "operationDirectory", "operationId",
  "deployRoot", "runUrl", "generatedAt", "runtimeContractSha256",
  "candidateInputPath", "tuplePath", "bindingPath", "descriptorBindingPath",
  "composeEnvPath", "backendEnvPath", "baseComposePath",
  "candidateComposePath", "projectName", "nginxConfigPath",
  "publicBaseUrl", "releaseTuple", "candidateGeneration",
  "trafficGeneration", "canary", "platformBundle",
]);
const TUPLE_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "backendImageDigest", "backendConfigDigest",
  "journeyContractDigest", "serverRouteBundleDigest", "deploymentRevision",
  "environmentIdentity", "tupleSha256",
]);
const CANARY_FIELDS = Object.freeze([
  "canaryRequestIdentity", "requestId", "originStationId",
  "destinationStationId", "mobilityProfile", "constraintMode",
  "maxTransfers", "alternativeCount",
]);
const CANARY_PROBE_FIELDS = Object.freeze([
  "regionId", "requestId", "originStationId",
  "destinationStationId", "mobilityProfile", "constraintMode",
  "maxTransfers", "alternativeCount",
]);
const OVERRIDE_KEYS = new Set([
  "SPRING_PROFILES_ACTIVE",
  "EASYSUBWAY_PUSH_DELIVERY_ENABLED",
  "EASYSUBWAY_JOURNEY_PROFILE_RESOURCE_POLICY_PATH",
  "EASYSUBWAY_JOURNEY_PROFILE_RESOURCE_POLICY_SHA256",
  "EASYSUBWAY_JOURNEY_PROFILE_MAX_REQUEST_BYTES",
  "EASYSUBWAY_JOURNEY_V3_READINESS_RELEASE_TUPLE_SHA256",
  "EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST",
  "EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_CONFIG_SHA256",
  "EASYSUBWAY_JOURNEY_V3_READINESS_JOURNEY_CONTRACT_SHA256",
  "EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION",
  "EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION",
  "EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID",
  "EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN",
]);
const ERROR_MESSAGES = Object.freeze({
  K3S_USAGE: "K3s Journey activation request is invalid",
  K3S_PRECOMMIT_FAILED: "K3s Journey activation failed before traffic commit",
  K3S_POSTSWITCH_FAILED: "K3s Journey activation failed after traffic commit began",
  K3S_RECEIPT_FAILED: "K3s Journey activation receipt could not be stored",
});

export class K3sJourneyActivationError extends Error {
  constructor(code, exitCode, options) {
    super(ERROR_MESSAGES[code] ?? "K3s Journey activation failed", options);
    this.name = "K3sJourneyActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runK3sJourneyActivation(
  input,
  effects,
  { failureNow = () => new Date().toISOString() } = {},
) {
  validateRequest(input);
  validateEffects(effects);
  if (typeof failureNow !== "function") throw typed("K3S_USAGE", undefined, 2);
  try {
    await effects.verifyImmutableBundle?.({ input });
  } catch (cause) {
    throw typed("K3S_USAGE", cause, 1);
  }
  await reserveOperationDirectory(input.operationDirectory);
  const state = {
    candidateApplied: false,
    portForward: undefined,
    trafficCommitStarted: false,
    activeServiceMutationCount: 0,
    nginxMutationCount: 0,
    oldWorkloadMutationCount: 0,
    preparedActiveService: undefined,
    serviceCas: undefined,
  };
  try {
    const values = await executeK3sActivation(input, effects, state);
    const receipt = successReceipt({ input, ...values, ...state });
    await writeCreateOnly(
      path.join(input.operationDirectory, "k3s-activation-receipt.json"),
      receipt,
    );
    return receipt;
  } catch (cause) {
    await recordActivationFailure({ input, effects, failureNow, state, cause });
  }
}

async function reserveOperationDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    throw typed("K3S_USAGE", error, error?.code === "EEXIST" ? 1 : 2);
  }
}

async function executeK3sActivation(input, effects, state) {
  const verifiedInputs = await effects.verifyInputs({ input });
  const runtime = await effects.verifyRuntime({ input });
  // Issue #228: cleanup 책임은 이 run이 candidate 객체를 실제로 만들기 시작한 뒤에만 생긴다.
  const candidate = await effects.applyCandidate({
    input, runtime, markCandidateCreated: () => { state.candidateApplied = true; },
  });
  state.portForward = await effects.openCandidatePortForward({ input, candidate });
  const baseUrl = state.portForward.baseUrl;
  const canary = await effects.runCandidateCanary({ input, candidate, baseUrl });
  requireFallbackZero(canary);
  const observation = await effects.observeCandidate({
    input, candidate, baseUrl, canary,
  });
  const admission = await effects.admitCandidate({
    input, candidate, canary, observation,
  });
  const activation = await effects.activateCandidate({
    input, candidate, baseUrl, admission,
  });
  state.trafficCommitStarted = true;
  state.preparedActiveService = await effects.prepareActiveService({
    input, candidate, admission, activation,
  });
  state.activeServiceMutationCount =
    state.preparedActiveService.activeServiceMutationCount;
  state.serviceCas = await effects.commitActiveServiceCas({
    input, candidate, preparedActiveService: state.preparedActiveService,
    admission, activation,
  });
  state.activeServiceMutationCount += 1;
  const endpoint = await effects.verifyActiveEndpoint({
    input, candidate, serviceCas: state.serviceCas, activation,
  });
  const nginx = await effects.switchNginx({ input, endpoint, activation });
  state.nginxMutationCount = 1;
  let drain;
  try {
    drain = await effects.drainOldWorkloads({
      input, candidate, preparedActiveService: state.preparedActiveService,
      serviceCas: state.serviceCas,
    });
  } catch (error) {
    // drain이 일부 workload를 멈춘 뒤 실패하면 실패 receipt가 실제 변경 수를 기록해야 한다.
    if (Number.isSafeInteger(error?.oldWorkloadCount) && error.oldWorkloadCount >= 0) {
      state.oldWorkloadMutationCount = error.oldWorkloadCount;
    }
    throw error;
  }
  state.oldWorkloadMutationCount = drain.oldWorkloadCount;
  const publicSmoke = await effects.runPublicSmoke({
    input, endpoint, activation, canary,
  });
  await effects.cleanupCandidateService({ input, candidate });
  await state.portForward.close();
  state.portForward = undefined;
  return {
    verifiedInputs, runtime, candidate, canary, observation, admission,
    activation, endpoint, nginx, drain, publicSmoke,
  };
}

async function recordActivationFailure({ input, effects, failureNow, state, cause }) {
  let cleanupError;
  if (!state.trafficCommitStarted && state.candidateApplied) {
    try {
      await effects.cleanupCandidate({ input });
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await state.portForward?.close();
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw typed("K3S_RECEIPT_FAILED", cleanupError);
  const postSwitch = state.trafficCommitStarted;
  const code = postSwitch ? "K3S_POSTSWITCH_FAILED" : "K3S_PRECOMMIT_FAILED";
  let failedAt;
  try {
    failedAt = validTimestamp(failureNow());
  } catch (clockError) {
    throw typed("K3S_RECEIPT_FAILED", clockError);
  }
  const failure = {
    schemaVersion: "PLATFORM_K3S_ACTIVATION_FAILURE_V1",
    artifactKind: "platform-k3s-activation-failure",
    orchestrator: "K3S",
    phase: postSwitch ? "FAILED_POSTSWITCH" : "FAILED_PRECOMMIT",
    operationId: input.operationId,
    runUrl: input.runUrl,
    failedAt,
    releaseIdentity: releaseIdentity(input),
    mutationCounts: {
      activeService: postSwitch ? state.activeServiceMutationCount : 0,
      nginx: postSwitch ? state.nginxMutationCount : 0,
      oldWorkload: postSwitch ? state.oldWorkloadMutationCount : 0,
    },
    serviceCas: state.serviceCas ? publicServiceCas(state.serviceCas) : null,
    rollbackAttemptCount: 0,
    degradedSuccess: false,
    successReceiptCreated: false,
    fallbackZero: FALLBACK_ZERO,
    failureCode: code,
    bundleAcquisitionEvidenceDigest: input.platformBundle.acquisitionEvidenceDigest,
  };
  try {
    await writeCreateOnly(
      path.join(input.operationDirectory, "k3s-activation-failure.json"),
      failure,
    );
  } catch (receiptError) {
    throw typed("K3S_RECEIPT_FAILED", receiptError);
  }
  throw typed(code, cause);
}

export function createK3sJourneyActivationEffects({
  request,
  commandRunner = runCommand,
  serviceToken = process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
  fetchImpl = fetch,
} = {}) {
  validateRequest(request);
  if (typeof commandRunner !== "function" || typeof fetchImpl !== "function" ||
    !validServiceToken(serviceToken)) {
    throw typed("K3S_USAGE", undefined, 2);
  }
  let rendered;
  let backendEnvironment;
  // Issue #228: 이 run이 만든(또는 만들기 시작한) candidate 객체만 기록한다. cleanup은 이 목록만 지운다.
  const createdObjects = new Set();

  const kubectl = (args, options = {}) => commandRunner(
    "sudo",
    ["--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`, ...args],
    options,
  );
  const adminKubectl = (args, options = {}) => commandRunner(
    "sudo",
    ["--non-interactive", "k3s", "kubectl", ...args],
    options,
  );

  return {
    async verifyImmutableBundle() {
      const stagedBundle = await inspectStagedPlatformContractBundle({
        runtimeContractPath: request.platformBundle.runtimeContractPath,
        readStableFile: readStableRegularFile,
      });
      if (JSON.stringify(stagedBundle) !== JSON.stringify(request.platformBundle)) {
        throw new Error("K3s Hub bundle evidence binding changed");
      }
    },
    async verifyInputs() {
      const [, candidateBytes, backendEnvBytes] = await Promise.all([
        this.verifyImmutableBundle(),
        readStableRegularFile(request.candidateInputPath),
        readStableRegularFile(request.backendEnvPath),
      ]);
      const runtimeBytes = await readStableRegularFile(request.platformBundle.runtimeContractPath);
      if (digest(runtimeBytes) !== request.runtimeContractSha256) {
        throw new Error("K3s runtime contract identity changed");
      }
      const candidateInput = parseJson(candidateBytes);
      if (candidateInput.tupleSha256 !== request.releaseTuple.tupleSha256 ||
        candidateInput.candidateGeneration !== request.candidateGeneration ||
        candidateInput.trafficGeneration !== request.trafficGeneration ||
        candidateInput.secretIdentity !== digest(backendEnvBytes)) {
        throw new Error("K3s candidate input identity mismatch");
      }
      backendEnvironment = parseEnvironment(backendEnvBytes);
      return {
        runtimeContractSha256: request.runtimeContractSha256,
        candidateInputSha256: digest(candidateBytes),
        backendConfigSha256: digest(backendEnvBytes),
        evidenceDigest: evidence([
          request.runtimeContractSha256,
          digest(candidateBytes),
          digest(backendEnvBytes),
        ]),
      };
    },
    async verifyRuntime() {
      // 트래픽 전환 전 읽기 전용 검사: drain 대상이 아닌 backend가 운영 DB에 붙어 있으면 변경 없이 실패한다.
      const precommitForeign = await scanForeignBackendContainers(commandRunner, {
        tolerateComposeProject: request.projectName,
      });
      if (precommitForeign.length > 0) {
        throw new Error(
          `backend process outside the active K3s digest is running: ${precommitForeign.join(", ")}`,
        );
      }
      await commandRunner(
        "sudo",
        [
          "--non-interactive",
          path.join(REPOSITORY_ROOT, "tools/platform/bootstrap-single-node-k3s.sh"),
          "--mode", "VERIFY",
        ],
        { timeoutMs: 60_000 },
      );
      const nodes = parseJson(Buffer.from((await adminKubectl([
        "get", "nodes", "-o", "json",
      ])).stdout));
      if (!Array.isArray(nodes.items) || nodes.items.length !== 1) {
        throw new Error("exactly one K3s node is required");
      }
      const internalAddresses = nodes.items[0]?.status?.addresses?.filter(
        (entry) => entry.type === "InternalIP",
      ) ?? [];
      if (internalAddresses.length !== 1) throw new Error("one node InternalIP is required");
      const candidateInput = parseJson(await readStableRegularFile(request.candidateInputPath));
      if (candidateInput.nodeInternalIp !== internalAddresses[0].address) {
        throw new Error("protected node InternalIP does not match K3s runtime");
      }
      await adminKubectl(["get", "namespace", NAMESPACE, "-o", "name"]);
      // Issue #221: NetworkPolicy ipBlock과 Prometheus 대상(ClusterIP)이 실제 런타임과 같은지 PRECOMMIT에서
      // 읽기 전용으로 확인한다. 다르면 어떤 K3s 변경도 하기 전에 실패한다.
      const observability = await readObservabilityContract();
      const networkConfig = parseJson(Buffer.from((await commandRunner("docker", [
        "network", "inspect", observability.composeNetwork.name, "--format", "{{json .IPAM.Config}}",
      ])).stdout));
      if (!Array.isArray(networkConfig) || networkConfig.length !== 1 ||
        networkConfig[0]?.Subnet !== observability.composeNetwork.subnet) {
        const observed = Array.isArray(networkConfig) && networkConfig.length > 0
          ? networkConfig.map((entry) => String(entry?.Subnet)).join(",")
          : "none";
        throw new Error("compose network subnet does not match the observability contract: " +
          `expected ${observability.composeNetwork.subnet}, observed ${observed}`);
      }
      const activeServiceBytes = Buffer.from((await kubectl([
        "get", "service", observability.activeService.name, "--namespace", NAMESPACE,
        "--ignore-not-found", "-o", "json",
      ])).stdout);
      if (activeServiceBytes.toString("utf8").trim() !== "") {
        const observedClusterIp = parseJson(activeServiceBytes)?.spec?.clusterIP;
        if (observedClusterIp !== observability.activeService.clusterIP) {
          throw new Error("active Service ClusterIP does not match the observability contract: " +
            `expected ${observability.activeService.clusterIP}, observed ${String(observedClusterIp)}`);
        }
      }
      return {
        nodeInternalIp: internalAddresses[0].address,
        evidenceDigest: evidence([nodes.items[0].metadata?.uid, internalAddresses[0].address]),
      };
    },
    async applyCandidate({ markCandidateCreated = () => {} } = {}) {
      if (!backendEnvironment) throw new Error("inputs were not verified");
      const renderResult = await commandRunner(
        process.execPath,
        [
          path.join(REPOSITORY_ROOT, "tools/platform/render-journey-kubernetes-candidate.mjs"),
          "--input", request.candidateInputPath,
        ],
      );
      rendered = parseJson(Buffer.from(renderResult.stdout));
      const renderInput = parseJson(await readStableRegularFile(request.candidateInputPath));
      validateRender(rendered, request, await readObservabilityContract(), renderInput.nodeInternalIp);
      const configMap = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: rendered.configPlan.name, namespace: NAMESPACE },
        immutable: true,
        data: rendered.configPlan.overrides,
      };
      // Issue #228: immutable ConfigMap은 같은 이름에 다른 data를 둘 수 없다. 어떤 create·apply보다 먼저
      // 기존 객체와 대조하고, 다르면 지우거나 덮어쓰지 않고 실패한다.
      const existingConfigMapBytes = Buffer.from((await kubectl([
        "get", "configmap", configMap.metadata.name, "--namespace", NAMESPACE,
        "--ignore-not-found", "-o", "json",
      ])).stdout);
      const configMapExisted = existingConfigMapBytes.toString("utf8").trim() !== "";
      if (configMapExisted) {
        const existingData = parseJson(existingConfigMapBytes)?.data ?? {};
        const differing = [...new Set([...Object.keys(existingData), ...Object.keys(configMap.data)])]
          .filter((key) => existingData[key] !== configMap.data[key])
          .sort((left, right) => left.localeCompare(right));
        if (differing.length > 0) {
          throw new Error(
            `immutable ConfigMap ${configMap.metadata.name} already exists with different data: ${differing.join(",")}`,
          );
        }
      }
      const candidateEnv = {
        ...Object.fromEntries(
          Object.entries(backendEnvironment).filter(([key]) => !OVERRIDE_KEYS.has(key)),
        ),
      };
      if (candidateEnv.EASYSUBWAY_DATASOURCE_URL && rendered.configPlan?.internalEndpoints?.postgres) {
        const pgEndpoint = rendered.configPlan.internalEndpoints.postgres;
        candidateEnv.EASYSUBWAY_DATASOURCE_URL = candidateEnv.EASYSUBWAY_DATASOURCE_URL.replace(
          /:\/\/[^:]+:[0-9]+/,
          `://${pgEndpoint.host}:${pgEndpoint.port}`,
        );
      }
      if (candidateEnv.EASYSUBWAY_REPORT_OBJECT_STORAGE_INTERNAL_ENDPOINT && rendered.configPlan?.internalEndpoints?.objectStorage) {
        const osEndpoint = rendered.configPlan.internalEndpoints.objectStorage;
        candidateEnv.EASYSUBWAY_REPORT_OBJECT_STORAGE_INTERNAL_ENDPOINT =
          `${osEndpoint.scheme.toLowerCase()}://${osEndpoint.host}:${osEndpoint.port}`;
      }
      if (!candidateEnv.EASYSUBWAY_ADMIN_REMEMBER_ME_KEY || candidateEnv.EASYSUBWAY_ADMIN_REMEMBER_ME_KEY.length < 32) {
        if (candidateEnv.EASYSUBWAY_ADMIN_PASSWORD || candidateEnv.EASYSUBWAY_DATASOURCE_URL) {
          candidateEnv.EASYSUBWAY_ADMIN_REMEMBER_ME_KEY = createHash("sha256")
            .update(`${request.releaseTuple?.tupleSha256 ?? "easysubway"}:remember-me`)
            .digest("hex");
        }
      }
      if (candidateEnv.EASYSUBWAY_TIMETABLE_SEED_ENABLED !== undefined) {
        candidateEnv.EASYSUBWAY_TIMETABLE_SEED_ENABLED = "false";
      }
      if (candidateEnv.EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX !== undefined) {
        candidateEnv.EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX = "false";
      }
      const descriptorPath = path.join(
        path.dirname(request.tuplePath),
        "server-route-bundle-publication-descriptor.json",
      );
      try {
        const descriptorBytes = await readStableRegularFile(descriptorPath);
        const descriptorJson = JSON.parse(descriptorBytes.toString("utf8"));
        if (descriptorJson?.publicationReceipt?.locator?.publicBaseUrl) {
          candidateEnv.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_DESCRIPTOR_BASE64 =
            descriptorBytes.toString("base64");
          candidateEnv.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_ACTIVATION_REQUEST_IDENTITY =
            request.releaseTuple.tupleSha256;
          candidateEnv.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_TRUSTED_RAW_DESCRIPTOR_BASE_URL =
            descriptorJson.publicationReceipt.locator.publicBaseUrl;
          candidateEnv.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_KEY_ID =
            descriptorJson.manifest?.keyId ?? "production-v1";
          const signingKey = candidateEnv.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
          if (signingKey) {
            const pem = normalizePem(signingKey);
            candidateEnv.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = pem;
            candidateEnv.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_PUBLIC_KEY_PEM = pem;
          }
        }
      } catch {
        // Optional startup route bundle descriptor injection
      }
      candidateEnv.EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN = serviceToken;

      const secret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: rendered.secretPlan.name, namespace: NAMESPACE },
        immutable: true,
        type: "Opaque",
        stringData: candidateEnv,
      };
      try {
        await kubectl(["create", "-f", "-"], { input: jsonBytes(secret) });
      } catch (error) {
        if (!String(error?.message ?? "").includes("AlreadyExists")) {
          throw error;
        }
        await kubectl([
          "delete", "secret", rendered.secretPlan.name,
          "--namespace", NAMESPACE, "--ignore-not-found=true",
        ]);
        await kubectl(["create", "-f", "-"], { input: jsonBytes(secret) });
      }
      createdObjects.add(`secret/${rendered.secretPlan.name}`);
      markCandidateCreated();
      // apply 전에 없던 candidate 객체만 이 run 소유로 기록한다(apply가 중간에 실패해도 정리 대상이 정확하다).
      const ownedCandidates = [
        ["deployment", rendered.activationPlan.candidateDeploymentName],
        ["service", rendered.activationPlan.candidateServiceName],
      ];
      for (const [kind, name] of ownedCandidates) {
        const existing = (await kubectl([
          "get", kind, name, "--namespace", NAMESPACE, "--ignore-not-found", "-o", "name",
        ])).stdout;
        if (Buffer.from(existing ?? "").toString("utf8").trim() === "") createdObjects.add(`${kind}/${name}`);
      }
      if (!configMapExisted) createdObjects.add(`configmap/${configMap.metadata.name}`);
      const objects = [
        configMap,
        ...rendered.candidateObjects.filter((object) => object.kind !== "Namespace"),
      ];
      await kubectl(["apply", "-f", "-"], { input: jsonBytes({
        apiVersion: "v1",
        kind: "List",
        items: objects,
      }) });
      try {
        await kubectl([
          "rollout", "status", `deployment/${rendered.activationPlan.candidateDeploymentName}`,
          "--namespace", NAMESPACE, "--timeout=360s",
        ], { timeoutMs: 370_000 });
      } catch (rolloutError) {
        try {
          const desc = await adminKubectl([
            "describe", "deployment", rendered.activationPlan.candidateDeploymentName,
            "--namespace", NAMESPACE,
          ]);
          process.stderr.write(`\n=== CANDIDATE DEPLOYMENT DESCRIBE ===\n${desc.stdout}\n`);
        } catch (descError) {
          process.stderr.write(`\n=== DESCRIBE ERROR ===\n${descError.message}\n`);
        }
        try {
          const podLogs = await adminKubectl([
            "logs", `deployment/${rendered.activationPlan.candidateDeploymentName}`,
            "--namespace", NAMESPACE, "--tail=100", "--all-containers=true",
          ]);
          process.stderr.write(`\n=== CANDIDATE POD LOGS ===\n${podLogs.stdout}\n${podLogs.stderr}\n`);
        } catch (logsError) {
          process.stderr.write(`\n=== LOGS ERROR ===\n${logsError.message}\n`);
        }
        throw rolloutError;
      }
      return {
        deploymentName: rendered.activationPlan.candidateDeploymentName,
        candidateServiceName: rendered.activationPlan.candidateServiceName,
        candidateToken: rendered.releaseIdentity.candidateToken,
        evidenceDigest: evidence([
          rendered.releaseIdentity.tupleSha256,
          rendered.activationPlan.candidateDeploymentName,
        ]),
      };
    },
    async openCandidatePortForward({ candidate }) {
      return openPortForward({
        command: "sudo",
        args: [
          "--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`,
          "--namespace", NAMESPACE,
          "port-forward", `service/${candidate.candidateServiceName}`,
          ":8080", "--address=127.0.0.1",
        ],
      });
    },
    async runCandidateCanary({ candidate, baseUrl }) {
      try {
        return await runJourneyCandidateCanary({
          tuplePath: request.tuplePath,
          baseUrl,
          candidateGeneration: request.candidateGeneration,
          ...request.canary,
          serviceToken,
          fetchImpl,
        });
      } catch (canaryError) {
        try {
          const podLogs = await adminKubectl([
            "logs", `deployment/${candidate?.deploymentName ?? rendered?.activationPlan?.candidateDeploymentName}`,
            "--namespace", NAMESPACE, "--tail=200", "--all-containers=true",
          ]);
          process.stderr.write(`\n=== CANDIDATE POD LOGS ON CANARY FAILURE ===\n${podLogs.stdout}\n${podLogs.stderr}\n`);
        } catch (dumpError) {
          process.stderr.write(`\n=== POD LOG DUMP ERROR ===\n${dumpError.message}\n`);
        }
        throw canaryError;
      }
    },
    async observeCandidate({ baseUrl, canary }) {
      requireFallbackZero(canary);
      const body = await requestJson(
        new URL("/internal/v1/journey/readiness/candidate", `${baseUrl}/`),
        { serviceToken, fetchImpl },
      );
      validateReadiness(body, request, false);
      return {
        ready: true,
        tupleSha256: request.releaseTuple.tupleSha256,
        evidenceDigest: `sha256:${body.evidenceSha256}`,
      };
    },
    async admitCandidate({ canary, observation }) {
      const candidateAdmissionSha256 = evidence([
        "K3S",
        request.releaseTuple.tupleSha256,
        canary.evidenceDigest,
        observation.evidenceDigest,
        String(request.candidateGeneration),
      ]);
      return {
        candidateAdmissionSha256,
        evidenceDigest: candidateAdmissionSha256,
      };
    },
    async activateCandidate({ baseUrl, admission }) {
      const command = {
        schemaVersion: 1,
        artifactKind: "journey-v3-activation-command",
        activationRequestIdentity: request.releaseTuple.tupleSha256,
        candidateManifestSha256: request.releaseTuple.serverRouteBundleDigest.slice(7),
        candidateGeneration: request.candidateGeneration,
        expectedActiveGeneration: request.candidateGeneration - 1,
        trafficGeneration: request.trafficGeneration,
      };
      try {
        const body = await requestJson(
          new URL("/internal/v1/journey/activation", `${baseUrl}/`),
          { method: "POST", body: command, serviceToken, fetchImpl },
        );
        validateReadiness(body, request, true);
        return {
          trafficGeneration: request.trafficGeneration,
          activeReadinessEvidenceDigest: `sha256:${body.evidenceSha256}`,
          evidenceDigest: `sha256:${body.evidenceSha256}`,
        };
      } catch (activationError) {
        try {
          const podLogs = await adminKubectl([
            "logs", `deployment/${rendered?.activationPlan?.candidateDeploymentName}`,
            "--namespace", NAMESPACE, "--tail=200", "--all-containers=true",
          ]);
          process.stderr.write(`\n=== CANDIDATE POD LOGS ON ACTIVATION FAILURE ===\n${podLogs.stdout}\n${podLogs.stderr}\n`);
        } catch (dumpError) {
          process.stderr.write(`\n=== POD LOG DUMP ERROR ===\n${dumpError.message}\n`);
        }
        throw activationError;
      }
    },
    async prepareActiveService() {
      let current;
      let serviceExisted = true;
      let activeServiceMutationCount = 0;
      try {
        current = parseJson(Buffer.from((await kubectl([
          "get", "service", rendered.activationPlan.activeServiceName,
          "--namespace", NAMESPACE, "-o", "json",
        ])).stdout));
      } catch (error) {
        if (!(error instanceof HostCommandError) || !error.stderr.includes("NotFound")) {
          throw error;
        }
        serviceExisted = false;
        const unbound = structuredClone(rendered.activationPlan.activeServiceTemplate);
        unbound.spec.selector = {
          "easysubway.io/traffic-disabled": request.operationId.slice(7, 27),
        };
        await kubectl(["create", "-f", "-"], { input: jsonBytes(unbound) });
        activeServiceMutationCount = 1;
        current = parseJson(Buffer.from((await kubectl([
          "get", "service", rendered.activationPlan.activeServiceName,
          "--namespace", NAMESPACE, "-o", "json",
        ])).stdout));
      }
      validateActiveService(current);
      return {
        serviceExisted,
        resourceVersion: current.metadata.resourceVersion,
        activeServiceMutationCount,
        previousSelector: current.spec.selector ?? {},
        currentService: current,
        evidenceDigest: evidence([
          current.metadata.uid,
          current.metadata.resourceVersion,
          JSON.stringify(current.spec.selector ?? {}),
        ]),
      };
    },
    async commitActiveServiceCas({ preparedActiveService }) {
      if (preparedActiveService.resourceVersion !==
        preparedActiveService.currentService?.metadata?.resourceVersion) {
        throw new Error("active Service resourceVersion was not preserved");
      }
      const replacement = sanitizeServiceForReplace(preparedActiveService.currentService);
      replacement.metadata.labels = rendered.activationPlan.activeServiceTemplate.metadata.labels;
      replacement.metadata.annotations = releaseAnnotations(request);
      replacement.spec.selector = rendered.activationPlan.selectorPatch;
      return commitServiceCasWithReconciliation({
        replace: async () => parseJson(Buffer.from((await kubectl([
          "replace", "-f", "-", "-o", "json"],
        { input: jsonBytes(replacement) })).stdout)),
        readCurrent: async () => parseJson(Buffer.from((await kubectl([
          "get", "service", rendered.activationPlan.activeServiceName,
          "--namespace", NAMESPACE, "-o", "json"])).stdout)),
        previousResourceVersion: preparedActiveService.resourceVersion,
        selector: rendered.activationPlan.selectorPatch, annotations: replacement.metadata.annotations,
      });
    },
    async verifyActiveEndpoint({ candidate }) {
      return waitForActiveEndpoint({
        readSnapshot: async () => {
          const [pods, slices] = await Promise.all([
            kubectl(["get", "pods", "--namespace", NAMESPACE,
              "-l", `easysubway.io/candidate-token=${candidate.candidateToken}`, "-o", "json"]),
            kubectl(["get", "endpointslices", "--namespace", NAMESPACE,
              "-l", "kubernetes.io/service-name=journey-active", "-o", "json"]),
          ]);
          return { pods: parseJson(Buffer.from(pods.stdout)),
            slices: parseJson(Buffer.from(slices.stdout)) };
        },
        tupleSha256: request.releaseTuple.tupleSha256,
      });
    },
    async switchNginx() {
      const current = Buffer.from((await commandRunner("sudo", [
        "--non-interactive", "cat", request.nginxConfigPath,
      ])).stdout, "utf8");
      const bytes = renderK3sNginxConfig(current);
      const stagedPath = path.join(request.operationDirectory, "nginx-k3s-candidate.conf");
      await writeBytesCreateOnly(stagedPath, bytes, 0o600);
      await commandRunner("sudo", [
        "--non-interactive", "install", "--mode=0644", stagedPath,
        request.nginxConfigPath,
      ]);
      await commandRunner("sudo", ["--non-interactive", "nginx", "-t"]);
      await commandRunner("sudo", ["--non-interactive", "nginx", "-s", "reload"]);
      return {
        targetPort: 32080,
        nginxConfigSha256: digest(bytes),
        evidenceDigest: evidence([digest(bytes), "32080"]),
      };
    },
    async drainOldWorkloads({ candidate, preparedActiveService }) {
      let oldWorkloadCount = 0;
      const previousToken = preparedActiveService.previousSelector?.[
        "easysubway.io/candidate-token"
      ];
      if (previousToken && previousToken !== candidate.candidateToken) {
        await kubectl([
          "delete", "deployment", "--namespace", NAMESPACE,
          "-l", `easysubway.io/candidate-token=${previousToken}`,
          "--ignore-not-found=true", "--wait=true", "--timeout=30s",
        ], { timeoutMs: 35_000 });
        oldWorkloadCount += 1;
      }
      const composePrefix = [
        "compose", "--project-name", request.projectName,
        "--env-file", request.composeEnvPath,
        "-f", request.baseComposePath,
      ];
      const composeOptions = {
        env: {
          ...process.env,
          EASYSUBWAY_BACKEND_ENV_FILE: request.backendEnvPath,
          EASYSUBWAY_BACKEND_IMAGE: `ghcr.io/aquilaxk/easysubway-backend@${request.releaseTuple.backendImageDigest}`,
        },
      };
      const running = parseRunningComposeServices((await commandRunner("docker", [
        ...composePrefix, "ps", "--services", "--status", "running",
        ...PRODUCTION_DB_COMPOSE_BACKEND_SERVICES,
      ], composeOptions)).stdout);
      if (running.length > 0) {
        await commandRunner("docker", [
          ...composePrefix, "stop", "--timeout", "30", ...running,
        ], { ...composeOptions, timeoutMs: 35_000 });
      }
      // K3s pod는 containerd에서 돌므로, drain 뒤 docker에 남은 backend 프로세스는 모두
      // 활성 K3s digest가 아닌 이미지로 운영 DB에 붙은 프로세스다(Issue #219).
      const foreign = await scanForeignBackendContainers(commandRunner);
      if (foreign.length > 0) {
        throw Object.assign(new Error(
          `backend process outside the active K3s digest is still running: ${foreign.join(", ")}`,
        ), { oldWorkloadCount: oldWorkloadCount + running.length });
      }
      oldWorkloadCount += running.length;
      return {
        signal: "SIGTERM",
        stopGracePeriodSeconds: 30,
        oldWorkloadCount,
        evidenceDigest: evidence(["SIGTERM", "30", String(oldWorkloadCount)]),
      };
    },
    async runPublicSmoke({ canary } = {}) {
      try {
        const active = await requestJson(
          new URL("/internal/v1/journey/readiness/active", `${request.publicBaseUrl}/`),
          { serviceToken, fetchImpl },
        );
        validateReadiness(active, request, true);
        const canaryEvidence = canary?.evidenceDigest ?? canary?.evidenceSha256 ?? request.releaseTuple.tupleSha256;
        return {
          passed: true,
          tupleSha256: request.releaseTuple.tupleSha256,
          evidenceDigest: evidence([canaryEvidence, active.evidenceSha256]),
        };
      } catch (smokeError) {
        try {
          const podLogs = await adminKubectl([
            "logs", `deployment/${rendered?.activationPlan?.candidateDeploymentName}`,
            "--namespace", NAMESPACE, "--tail=200", "--all-containers=true",
          ]);
          process.stderr.write(`\n=== CANDIDATE POD LOGS ON PUBLIC SMOKE FAILURE ===\n${podLogs.stdout}\n${podLogs.stderr}\n`);
        } catch (dumpError) {
          process.stderr.write(`\n=== POD LOG DUMP ERROR ===\n${dumpError.message}\n`);
        }
        throw smokeError;
      }
    },
    async cleanupCandidateService() {
      await kubectl([
        "delete", "service", rendered.activationPlan.candidateServiceName,
        "--namespace", NAMESPACE, "--ignore-not-found=true", "--wait=true",
      ]);
      return {
        removed: true,
        evidenceDigest: evidence([rendered.activationPlan.candidateServiceName, "removed"]),
      };
    },
    async cleanupCandidate() {
      if (!rendered) return;
      const owned = [
        `deployment/${rendered.activationPlan.candidateDeploymentName}`,
        `service/${rendered.activationPlan.candidateServiceName}`,
        `configmap/${rendered.configPlan.name}`,
        `secret/${rendered.secretPlan.name}`,
      ].filter((object) => createdObjects.has(object));
      if (owned.length === 0) return;
      await kubectl([
        "delete", ...owned,
        "--namespace", NAMESPACE, "--ignore-not-found=true", "--wait=true",
      ]);
    },
  };
}

function successReceipt(values) {
  return {
    schemaVersion: "PLATFORM_K3S_ACTIVATION_RECEIPT_V1",
    artifactKind: "platform-k3s-activation-receipt",
    orchestrator: "K3S",
    outcome: "ACTIVE_SERVING",
    operation: {
      operationId: values.input.operationId,
      runUrl: values.input.runUrl,
      generatedAt: values.input.generatedAt,
    },
    releaseIdentity: releaseIdentity(values.input),
    verification: {
      inputsEvidenceDigest: values.verifiedInputs.evidenceDigest,
      runtimeEvidenceDigest: values.runtime.evidenceDigest,
    },
    candidate: {
      deploymentName: values.candidate.deploymentName,
      candidateEvidenceDigest: values.candidate.evidenceDigest,
      canaryEvidenceDigest: values.canary.evidenceDigest,
      observationEvidenceDigest: values.observation.evidenceDigest,
      candidateAdmissionSha256: values.admission.candidateAdmissionSha256,
      activeReadinessEvidenceDigest: values.activation.activeReadinessEvidenceDigest,
    },
    activation: {
      servicePreparation: {
        serviceExisted: values.preparedActiveService.serviceExisted,
        activeServiceMutationCount: values.activeServiceMutationCount,
        evidenceDigest: values.preparedActiveService.evidenceDigest,
      },
      serviceCas: publicServiceCas(values.serviceCas),
      endpoint: values.endpoint,
      nginx: values.nginx,
      drain: values.drain,
      publicSmoke: values.publicSmoke,
    },
    mutationCounts: {
      activeService: values.activeServiceMutationCount,
      nginx: values.nginxMutationCount,
      oldWorkload: values.oldWorkloadMutationCount,
    },
    rollbackAttemptCount: 0,
    fallbackZero: FALLBACK_ZERO,
    bundleAcquisitionEvidenceDigest: values.input.platformBundle.acquisitionEvidenceDigest,
  };
}

function publicServiceCas(value) {
  return {
    previousResourceVersion: value.previousResourceVersion,
    committedResourceVersion: value.committedResourceVersion,
    selector: value.selector,
    evidenceDigest: value.evidenceDigest,
  };
}

function releaseIdentity(input) {
  return {
    tupleSha256: input.releaseTuple.tupleSha256,
    backendImageDigest: input.releaseTuple.backendImageDigest,
    backendConfigDigest: input.releaseTuple.backendConfigDigest,
    journeyContractDigest: input.releaseTuple.journeyContractDigest,
    serverRouteBundleDigest: input.releaseTuple.serverRouteBundleDigest,
    deploymentRevision: input.releaseTuple.deploymentRevision,
    environmentIdentity: input.releaseTuple.environmentIdentity,
    candidateGeneration: input.candidateGeneration,
    trafficGeneration: input.trafficGeneration,
  };
}

function validateRequest(input) {
  if (!exactObject(input, REQUEST_FIELDS) ||
    input.schemaVersion !== "PLATFORM_SOURCE_FREE_K3S_ACTIVATION_REQUEST_V1" ||
    input.artifactKind !== "platform-source-free-k3s-activation-request" ||
    ![input.operationDirectory, input.deployRoot, input.candidateInputPath,
      input.tuplePath, input.bindingPath, input.descriptorBindingPath,
      input.composeEnvPath, input.backendEnvPath, input.baseComposePath,
      input.candidateComposePath, input.nginxConfigPath].every(absolutePath) ||
    !input.operationDirectory.startsWith(`${input.deployRoot}${path.sep}`) ||
    !DIGEST.test(input.operationId) || !DIGEST.test(input.runtimeContractSha256) ||
    !RUN_URL.test(input.runUrl) || !validTimestamp(input.generatedAt) ||
    !SAFE_PROJECT.test(input.projectName) || !validPublicBaseUrl(input.publicBaseUrl) ||
    !Number.isSafeInteger(input.candidateGeneration) || input.candidateGeneration < 1 ||
    !Number.isSafeInteger(input.trafficGeneration) || input.trafficGeneration < 1 ||
    !validateTuple(input.releaseTuple) || !validateCanary(input.canary) || !validatePlatformBundle(input.platformBundle)) {
    throw typed("K3S_USAGE", undefined, 2);
  }
}
function validatePlatformBundle(bundle) {
  return exactObject(bundle, ["hubRevision", "bundleSha256", "resourceSetSha256", "acquisitionEvidenceDigest", "runtimeContractPath"]) &&
    bundle.hubRevision === HUB_REVISION && bundle.bundleSha256 === `sha256:${BUNDLE_SHA256}` &&
    DIGEST.test(bundle.resourceSetSha256) && DIGEST.test(bundle.acquisitionEvidenceDigest) && absolutePath(bundle.runtimeContractPath);
}

function validateTuple(tuple) {
  return exactObject(tuple, TUPLE_FIELDS) &&
    tuple.schemaVersion === "JOURNEY_RELEASE_TUPLE_V1" &&
    tuple.artifactKind === "journey-release-tuple" &&
    [tuple.backendImageDigest, tuple.backendConfigDigest,
      tuple.journeyContractDigest, tuple.serverRouteBundleDigest,
      tuple.tupleSha256].every((value) => typeof value === "string" && DIGEST.test(value)) &&
    REVISION.test(tuple.deploymentRevision) &&
    typeof tuple.environmentIdentity === "string" && tuple.environmentIdentity.length > 0;
}

function validateCanary(canary) {
  if (canary && Array.isArray(canary.probes)) {
    return exactObject(canary, ["canaryRequestIdentity", "probes"]) &&
      typeof canary.canaryRequestIdentity === "string" && canary.canaryRequestIdentity.length > 0 &&
      canary.probes.length > 0 &&
      canary.probes.every((probe) =>
        exactObject(probe, CANARY_PROBE_FIELDS) &&
        typeof probe.regionId === "string" && probe.regionId.length > 0 &&
        typeof probe.requestId === "string" && probe.requestId.length > 0 &&
        typeof probe.originStationId === "string" && probe.originStationId.length > 0 &&
        typeof probe.destinationStationId === "string" && probe.destinationStationId.length > 0 &&
        typeof probe.mobilityProfile === "string" && probe.mobilityProfile.length > 0 &&
        typeof probe.constraintMode === "string" && probe.constraintMode.length > 0 &&
        Number.isSafeInteger(probe.maxTransfers) && probe.maxTransfers >= 0 &&
        Number.isSafeInteger(probe.alternativeCount) && probe.alternativeCount > 0
      );
  }
  return exactObject(canary, CANARY_FIELDS) &&
    typeof canary.canaryRequestIdentity === "string" && canary.canaryRequestIdentity.length > 0 &&
    typeof canary.requestId === "string" && canary.requestId.length > 0 &&
    typeof canary.originStationId === "string" && canary.originStationId.length > 0 &&
    typeof canary.destinationStationId === "string" && canary.destinationStationId.length > 0 &&
    typeof canary.mobilityProfile === "string" && canary.mobilityProfile.length > 0 &&
    typeof canary.constraintMode === "string" && canary.constraintMode.length > 0 &&
    Number.isSafeInteger(canary.maxTransfers) && canary.maxTransfers >= 0 &&
    Number.isSafeInteger(canary.alternativeCount) && canary.alternativeCount > 0;
}

function validateEffects(effects) {
  const methods = [
    "verifyInputs", "verifyRuntime", "applyCandidate", "openCandidatePortForward",
    "runCandidateCanary", "observeCandidate", "admitCandidate",
    "activateCandidate", "prepareActiveService", "commitActiveServiceCas",
    "verifyActiveEndpoint", "switchNginx", "drainOldWorkloads",
    "runPublicSmoke", "cleanupCandidateService", "cleanupCandidate",
  ];
  if (!effects || methods.some((method) => typeof effects[method] !== "function")) {
    throw typed("K3S_USAGE", undefined, 2);
  }
}

async function readObservabilityContract() {
  return parseJson(await readStableRegularFile(OBSERVABILITY_CONTRACT_PATH));
}

// 보안 경계(Issue #221 F1): backend ingress의 모든 규칙은 TCP 8080 하나만 연다. ipBlock 출처는 노드 /32와
// 계약 compose subnet 둘뿐이고 except가 붙지 않아야 하며, 그 밖의 출처는 자기 namespace selector뿐이다.
// 각 조건은 서로를 대신하지 않도록 독립적으로 검사한다.
function renderMatchesObservability(value, observability, nodeInternalIp) {
  const policy = value?.candidateObjects?.find((object) => object?.kind === "NetworkPolicy");
  const ingress = policy?.spec?.ingress;
  if (value?.activationPlan?.activeServiceTemplate?.spec?.clusterIP !== observability.activeService.clusterIP ||
    !Array.isArray(ingress) || ingress.length === 0) return false;
  const onlyPort8080 = ingress.every((rule) =>
    JSON.stringify(rule?.ports) === JSON.stringify([{ protocol: "TCP", port: 8080 }]));
  const sources = ingress.flatMap((rule) => (Array.isArray(rule?.from) ? rule.from : [undefined]));
  const allowedCidrs = new Set([`${nodeInternalIp}/32`, observability.composeNetwork.subnet]);
  const ipBlocksAllowed = sources.every((source) => source?.ipBlock === undefined ||
    allowedCidrs.has(source.ipBlock.cidr));
  const noExcept = sources.every((source) => source?.ipBlock?.except === undefined);
  const ownNamespaceSelector = JSON.stringify({
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NAMESPACE } },
  });
  const otherSourcesAllowed = sources.every((source) =>
    source?.ipBlock !== undefined || JSON.stringify(source) === ownNamespaceSelector);
  const subnetAdmitted = sources.some((source) => source?.ipBlock?.cidr === observability.composeNetwork.subnet);
  return onlyPort8080 && ipBlocksAllowed && noExcept && otherSourcesAllowed && subnetAdmitted;
}

function validateRender(value, request, observability, nodeInternalIp) {
  if (!renderMatchesObservability(value, observability, nodeInternalIp) ||
    value?.schemaVersion !== "PLATFORM_K3S_CANDIDATE_RENDER_V1" ||
    value?.artifactKind !== "platform-k3s-candidate-render" ||
    value?.releaseIdentity?.tupleSha256 !== request.releaseTuple.tupleSha256 ||
    value?.configPlan?.overrides?.EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION !==
      request.releaseTuple.deploymentRevision ||
    value?.activationPlan?.requiredCasField !== "metadata.resourceVersion" ||
    value?.activationPlan?.applyDuringCandidatePreparation !== false ||
    value?.activationPlan?.activeServiceTemplate?.spec?.ports?.[0]?.nodePort !== 32080 ||
    !Array.isArray(value.candidateObjects)) {
    throw new Error("K3s candidate render is invalid");
  }
}

function validateActiveService(service) {
  const port = service?.spec?.ports?.find((entry) => entry.name === "http");
  if (service?.metadata?.name !== "journey-active" ||
    service?.metadata?.namespace !== NAMESPACE ||
    !RESOURCE_VERSION.test(service?.metadata?.resourceVersion ?? "") ||
    service?.spec?.type !== "NodePort" || port?.nodePort !== 32080 ||
    port?.port !== 8080 || port?.targetPort !== 8080) {
    throw new Error("active Service contract is invalid");
  }
}

function validateReadiness(body, request, active) {
  if (!body || typeof body !== "object" ||
    body.releaseTupleSha256 !== request.releaseTuple.tupleSha256.slice(7) ||
    body.backendImageDigest !== request.releaseTuple.backendImageDigest ||
    body.backendConfigSha256 !== request.releaseTuple.backendConfigDigest.slice(7) ||
    body.journeyContractSha256 !== request.releaseTuple.journeyContractDigest.slice(7) ||
    body.routeBundleManifestSha256 !== request.releaseTuple.serverRouteBundleDigest.slice(7) ||
    body.generation !== request.candidateGeneration ||
    !/^[a-f0-9]{64}$/.test(body.evidenceSha256 ?? "")) {
    throw new Error("Journey readiness identity mismatch");
  }
  if (active && (body.trafficGeneration !== request.trafficGeneration ||
    body.servingReady !== true || body.draining !== false)) {
    throw new Error("Journey active readiness state mismatch");
  }
  if (!active && (body.warmed !== true || body.ready !== true)) {
    throw new Error("Journey candidate readiness state mismatch");
  }
}

function requireFallbackZero(value) {
  for (const [field, expected] of Object.entries(FALLBACK_ZERO)) {
    if (value?.[field] !== expected) throw new Error("Journey fallback counter is nonzero");
  }
}

function sanitizeServiceForReplace(service) {
  const replacement = structuredClone(service);
  delete replacement.status;
  for (const field of [
    "creationTimestamp", "deletionGracePeriodSeconds", "deletionTimestamp",
    "generation", "managedFields", "selfLink", "uid",
  ]) delete replacement.metadata[field];
  return replacement;
}

function releaseAnnotations(input) {
  return {
    "easysubway.io/tuple-sha256": input.releaseTuple.tupleSha256,
    "easysubway.io/backend-image-digest": input.releaseTuple.backendImageDigest,
    "easysubway.io/backend-config-digest": input.releaseTuple.backendConfigDigest,
    "easysubway.io/journey-contract-digest": input.releaseTuple.journeyContractDigest,
    "easysubway.io/server-route-bundle-digest": input.releaseTuple.serverRouteBundleDigest,
    "easysubway.io/deployment-revision": input.releaseTuple.deploymentRevision,
    "easysubway.io/environment-identity": input.releaseTuple.environmentIdentity,
    "easysubway.io/candidate-generation": String(input.candidateGeneration),
    "easysubway.io/traffic-generation": String(input.trafficGeneration),
  };
}

async function requestJson(url, {
  method = "GET",
  body,
  serviceToken,
  fetchImpl,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error("Journey request failed", { cause: error });
  }
  if (response.status !== 200 ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    let text = "";
    try { text = await response.text(); } catch {}
    throw new Error(`Journey response boundary failed (status: ${response.status}${text ? `, body: ${text.slice(0, 1000)}` : ""})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > 64 * 1024) {
    throw new Error("Journey response size is invalid");
  }
  return parseJson(bytes);
}

async function openPortForward({ command, args }) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`K3s port-forward timed out (output: ${output.trim()})`)), 10_000);
    const consume = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 16 * 1024) {
        clearTimeout(timeout);
        reject(new Error("K3s port-forward output exceeded limit"));
        return;
      }
      const match = /Forwarding from 127\.0\.0\.1:([1-9]\d{0,4}) -> 8080/.exec(output);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`K3s port-forward exited with ${code}: ${output.trim()}`));
    });
  }).catch((error) => {
    child.kill("SIGTERM");
    throw error;
  });
  if (!Number.isSafeInteger(port) || port > 65535) {
    child.kill("SIGTERM");
    throw new Error("K3s port-forward selected an invalid port");
  }
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    evidenceDigest: evidence(["127.0.0.1", String(port)]),
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

class HostCommandError extends Error {
  constructor(command, code, stderr) {
    super(`host command failed: ${command}${stderr ? `: ${stderr.trim()}` : ""}`);
    this.name = "HostCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

async function runCommand(command, args, {
  input,
  timeoutMs = 120_000,
  env = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputSize = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (target) => (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 4 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => reject(new HostCommandError(command, "OUTPUT_LIMIT", "")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new HostCommandError(command, code, err.slice(0, 4096)));
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new HostCommandError(command, "TIMEOUT", "")));
    }, timeoutMs);
    if (input) child.stdin.end(input);
  });
}

export function normalizePem(value) {
  if (typeof value !== "string") return value;
  let pem = value.trim();
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
    pem = pem.slice(1, -1).trim();
  }
  return pem.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

export function parseEnvironment(bytes) {
  const environment = {};
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (const line of lines) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      Object.hasOwn(environment, key) || value.includes("\0")) {
      throw new Error("backend environment projection is invalid");
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    environment[key] = value;
  }
  if (Object.keys(environment).length === 0) {
    throw new Error("backend environment projection is empty");
  }
  return environment;
}

async function writeCreateOnly(pathname, value) {
  return writeBytesCreateOnly(pathname, jsonBytes(value), 0o600);
}

async function writeBytesCreateOnly(pathname, bytes, mode) {
  let handle;
  try {
    handle = await open(
      pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await chmod(pathname, mode);
}

function parseJson(bytes) {
  return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
}

function evidence(parts) {
  return digest(Buffer.from(`${parts.join("\n")}\n`, "utf8"));
}

export async function commitServiceCasWithReconciliation({
  replace, readCurrent, previousResourceVersion, selector, annotations,
}) {
  let committed;
  try {
    committed = await replace();
    requireCommittedService(committed, previousResourceVersion, selector, annotations);
  } catch (error) {
    try {
      const reconciled = await readCurrent();
      requireCommittedService(reconciled, previousResourceVersion, selector, annotations);
      committed = reconciled;
    } catch {
      throw error;
    }
  }
  return {
    previousResourceVersion,
    committedResourceVersion: committed.metadata.resourceVersion,
    selector: committed.spec.selector,
    evidenceDigest: evidence([previousResourceVersion,
      committed.metadata.resourceVersion, JSON.stringify(committed.spec.selector)]),
  };
}

function requireCommittedService(service, previousResourceVersion, selector, annotations) {
  if (!RESOURCE_VERSION.test(service?.metadata?.resourceVersion ?? "") ||
    service.metadata.resourceVersion === previousResourceVersion ||
    !sameObject(service.spec?.selector, selector) ||
    !containsObject(service.metadata?.annotations, annotations)) {
    throw new Error("active Service CAS result is invalid");
  }
}

export async function waitForActiveEndpoint({
  readSnapshot, tupleSha256, attempts = 30,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (typeof readSnapshot !== "function" || typeof wait !== "function" || !DIGEST.test(tupleSha256) ||
    !Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error("active endpoint poll configuration is invalid");
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const { pods, slices } = await readSnapshot();
    const readyPods = (pods.items ?? []).filter((pod) => pod.status?.phase === "Running" &&
      pod.metadata?.annotations?.["easysubway.io/tuple-sha256"] === tupleSha256 &&
      pod.status?.conditions?.some((condition) =>
        condition.type === "Ready" && condition.status === "True"));
    const addresses = (slices.items ?? []).flatMap((slice) => (slice.endpoints ?? [])
      .filter((endpoint) => endpoint.conditions?.ready === true)
        .flatMap((endpoint) => endpoint.addresses ?? []));
    if (readyPods.length === 1 && addresses.length === 1 &&
      readyPods[0].status.podIP === addresses[0]) {
      return {
        readyAddress: addresses[0], nodePort: 32080, tupleSha256,
        evidenceDigest: evidence([readyPods[0].metadata.uid, addresses[0], tupleSha256]),
      };
    }
    if (attempt < attempts) await wait(1_000);
  }
  throw new Error("active Service endpoint did not reconcile to the admitted candidate");
}

export function parseRunningComposeServices(output) {
  if (typeof output !== "string") throw new Error("Compose service output is invalid");
  const services = output.split(/\r?\n/).filter((value) => value.length > 0);
  const allowed = new Set(PRODUCTION_DB_COMPOSE_BACKEND_SERVICES);
  if (new Set(services).size !== services.length || services.some((service) => !allowed.has(service))) {
    throw new Error("Compose running service identity is invalid");
  }
  return services;
}

// 레포 경로의 마지막 구성요소가 easysubway-backend로 시작하면 backend 이미지다.
export function isBackendImageReference(image) {
  if (typeof image !== "string") return false;
  const repository = image.split("@")[0].replace(/:[^/]*$/, "");
  return repository.split("/").pop().startsWith("easysubway-backend");
}

// docker에서 running·restarting 상태인 backend 이미지 컨테이너 이름을 돌려준다(Issue #219).
// restarting은 재시작 사이에 running 목록에서 빠지지만 곧 다시 운영 DB에 붙으므로 포함한다.
// 태그가 지워져 ID로만 보이는 이미지는 docker image inspect로 판정하고, 판정할 수 없을 때만 실패로 본다.
// tolerateComposeProject를 주면 그 project의 drain 집합 서비스는 활성화가 곧 멈출 대상이므로 제외한다.
export async function scanForeignBackendContainers(commandRunner, { tolerateComposeProject } = {}) {
  const raw = (await commandRunner("docker", [...HOST_BACKEND_SCAN_ARGS]))?.stdout;
  const output = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  if (typeof output !== "string") throw new Error("docker container output is invalid");
  const foreign = [];
  for (const line of output.split(/\r?\n/).filter((value) => value.length > 0)) {
    const fields = line.split("\t");
    if (fields.length !== 4 || fields[0].length === 0 || fields[1].length === 0) {
      throw new Error("docker container identity is invalid");
    }
    const [name, image, composeProject, composeService] = fields;
    if (tolerateComposeProject !== undefined && composeProject === tolerateComposeProject &&
      PRODUCTION_DB_COMPOSE_BACKEND_SERVICES.includes(composeService)) {
      continue;
    }
    if (isBackendImageReference(image)) {
      foreign.push(name);
    } else if (UNRESOLVED_IMAGE_ID.test(image) &&
      await inspectedImageIsBackendOrUnknown(commandRunner, image)) {
      foreign.push(name);
    }
  }
  return foreign;
}

async function inspectedImageIsBackendOrUnknown(commandRunner, imageId) {
  let image;
  try {
    const raw = (await commandRunner("docker", ["image", "inspect", imageId]))?.stdout;
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
      return true;
    }
    image = parsed[0];
  } catch {
    return true;
  }
  const references = [...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])];
  const source = image.Config?.Labels?.["org.opencontainers.image.source"];
  return references.some(isBackendImageReference) ||
    (typeof source === "string" && BACKEND_IMAGE_SOURCE.test(source));
}

function sameObject(left, right) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).sort((first, second) => first.localeCompare(second));
  const rightKeys = Object.keys(right).sort((first, second) => first.localeCompare(second));
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function containsObject(actual, expected) {
  return actual && expected && Object.entries(expected)
    .every(([key, value]) => actual[key] === value);
}

export function renderK3sNginxConfig(current) {
  if (!Buffer.isBuffer(current)) throw new Error("installed Nginx config is invalid");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(current);
  const composeTarget = "proxy_pass http://127.0.0.1:8080;";
  const k3sTarget = "proxy_pass http://127.0.0.1:32080;";
  const composeTargetCount = source.split(composeTarget).length - 1;
  const k3sTargetCount = source.split(k3sTarget).length - 1;
  if (!((composeTargetCount === 3 && k3sTargetCount === 0) ||
    (composeTargetCount === 0 && k3sTargetCount === 3))) {
    throw new Error("installed Nginx backend target does not match the cutover contract");
  }
  return composeTargetCount === 3
    ? Buffer.from(source.replaceAll(composeTarget, k3sTarget), "utf8")
    : Buffer.from(current);
}

function validTimestamp(value) {
  if (typeof value !== "string" || !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))) {
    throw new Error("timestamp is invalid");
  }
  return value;
}

function validServiceToken(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x21 && codePoint < 0x7f;
    });
}

function typed(code, cause, exitCode = 1) {
  return new K3sJourneyActivationError(code, exitCode, cause ? { cause } : undefined);
}

function parseCli(args) {
  if (args.length !== 2 || args[0] !== "--request" ||
    !absolutePath(args[1])) throw typed("K3S_USAGE", undefined, 2);
  return args[1];
}

async function main() {
  const requestPath = parseCli(process.argv.slice(2));
  const bytes = await readStableRegularFile(requestPath);
  const request = parseJson(bytes);
  const result = await runK3sJourneyActivation(
    request,
    createK3sJourneyActivationEffects({ request }),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    const failure = error instanceof K3sJourneyActivationError
      ? error
      : typed("K3S_PRECOMMIT_FAILED", error);
    process.stderr.write(`${failure.code} ${failure.message}\n`);
    if (failure.cause) {
      process.stderr.write(`\n=== ACTIVATION ERROR CAUSE ===\n${failure.cause?.stack ?? failure.cause}\n`);
      let cause = failure.cause.cause;
      while (cause) {
        process.stderr.write(`\n=== ROOT CAUSE ===\n${cause?.stack ?? cause}\n`);
        cause = cause.cause;
      }
    }
    process.exitCode = failure.exitCode;
  }
}
