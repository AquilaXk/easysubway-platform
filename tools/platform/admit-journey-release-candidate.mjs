#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CandidateBindingError,
  validateJourneyReleaseTupleBytes,
} from "./bind-journey-release-candidate.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "orchestrator",
  "tupleSha256",
  "deploymentRevision",
  "environmentIdentity",
  "handoffSha256",
  "serverRouteBundleDigest",
]);
const OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "orchestrator",
  "bindingSha256",
  "tupleSha256",
  "instances",
  "canary",
]);
const INSTANCE_FIELDS = Object.freeze([
  "instanceIdentity",
  "failureDomainIdentity",
  "tupleSha256",
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
  "warmed",
  "ready",
  "readinessEvidenceDigest",
]);
const CANARY_FIELDS = Object.freeze([
  "passed",
  "evidenceDigest",
  "legacyGraphSuccessCount",
  "localRouteInvocationCount",
  "staleJourneyServedCount",
  "alternateEndpointSuccessCount",
]);
const TUPLE_IDENTITY_FIELDS = Object.freeze([
  "tupleSha256",
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
]);
const CANARY_COUNTER_FIELDS = Object.freeze(CANARY_FIELDS.slice(2));
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]{1,255}$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,255}$/;
const ORCHESTRATORS = new Set(["COMPOSE", "KUBERNETES"]);
const ERROR_MESSAGES = Object.freeze({
  CANDIDATE_ADMISSION_USAGE: "expected exact candidate admission arguments",
  CANDIDATE_ADMISSION_INPUT_INVALID: "candidate admission input validation failed",
  CANDIDATE_ADMISSION_INPUT_UNSTABLE: "candidate admission input changed during verification",
  CANDIDATE_ADMISSION_IDENTITY_MISMATCH: "candidate admission identities differ",
  CANDIDATE_ADMISSION_TOPOLOGY_INVALID: "candidate instance topology validation failed",
  CANDIDATE_ADMISSION_INSTANCE_NOT_READY: "candidate instance admission failed",
  CANDIDATE_ADMISSION_CANARY_FAILED: "candidate canary admission failed",
});

export class CandidateAdmissionError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "candidate admission failed");
    this.name = "CandidateAdmissionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function admitJourneyReleaseCandidate({
  bindingPath,
  tuplePath,
  observationsPath,
  beforeFinalVerification = async () => {},
}) {
  validateInvocation({
    bindingPath,
    tuplePath,
    observationsPath,
    beforeFinalVerification,
  });
  const inputs = [];
  try {
    const bindingInput = await openStableInput(bindingPath);
    inputs.push(bindingInput);
    const tupleInput = await openStableInput(tuplePath);
    inputs.push(tupleInput);
    const observationsInput = await openStableInput(observationsPath);
    inputs.push(observationsInput);

    const binding = validateBinding(bindingInput.bytes);
    const tuple = validateTuple(tupleInput.bytes);
    const observations = validateObservations(observationsInput.bytes);
    const result = admit({
      binding,
      bindingBytes: bindingInput.bytes,
      tuple,
      observations,
      observationsBytes: observationsInput.bytes,
    });

    try {
      await beforeFinalVerification();
    } catch {
      throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
    }
    for (const input of inputs) await input.verify();
    return result;
  } finally {
    for (const input of inputs.reverse()) await input.close();
  }
}

export function formatCandidateAdmissionSuccess(admission) {
  return `${JSON.stringify(admission)}\n`;
}

function validateInvocation({
  bindingPath,
  tuplePath,
  observationsPath,
  beforeFinalVerification,
}) {
  if (
    !isNonemptyString(bindingPath) ||
    !isNonemptyString(tuplePath) ||
    !isNonemptyString(observationsPath) ||
    typeof beforeFinalVerification !== "function"
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_USAGE", 2);
  }
}

