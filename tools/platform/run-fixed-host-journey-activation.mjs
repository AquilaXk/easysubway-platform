#!/usr/bin/env node

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9][0-9]*$/;
const FALLBACK_ZERO = Object.freeze({
  legacyGraphSuccessCount: 0,
  localRouteInvocationCount: 0,
  staleJourneyServedCount: 0,
  alternateEndpointSuccessCount: 0,
});

const ERROR_MESSAGES = Object.freeze({
  FIXED_HOST_USAGE: "fixed-host activation input is invalid",
  FIXED_HOST_OPERATION_EXISTS: "fixed-host activation operation already exists",
  FIXED_HOST_LOCK_FAILED: "fixed-host deploy lock is unavailable",
  FIXED_HOST_PRECOMMIT_FAILED: "fixed-host activation failed before traffic commit",
  FIXED_HOST_POSTSWITCH_FAILED: "fixed-host activation failed after traffic commit",
  FIXED_HOST_RECEIPT_FAILED: "fixed-host activation receipt could not be stored",
});

export class FixedHostJourneyActivationError extends Error {
  constructor(code, exitCode = 1, options = undefined) {
    super(ERROR_MESSAGES[code] ?? "fixed-host Journey activation failed", options);
    this.name = "FixedHostJourneyActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runFixedHostJourneyActivation(input, effects) {
  validateInvocation(input, effects);
  await reserveOperationDirectory(input.operationDirectory);

  let lock;
  let candidateStarted = false;
  let committed = false;
  let phase = "INPUTS_VALIDATED";
  let result;
  try {
    try {
      lock = await effects.acquireDeployLock({
        lockPath: path.join(input.deployRoot, "deploy.lock"),
        operationId: input.operationId,
      });
      validateLock(lock);
    } catch (error) {
      throw typed("FIXED_HOST_LOCK_FAILED", error);
    }

    const runStep = async (name, operation) => {
      await lock.verify();
      await effects.verifyInputs({ phase: name });
      return operation();
    };

    const runtime = validateRuntime(await runStep("STANDBY_STARTED", () =>
      effects.startStandby({ input, inheritedDeployLock: inheritedLock(lock) })));
    candidateStarted = true;
    phase = "STANDBY_STARTED";
    const runtimePath = await writeEvidence(
      input.operationDirectory,
      "candidate-runtime.json",
      runtime,
      "pretty",
    );

    const canary = validateCanary(await runStep("CANARY_PASSED", () =>
      effects.runCanary({ input, runtime, runtimePath })));
    phase = "CANARY_PASSED";
    const canaryPath = await writeEvidence(
      input.operationDirectory,
      "candidate-canary.json",
      canary,
      "pretty",
    );

    const observations = validateObservations(await runStep("STANDBY_READY", () =>
      effects.observeCandidate({ input, runtime, runtimePath, canary, canaryPath })));
    phase = "STANDBY_READY";
    const observationsPath = await writeEvidence(
      input.operationDirectory,
      "candidate-observations.json",
      observations,
      "pretty",
    );

    const admission = validateAdmission(await runStep("READY_TO_ACTIVATE", () =>
      effects.admitCandidate({ input, observations, observationsPath })));
    phase = "READY_TO_ACTIVATE";
    const admissionPath = await writeEvidence(
      input.operationDirectory,
      "candidate-admission.json",
      admission,
      "compact",
    );

    const standbyActivation = validateActivation(
      await runStep("STANDBY_ACTIVE", () => effects.activateStandby({
        input,
        admission,
        admissionPath,
      })),
      "backend-standby",
      input,
      admission,
    );
    phase = "STANDBY_ACTIVE";
    await writeEvidence(
      input.operationDirectory,
      "standby-activation.json",
      standbyActivation,
      "compact",
    );

    const standbySwitch = validateSwitch(
      await runStep("TRAFFIC_ON_STANDBY", () => effects.switchNginx({
        input,
        fromPort: 8080,
        toPort: 8082,
      })),
      8080,
      8082,
    );
    committed = true;
    phase = "TRAFFIC_ON_STANDBY";
    await writeEvidence(
      input.operationDirectory,
      "nginx-standby-switch.json",
      standbySwitch,
      "pretty",
    );

    const termination = validateTermination(await runStep(
      "CANONICAL_RECREATED",
      () => effects.drainAndRecreateCanonical({ input, admission, admissionPath }),
    ));
    phase = "CANONICAL_RECREATED";
    await writeEvidence(
      input.operationDirectory,
      "canonical-termination.json",
      termination,
      "pretty",
    );

    const canonicalActivation = validateActivation(
      await runStep("CANONICAL_ACTIVE", () => effects.activateCanonical({
        input,
        admission,
        admissionPath,
      })),
      "backend",
      input,
      admission,
    );
    phase = "CANONICAL_ACTIVE";
    await writeEvidence(
      input.operationDirectory,
      "canonical-activation.json",
      canonicalActivation,
      "compact",
    );

    const canonicalSwitch = validateSwitch(
      await runStep("TRAFFIC_ON_CANONICAL", () => effects.switchNginx({
        input,
        fromPort: 8082,
        toPort: 8080,
      })),
      8082,
      8080,
    );
    phase = "TRAFFIC_ON_CANONICAL";
    await writeEvidence(
      input.operationDirectory,
      "nginx-canonical-switch.json",
      canonicalSwitch,
      "pretty",
    );

    const cleanup = validateCleanup(await runStep(
      "STANDBY_REMOVED",
      () => effects.removeStandby({ input }),
    ));
    phase = "STANDBY_REMOVED";
    await writeEvidence(
      input.operationDirectory,
      "standby-removal.json",
      cleanup,
      "pretty",
    );

    await lock.verify();
    await effects.verifyInputs({ phase: "ACTIVE_SERVING" });
    result = activationReceipt({
      input,
      lock,
      canary,
      observations,
      admission,
      standbyActivation,
      standbySwitch,
      termination,
      canonicalActivation,
      canonicalSwitch,
      cleanup,
    });
    try {
      await writeEvidence(
        input.operationDirectory,
        "activation-receipt.json",
        result,
        "pretty",
      );
    } catch (error) {
      throw typed("FIXED_HOST_RECEIPT_FAILED", error);
    }
  } catch (error) {
    const failure = normalizeFailure(error, committed);
    if (!committed && candidateStarted) {
      try {
        await effects.cleanupStandby({ input, phase });
      } catch {
        // The original failure remains authoritative; failed evidence records cleanup uncertainty.
      }
    }
    await writeFailureReceipt(input, failure, phase, committed).catch(() => {});
    throw failure;
  } finally {
    await lock?.close().catch(() => {});
  }
  return result;
}

function validateInvocation(input, effects) {
  if (
    !isObject(input) ||
    !path.isAbsolute(input.operationDirectory ?? "") ||
    !path.isAbsolute(input.deployRoot ?? "") ||
    input.deployRoot === "/" ||
    !matches(input.operationId, OPERATION_ID) ||
    !matches(input.runUrl, RUN_URL) ||
    !validInstant(input.generatedAt) ||
    !validTuple(input.tuple) ||
    ![
      input.dataDescriptorSha256,
      input.candidateBindingSha256,
      input.descriptorBindingSha256,
    ].every((value) => matches(value, DIGEST)) ||
    !positiveInteger(input.candidateGeneration) ||
    !positiveInteger(input.trafficGeneration) ||
    !isObject(effects) ||
    [
      "acquireDeployLock",
      "verifyInputs",
      "startStandby",
      "runCanary",
      "observeCandidate",
      "admitCandidate",
      "activateStandby",
      "switchNginx",
      "drainAndRecreateCanonical",
      "activateCanonical",
      "removeStandby",
      "cleanupStandby",
    ].some((name) => typeof effects[name] !== "function")
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
}

async function reserveOperationDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw typed("FIXED_HOST_OPERATION_EXISTS", error, 2);
    }
    throw typed("FIXED_HOST_USAGE", error, 2);
  }
}

