import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contractUrl = new URL("../../contracts/release/server-route-bundle-object-acquisition-contract.json", import.meta.url);
const schemaUrl = new URL("../../contracts/release/server-route-bundle-object-acquisition-contract.schema.json", import.meta.url);
const workflowUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const ciCommand = "node --test tools/platform/server-route-bundle-object-acquisition-contract.test.mjs";

const producerSchemas = [
  {
    role: "consumer-handoff",
    path: "contracts/datapack/server-route-bundle-consumer-handoff.schema.json",
    gitBlob: "b88c86f353310cd119ebb3fb0d76a4cc27251cb7",
    rawSha256: "9a6e691a8e029c21075a93f7da2b409ae5a0cde2d7bb8e02ff9c393157657d36",
  },
  {
    role: "publication-receipt",
    path: "contracts/datapack/server-route-bundle-publication-receipt.schema.json",
    gitBlob: "98395dc2928dc818b8b409b65c1ed1e19af9b9da",
    rawSha256: "79c2396c383461dc45b6503ccd3b85bdbf3fc64183e31042f09c92c84db44d3e",
  },
  {
    role: "component-manifest",
    path: "contracts/datapack/artifact-component-manifest.schema.json",
    gitBlob: "7ff2141895446876aeeaccd85d3bd7b2634f9c42",
    rawSha256: "64995e377b45aa86ff7dbd9635dd8248315bc74134040da6ff42ae82ed05c20b",
  },
];

const consumedJsonPointers = [
  "/publicationReceipt/repository/gitSha",
  "/publicationReceipt/candidate",
  "/publicationReceipt/locator",
  "/publicationReceipt/objects",
  "/release",
  "/platformRelease/serverRouteBundleDigest",
  "/handoffSha256",
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

test("schema is closed and accepts only the exact contract", () => {
  const contract = readJson(contractUrl);
  const schema = readJson(schemaUrl);
  const required = [
    "schemaVersion",
    "artifactKind",
    "issueRef",
    "producer",
    "consumedJsonPointers",
    "acquisition",
    "candidateOutput",
    "retention",
    "failure",
  ];

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.title, "Server route bundle object acquisition contract");
  assertClosedObjectSchema(schema, required);
  assertMatchesSchema(contract, schema);

  const driftCases = [
    (value) => { value.producer.gitSha = "f".repeat(40); },
    (value) => { value.producer.schemas.reverse(); },
    (value) => { value.consumedJsonPointers.reverse(); },
    (value) => { value.acquisition.objectCount = 7; },
    (value) => { value.candidateOutput.overwriteAllowed = true; },
    (value) => { value.retention.alternateSelectionCount = 1; },
    (value) => { value.failure.stateMutationOnFailure.candidate = 1; },
    (value) => { value.unknown = true; },
  ];
  for (const mutate of driftCases) {
    const drift = structuredClone(contract);
    mutate(drift);
    assert.throws(() => assertMatchesSchema(drift, schema));
  }
});

test("producer identities and consumed pointers bind the immutable Data handoff", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.producer, {
    repository: "AquilaXk/easysubway-data",
    gitSha: "2b1390c1c764fde10b9da8ca8015a9252e5342fb",
    schemas: producerSchemas,
  });
  assert.deepEqual(contract.consumedJsonPointers, consumedJsonPointers);
});

test("acquisition requires one exact ordered eight-object HTTPS inventory", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.acquisition, {
    inventoryPointer: "/publicationReceipt/objects",
    objectCount: 8,
    objectIdentityFields: ["objectKey", "sizeBytes", "sha256"],
    transport: {
      scheme: "HTTPS",
      redirectsAllowed: false,
      locatorPointer: "/publicationReceipt/locator",
      objectPrefixPolicy: "EXACT_RECEIPT_PREFIX_AND_KEY",
    },
    rejectConditions: [
      "MISSING_OR_UNKNOWN_FIELD",
      "DUPLICATE_OR_REORDERED_OBJECT",
      "OBJECT_KEY_OR_PREFIX_MISMATCH",
      "EMPTY_PARTIAL_OR_OVERSIZED_OBJECT",
      "SIZE_OR_SHA256_MISMATCH",
      "TRANSPORT_INTERRUPTED",
      "CHANGED_SECOND_READ",
      "PATH_TRAVERSAL",
      "SYMLINK_OUTPUT",
    ],
  });
});

test("candidate visibility, retention, and failure remain fail-closed without alternates", () => {
  const contract = readJson(contractUrl);
  assert.deepEqual(contract.candidateOutput, {
    ownership: "TASK_OWNED",
    overwriteAllowed: false,
    visibility: "AFTER_ALL_OBJECTS_AND_HANDOFF_IDENTITIES_VALIDATE",
    partialOutputOnFailure: 0,
  });
  assert.deepEqual(contract.retention, {
    protectedTargets: ["ACTIVE", "EXPLICIT_VALIDATED_ROLLBACK"],
    currentObjectUnavailableAction: "TYPED_NONZERO_FAILURE",
    forbiddenAlternateSources: ["OLDER_OBJECT", "LOCAL_CACHE", "HUB_SOURCE", "PREVIOUS_ARTIFACT"],
    alternateSelectionCount: 0,
  });
  assert.deepEqual(contract.failure, {
    result: "TYPED_NONZERO",
    codes: [
      "HANDOFF_SHAPE_INVALID",
      "PRODUCER_IDENTITY_MISMATCH",
      "INVENTORY_INVALID",
      "LOCATOR_POLICY_VIOLATION",
      "OBJECT_IDENTITY_MISMATCH",
      "OBJECT_READ_UNSTABLE",
      "OUTPUT_POLICY_VIOLATION",
      "RETENTION_TARGET_PROTECTED",
      "CURRENT_OBJECT_UNAVAILABLE",
    ],
    stateMutationOnFailure: { candidate: 0, active: 0, traffic: 0 },
    alternateInvocationCount: 0,
  });

  const serialized = JSON.stringify(contract);
  for (const permissive of [
    "WARN_AND_CONTINUE",
    "BEST_EFFORT",
    "ALLOW_STALE",
    "SELECT_PREVIOUS",
    "USE_LOCAL_CACHE",
    "FALLBACK_TO_HUB",
  ]) {
    assert.equal(serialized.includes(permissive), false, permissive);
  }
});

test("Platform CI runs the exact focused contract test in jobs.platform", () => {
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
  if (Object.hasOwn(schema, "const")) {
    assert.deepEqual(value, schema.const, `${path} must match const`);
  }
  if (schema.type === "object") {
    assert.equal(typeof value, "object", `${path} must be object`);
    assert.notEqual(value, null, `${path} must not be null`);
    assert.equal(Array.isArray(value), false, `${path} must not be array`);
    for (const key of schema.required ?? []) {
      assert.equal(Object.hasOwn(value, key), true, `${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.equal(Object.hasOwn(schema.properties, key), true, `${path}.${key} is unknown`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertMatchesSchema(value[key], propertySchema, `${path}.${key}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