async function openStableInput(path) {
  const absolutePath = resolve(path);
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const initial = await handle.stat({ bigint: true });
    if (
      !initial.isFile() ||
      initial.size < 1n ||
      initial.size > BigInt(MAX_INPUT_BYTES)
    ) {
      throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
    }
    await requirePathIdentity(absolutePath, initial);
    const first = await readPass(handle, Number(initial.size));
    await requireHandleIdentity(handle, initial);
    const second = await readPass(handle, Number(initial.size));
    await requireHandleIdentity(handle, initial);
    if (!first.equals(second)) {
      throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
    }
    return {
      bytes: first,
      verify: async () => {
        await requireHandleIdentity(handle, initial);
        await requirePathIdentity(absolutePath, initial);
      },
      close: async () => {
        await handle.close().catch(() => {});
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof CandidateAdmissionError) throw error;
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
  }
}

async function readPass(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) {
      throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
    }
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  const { bytesRead } = await handle.read(extra, 0, 1, size);
  if (bytesRead !== 0) {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
  }
  return bytes;
}

async function requireHandleIdentity(handle, expected) {
  let current;
  try {
    current = await handle.stat({ bigint: true });
  } catch {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
  }
  if (!sameFileIdentity(expected, current)) {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
  }
}

async function requirePathIdentity(path, expected) {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
  }
  if (!current.isFile() || !sameFileIdentity(expected, current)) {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
  }
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(
    (field) => left[field] === right[field],
  );
}

function validateBinding(bytes) {
  const binding = parseJson(bytes);
  if (
    !isExactObject(binding, BINDING_FIELDS) ||
    binding.schemaVersion !== "JOURNEY_RELEASE_CANDIDATE_BINDING_V1" ||
    binding.artifactKind !== "journey-release-candidate-binding" ||
    !ORCHESTRATORS.has(binding.orchestrator) ||
    !matches(binding.tupleSha256, DIGEST) ||
    !matches(binding.deploymentRevision, REVISION) ||
    !matches(binding.environmentIdentity, ENVIRONMENT) ||
    !matches(binding.handoffSha256, RAW_SHA256) ||
    !matches(binding.serverRouteBundleDigest, DIGEST) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(binding)}\n`))
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
  }
  return binding;
}

function validateTuple(bytes) {
  try {
    return validateJourneyReleaseTupleBytes(bytes);
  } catch (error) {
    if (error instanceof CandidateBindingError) {
      throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
    }
    throw error;
  }
}

function validateObservations(bytes) {
  const observations = parseJson(bytes);
  if (
    !isExactObject(observations, OBSERVATION_FIELDS) ||
    observations.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1" ||
    observations.artifactKind !== "journey-candidate-observations" ||
    !ORCHESTRATORS.has(observations.orchestrator) ||
    !matches(observations.bindingSha256, DIGEST) ||
    !matches(observations.tupleSha256, DIGEST) ||
    !Array.isArray(observations.instances) ||
    !isExactObject(observations.canary, CANARY_FIELDS) ||
    typeof observations.canary.passed !== "boolean" ||
    !matches(observations.canary.evidenceDigest, DIGEST) ||
    !CANARY_COUNTER_FIELDS.every(
      (field) => Number.isSafeInteger(observations.canary[field]) && observations.canary[field] >= 0,
    ) ||
    !observations.instances.every(validateInstanceShape) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(observations, null, 2)}\n`))
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
  }
  return observations;
}

function validateInstanceShape(instance) {
  return isExactObject(instance, INSTANCE_FIELDS) &&
    matches(instance.instanceIdentity, SAFE_IDENTITY) &&
    matches(instance.failureDomainIdentity, SAFE_IDENTITY) &&
    matches(instance.tupleSha256, DIGEST) &&
    matches(instance.backendImageDigest, DIGEST) &&
    matches(instance.backendConfigDigest, DIGEST) &&
    matches(instance.journeyContractDigest, DIGEST) &&
    matches(instance.serverRouteBundleDigest, DIGEST) &&
    matches(instance.deploymentRevision, REVISION) &&
    matches(instance.environmentIdentity, ENVIRONMENT) &&
    typeof instance.warmed === "boolean" &&
    typeof instance.ready === "boolean" &&
    matches(instance.readinessEvidenceDigest, DIGEST);
}