function validateLock(lock) {
  if (
    !isObject(lock) ||
    !matches(lock.evidenceDigest, DIGEST) ||
    typeof lock.verify !== "function" ||
    typeof lock.close !== "function"
  ) {
    throw typed("FIXED_HOST_LOCK_FAILED");
  }
}

function inheritedLock(lock) {
  return Object.freeze({
    verify: () => lock.verify(),
    close: async () => {},
  });
}

function validateRuntime(value) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1" ||
    value.artifactKind !== "journey-compose-candidate-runtime" ||
    value.orchestrator !== "COMPOSE" ||
    !Array.isArray(value.instances) ||
    value.instances.length !== 1 ||
    !isObject(value.instances[0]) ||
    value.instances[0].instanceIdentity !== "backend-standby" ||
    value.instances[0].failureDomainIdentity !== "oci-host-easysubway-a1" ||
    value.instances[0].baseUrl !== "http://127.0.0.1:8082"
  ) {
    throw new Error("invalid standby runtime evidence");
  }
  return value;
}

function validateCanary(value) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1" ||
    value.artifactKind !== "journey-candidate-canary" ||
    value.passed !== true ||
    !matches(value.tupleSha256, DIGEST) ||
    !matches(value.evidenceDigest, DIGEST) ||
    Object.keys(FALLBACK_ZERO).some((field) => value[field] !== 0)
  ) {
    throw new Error("invalid canary evidence");
  }
  return value;
}

