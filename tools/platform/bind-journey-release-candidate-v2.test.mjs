import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CandidateBindingError,
  bindJourneyReleaseDescriptorCandidate,
} from "./bind-journey-release-candidate.mjs";

test("binds one immutable Data descriptor v2 identity to one COMPOSE release tuple", async (t) => {
  const fixture = await createFixture(t);
  const binding = await bindJourneyReleaseDescriptorCandidate({
    tuplePath: fixture.tuplePath,
    descriptorBindingPath: fixture.descriptorBindingPath,
    orchestrator: "COMPOSE",
  });

  assert.deepEqual(binding, {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V2",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: fixture.tuple.tupleSha256,
    deploymentRevision: fixture.tuple.deploymentRevision,
    environmentIdentity: fixture.tuple.environmentIdentity,
    descriptorSha256: fixture.descriptorBinding.descriptorSha256,
    serverRouteBundleDigest: fixture.tuple.serverRouteBundleDigest,
  });
  assert.equal(Object.hasOwn(binding, "handoffSha256"), false);
});

test("rejects descriptor and tuple identity drift without inspecting or acquiring objects", async (t) => {
  const fixture = await createFixture(t, {
    descriptorBundleDigest: digest("f"),
  });
  await assert.rejects(
    bindJourneyReleaseDescriptorCandidate({
      tuplePath: fixture.tuplePath,
      descriptorBindingPath: fixture.descriptorBindingPath,
      orchestrator: "COMPOSE",
    }),
    (error) => error instanceof CandidateBindingError &&
      error.code === "CANDIDATE_IDENTITY_MISMATCH",
  );
});

async function createFixture(t, { descriptorBundleDigest } = {}) {
  const root = await mkdtemp(join(tmpdir(), "journey-release-candidate-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("1"),
    backendConfigDigest: digest("2"),
    journeyContractDigest: digest("3"),
    serverRouteBundleDigest: digest("4"),
    deploymentRevision: "5".repeat(40),
    environmentIdentity: "production",
    tupleSha256: "",
  };
  tuple.tupleSha256 = tupleHash(tuple);
  const descriptorBinding = {
    schemaVersion: "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1",
    artifactKind: "platform-server-route-bundle-descriptor-binding",
    descriptorSha256: "6".repeat(64),
    producerGitSha: "7".repeat(40),
    tupleSha256: tuple.tupleSha256,
    serverRouteBundleDigest: descriptorBundleDigest ?? tuple.serverRouteBundleDigest,
  };
  const tuplePath = join(root, "tuple.json");
  const descriptorBindingPath = join(root, "descriptor-binding.json");
  await Promise.all([
    writeFile(tuplePath, `${JSON.stringify(tuple, null, 2)}\n`),
    writeFile(descriptorBindingPath, `${JSON.stringify(descriptorBinding)}\n`),
  ]);
  return { tuple, descriptorBinding, tuplePath, descriptorBindingPath };
}

function tupleHash(tuple) {
  const fields = [
    "backendImageDigest",
    "backendConfigDigest",
    "journeyContractDigest",
    "serverRouteBundleDigest",
    "deploymentRevision",
    "environmentIdentity",
  ];
  return `sha256:${createHash("sha256")
    .update(`${fields.map((field) => tuple[field]).join("\n")}\n`, "utf8")
    .digest("hex")}`;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}
