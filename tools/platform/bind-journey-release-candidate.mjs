#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AcquisitionError,
  inspectAcquiredServerRouteBundleCandidate,
} from "./acquire-server-route-bundle.mjs";

const TUPLE_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
  "tupleSha256",
]);
const IDENTITY_FIELDS = Object.freeze([
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,255}$/;
const ORCHESTRATORS = new Set(["COMPOSE", "KUBERNETES"]);
const ERROR_MESSAGES = Object.freeze({
  CANDIDATE_BINDING_USAGE: "expected exact candidate binding arguments",
  CANDIDATE_TUPLE_INVALID: "staged release tuple validation failed",
  CANDIDATE_BUNDLE_INVALID: "acquired bundle validation failed",
  CANDIDATE_IDENTITY_MISMATCH: "release tuple and acquired bundle identities differ",
  CANDIDATE_INPUT_UNSTABLE: "candidate binding input changed during verification",
  CANDIDATE_DESCRIPTOR_INVALID: "descriptor binding validation failed",
});

const DESCRIPTOR_BINDING_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "descriptorSha256",
  "producerGitSha",
  "tupleSha256",
  "serverRouteBundleDigest",
]);

export class CandidateBindingError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "candidate binding failed");
    this.name = "CandidateBindingError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function bindJourneyReleaseCandidate({
  contractPath,
  tuplePath,
  candidateRoot,
  orchestrator,
  inspectCandidate = inspectAcquiredServerRouteBundleCandidate,
}) {
  validateInvocation({
    contractPath,
    tuplePath,
    candidateRoot,
    orchestrator,
    inspectCandidate,
  });
  const tupleBytes = await readRegularTuple(tuplePath, "CANDIDATE_TUPLE_INVALID");
  const tuple = validateJourneyReleaseTupleBytes(tupleBytes);

  let candidate;
  try {
    candidate = await inspectCandidate({ contractPath, candidateRoot });
  } catch (error) {
    if (error instanceof CandidateBindingError) throw error;
    if (error instanceof AcquisitionError && error.code === "OBJECT_READ_UNSTABLE") {
      throw bindingFailure("CANDIDATE_INPUT_UNSTABLE");
    }
    if (error instanceof AcquisitionError) {
      throw bindingFailure("CANDIDATE_BUNDLE_INVALID", 2);
    }
    throw bindingFailure("CANDIDATE_INPUT_UNSTABLE");
  }

  const tupleSecondRead = await readRegularTuple(
    tuplePath,
    "CANDIDATE_INPUT_UNSTABLE",
  );
  if (!tupleBytes.equals(tupleSecondRead)) {
    throw bindingFailure("CANDIDATE_INPUT_UNSTABLE");
  }
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.handoffSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.handoffSha256) ||
    typeof candidate.serverRouteBundleDigest !== "string" ||
    !DIGEST.test(candidate.serverRouteBundleDigest)
  ) {
    throw bindingFailure("CANDIDATE_BUNDLE_INVALID", 2);
  }
  if (tuple.serverRouteBundleDigest !== candidate.serverRouteBundleDigest) {
    throw bindingFailure("CANDIDATE_IDENTITY_MISMATCH", 2);
  }

  return {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator,
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: candidate.handoffSha256,
    serverRouteBundleDigest: candidate.serverRouteBundleDigest,
  };
}

export async function bindJourneyReleaseDescriptorCandidate({
  tuplePath,
  descriptorBindingPath,
  orchestrator,
}) {
  if (
    !isNonemptyString(tuplePath) ||
    !isNonemptyString(descriptorBindingPath) ||
    !ORCHESTRATORS.has(orchestrator)
  ) throw bindingFailure("CANDIDATE_BINDING_USAGE", 2);

  const tupleBytes = await readRegularTuple(tuplePath, "CANDIDATE_TUPLE_INVALID");
  const descriptorBytes = await readRegularTuple(
    descriptorBindingPath,
    "CANDIDATE_DESCRIPTOR_INVALID",
  );
  const tuple = validateJourneyReleaseTupleBytes(tupleBytes);
  const descriptor = validateDescriptorBindingBytes(descriptorBytes);
  if (
    descriptor.tupleSha256 !== tuple.tupleSha256 ||
    descriptor.serverRouteBundleDigest !== tuple.serverRouteBundleDigest
  ) throw bindingFailure("CANDIDATE_IDENTITY_MISMATCH", 2);

  const [tupleSecondRead, descriptorSecondRead] = await Promise.all([
    readRegularTuple(tuplePath, "CANDIDATE_INPUT_UNSTABLE"),
    readRegularTuple(descriptorBindingPath, "CANDIDATE_INPUT_UNSTABLE"),
  ]);
  if (!tupleBytes.equals(tupleSecondRead) || !descriptorBytes.equals(descriptorSecondRead)) {
    throw bindingFailure("CANDIDATE_INPUT_UNSTABLE");
  }

  return {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V2",
    artifactKind: "journey-release-candidate-binding",
    orchestrator,
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    descriptorSha256: descriptor.descriptorSha256,
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
  };
}

