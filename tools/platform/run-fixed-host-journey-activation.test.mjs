import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FixedHostJourneyActivationError,
  createFixedHostOperations,
  parseFixedHostJourneyActivationCli,
  runFixedHostJourneyActivation,
} from "./run-fixed-host-journey-activation.mjs";

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const tuple = Object.freeze({
  tupleSha256: DIGEST("a"), backendImageDigest: DIGEST("b"),
  backendConfigDigest: DIGEST("c"), journeyContractDigest: DIGEST("d"),
  serverRouteBundleDigest: DIGEST("e"), deploymentRevision: "f".repeat(40),
  environmentIdentity: "production",
});
const admission = Object.freeze({
  candidateAdmissionSha256: DIGEST("1"), candidateGeneration: 7,
  tupleSha256: tuple.tupleSha256, backendImageDigest: tuple.backendImageDigest,
  backendConfigDigest: tuple.backendConfigDigest,
  journeyContractDigest: tuple.journeyContractDigest,
  serverRouteBundleDigest: tuple.serverRouteBundleDigest,
  deploymentRevision: tuple.deploymentRevision, environmentIdentity: tuple.environmentIdentity,
});

test("runs the exact fixed-host order once and stores only the final immutable success receipt", async () => {
  const fixture = await createFixture();
  assert.deepEqual(
    parseFixedHostJourneyActivationCli([
      "--binding", "binding", "--descriptor-binding", "descriptor-binding", "--tuple", "tuple",
      "--descriptor", "descriptor", "--compose-env", "compose-env", "--backend-env", "backend-env",
      "--project-name", "project", "--operation-id", "operation", "--traffic-generation", "19", "--candidate-generation", "7",
      "--canary-request-identity", "canary", "--request-id", "01K2H7Q5B7E3T19N8J4M6P0R2V",
      "--origin-station-id", "0101", "--destination-station-id", "0102", "--mobility-profile", "STANDARD",
      "--constraint-mode", "NONE", "--max-transfers", "2", "--alternative-count", "1",
      "--receipt", "receipt", "--drain-probe", "probe", "--run-url",
      "https://github.com/AquilaXk/easysubway-platform/actions/runs/123",
    ]).operationId,
    "operation",
  );
  const configPath = join(await mkdtemp(join(tmpdir(), "fixed-host-nginx-")), "easysubway");
  await writeFile(configPath, "previous\n");
  const hostOperations = createFixedHostOperations({ host: {
    nginxConfigPath: configPath,
    commandRunner: async ({ command, args }) => {
      assert.equal(command, "sudo");
      if (args[0] === "install") await copyFile(args[3], args[4]);
      if (args[0] === "mv") await rename(args[1], args[2]);
      return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  } });
  const defaultSwitch = await hostOperations.switchNginx({ fromPort: 8080, toPort: 8082 });
  assert.equal(defaultSwitch.toPort, 8082);
  const rendered = await readFile(configPath, "utf8");
  assert.equal(rendered.includes("proxy_pass http://127.0.0.1:8082;"), true);
  assert.equal(rendered.includes("return 404;"), true);
  const hostCalls = [];
  const probe = { inFlightRequest: journeyRequest("01K2H7Q5B7E3T19N8J4M6P0R2V"),
    afterSignalRequest: journeyRequest("01K2H7Q5B7E3T19N8J4M6P0R2W") };
  const drainOperations = createFixedHostOperations({ drainProbe: probe, host: {
    now: (() => { let value = 1000; return () => value += 10; })(),
    openInFlightJourneyImpl: async () => ({
      async finish() { hostCalls.push("finish-body"); return {
        status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" },
        body: Buffer.from(JSON.stringify({ requestId: probe.inFlightRequest.requestId })),
      }; },
      destroy() {},
    }),
    fetchImpl: async () => { hostCalls.push("post-signal"); throw new Error("connection refused"); },
  } });
  const composeContext = { prefix: ["compose"], env: {}, composeRunner: async ({ args }) => {
    hostCalls.push(args.slice(-4).join(" "));
    return { status: 0, signal: null, timedOut: false };
  } };
  const drainEvidence = await drainOperations.drainCanonical({
    tuple, sessionToken: "same_rc_journey_session_token_0123456789", composeContext,
  });
  assert.equal(drainEvidence.inFlightCompleted, true);
  assert.deepEqual(hostCalls, [
    "kill --signal SIGTERM backend", "finish-body", "post-signal",
    "stop --timeout 30 backend",
  ]);
  const calls = [];
  const receipt = await runFixedHostJourneyActivation({
    ...fixture.input,
    startCandidates: async ({ withinOperation }) => {
      calls.push("start");
      return withinOperation(fixture.lease);
    },
    runCanary: async () => { calls.push("canary"); return canary(); },
    observeReadiness: async () => { calls.push("observe"); return observations(); },
    admitCandidate: async () => { calls.push("admit"); return admission; },
    activateBackend: async ({ instanceIdentity }) => {
      calls.push(`activate:${instanceIdentity}`);
      return activation(instanceIdentity);
    },
    operations: operations(calls),
  });

  assert.deepEqual(calls, [
    "start", "canary", "observe", "admit", "activate:backend-standby",
    "switch:8080:8082", "drain", "recreate", "activate:backend",
    "switch:8082:8080", "remove", "receipt",
  ]);
  assert.equal(receipt.outcome, "ACTIVE_SERVING");
  assert.equal(receipt.candidate.instanceIdentity, "backend-standby");
  assert.equal(receipt.activation.trafficGeneration, 19);
  assert.equal(fixture.lease.verifyCount, 12);
  assert.deepEqual(JSON.parse(await readFile(fixture.input.receiptPath, "utf8")), receipt);
  assert.equal(JSON.stringify(receipt).includes(fixture.secret), false);
});

test("pre-commit failure cleans only the operation-owned standby and makes no visible mutation or success receipt", async () => {
  const fixture = await createFixture();
  const calls = [];
  await assert.rejects(
    runFixedHostJourneyActivation({
      ...fixture.input,
      startCandidates: async ({ withinOperation }) => withinOperation(fixture.lease),
      runCanary: async () => { throw new Error(fixture.secret); },
      observeReadiness: async () => { throw new Error("not reached"); },
      admitCandidate: async () => { throw new Error("not reached"); },
      activateBackend: async () => { throw new Error("not reached"); },
      operations: operations(calls),
    }),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "CANARY_OR_ADMISSION_FAILED" && !error.message.includes(fixture.secret),
  );
  assert.deepEqual(calls, ["remove"]);
  await assert.rejects(readFile(fixture.input.receiptPath));
});

test("a post-switch canonical failure leaves the exact admitted standby serving and emits no success receipt", async () => {
  const fixture = await createFixture();
  const calls = [];
  await assert.rejects(
    runFixedHostJourneyActivation({
      ...fixture.input,
      startCandidates: async ({ withinOperation }) => withinOperation(fixture.lease),
      runCanary: async () => canary(), observeReadiness: async () => observations(),
      admitCandidate: async () => admission,
      activateBackend: async ({ instanceIdentity }) => activation(instanceIdentity),
      operations: operations(calls, { recreateCanonical: async () => {
        calls.push("recreate");
        throw new Error("canonical");
      } }),
    }),
    (error) => error instanceof FixedHostJourneyActivationError &&
      error.code === "CANONICAL_RECREATE_OR_ACTIVATION_FAILED",
  );
  assert.deepEqual(calls, ["switch:8080:8082", "drain", "recreate"]);
  await assert.rejects(readFile(fixture.input.receiptPath));
});

test("receipt existence, lease drift, and drain identity mismatch fail closed without secrets or overwrite", async () => {
  for (const [name, mutate, code] of [
    ["existing receipt", async (fixture) => writeFile(fixture.input.receiptPath, "already\n"), "OPERATION_INPUT_INVALID"],
    ["lost lease", async (fixture) => { fixture.lease.verify = async () => { throw new Error("lost"); }; }, "DEPLOY_LOCK_UNAVAILABLE"],
    ["readiness token reused as session", async (fixture) => { fixture.input.journeySessionToken = fixture.secret; }, "OPERATION_INPUT_INVALID"],
    ["wrong drain identity", async (fixture) => { fixture.drain = { ...drain(), tupleSha256: DIGEST("0") }; }, "CANONICAL_DRAIN_FAILED"],
  ]) {
    const fixture = await createFixture();
    await mutate(fixture);
    const calls = [];
    await assert.rejects(
      runFixedHostJourneyActivation({
        ...fixture.input,
        startCandidates: async ({ withinOperation }) => withinOperation(fixture.lease),
        runCanary: async () => canary(), observeReadiness: async () => observations(),
        admitCandidate: async () => admission,
        activateBackend: async ({ instanceIdentity }) => activation(instanceIdentity),
        operations: operations(calls, { drainCanonical: async () => fixture.drain }),
      }),
      (error) => error instanceof FixedHostJourneyActivationError &&
        error.code === code && !error.message.includes(fixture.secret), name,
    );
    assert.equal(calls.includes("receipt"), false, name);
  }
  const malformedProbeOperations = createFixedHostOperations({
    drainProbe: {
      inFlightRequest: { requestId: "01K2H7Q5B7E3T19N8J4M6P0R2V" },
      afterSignalRequest: journeyRequest("01K2H7Q5B7E3T19N8J4M6P0R2W"),
    },
  });
  await assert.rejects(
    malformedProbeOperations.drainCanonical({
      tuple,
      sessionToken: "same_rc_journey_session_token_0123456789",
      composeContext: { prefix: [], env: {}, composeRunner: async () => assert.fail("compose called") },
    }),
    (error) => error instanceof FixedHostJourneyActivationError && error.code === "CANONICAL_DRAIN_FAILED",
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "fixed-host-activation-"));
  const lease = {
    verifyCount: 0,
    inputIdentity: {
      descriptorSha256: "sha256:" + "a".repeat(64),
      candidateBindingSha256: DIGEST("2"),
      descriptorBindingSha256: DIGEST("3"),
    },
    composeContext: { prefix: [], env: {}, composeRunner: async () => ({ status: 0, signal: null, timedOut: false }) },
    runtime: { instances: [{
      instanceIdentity: "backend-standby", failureDomainIdentity: "oci-host-easysubway-a1",
      baseUrl: "http://127.0.0.1:8082",
    }] },
    async verify() { this.verifyCount += 1; },
  };
  const secret = "same-rc-session-token-0123456789abcdef";
  return {
    secret, lease, drain: drain(),
    input: {
      operationId: "journey-activation-103", trafficGeneration: 19,
      receiptPath: join(root, "activation-receipt.json"),
      tuple, descriptorSha256: "a".repeat(64), candidateBindingSha256: DIGEST("2"),
      descriptorBindingSha256: DIGEST("3"), serviceToken: secret,
      journeySessionToken: "same_rc_journey_session_token_0123456789",
      currentPublicKeyPem: "not-rendered", runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/123",
    },
  };
}

function operations(calls, overrides = {}) {
  return {
    async switchNginx({ fromPort, toPort }) { calls.push(`switch:${fromPort}:${toPort}`); return switchEvidence(fromPort, toPort); },
    async drainCanonical() { calls.push("drain"); return drain(); },
    async recreateCanonical() { calls.push("recreate"); return { tupleSha256: tuple.tupleSha256 }; },
    async removeStandby() { calls.push("remove"); return { evidenceDigest: DIGEST("9") }; },
    async writeReceipt(receipt) { calls.push("receipt"); return receipt; },
    ...overrides,
  };
}
function canary() { return { tupleSha256: tuple.tupleSha256, passed: true, evidenceDigest: DIGEST("4"), legacyGraphSuccessCount: 0, localRouteInvocationCount: 0, staleJourneyServedCount: 0, alternateEndpointSuccessCount: 0 }; }
function observations() { return { instances: [{ instanceIdentity: "backend-standby", candidateGeneration: 7 }], canary: canary() }; }
function activation(instanceIdentity) { return { instanceIdentity, candidateAdmissionSha256: admission.candidateAdmissionSha256, candidateGeneration: 7, trafficGeneration: 19, activeReadinessEvidenceDigest: DIGEST(instanceIdentity === "backend" ? "7" : "6") }; }
function switchEvidence(fromPort, toPort) { return { fromPort, toPort, nginxConfigSha256: DIGEST(fromPort === 8080 ? "8" : "9"), nginxTestPassed: true, reloadCompleted: true, evidenceDigest: DIGEST(fromPort === 8080 ? "a" : "b") }; }
function drain() { return { tupleSha256: tuple.tupleSha256, signal: "SIGTERM", stopGracePeriodSeconds: 30, newRequestAdmissionAfterSignal: 0, inFlightSnapshotPinned: true, inFlightCompleted: true, oldProcessExited: true, withinBudget: true, droppedJourneyCount: 0, duplicateJourneyCount: 0, evidenceDigest: DIGEST("c") }; }
function journeyRequest(requestId) {
  return { requestId, originStationId: "0101", destinationStationId: "0102",
    departure: { mode: "NOW" }, timePolicy: "TIMETABLE_REQUIRED", mobilityProfile: "STANDARD",
    constraintMode: "NONE", maxTransfers: 2, alternativeCount: 1 };
}
