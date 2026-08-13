import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const tuple = JSON.parse(readFileSync(new URL("../../contracts/release/journey-release-tuple.schema.json", import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL("../../contracts/release/platform-activation-receipt.schema.json", import.meta.url)));
const absoluteEnd = "(?![\\s\\S])";
const digestPattern = `^sha256:[a-f0-9]{64}${absoluteEnd}`;
const mutableContractSourceGuard = "node --test tools/platform/no-mutable-contract-source.test.mjs";
const journeyReleaseTupleStageTest = "node --test tools/platform/stage-journey-release-tuple.test.mjs";
const journeyReleaseTupleReaderTest = "node --test tools/platform/read-staged-journey-release-tuple.test.mjs";

test("Platform CI explicitly runs the mutable contract source guard", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assertWorkflowRunsMutableContractSourceGuard(workflow);
});

test("Platform CI rejects the mutable contract source guard when only an optional job runs it", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const guardInOptionalJob = `${workflow.replace(`          ${mutableContractSourceGuard}\n`, "")}\n  optional:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${mutableContractSourceGuard}\n`;
  assert.throws(() => assertWorkflowRunsMutableContractSourceGuard(guardInOptionalJob), /Platform CI job/);
});

test("Platform CI explicitly runs the Journey release tuple staging test", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assertWorkflowRunsPlatformCommand(workflow, journeyReleaseTupleStageTest);
});

test("Platform CI explicitly runs the Journey release tuple admission reader test", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assertWorkflowRunsPlatformCommand(workflow, journeyReleaseTupleReaderTest);
});

function assertWorkflowRunsMutableContractSourceGuard(workflow) {
  const jobsIndex = workflow.indexOf("jobs:\n");
  assert.notEqual(jobsIndex, -1, "workflow must define jobs");
  const jobs = workflow.slice(jobsIndex + "jobs:\n".length);
  const platformJob = jobs.match(/^  platform:\n(?<block>(?:^(?:    .*|)\n?)*)/m);
  assert.notEqual(platformJob, null, "workflow must define jobs.platform");
  assert.match(
    platformJob.groups.block,
    new RegExp(`^          ${escapeRegExp(mutableContractSourceGuard)}$`, "m"),
    "Platform CI job must run the mutable contract source guard",
  );
}

