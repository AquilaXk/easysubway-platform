import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FixedHostJourneyActivationError,
  runFixedHostJourneyActivation,
} from "./run-fixed-host-journey-activation.mjs";

const digest = (value) => `sha256:${value.repeat(64)}`;

function input(root) {
  return {
    operationDirectory: path.join(root, "operation"),
    operationId: "journey-activation-20260813-001",
    deployRoot: "/opt/easysubway",
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/31670000000",
    generatedAt: "2026-08-13T05:00:00.000Z",
    tuple: {
      schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
      artifactKind: "journey-release-tuple",
      backendImageDigest: digest("a"),
      backendConfigDigest: digest("b"),
      journeyContractDigest: digest("c"),
      serverRouteBundleDigest: digest("d"),
      deploymentRevision: "e".repeat(40),
      environmentIdentity: "production",
      tupleSha256: digest("f"),
    },
    dataDescriptorSha256: digest("1"),
    candidateBindingSha256: digest("2"),
    descriptorBindingSha256: digest("3"),
    candidateGeneration: 9,
    trafficGeneration: 17,
  };
}

function effects(events, failAt) {
  const step = (name, result) => async () => {
    events.push(name);
    if (name === failAt) throw new Error(`injected ${name}`);
    return structuredClone(result);
  };
  const lock = {
    evidenceDigest: digest("4"),
    verify: async () => {
      events.push("lock.verify");
      if (failAt === "lock.verify") throw new Error("injected lock loss");
    },
    close: async () => events.push("lock.close"),
  };
  return {
    acquireDeployLock: async () => {
      events.push("lock.acquire");
      if (failAt === "lock.acquire") throw new Error("injected lock acquisition");
      return lock;
    },
    verifyInputs: step("inputs.verify", undefined),
    startStandby: step("standby.start", {
      schemaVersion: "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1",
      artifactKind: "journey-compose-candidate-runtime",
      orchestrator: "COMPOSE",
      instances: [{
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        baseUrl: "http://127.0.0.1:8082",
      }],
    }),
    runCanary: step("canary.run", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1",
      artifactKind: "journey-candidate-canary",
      tupleSha256: digest("f"),
      passed: true,
      evidenceDigest: digest("5"),
      legacyGraphSuccessCount: 0,
      localRouteInvocationCount: 0,
      staleJourneyServedCount: 0,
      alternateEndpointSuccessCount: 0,
    }),
    observeCandidate: step("candidate.observe", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1",
      artifactKind: "journey-candidate-observations",
      orchestrator: "COMPOSE",
      tupleSha256: digest("f"),
      instances: [{
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        candidateGeneration: 9,
        warmed: true,
        ready: true,
        readinessEvidenceDigest: digest("6"),
      }],
      canary: {
        passed: true,
        evidenceDigest: digest("5"),
        legacyGraphSuccessCount: 0,
        localRouteInvocationCount: 0,
        staleJourneyServedCount: 0,
        alternateEndpointSuccessCount: 0,
      },
    }),
    admitCandidate: step("candidate.admit", {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1",
      artifactKind: "journey-candidate-admission",
      orchestrator: "COMPOSE",
      tupleSha256: digest("f"),
      candidateGeneration: 9,
      candidateAdmissionSha256: digest("7"),
    }),
    activateStandby: step("standby.activate", {
      instanceIdentity: "backend-standby",
      candidateAdmissionSha256: digest("7"),
      candidateGeneration: 9,
      trafficGeneration: 17,
      activeReadinessEvidenceDigest: digest("8"),
    }),
    switchNginx: async ({ fromPort, toPort }) => {
      const name = `nginx.${fromPort}.${toPort}`;
      events.push(name);
      if (name === failAt) throw new Error(`injected ${name}`);
      return {
        fromPort,
        toPort,
        nginxConfigSha256: digest(toPort === 8082 ? "9" : "a"),
        nginxTestPassed: true,
        reloadCompleted: true,
        evidenceDigest: digest(toPort === 8082 ? "b" : "c"),
      };
    },
    drainAndRecreateCanonical: step("canonical.drain-recreate", {
      signal: "SIGTERM",
      stopGracePeriodSeconds: 30,
      newRequestAdmissionAfterSignal: 0,
      inFlightSnapshotPinned: true,
      inFlightCompleted: true,
      oldProcessExited: true,
      withinBudget: true,
      droppedJourneyCount: 0,
      duplicateJourneyCount: 0,
      evidenceDigest: digest("d"),
    }),
    activateCanonical: step("canonical.activate", {
      instanceIdentity: "backend",
      candidateAdmissionSha256: digest("7"),
      candidateGeneration: 9,
      trafficGeneration: 17,
      activeReadinessEvidenceDigest: digest("e"),
    }),
    removeStandby: step("standby.remove", {
      standbyRemoved: true,
      orphanedStandbyCount: 0,
      evidenceDigest: digest("0"),
    }),
    cleanupStandby: step("standby.cleanup", undefined),
  };
}

