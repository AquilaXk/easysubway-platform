import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contractUrl = new URL("../../contracts/release/platform-journey-release-lifecycle-contract.json", import.meta.url);
const schemaUrl = new URL("../../contracts/release/platform-journey-release-lifecycle-contract.schema.json", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const ciCommand = "node --test tools/platform/platform-journey-release-lifecycle-contract.test.mjs";

const states = [
  "ABSENT",
  "INPUTS_VALIDATED",
  "STANDBY_STARTED",
  "STANDBY_READY",
  "CANARY_PASSED",
  "READY_TO_ACTIVATE",
  "STANDBY_ACTIVE",
  "TRAFFIC_ON_STANDBY",
  "CANONICAL_DRAINING",
  "CANONICAL_RECREATED",
  "CANONICAL_ACTIVE",
  "TRAFFIC_ON_CANONICAL",
  "STANDBY_REMOVED",
  "ACTIVE_SERVING",
  "FAILED_PRECOMMIT",
  "FAILED_POSTSWITCH",
];

const transitions = states.slice(0, 14).slice(0, -1)
  .map((state, index) => [state, states[index + 1]]);

test("contract and schema are canonical JSON with one trailing LF", () => {
  for (const url of [contractUrl, schemaUrl]) {
    const bytes = readFileSync(url, "utf8");
    assert.equal(bytes.includes("\r"), false);
    assert.equal(bytes.startsWith("\uFEFF"), false);
    assert.equal(bytes, `${bytes.trimEnd()}\n`);
    assert.doesNotThrow(() => JSON.parse(bytes));
  }
});

test("closed schema accepts only the exact fixed-host lifecycle contract", () => {
  const contract = readJson(contractUrl);
  const schema = readJson(schemaUrl);
  const required = [
    "schemaVersion", "artifactKind", "issueRef", "consumedContracts",
    "sourceFreeInput", "orchestratorBinding", "candidate", "activeState",
    "activation", "recoveryDeployment", "failure", "receipts",
  ];

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "Platform Journey release lifecycle contract");
  assertClosedObjectSchema(schema, required);
  assertMatchesSchema(contract, schema);

  const driftCases = [
    (value) => { value.issueRef.issueNumber = 77; },
    (value) => { value.sourceFreeInput.hubCheckoutReadCount = 1; },
    (value) => { value.orchestratorBinding.configured = "KUBERNETES"; },
    (value) => { value.orchestratorBinding.lockCoverage = "STANDBY_START_ONLY"; },
    (value) => { value.candidate.maximumInstanceCount = 2; },
    (value) => { value.candidate.roles.standby.port = 8080; },
    (value) => { value.candidate.stateMachine.successTransitions.reverse(); },
    (value) => { value.activeState.commitLinearizationPointCount = 2; },
    (value) => { value.activation.canonical.stopGracePeriodSeconds = 31; },
    (value) => { value.activation.nginxSwitches[0].toPort = 8080; },
    (value) => { value.failure.preCommitVisibleStateMutation.nginx = 1; },
    (value) => { value.failure.postSwitchFailure.degradedSuccessCount = 1; },
    (value) => { value.receipts.successReceiptAfter = "TRAFFIC_ON_STANDBY"; },
    (value) => { value.unknown = true; },
  ];
  for (const mutate of driftCases) {
    const drift = structuredClone(contract);
    mutate(drift);
    assert.throws(() => assertMatchesSchema(drift, schema));
  }
});

test("source-free inputs and one inherited COMPOSE deploy lock forbid substitution", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.consumedContracts, {
    journeyReleaseTuple: {
      path: "contracts/release/journey-release-tuple.schema.json",
      schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    },
    serverRouteBundlePublicationDescriptor: {
      repository: "AquilaXk/easysubway-data",
      path: "contracts/datapack/server-route-bundle-publication-descriptor.schema.json",
      schemaVersion: 2,
      artifactKind: "server-route-bundle-publication-descriptor",
    },
    activationReceiptFoundation: {
      path: "contracts/release/platform-activation-receipt.schema.json",
      schemaVersion: "PLATFORM_ACTIVATION_RECEIPT_V2",
      disposition: "FIXED_HOST_RUNTIME_BINDING_REQUIRED_BY_77",
    },
    semanticOwnership: "BACKEND_AND_PLAN_JOURNEY",
  });
  assert.deepEqual(contract.sourceFreeInput, {
    allowedInputs: [
      "IMMUTABLE_DEPLOYMENT_INPUT_ENVELOPE",
      "IMMUTABLE_DATA_PUBLICATION_DESCRIPTOR",
      "IMMUTABLE_RELEASE_TUPLE",
      "IMMUTABLE_CANDIDATE_BINDING",
      "IMMUTABLE_DESCRIPTOR_BINDING",
      "IMMUTABLE_CANDIDATE_ADMISSION",
      "IMMUTABLE_EVIDENCE_REFERENCES",
    ],
    sourceTreeReadCount: 0,
    hubCheckoutReadCount: 0,
    rawMainReadCount: 0,
    siblingCheckoutReadCount: 0,
    mutableLocatorCount: 0,
    localDurableTruthCount: 0,
  });
  assert.deepEqual(contract.orchestratorBinding, {
    configured: "COMPOSE",
    configuredCount: 1,
    alternateSelectionCount: 0,
    mutableDuringOperation: false,
    failureSelectsAlternate: false,
    sharedDeployLock: "${DEPLOY_ROOT}/deploy.lock",
    lockCoverage: "STANDBY_START_THROUGH_FINAL_CLEANUP_AND_RECEIPT",
  });
});

