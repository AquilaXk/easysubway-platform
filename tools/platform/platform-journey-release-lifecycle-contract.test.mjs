import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contractUrl = new URL("../../contracts/release/platform-journey-release-lifecycle-contract.json", import.meta.url);
const schemaUrl = new URL("../../contracts/release/platform-journey-release-lifecycle-contract.schema.json", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const ciCommand = "node --test tools/platform/platform-journey-release-lifecycle-contract.test.mjs";

const tupleIdentityFields = [
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
];

const candidateStates = [
  "ABSENT",
  "ALLOCATED",
  "INPUTS_VALIDATED",
  "INSTANCES_STARTED",
  "ALL_INSTANCES_WARMED",
  "CANARY_PASSED",
  "READY_TO_ACTIVATE",
  "ACTIVE_PENDING_CONVERGENCE",
  "ACTIVE_SERVING",
  "FAILED_PRECOMMIT",
  "FAILED_POSTCOMMIT",
];

const successTransitions = [
  ["ABSENT", "ALLOCATED"],
  ["ALLOCATED", "INPUTS_VALIDATED"],
  ["INPUTS_VALIDATED", "INSTANCES_STARTED"],
  ["INSTANCES_STARTED", "ALL_INSTANCES_WARMED"],
  ["ALL_INSTANCES_WARMED", "CANARY_PASSED"],
  ["CANARY_PASSED", "READY_TO_ACTIVATE"],
  ["READY_TO_ACTIVATE", "ACTIVE_PENDING_CONVERGENCE"],
  ["ACTIVE_PENDING_CONVERGENCE", "ACTIVE_SERVING"],
];

test("contract and schema are canonical JSON with one trailing LF", () => {
  for (const url of [contractUrl, schemaUrl]) {
    const bytes = readFileSync(url, "utf8");
    assert.equal(bytes.includes("\r"), false);
    assert.equal(bytes.startsWith("\uFEFF"), false);
    assert.equal(bytes, `${bytes.trimEnd()}\n`);
    assert.doesNotThrow(() => JSON.parse(bytes));
  }
});

test("closed schema accepts only the exact lifecycle contract", () => {
  const contract = readJson(contractUrl);
  const schema = readJson(schemaUrl);
  const required = [
    "schemaVersion",
    "artifactKind",
    "issueRef",
    "consumedContracts",
    "sourceFreeInput",
    "orchestratorBinding",
    "candidate",
    "activeState",
    "activation",
    "recoveryDeployment",
    "failure",
    "receipts",
  ];

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "Platform Journey release lifecycle contract");
  assertClosedObjectSchema(schema, required);
  assertMatchesSchema(contract, schema);

  const driftCases = [
    (value) => { value.issueRef.issueNumber = 17; },
    (value) => { value.sourceFreeInput.sourceTreeReadCount = 1; },
    (value) => { value.orchestratorBinding.failureSelectsAlternate = true; },
    (value) => { value.candidate.minimumInstanceCount = 2; },
    (value) => { value.candidate.stateMachine.successTransitions.reverse(); },
    (value) => { value.activeState.commitLinearizationPointCount = 2; },
    (value) => { value.activeState.requiredServingEqualityFields.pop(); },
    (value) => { value.activation.genericRollingMixedExposureCount = 1; },
    (value) => { value.activation.priorActivePool.identity = "NEW_ACTIVE_POOL"; },
    (value) => { value.activation.modes.FIRST_ACTIVATION.drainRequired = true; },
    (value) => { value.activation.priorActivePool.failedPostCommitRecovery.automaticStartCount = 1; },
    (value) => { value.recoveryDeployment.implicitPreviousSelectionCount = 1; },
    (value) => { value.recoveryDeployment.approvalReceipt = "OPTIONAL"; },
    (value) => { value.failure.preCommitVisibleStateMutation.active = 1; },
    (value) => { value.failure.postCommitFailure.successClaim = 1; },
    (value) => { value.unknown = true; },
  ];
  for (const mutate of driftCases) {
    const drift = structuredClone(contract);
    mutate(drift);
    assert.throws(() => assertMatchesSchema(drift, schema));
  }
});