async function missing(pathname) {
  await assert.rejects(access(pathname));
}

test("success holds one lock, performs exact fixed-host order and writes V2 receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-runtime-"));
  const events = [];

  const receipt = await runFixedHostJourneyActivation(input(root), effects(events));

  assert.deepEqual(events, [
    "lock.acquire",
    "lock.verify", "inputs.verify", "standby.start",
    "lock.verify", "inputs.verify", "canary.run",
    "lock.verify", "inputs.verify", "candidate.observe",
    "lock.verify", "inputs.verify", "candidate.admit",
    "lock.verify", "inputs.verify", "standby.activate",
    "lock.verify", "inputs.verify", "nginx.8080.8082",
    "lock.verify", "inputs.verify", "canonical.drain-recreate",
    "lock.verify", "inputs.verify", "canonical.activate",
    "lock.verify", "inputs.verify", "nginx.8082.8080",
    "lock.verify", "inputs.verify", "standby.remove",
    "lock.verify", "inputs.verify",
    "lock.close",
  ]);
  assert.equal(receipt.schemaVersion, "PLATFORM_ACTIVATION_RECEIPT_V2");
  assert.equal(receipt.outcome, "ACTIVE_SERVING");
  assert.equal(receipt.operation.deployLockPath, "${DEPLOY_ROOT}/deploy.lock");
  assert.equal(receipt.bindings.candidateAdmissionSha256, digest("7"));
  assert.equal(receipt.candidate.canaryEvidenceDigest, digest("5"));
  assert.equal(receipt.candidate.standbyActiveReadinessEvidenceDigest, digest("8"));
  assert.equal(receipt.activation.canonicalActiveReadinessEvidenceDigest, digest("e"));
  assert.equal(receipt.activation.standbySwitch.toPort, 8082);
  assert.equal(receipt.activation.canonicalSwitch.toPort, 8080);
  assert.deepEqual(Object.values(receipt.fallbackZero), [0, 0, 0, 0]);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, "operation", "activation-receipt.json"), "utf8")),
    receipt,
  );
  await missing(path.join(root, "operation", "failed-operation.json"));
});

test("precommit failure cleans standby and never calls Nginx or canonical effects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-precommit-"));
  const events = [];

  await assert.rejects(
    runFixedHostJourneyActivation(input(root), effects(events, "candidate.admit")),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_PRECOMMIT_FAILED",
  );

  assert.ok(events.includes("standby.cleanup"));
  assert.ok(events.includes("lock.close"));
  assert.ok(!events.some((event) => event.startsWith("nginx.")));
  assert.ok(!events.some((event) => event.startsWith("canonical.")));
  await missing(path.join(root, "operation", "activation-receipt.json"));
  const failure = JSON.parse(
    await readFile(path.join(root, "operation", "failed-operation.json"), "utf8"),
  );
  assert.equal(failure.phase, "FAILED_PRECOMMIT");
  assert.equal(failure.successReceiptCreated, false);
  assert.deepEqual(Object.values(failure.fallbackZero), [0, 0, 0, 0]);
});

test("post-switch failure leaves admitted standby serving and emits no success receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-postswitch-"));
  const events = [];

  await assert.rejects(
    runFixedHostJourneyActivation(
      input(root),
      effects(events, "canonical.drain-recreate"),
    ),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_POSTSWITCH_FAILED",
  );

  assert.ok(events.includes("nginx.8080.8082"));
  assert.ok(!events.includes("standby.cleanup"));
  assert.ok(!events.includes("standby.remove"));
  await missing(path.join(root, "operation", "activation-receipt.json"));
  const failure = JSON.parse(
    await readFile(path.join(root, "operation", "failed-operation.json"), "utf8"),
  );
  assert.equal(failure.phase, "FAILED_POSTSWITCH");
  assert.equal(failure.admittedStandbyMayRemainServing, true);
  assert.equal(failure.successReceiptCreated, false);
});

test("operation evidence is create-only and an existing operation has host effects zero", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fixed-host-collision-"));
  const value = input(root);
  const events = [];
  await writeFile(value.operationDirectory, "owned-file", "utf8");

  await assert.rejects(
    runFixedHostJourneyActivation(value, effects(events)),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "FIXED_HOST_OPERATION_EXISTS",
  );
  assert.deepEqual(events, []);
  assert.equal(await readFile(value.operationDirectory, "utf8"), "owned-file");
});