test("state machine commits only at the first Nginx switch and returns to fixed canonical", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.candidate, {
    ownership: "OPERATION_OWNED_IMMUTABLE",
    hostCount: 1,
    realFailureDomainCount: 1,
    minimumInstanceCount: 1,
    maximumInstanceCount: 1,
    productionTrafficBeforeCommit: 0,
    roles: {
      canonical: { service: "backend", host: "127.0.0.1", port: 8080, transient: false },
      standby: { service: "backend-standby", host: "127.0.0.1", port: 8082, transient: true },
    },
    exactIdentityFields: [
      "tupleSha256", "backendImageDigest", "backendConfigDigest",
      "journeyContractDigest", "serverRouteBundleDigest",
      "deploymentRevision", "environmentIdentity", "candidateGeneration",
    ],
    requiredPreCommitEvidence: [
      "CANDIDATE_READINESS", "CANDIDATE_CANARY", "CANDIDATE_ADMISSION",
      "STANDBY_ACTIVATION", "STANDBY_ACTIVE_READINESS",
    ],
    stateMachine: {
      states,
      successTransitions: transitions,
      preCommitStates: states.slice(0, 7),
      commitTransition: ["STANDBY_ACTIVE", "TRAFFIC_ON_STANDBY"],
      preCommitFailureTarget: "FAILED_PRECOMMIT",
      postCommitFailureTarget: "FAILED_POSTSWITCH",
    },
  });
  assert.deepEqual(contract.activeState, {
    classification: "HOST_NGINX_TARGET",
    persistentSlotRegistryCount: 0,
    commit: "ATOMIC_NGINX_SWITCH_TO_127_0_0_1_8082",
    commitLinearizationPointCount: 1,
    commitPrecondition: "STANDBY_ACTIVE",
    trafficGeneration: "STRICTLY_INCREASING_INTEGER",
    postCommitState: "TRAFFIC_ON_STANDBY",
    steadyState: "ACTIVE_SERVING",
    steadyStateTarget: "127.0.0.1:8080",
    mixedUnknownOrUnreadyTrafficCount: 0,
    localDurableTruthCount: 0,
  });
});

test("activation binds standby, two Nginx switches and canonical 30-second drain", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.activation, {
    standby: {
      activationAttemptCount: 1,
      endpoint: "/internal/v1/journey/activation",
      activeReadinessRequired: true,
      beforeFirstTrafficSwitch: true,
    },
    nginxSwitches: [
      { fromPort: 8080, toPort: 8082, nginxTestRequired: true, reloadRequired: true },
      { fromPort: 8082, toPort: 8080, nginxTestRequired: true, reloadRequired: true },
    ],
    canonical: {
      signal: "SIGTERM",
      stopGracePeriodSeconds: 30,
      newRequestAdmissionAfterSignal: 0,
      inFlightSnapshot: "PINNED_TO_REQUEST_START_RELEASE_TUPLE",
      inFlightCompletionRequired: true,
      recreateWithAdmittedBytes: true,
      activationAttemptCount: 1,
      activeReadinessConvergenceRequired: true,
    },
    successRequires: [
      "CANONICAL_ACTIVE_READINESS_EQUALITY",
      "NGINX_SWITCHBACK_TO_8080",
      "STANDBY_REMOVED",
      "SUCCESS_RECEIPT_STORED",
    ],
    genericRollingMixedExposureCount: 0,
    implicitReversalCount: 0,
  });
  assert.deepEqual(contract.recoveryDeployment, {
    ownerIssueNumber: 17,
    includedInCurrentRuntime: false,
    automaticStartCount: 0,
    implicitPreviousSelectionCount: 0,
    olderTargetTrialCount: 0,
    requiredTarget: "OPERATOR_SELECTED_CURRENT_VALID_IMMUTABLE_RELEASE_TUPLE",
    repeatsFixedHostLifecycle: true,
  });
});