test("source-free inputs and orchestrator binding forbid substitution", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.consumedContracts, {
    journeyReleaseTuple: {
      path: "contracts/release/journey-release-tuple.schema.json",
      schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    },
    serverRouteBundleObjectAcquisition: {
      path: "contracts/release/server-route-bundle-object-acquisition-contract.json",
      schemaVersion: 1,
      artifactKind: "server-route-bundle-object-acquisition-contract-v1",
    },
    activationReceiptFoundation: {
      path: "contracts/release/platform-activation-receipt.schema.json",
      schemaVersion: "PLATFORM_ACTIVATION_RECEIPT_V1",
      disposition: "FOUNDATION_REQUIRES_FUTURE_RUNTIME_BINDING",
    },
    semanticOwnership: "BACKEND_AND_PLAN_JOURNEY",
  });
  assert.deepEqual(contract.sourceFreeInput, {
    allowedInputs: [
      "IMMUTABLE_RELEASE_TUPLE",
      "IMMUTABLE_BACKEND_IMAGE",
      "IMMUTABLE_CONFIG_OBJECT",
      "IMMUTABLE_JOURNEY_CONTRACT_OBJECT",
      "IMMUTABLE_ACQUIRED_SERVER_ROUTE_BUNDLE_OBJECT_SET",
      "IMMUTABLE_EVIDENCE_REFERENCES",
    ],
    releaseTupleIdentityFields: tupleIdentityFields,
    sourceTreeReadCount: 0,
    hubCheckoutReadCount: 0,
    rawMainReadCount: 0,
    siblingCheckoutReadCount: 0,
    mutableLocatorCount: 0,
    localDurableTruthCount: 0,
  });
  assert.deepEqual(contract.orchestratorBinding, {
    contractMappings: ["COMPOSE", "KUBERNETES"],
    selection: "EXACTLY_ONE_PER_OPERATION",
    mutableDuringOperation: false,
    failureSelectsAlternate: false,
    implementationIncluded: false,
  });
});

