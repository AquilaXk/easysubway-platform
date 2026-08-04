import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const tuple = JSON.parse(readFileSync(new URL("../../contracts/release/journey-release-tuple.schema.json", import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL("../../contracts/release/platform-activation-receipt.schema.json", import.meta.url)));
const digestPattern = "^sha256:[a-f0-9]{64}$";

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
  assert.equal(tuple.properties.deploymentRevision.pattern, "^[a-f0-9]{40}$");
  assert.equal(tuple.properties.environmentIdentity.type, "string");
  assert.equal(tuple.properties.environmentIdentity.pattern, "^[A-Za-z0-9._-]+$");
  assert.equal(tuple.properties.environmentIdentity.minLength, 1);
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

test("activation receipt rejects non-ready, mixed, fallback, and non-GitHub evidence shapes", () => {
  const required = [
    "schemaVersion", "artifactKind", "orchestrator", "tuple", "candidate", "activation", "termination", "fallbackZero", "evidence",
  ];
  assertClosed(receipt, required);
  assert.equal(receipt.properties.schemaVersion.type, "string");
  assert.equal(receipt.properties.schemaVersion.const, "PLATFORM_ACTIVATION_RECEIPT_V1");
  assert.equal(receipt.properties.artifactKind.type, "string");
  assert.equal(receipt.properties.artifactKind.const, "platform-activation-receipt");
  assert.equal(receipt.properties.orchestrator.type, "string");
  assert.deepEqual(receipt.properties.orchestrator.enum, ["COMPOSE", "KUBERNETES"]);
  assert.equal(receipt.properties.tuple.$ref, "journey-release-tuple.schema.json");
  assertClosed(receipt.properties.candidate, ["instanceCount", "distinctFailureDomainCount", "allReady", "allInstancesMatchTuple", "canaryPassed"]);
  assert.equal(receipt.properties.candidate.properties.instanceCount.type, "integer");
  assert.equal(receipt.properties.candidate.properties.instanceCount.minimum, 2);
  assert.equal(receipt.properties.candidate.properties.distinctFailureDomainCount.type, "integer");
  assert.equal(receipt.properties.candidate.properties.distinctFailureDomainCount.minimum, 2);
  for (const name of ["allReady", "allInstancesMatchTuple", "canaryPassed"]) {
    assert.equal(receipt.properties.candidate.properties[name].type, "boolean");
    assert.equal(receipt.properties.candidate.properties[name].const, true);
  }
  assertClosed(receipt.properties.activation, ["trafficGeneration", "trafficSwitchAtomic", "oldPoolDrained"]);
  assert.equal(receipt.properties.activation.properties.trafficGeneration.type, "integer");
  assert.equal(receipt.properties.activation.properties.trafficGeneration.minimum, 1);
  for (const name of ["trafficSwitchAtomic", "oldPoolDrained"]) {
    assert.equal(receipt.properties.activation.properties[name].type, "boolean");
    assert.equal(receipt.properties.activation.properties[name].const, true);
  }
  assertClosed(receipt.properties.termination, ["withinBudget", "droppedJourneyCount", "duplicateJourneyCount"]);
  assert.equal(receipt.properties.termination.properties.withinBudget.type, "boolean");
  assert.equal(receipt.properties.termination.properties.withinBudget.const, true);
  for (const name of ["droppedJourneyCount", "duplicateJourneyCount"]) {
    assert.equal(receipt.properties.termination.properties[name].type, "integer");
    assert.equal(receipt.properties.termination.properties[name].const, 0);
  }
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
  assert.doesNotMatch("not-a-date", generatedAt);
  assert.equal(receipt.properties.evidence.properties.runUrl.type, "string");
  assert.equal(receipt.properties.evidence.properties.runUrl.pattern, "^https://github\\.com/AquilaXk/easysubway-platform/actions/runs/[1-9][0-9]*$");
  const runUrl = new RegExp(receipt.properties.evidence.properties.runUrl.pattern);
  assert.match("https://github.com/AquilaXk/easysubway-platform/actions/runs/123", runUrl);
  assert.doesNotMatch("https://github.com/AquilaXk/easysubway-platform/actions/runs/123?ok=true", runUrl);
  assert.doesNotMatch("https://github.com/AquilaXk/easysubway-platform/actions/runs/123#receipt", runUrl);
});

function assertClosed(schema, required) {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, required);
  assert.deepEqual(Object.keys(schema.properties), required);
}

function tupleSha256(values) {
  return `sha256:${createHash("sha256").update(`${values.join("\n")}\n`, "utf8").digest("hex")}`;
}