function validateObservations(value) {
  const instance = value?.instances?.[0];
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1" ||
    value.artifactKind !== "journey-candidate-observations" ||
    value.orchestrator !== "COMPOSE" ||
    !matches(value.tupleSha256, DIGEST) ||
    !Array.isArray(value.instances) ||
    value.instances.length !== 1 ||
    !isObject(instance) ||
    instance.instanceIdentity !== "backend-standby" ||
    instance.failureDomainIdentity !== "oci-host-easysubway-a1" ||
    !positiveInteger(instance.candidateGeneration) ||
    instance.warmed !== true ||
    instance.ready !== true ||
    !matches(instance.readinessEvidenceDigest, DIGEST) ||
    !isObject(value.canary) ||
    value.canary.passed !== true ||
    !matches(value.canary.evidenceDigest, DIGEST) ||
    Object.keys(FALLBACK_ZERO).some((field) => value.canary[field] !== 0)
  ) {
    throw new Error("invalid candidate observation evidence");
  }
  return value;
}

function validateAdmission(value) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1" ||
    value.artifactKind !== "journey-candidate-admission" ||
    value.orchestrator !== "COMPOSE" ||
    !matches(value.tupleSha256, DIGEST) ||
    !positiveInteger(value.candidateGeneration) ||
    !matches(value.candidateAdmissionSha256, DIGEST)
  ) {
    throw new Error("invalid candidate admission evidence");
  }
  return value;
}

function validateActivation(value, instanceIdentity, input, admission) {
  if (
    !isObject(value) ||
    value.instanceIdentity !== instanceIdentity ||
    value.candidateAdmissionSha256 !== admission.candidateAdmissionSha256 ||
    value.candidateGeneration !== input.candidateGeneration ||
    value.trafficGeneration !== input.trafficGeneration ||
    !matches(value.activeReadinessEvidenceDigest, DIGEST)
  ) {
    throw new Error("invalid Backend activation evidence");
  }
  return value;
}

function validateSwitch(value, fromPort, toPort) {
  if (
    !isObject(value) ||
    value.fromPort !== fromPort ||
    value.toPort !== toPort ||
    !matches(value.nginxConfigSha256, DIGEST) ||
    value.nginxTestPassed !== true ||
    value.reloadCompleted !== true ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid Nginx switch evidence");
  }
  return value;
}

function validateTermination(value) {
  if (
    !isObject(value) ||
    value.signal !== "SIGTERM" ||
    value.stopGracePeriodSeconds !== 30 ||
    value.newRequestAdmissionAfterSignal !== 0 ||
    value.inFlightSnapshotPinned !== true ||
    value.inFlightCompleted !== true ||
    value.oldProcessExited !== true ||
    value.withinBudget !== true ||
    value.droppedJourneyCount !== 0 ||
    value.duplicateJourneyCount !== 0 ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid canonical termination evidence");
  }
  return value;
}

function validateCleanup(value) {
  if (
    !isObject(value) ||
    value.standbyRemoved !== true ||
    value.orphanedStandbyCount !== 0 ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid standby cleanup evidence");
  }
  return value;
}