test("candidate state machine and active commit keep mixed traffic at zero", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.candidate, {
    ownership: "TASK_OWNED_IMMUTABLE",
    productionTrafficBeforeActiveServing: 0,
    minimumInstanceCount: 1,
    distinctFailureDomainsRequired: false,
    requiredSteps: [
      "VALIDATE_EXACT_RELEASE_TUPLE",
      "START_EVERY_TARGET_INSTANCE",
      "LOAD_COMPILE_AND_BOUNDED_WARM",
      "RUN_REQUIRED_CANARIES",
      "REQUIRE_EVERY_INSTANCE_IDENTITY_AND_READINESS",
      "RECORD_IMMUTABLE_CANDIDATE_RECEIPT",
    ],
    exactIdentityFields: ["tupleSha256", ...tupleIdentityFields],
    stateMachine: {
      states: candidateStates,
      successTransitions,
      preCommitStates: candidateStates.slice(0, 7),
      preCommitFailureTarget: "FAILED_PRECOMMIT",
      postCommitFailureTarget: "FAILED_POSTCOMMIT",
    },
  });
  assert.deepEqual(contract.activeState, {
    classification: "ATOMIC_GLOBAL_PLATFORM_STATE",
    activePointerCount: 1,
    commit: "COMPARE_AND_SET_POINTER_AND_TRAFFIC_GENERATION",
    trafficGeneration: "STRICTLY_INCREASING_INTEGER",
    commitLinearizationPointCount: 1,
    commitPrecondition: "READY_TO_ACTIVATE",
    postCommitState: "ACTIVE_PENDING_CONVERGENCE",
    servingState: "ACTIVE_SERVING",
    trafficAdmission: "ONLY_ACTIVE_SERVING_WITH_ALL_IDENTITIES_EQUAL",
    requiredServingEqualityFields: ["tupleSha256", "trafficGeneration"],
    candidateTrafficCount: 0,
    mixedUnknownOrUnreadyTrafficCount: 0,
    localDurableTruthCount: 0,
  });
  assert.deepEqual(contract.activation, {
    modes: {
      FIRST_ACTIVATION: {
        requiredPreviousActiveState: "ABSENT",
        previousActiveIdentityRequired: false,
        drainRequired: false,
      },
      REPLACEMENT_ACTIVATION: {
        requiredPreviousActiveState: "PRESENT_EXACT_TUPLE_AND_GENERATION",
        previousActiveIdentityRequired: true,
        drainRequired: true,
      },
    },
    commonPostCommitSteps: [
      "REQUERY_EVERY_SERVING_INSTANCE",
      "REQUIRE_EXACT_ACTIVE_IDENTITY_EQUALITY",
      "OPEN_JOURNEY_TRAFFIC",
    ],
    modePostCommitSteps: {
      FIRST_ACTIVATION: ["RECORD_IMMUTABLE_ACTIVATION_RECEIPT"],
      REPLACEMENT_ACTIVATION: [
        "MARK_OLD_POOL_NOT_READY",
        "DRAIN_OLD_POOL",
        "RECORD_IMMUTABLE_ACTIVATION_RECEIPT",
      ],
    },
    successRequiresByMode: {
      FIRST_ACTIVATION: ["POST_COMMIT_CONVERGENCE", "SUCCESS_RECEIPT_STORED"],
      REPLACEMENT_ACTIVATION: ["POST_COMMIT_CONVERGENCE", "OLD_POOL_DRAINED", "SUCCESS_RECEIPT_STORED"],
    },
    genericRollingMixedExposureCount: 0,
    oldPoolReadinessAfterConvergence: "DOWN",
    inFlightSnapshot: "PINNED_TO_REQUEST_START_RELEASE_TUPLE",
    drainFailureOutcome: "FAILED_POSTCOMMIT_WITH_JOURNEY_TRAFFIC_ZERO",
    implicitReversalCount: 0,
    priorActivePool: {
      identity: "PREVIOUS_ACTIVE_POINTER_TUPLE_AND_GENERATION",
      drainStartsAfter: "NEW_ACTIVE_POST_COMMIT_CONVERGENCE",
      states: ["ACTIVE_SERVING", "NOT_READY", "DRAINING", "DRAINED", "FAILED_POSTCOMMIT"],
      successTransitions: [
        ["ACTIVE_SERVING", "NOT_READY"],
        ["NOT_READY", "DRAINING"],
        ["DRAINING", "DRAINED"],
      ],
      drainFailureTarget: "FAILED_POSTCOMMIT",
      failedPostCommitRecovery: {
        operationKind: "RECOVERY_DEPLOYMENT",
        requiresOperatorApprovalReceipt: true,
        requiredStartingState: "FAILED_POSTCOMMIT",
        requiredPointerIdentity: "EXACT_CURRENT_POINTER_TUPLE_AND_GENERATION",
        successTransitions: [
          ["FAILED_POSTCOMMIT", "NOT_READY"],
          ["NOT_READY", "DRAINING"],
          ["DRAINING", "DRAINED"],
        ],
        journeyTrafficDuringCleanup: 0,
        automaticStartCount: 0,
        implicitPreviousSelectionCount: 0,
        cleanupReceiptRequired: true,
      },
    },
  });
});