function validateDescriptorBindingBytes(bytes) {
  let descriptor;
  try {
    descriptor = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw bindingFailure("CANDIDATE_DESCRIPTOR_INVALID", 2);
  }
  if (
    descriptor === null ||
    Array.isArray(descriptor) ||
    typeof descriptor !== "object" ||
    !sameArray(Object.keys(descriptor), DESCRIPTOR_BINDING_FIELDS) ||
    descriptor.schemaVersion !== "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1" ||
    descriptor.artifactKind !== "platform-server-route-bundle-descriptor-binding" ||
    typeof descriptor.descriptorSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.descriptorSha256) ||
    typeof descriptor.producerGitSha !== "string" ||
    !REVISION.test(descriptor.producerGitSha) ||
    typeof descriptor.tupleSha256 !== "string" ||
    !DIGEST.test(descriptor.tupleSha256) ||
    typeof descriptor.serverRouteBundleDigest !== "string" ||
    !DIGEST.test(descriptor.serverRouteBundleDigest) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(descriptor)}\n`))
  ) throw bindingFailure("CANDIDATE_DESCRIPTOR_INVALID", 2);
  return descriptor;
}

export function formatCandidateBindingSuccess(binding) {
  return `${JSON.stringify(binding)}\n`;
}

function validateInvocation({
  contractPath,
  tuplePath,
  candidateRoot,
  orchestrator,
  inspectCandidate,
}) {
  if (
    !isNonemptyString(contractPath) ||
    !isNonemptyString(tuplePath) ||
    !isNonemptyString(candidateRoot) ||
    !ORCHESTRATORS.has(orchestrator) ||
    typeof inspectCandidate !== "function"
  ) {
    throw bindingFailure("CANDIDATE_BINDING_USAGE", 2);
  }
}

async function readRegularTuple(path, code) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) throw bindingFailure(code, code === "CANDIDATE_TUPLE_INVALID" ? 2 : 1);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof CandidateBindingError) throw error;
    throw bindingFailure(code, code === "CANDIDATE_TUPLE_INVALID" ? 2 : 1);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function validateJourneyReleaseTupleBytes(bytes) {
  let tuple;
  try {
    tuple = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw bindingFailure("CANDIDATE_TUPLE_INVALID", 2);
  }
  if (
    tuple === null ||
    Array.isArray(tuple) ||
    typeof tuple !== "object" ||
    !sameArray(Object.keys(tuple), TUPLE_FIELDS) ||
    tuple.schemaVersion !== "JOURNEY_RELEASE_TUPLE_V1" ||
    tuple.artifactKind !== "journey-release-tuple" ||
    !IDENTITY_FIELDS.slice(0, 4).every(
      (field) => typeof tuple[field] === "string" && DIGEST.test(tuple[field]),
    ) ||
    typeof tuple.deploymentRevision !== "string" ||
    !REVISION.test(tuple.deploymentRevision) ||
    typeof tuple.environmentIdentity !== "string" ||
    !ENVIRONMENT.test(tuple.environmentIdentity) ||
    typeof tuple.tupleSha256 !== "string" ||
    !DIGEST.test(tuple.tupleSha256)
  ) {
    throw bindingFailure("CANDIDATE_TUPLE_INVALID", 2);
  }
  const canonicalBytes = Buffer.from(`${JSON.stringify(tuple, null, 2)}\n`);
  if (!bytes.equals(canonicalBytes) || tuple.tupleSha256 !== tupleHash(tuple)) {
    throw bindingFailure("CANDIDATE_TUPLE_INVALID", 2);
  }
  return tuple;
}

function tupleHash(tuple) {
  const identityBytes = `${IDENTITY_FIELDS.map((field) => tuple[field]).join("\n")}\n`;
  return `sha256:${createHash("sha256").update(identityBytes, "utf8").digest("hex")}`;
}

function sameArray(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function bindingFailure(code, exitCode = 1) {
  return new CandidateBindingError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== 8) throw bindingFailure("CANDIDATE_BINDING_USAGE", 2);
  const expected = new Set(["--contract", "--tuple", "--candidate", "--orchestrator"]);
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
      throw bindingFailure("CANDIDATE_BINDING_USAGE", 2);
    }
    values.set(flag, value);
  }
  if (values.size !== expected.size) {
    throw bindingFailure("CANDIDATE_BINDING_USAGE", 2);
  }
  return {
    contractPath: values.get("--contract"),
    tuplePath: values.get("--tuple"),
    candidateRoot: values.get("--candidate"),
    orchestrator: values.get("--orchestrator"),
  };
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const binding = await bindJourneyReleaseCandidate(input);
  process.stdout.write(formatCandidateBindingSuccess(binding));
}

if (isMainModule()) {
  main().catch((error) => {
    const failure = error instanceof CandidateBindingError
      ? error
      : bindingFailure("CANDIDATE_INPUT_UNSTABLE");
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