test("failure and receipts keep admitted-standby failure distinct from success", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.failure, {
    result: "TYPED_NONZERO",
    codes: [
      "OPERATION_INPUT_INVALID", "SOURCE_FREE_INPUT_POLICY_VIOLATION",
      "DEPLOY_LOCK_UNAVAILABLE", "STANDBY_START_OR_READINESS_FAILED",
      "CANARY_OR_ADMISSION_FAILED", "STANDBY_ACTIVATION_FAILED",
      "NGINX_STANDBY_SWITCH_FAILED", "CANONICAL_DRAIN_FAILED",
      "CANONICAL_RECREATE_OR_ACTIVATION_FAILED",
      "NGINX_CANONICAL_SWITCHBACK_FAILED", "STANDBY_CLEANUP_FAILED",
      "EVIDENCE_INVALID",
    ],
    preCommitVisibleStateMutation: {
      canonical: 0, nginx: 0, trafficTarget: 0, trafficGeneration: 0,
      candidateCleanupRequired: true,
    },
    postSwitchFailure: {
      exactAdmittedStandbyMayRemainServing: true,
      successClaim: 0,
      goContribution: 0,
      successReceipt: 0,
      degradedSuccessCount: 0,
      automaticPreviousSelectionCount: 0,
      automaticAlternateActivationCount: 0,
    },
    forbiddenSuccessSources: [
      "SOURCE_TREE", "HUB_OR_RAW_MAIN", "MUTABLE_LOCATOR",
      "PREVIOUS_ARTIFACT_CONFIG_OR_IMAGE", "ROUTE_V2_OR_LEGACY",
      "ALTERNATE_ORCHESTRATOR", "CACHED_OR_LOCAL_ARTIFACT",
    ],
  });
  assert.deepEqual(contract.receipts, {
    immutableNoOverwrite: true,
    requiredKinds: ["CANDIDATE", "ACTIVATION", "FAILED_OPERATION"],
    activationIdentityFields: [
      "operationId", "dataDescriptorSha256", "tupleSha256",
      "candidateBindingSha256", "descriptorBindingSha256",
      "candidateAdmissionSha256", "candidateGeneration", "trafficGeneration",
      "standbyActiveReadinessEvidenceDigest", "standbyNginxSwitchEvidenceDigest",
      "canonicalDrainEvidenceDigest", "canonicalActiveReadinessEvidenceDigest",
      "canonicalNginxSwitchEvidenceDigest", "standbyRemovalEvidenceDigest",
      "outcome",
    ],
    successReceiptAfter: "ACTIVE_SERVING_AND_STANDBY_REMOVED",
    failedOperationReceiptRequired: true,
    sanitizedEvidenceDigestsOnly: true,
  });

  const serialized = JSON.stringify(contract);
  for (const forbidden of [
    "COMPARE_AND_SET_POINTER", "KUBERNETES", "SELECT_PREVIOUS",
    "AUTO_RECOVERY", "FALLBACK_TO_HUB", "ALLOW_MIXED_TRAFFIC",
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("Platform CI runs the exact focused lifecycle test in jobs.platform", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  const jobsIndex = workflow.indexOf("jobs:\n");
  assert.notEqual(jobsIndex, -1, "workflow must define jobs");
  const jobs = workflow.slice(jobsIndex + "jobs:\n".length);
  const platformJob = jobs.match(/^  platform:\n(?<block>(?:^(?:    .*|)\n?)*)/m);
  assert.notEqual(platformJob, null, "workflow must define jobs.platform");
  assert.match(
    platformJob.groups.block,
    new RegExp(`^          ${escapeRegExp(ciCommand)}$`, "m"),
    `Platform CI job must run ${ciCommand}`,
  );
});

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function assertClosedObjectSchema(schema, required) {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, required);
  assert.deepEqual(Object.keys(schema.properties), required);
}

function assertMatchesSchema(value, schema, path = "$") {
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const, `${path} must match const`);
  if (schema.type === "object") {
    assert.equal(typeof value, "object", `${path} must be object`);
    assert.notEqual(value, null, `${path} must not be null`);
    assert.equal(Array.isArray(value), false, `${path} must not be array`);
    for (const key of schema.required ?? []) assert.equal(Object.hasOwn(value, key), true, `${path}.${key} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.equal(Object.hasOwn(schema.properties, key), true, `${path}.${key} is unknown`);
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertMatchesSchema(value[key], propertySchema, `${path}.${key}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