test("recovery and failure contracts require explicit targets and zero alternates", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.recoveryDeployment, {
    operationKind: "RECOVERY_DEPLOYMENT",
    trigger: "EXPLICIT_OPERATOR_APPROVAL",
    operationIdentity: "NEW_UNIQUE_OPERATION_ID",
    approvalReceipt: "IMMUTABLE_OPERATOR_APPROVAL_RECEIPT_DIGEST",
    cause: "REQUIRED_SANITIZED_NON_EMPTY_CAUSE",
    exactTargetCount: 1,
    targetSelection: "OPERATOR_SELECTED_IMMUTABLE_RELEASE_TUPLE",
    currentValidationFields: [
      "SIGNATURE_AND_CURRENT_KEY",
      "FRESHNESS",
      "SCHEMA_AND_STATION_SET",
      "CONTRACT_IMAGE_AND_CONFIG_COMPATIBILITY",
      "EVERY_INSTANCE_WARMUP_IDENTITY_AND_READINESS",
    ],
    repeatsLifecycle: true,
    currentValidationResult: "IMMUTABLE_CURRENT_VALIDATION_RESULT_DIGEST",
    receiptBinding: "APPROVAL_CAUSE_TARGET_VALIDATION_AND_OUTCOME",
    automaticStartAfterFailureCount: 0,
    implicitPreviousSelectionCount: 0,
    olderTargetTrialCount: 0,
    invalidTargetMutation: { active: 0, trafficGeneration: 0, traffic: 0 },
  });
  assert.deepEqual(contract.failure, {
    result: "TYPED_NONZERO",
    codes: [
      "OPERATION_INPUT_INVALID",
      "SOURCE_FREE_INPUT_POLICY_VIOLATION",
      "CANDIDATE_OWNERSHIP_VIOLATION",
      "INSTANCE_COUNT_OR_FAILURE_DOMAIN_INVALID",
      "VALIDATION_OR_WARMUP_FAILED",
      "INSTANCE_IDENTITY_MISMATCH",
      "CANARY_FAILED",
      "ACTIVE_COMPARE_AND_SET_CONFLICT",
      "POST_COMMIT_CONVERGENCE_FAILED",
      "OLD_POOL_DRAIN_FAILED",
      "RECOVERY_APPROVAL_OR_TARGET_INVALID",
      "EVIDENCE_INVALID",
    ],
    preCommitVisibleStateMutation: { candidate: 0, active: 0, trafficGeneration: 0, traffic: 0 },
    postCommitFailure: {
      journeyTraffic: 0,
      successClaim: 0,
      goContribution: 0,
      successReceipt: 0,
      automaticAlternateActivation: 0,
    },
    forbiddenSuccessSources: [
      "SOURCE_TREE",
      "HUB_OR_RAW_MAIN",
      "MUTABLE_LOCATOR",
      "PREVIOUS_ARTIFACT_CONFIG_OR_IMAGE",
      "ROUTE_V2_OR_LEGACY",
      "ALTERNATE_ORCHESTRATOR",
      "CROSS_RC_EVIDENCE",
    ],
    counters: {
      currentFailureToAlternateSuccessCount: 0,
      previousTargetSelectedAfterFailureCount: 0,
      orchestratorFallbackCount: 0,
      crossRcEvidenceCount: 0,
    },
  });
  assert.deepEqual(contract.receipts, {
    immutableNoOverwrite: true,
    requiredKinds: ["CANDIDATE", "ACTIVATION", "RECOVERY_DEPLOYMENT", "FAILED_OPERATION"],
    commonIdentityFields: [
      "operationId",
      "operationKind",
      "selectedOrchestrator",
      "tupleSha256",
      "expectedTrafficGeneration",
      "resultingTrafficGeneration",
      "outcome",
      "evidenceDigests",
    ],
    activationModeIdentityFields: {
      FIRST_ACTIVATION: {
        previousActivePointerState: "ABSENT",
        requiredFields: [],
      },
      REPLACEMENT_ACTIVATION: {
        previousActivePointerState: "PRESENT",
        requiredFields: ["previousActiveTupleSha256", "previousTrafficGeneration"],
      },
    },
    recoveryDeploymentIdentityFields: [
      "operatorApprovalReceiptDigest",
      "recoveryCause",
      "selectedTargetTupleSha256",
      "currentValidationResultDigest",
      "outcome",
    ],
    successReceiptAfterByMode: {
      FIRST_ACTIVATION: "POST_COMMIT_CONVERGENCE",
      REPLACEMENT_ACTIVATION: "POST_COMMIT_CONVERGENCE_AND_OLD_POOL_DRAIN",
    },
    failedOperationReceiptRequired: true,
    sanitizedEvidenceDigestsOnly: true,
  });

  const serialized = JSON.stringify(contract);
  for (const permissive of [
    "WARN_AND_CONTINUE",
    "BEST_EFFORT",
    "SELECT_PREVIOUS",
    "AUTO_RECOVERY",
    "FALLBACK_TO_HUB",
    "ALLOW_MIXED_TRAFFIC",
  ]) {
    assert.equal(serialized.includes(permissive), false, permissive);
  }
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