function admit({
  binding,
  bindingBytes,
  tuple,
  observations,
  observationsBytes,
}) {
  const failureDomains = new Set(
    observations.instances.map((instance) => instance.failureDomainIdentity),
  );
  const instanceIdentities = new Set(
    observations.instances.map((instance) => instance.instanceIdentity),
  );
  if (
    observations.instances.length !== 2 ||
    instanceIdentities.size !== 2 ||
    failureDomains.size !== 2 ||
    observations.instances[0].instanceIdentity >=
      observations.instances[1].instanceIdentity
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_TOPOLOGY_INVALID");
  }

  if (
    observations.bindingSha256 !== sha256(bindingBytes) ||
    observations.orchestrator !== binding.orchestrator ||
    observations.tupleSha256 !== tuple.tupleSha256 ||
    binding.tupleSha256 !== tuple.tupleSha256 ||
    binding.deploymentRevision !== tuple.deploymentRevision ||
    binding.environmentIdentity !== tuple.environmentIdentity ||
    binding.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    observations.instances.some((instance) =>
      TUPLE_IDENTITY_FIELDS.some((field) => instance[field] !== tuple[field])
    )
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_IDENTITY_MISMATCH");
  }
  if (observations.instances.some((instance) => !instance.warmed || !instance.ready)) {
    throw admissionFailure("CANDIDATE_ADMISSION_INSTANCE_NOT_READY");
  }
  if (
    !observations.canary.passed ||
    CANARY_COUNTER_FIELDS.some((field) => observations.canary[field] !== 0)
  ) {
    throw admissionFailure("CANDIDATE_ADMISSION_CANARY_FAILED");
  }

  const admission = {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1",
    artifactKind: "journey-candidate-admission",
    orchestrator: binding.orchestrator,
    tupleSha256: tuple.tupleSha256,
    backendImageDigest: tuple.backendImageDigest,
    backendConfigDigest: tuple.backendConfigDigest,
    journeyContractDigest: tuple.journeyContractDigest,
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    bindingSha256: sha256(bindingBytes),
    observationsSha256: sha256(observationsBytes),
    handoffSha256: binding.handoffSha256,
    instanceCount: observations.instances.length,
    failureDomainCount: failureDomains.size,
    canaryEvidenceDigest: observations.canary.evidenceDigest,
  };
  return {
    ...admission,
    candidateAdmissionSha256: sha256(Buffer.from(`${JSON.stringify(admission)}\n`)),
  };
}

function parseJson(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw admissionFailure("CANDIDATE_ADMISSION_INPUT_INVALID", 2);
  }
  return value;
}

function isExactObject(value, fields) {
  return value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    sameArray(Object.keys(value), fields);
}

function sameArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function admissionFailure(code, exitCode = 1) {
  return new CandidateAdmissionError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== 6) throw admissionFailure("CANDIDATE_ADMISSION_USAGE", 2);
  const expected = new Set(["--binding", "--tuple", "--observations"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !expected.has(flag) ||
      values.has(flag) ||
      !isNonemptyString(value) ||
      value.startsWith("--")
    ) {
      throw admissionFailure("CANDIDATE_ADMISSION_USAGE", 2);
    }
    values.set(flag, value);
  }
  if (values.size !== expected.size) {
    throw admissionFailure("CANDIDATE_ADMISSION_USAGE", 2);
  }
  return {
    bindingPath: values.get("--binding"),
    tuplePath: values.get("--tuple"),
    observationsPath: values.get("--observations"),
  };
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const result = await admitJourneyReleaseCandidate(input);
  process.stdout.write(formatCandidateAdmissionSuccess(result));
}

if (isMainModule()) {
  main().catch((error) => {
    const failure = error instanceof CandidateAdmissionError
      ? error
      : admissionFailure("CANDIDATE_ADMISSION_INPUT_UNSTABLE");
    process.stderr.write(`${failure.code} ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = resolve(process.argv[1]);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}