function activationReceipt({
  input,
  lock,
  canary,
  observations,
  admission,
  standbyActivation,
  standbySwitch,
  termination,
  canonicalActivation,
  canonicalSwitch,
  cleanup,
}) {
  const { tupleSha256, ...schemaTuple } = input.tuple;
  return {
    schemaVersion: "PLATFORM_ACTIVATION_RECEIPT_V2",
    artifactKind: "platform-activation-receipt",
    orchestrator: "COMPOSE",
    operation: {
      operationId: input.operationId,
      hostIdentity: "oci-host-easysubway-a1",
      deployLockPath: "${DEPLOY_ROOT}/deploy.lock",
      deployLockEvidenceDigest: lock.evidenceDigest,
    },
    tuple: schemaTuple,
    bindings: {
      dataDescriptorSha256: input.dataDescriptorSha256,
      tupleSha256,
      candidateBindingSha256: input.candidateBindingSha256,
      descriptorBindingSha256: input.descriptorBindingSha256,
      candidateAdmissionSha256: admission.candidateAdmissionSha256,
    },
    candidate: {
      instanceCount: 1,
      failureDomainCount: 1,
      instanceIdentity: "backend-standby",
      failureDomainIdentity: "oci-host-easysubway-a1",
      baseUrl: "http://127.0.0.1:8082",
      candidateGeneration: input.candidateGeneration,
      allReady: true,
      allInstancesMatchTuple: true,
      canaryPassed: true,
      canaryEvidenceDigest: canary.evidenceDigest,
      standbyActiveReadinessEvidenceDigest:
        standbyActivation.activeReadinessEvidenceDigest,
    },
    activation: {
      trafficGeneration: input.trafficGeneration,
      standbySwitch,
      canonicalActiveReadinessEvidenceDigest:
        canonicalActivation.activeReadinessEvidenceDigest,
      canonicalSwitch,
    },
    termination,
    cleanup,
    outcome: "ACTIVE_SERVING",
    fallbackZero: { ...FALLBACK_ZERO },
    evidence: {
      generatedAt: input.generatedAt,
      runUrl: input.runUrl,
    },
  };
}

async function writeFailureReceipt(input, error, phase, committed) {
  const value = {
    schemaVersion: "PLATFORM_FIXED_HOST_ACTIVATION_FAILURE_V1",
    artifactKind: "platform-fixed-host-activation-failure",
    operationId: input.operationId,
    phase: committed ? "FAILED_POSTSWITCH" : "FAILED_PRECOMMIT",
    lastCompletedState: phase,
    code: error.code,
    trafficCommitted: committed,
    admittedStandbyMayRemainServing: committed,
    successReceiptCreated: false,
    fallbackZero: { ...FALLBACK_ZERO },
    failedAt: input.generatedAt,
    runUrl: input.runUrl,
  };
  await writeEvidence(
    input.operationDirectory,
    "failed-operation.json",
    value,
    "pretty",
  );
}

async function writeEvidence(directory, filename, value, style) {
  const target = path.join(directory, filename);
  const bytes = Buffer.from(style === "compact"
    ? `${JSON.stringify(value)}\n`
    : `${JSON.stringify(value, null, 2)}\n`);
  let handle;
  try {
    handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const identity = await handle.stat();
    if (!identity.isFile() || identity.size !== bytes.length) {
      throw new Error("evidence identity mismatch");
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  return target;
}

function normalizeFailure(error, committed) {
  if (error instanceof FixedHostJourneyActivationError) return error;
  return typed(
    committed ? "FIXED_HOST_POSTSWITCH_FAILED" : "FIXED_HOST_PRECOMMIT_FAILED",
    error,
  );
}

function validTuple(value) {
  return isObject(value) &&
    value.schemaVersion === "JOURNEY_RELEASE_TUPLE_V1" &&
    value.artifactKind === "journey-release-tuple" &&
    [
      value.backendImageDigest,
      value.backendConfigDigest,
      value.journeyContractDigest,
      value.serverRouteBundleDigest,
      value.tupleSha256,
    ].every((entry) => matches(entry, DIGEST)) &&
    matches(value.deploymentRevision, REVISION) &&
    typeof value.environmentIdentity === "string" &&
    /^[A-Za-z0-9._-]{1,255}$/.test(value.environmentIdentity);
}

function validInstant(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typed(code, cause, exitCode = 1) {
  return new FixedHostJourneyActivationError(
    code,
    exitCode,
    cause === undefined ? undefined : { cause },
  );
}