function assertWorkflowRunsPlatformCommand(workflow, command) {
  const jobsIndex = workflow.indexOf("jobs:\n");
  assert.notEqual(jobsIndex, -1, "workflow must define jobs");
  const jobs = workflow.slice(jobsIndex + "jobs:\n".length);
  const platformJob = jobs.match(/^  platform:\n(?<block>(?:^(?:    .*|)\n?)*)/m);
  assert.notEqual(platformJob, null, "workflow must define jobs.platform");
  assert.match(
    platformJob.groups.block,
    new RegExp(`^          ${escapeRegExp(command)}$`, "m"),
    `Platform CI job must run ${command}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("JourneyReleaseTuple is closed and pins immutable identities", () => {
  const required = [
    "schemaVersion", "artifactKind", "backendImageDigest", "backendConfigDigest",
    "journeyContractDigest", "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity",
  ];
  assertClosed(tuple, required);
  assert.equal(tuple.properties.schemaVersion.type, "string");
  assert.equal(tuple.properties.schemaVersion.const, "JOURNEY_RELEASE_TUPLE_V1");
  assert.equal(tuple.properties.artifactKind.type, "string");
  assert.equal(tuple.properties.artifactKind.const, "journey-release-tuple");
  for (const name of ["backendImageDigest", "backendConfigDigest", "journeyContractDigest", "serverRouteBundleDigest"]) {
    assert.equal(tuple.properties[name].type, "string");
    assert.equal(tuple.properties[name].pattern, digestPattern);
  }
  assert.equal(tuple.properties.deploymentRevision.type, "string");
  assert.equal(tuple.properties.deploymentRevision.pattern, `^[a-f0-9]{40}${absoluteEnd}`);
  assert.equal(tuple.properties.environmentIdentity.type, "string");
  assert.equal(tuple.properties.environmentIdentity.pattern, `^[A-Za-z0-9._-]+${absoluteEnd}`);
  assert.equal(tuple.properties.environmentIdentity.minLength, 1);
  assert.equal(tuple.properties.environmentIdentity.maxLength, 255);
  assert.deepEqual(tuple["x-easysubway-tuple-sha256"], {
    encoding: "UTF-8",
    fields: ["backendImageDigest", "backendConfigDigest", "journeyContractDigest", "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity"],
    separator: "LF",
    trailingSeparator: true,
  });
});

test("tupleSha256 uses exact ordered UTF-8 LF-delimited identity bytes", () => {
  const values = [
    `sha256:${"a".repeat(64)}`,
    `sha256:${"b".repeat(64)}`,
    `sha256:${"c".repeat(64)}`,
    `sha256:${"d".repeat(64)}`,
    "e".repeat(40),
    "production",
  ];
  const bytes = `${values.join("\n")}\n`;
  assert.equal(bytes, `${values[0]}\n${values[1]}\n${values[2]}\n${values[3]}\n${values[4]}\n${values[5]}\n`);
  assert.equal(tupleSha256(values), "sha256:341ae0aa029d74f164efc0f1bb9290c50ec60c8e45680a99dc5972a5db338f0a");
});

test("activation receipt closes the fixed-host activation and drain evidence", () => {
  const required = [
    "schemaVersion", "artifactKind", "orchestrator", "operation", "tuple",
    "bindings", "candidate", "activation", "termination", "cleanup",
    "fallbackZero", "evidence",
  ];
  assertClosed(receipt, required);
  assert.deepEqual(receipt.properties.schemaVersion, {
    type: "string",
    const: "PLATFORM_ACTIVATION_RECEIPT_V2",
  });
  assert.deepEqual(receipt.properties.artifactKind, {
    type: "string",
    const: "platform-activation-receipt",
  });
  assert.deepEqual(receipt.properties.orchestrator, {
    type: "string",
    const: "COMPOSE",
  });

  assertClosed(receipt.properties.operation, [
    "operationId", "hostIdentity", "deployLockPath", "deployLockEvidenceDigest",
  ]);
  assert.deepEqual(receipt.properties.operation.properties.operationId, {
    type: "string",
    pattern: `^[A-Za-z0-9._:-]{1,255}${absoluteEnd}`,
  });
  assert.deepEqual(receipt.properties.operation.properties.hostIdentity, {
    type: "string",
    const: "oci-host-easysubway-a1",
  });
  assert.deepEqual(receipt.properties.operation.properties.deployLockPath, {
    type: "string",
    const: "${DEPLOY_ROOT}/deploy.lock",
  });
  assertDigest(receipt.properties.operation.properties.deployLockEvidenceDigest);

  assert.equal(receipt.properties.tuple.$ref, "journey-release-tuple.schema.json");
  assertClosed(receipt.properties.bindings, [
    "dataDescriptorSha256", "tupleSha256", "candidateBindingSha256",
    "descriptorBindingSha256", "candidateAdmissionSha256",
  ]);
  for (const property of Object.values(receipt.properties.bindings.properties)) assertDigest(property);

  assertClosed(receipt.properties.candidate, [
    "instanceCount", "failureDomainCount", "instanceIdentity", "failureDomainIdentity",
    "baseUrl", "candidateGeneration", "allReady", "allInstancesMatchTuple",
    "canaryPassed", "canaryEvidenceDigest", "standbyActiveReadinessEvidenceDigest",
  ]);
  assert.deepEqual(receipt.properties.candidate.properties.instanceCount, { type: "integer", const: 1 });
  assert.deepEqual(receipt.properties.candidate.properties.failureDomainCount, { type: "integer", const: 1 });
  assert.deepEqual(receipt.properties.candidate.properties.instanceIdentity, { type: "string", const: "backend-standby" });
  assert.deepEqual(receipt.properties.candidate.properties.failureDomainIdentity, { type: "string", const: "oci-host-easysubway-a1" });
  assert.deepEqual(receipt.properties.candidate.properties.baseUrl, { type: "string", const: "http://127.0.0.1:8082" });
  assert.deepEqual(receipt.properties.candidate.properties.candidateGeneration, { type: "integer", minimum: 1 });
  for (const name of ["allReady", "allInstancesMatchTuple", "canaryPassed"]) {
    assert.deepEqual(receipt.properties.candidate.properties[name], { type: "boolean", const: true });
  }
  for (const name of ["canaryEvidenceDigest", "standbyActiveReadinessEvidenceDigest"]) {
    assertDigest(receipt.properties.candidate.properties[name]);
  }

  assertClosed(receipt.properties.activation, [
    "trafficGeneration", "standbySwitch", "canonicalActiveReadinessEvidenceDigest", "canonicalSwitch",
  ]);
  assert.deepEqual(receipt.properties.activation.properties.trafficGeneration, { type: "integer", minimum: 1 });
  assertSwitch(receipt.properties.activation.properties.standbySwitch, 8080, 8082);
  assertDigest(receipt.properties.activation.properties.canonicalActiveReadinessEvidenceDigest);
  assertSwitch(receipt.properties.activation.properties.canonicalSwitch, 8082, 8080);

  assertClosed(receipt.properties.termination, [
    "signal", "stopGracePeriodSeconds", "newRequestAdmissionAfterSignal",
    "inFlightSnapshotPinned", "inFlightCompleted", "oldProcessExited",
    "withinBudget", "droppedJourneyCount", "duplicateJourneyCount", "evidenceDigest",
  ]);
  const termination = receipt.properties.termination.properties;
  assert.deepEqual(termination.signal, { type: "string", const: "SIGTERM" });
  assert.deepEqual(termination.stopGracePeriodSeconds, { type: "integer", const: 30 });
  assert.deepEqual(termination.newRequestAdmissionAfterSignal, { type: "integer", const: 0 });
  for (const name of ["inFlightSnapshotPinned", "inFlightCompleted", "oldProcessExited", "withinBudget"]) {
    assert.deepEqual(termination[name], { type: "boolean", const: true });
  }
  for (const name of ["droppedJourneyCount", "duplicateJourneyCount"]) {
    assert.deepEqual(termination[name], { type: "integer", const: 0 });
  }
  assertDigest(termination.evidenceDigest);

  assertClosed(receipt.properties.cleanup, ["standbyRemoved", "orphanedStandbyCount", "evidenceDigest"]);
  assert.deepEqual(receipt.properties.cleanup.properties.standbyRemoved, { type: "boolean", const: true });
  assert.deepEqual(receipt.properties.cleanup.properties.orphanedStandbyCount, { type: "integer", const: 0 });
  assertDigest(receipt.properties.cleanup.properties.evidenceDigest);

  assertClosed(receipt.properties.fallbackZero, ["legacyGraphSuccessCount", "localRouteInvocationCount", "staleJourneyServedCount", "alternateEndpointSuccessCount"]);
  for (const name of Object.keys(receipt.properties.fallbackZero.properties)) {
    assert.equal(receipt.properties.fallbackZero.properties[name].type, "integer");
    assert.equal(receipt.properties.fallbackZero.properties[name].const, 0);
  }
  assertClosed(receipt.properties.evidence, ["generatedAt", "runUrl"]);
  assert.equal(receipt.properties.evidence.properties.generatedAt.type, "string");
  assert.equal(receipt.properties.evidence.properties.generatedAt.format, "date-time");
  const generatedAt = new RegExp(receipt.properties.evidence.properties.generatedAt.pattern);
  assert.match("2026-08-04T22:30:00+09:00", generatedAt);
  assert.match("2024-02-29T00:00:00Z", generatedAt);
  assert.doesNotMatch("2026-02-31T12:00:00Z", generatedAt);
  assert.doesNotMatch("2026-02-29T00:00:00Z", generatedAt);
  assert.doesNotMatch("2026-08-04T22:30:60+09:00", generatedAt);
  assert.doesNotMatch("not-a-date", generatedAt);
  assert.equal(receipt.properties.evidence.properties.runUrl.type, "string");
  assert.equal(receipt.properties.evidence.properties.runUrl.pattern, `^https://github\\.com/AquilaXk/easysubway-platform/actions/runs/[1-9][0-9]*${absoluteEnd}`);
  const runUrl = new RegExp(receipt.properties.evidence.properties.runUrl.pattern);
  assert.match("https://github.com/AquilaXk/easysubway-platform/actions/runs/123", runUrl);
  assert.doesNotMatch("https://github.com/AquilaXk/easysubway-platform/actions/runs/123?ok=true", runUrl);
  assert.doesNotMatch("https://github.com/AquilaXk/easysubway-platform/actions/runs/123#receipt", runUrl);

  const exactPatterns = [
    ...["backendImageDigest", "backendConfigDigest", "journeyContractDigest", "serverRouteBundleDigest"].map((name) => [tuple.properties[name].pattern, `sha256:${"a".repeat(64)}`]),
    [tuple.properties.deploymentRevision.pattern, "a".repeat(40)],
    [tuple.properties.environmentIdentity.pattern, "production"],
    [receipt.properties.operation.properties.operationId.pattern, "release:2026.08.13"],
    [receipt.properties.operation.properties.deployLockEvidenceDigest.pattern, `sha256:${"a".repeat(64)}`],
    [receipt.properties.bindings.properties.candidateAdmissionSha256.pattern, `sha256:${"b".repeat(64)}`],
    [receipt.properties.candidate.properties.canaryEvidenceDigest.pattern, `sha256:${"c".repeat(64)}`],
    [receipt.properties.activation.properties.standbySwitch.properties.evidenceDigest.pattern, `sha256:${"d".repeat(64)}`],
    [receipt.properties.termination.properties.evidenceDigest.pattern, `sha256:${"e".repeat(64)}`],
    [receipt.properties.cleanup.properties.evidenceDigest.pattern, `sha256:${"f".repeat(64)}`],
    [receipt.properties.evidence.properties.generatedAt.pattern, "2026-08-04T22:30:00+09:00"],
    [receipt.properties.evidence.properties.runUrl.pattern, "https://github.com/AquilaXk/easysubway-platform/actions/runs/123"],
  ];
  for (const [pattern, value] of exactPatterns) {
    const exact = new RegExp(pattern);
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      assert.doesNotMatch(`${value}${terminator}`, exact);
    }
  }
});

function assertDigest(property) {
  assert.deepEqual(property, {
    type: "string",
    pattern: digestPattern,
  });
}

function assertSwitch(schema, fromPort, toPort) {
  assertClosed(schema, [
    "fromPort", "toPort", "nginxConfigSha256", "nginxTestPassed",
    "reloadCompleted", "evidenceDigest",
  ]);
  assert.deepEqual(schema.properties.fromPort, { type: "integer", const: fromPort });
  assert.deepEqual(schema.properties.toPort, { type: "integer", const: toPort });
  assertDigest(schema.properties.nginxConfigSha256);
  assert.deepEqual(schema.properties.nginxTestPassed, { type: "boolean", const: true });
  assert.deepEqual(schema.properties.reloadCompleted, { type: "boolean", const: true });
  assertDigest(schema.properties.evidenceDigest);
}

function assertClosed(schema, required) {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, required);
  assert.deepEqual(Object.keys(schema.properties), required);
}

function tupleSha256(values) {
  return `sha256:${createHash("sha256").update(`${values.join("\n")}\n`, "utf8").digest("hex")}`;
}
