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
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const CANDIDATE_PATH = "/internal/v1/journey/readiness/candidate";
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]{1,255}$/;
const BINDING_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "orchestrator", "tupleSha256",
  "deploymentRevision", "environmentIdentity", "handoffSha256",
  "serverRouteBundleDigest",
]);
const RUNTIME_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "orchestrator", "instances",
]);
const RUNTIME_INSTANCE_FIELDS = Object.freeze([
  "instanceIdentity", "failureDomainIdentity", "baseUrl",
]);
const CANARY_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "tupleSha256", "passed",
  "evidenceDigest", "legacyGraphSuccessCount", "localRouteInvocationCount",
  "staleJourneyServedCount", "alternateEndpointSuccessCount",
]);
const RESPONSE_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "instanceId", "releaseTupleSha256",
  "backendImageDigest", "backendConfigSha256", "journeyContractSha256",
  "routeBundleManifestSha256", "bundleId", "bundleReleaseSequence",
  "generation", "warmed", "ready", "freshUntil", "verifiedAt", "stagedAt",
  "evidenceSha256",
]);
const ZERO_COUNTER_FIELDS = Object.freeze([
  "legacyGraphSuccessCount", "localRouteInvocationCount",
  "staleJourneyServedCount", "alternateEndpointSuccessCount",
]);
const ERROR_MESSAGES = Object.freeze({
  CANDIDATE_OBSERVATION_USAGE: "expected exact candidate observation arguments",
  CANDIDATE_OBSERVATION_INPUT: "candidate observation input validation failed",
  CANDIDATE_OBSERVATION_SECRET: "candidate readiness secret validation failed",
  CANDIDATE_OBSERVATION_RUNTIME: "candidate runtime inventory validation failed",
  CANDIDATE_OBSERVATION_CANARY: "candidate canary evidence validation failed",
  CANDIDATE_READINESS_NETWORK: "candidate readiness request failed",
  CANDIDATE_READINESS_HTTP: "candidate readiness HTTP contract failed",
  CANDIDATE_READINESS_RESPONSE: "candidate readiness response validation failed",
  CANDIDATE_READINESS_IDENTITY: "candidate readiness identity validation failed",
  CANDIDATE_READINESS_FRESHNESS: "candidate readiness freshness validation failed",
  CANDIDATE_READINESS_EVIDENCE: "candidate readiness evidence validation failed",
  CANDIDATE_OBSERVATION_INPUT_UNSTABLE: "candidate observation input changed during collection",
});

export class CandidateObservationError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "candidate observation failed");
    this.name = "CandidateObservationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function observeJourneyCandidateReadiness({
  bindingPath,
  tuplePath,
  runtimePath,
  canaryPath,
  serviceToken,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  validateInvocation({
    bindingPath, tuplePath, runtimePath, canaryPath, serviceToken, fetchImpl, now,
  });
  const inputs = [];
  try {
    for (const path of [bindingPath, tuplePath, runtimePath, canaryPath]) {
      inputs.push(await openStableInput(path));
    }
    const [bindingInput, tupleInput, runtimeInput, canaryInput] = inputs;
    const tuple = validateTuple(tupleInput.bytes);
    const binding = validateBinding(bindingInput.bytes, tuple);
    const runtime = validateRuntime(runtimeInput.bytes);
    const canary = validateCanary(canaryInput.bytes, tuple);
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.valueOf())) {
      throw failure("CANDIDATE_OBSERVATION_INPUT", 2);
    }

    const instances = await Promise.all(runtime.instances.map((instance) =>
      observeInstance({ instance, tuple, serviceToken, fetchImpl, observedAt })));
    for (const input of inputs) await input.verify();
    return {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1",
      artifactKind: "journey-candidate-observations",
      orchestrator: binding.orchestrator,
      bindingSha256: sha256Reference(bindingInput.bytes),
      tupleSha256: tuple.tupleSha256,
      instances,
      canary: {
        passed: canary.passed,
        evidenceDigest: canary.evidenceDigest,
        legacyGraphSuccessCount: canary.legacyGraphSuccessCount,
        localRouteInvocationCount: canary.localRouteInvocationCount,
        staleJourneyServedCount: canary.staleJourneyServedCount,
        alternateEndpointSuccessCount: canary.alternateEndpointSuccessCount,
      },
    };
  } finally {
    for (const input of inputs.reverse()) await input.close();
  }
}

export function formatCandidateObservations(observations) {
  return `${JSON.stringify(observations, null, 2)}\n`;
}

function validateInvocation(values) {
  if (
    ![values.bindingPath, values.tuplePath, values.runtimePath, values.canaryPath]
      .every(isNonemptyString) ||
    typeof values.fetchImpl !== "function" ||
    typeof values.now !== "function"
  ) {
    throw failure("CANDIDATE_OBSERVATION_USAGE", 2);
  }
  if (
    typeof values.serviceToken !== "string" ||
    values.serviceToken.length < 32 ||
    values.serviceToken.length > 512 ||
    [...values.serviceToken].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x21 || codePoint === 0x7f;
    })
  ) {
    throw failure("CANDIDATE_OBSERVATION_SECRET", 2);
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
    const identity = await handle.stat({ bigint: true });
    if (!identity.isFile() || identity.size < 1n || identity.size > BigInt(MAX_INPUT_BYTES)) {
      throw failure("CANDIDATE_OBSERVATION_INPUT", 2);
    }
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== identity.size) {
      throw failure("CANDIDATE_OBSERVATION_INPUT_UNSTABLE");
    }
    await requireStableInput(handle, absolutePath, identity);
    return {
      bytes,
      verify: () => requireStableInput(handle, absolutePath, identity),
      close: () => handle.close().catch(() => {}),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof CandidateObservationError) throw error;
    throw failure("CANDIDATE_OBSERVATION_INPUT", 2);
  }
}

async function requireStableInput(handle, path, expected) {
  let descriptor;
  let entry;
  try {
    descriptor = await handle.stat({ bigint: true });
    entry = await lstat(path, { bigint: true });
  } catch {
    throw failure("CANDIDATE_OBSERVATION_INPUT_UNSTABLE");
  }
  if (
    !descriptor.isFile() || !entry.isFile() || entry.isSymbolicLink() ||
    !sameIdentity(expected, descriptor) || !sameIdentity(expected, entry)
  ) {
    throw failure("CANDIDATE_OBSERVATION_INPUT_UNSTABLE");
  }
}

function sameIdentity(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .every((field) => left[field] === right[field]);
}

function validateTuple(bytes) {
  try {
    return validateJourneyReleaseTupleBytes(bytes);
  } catch (error) {
    if (error instanceof CandidateBindingError) {
      throw failure("CANDIDATE_OBSERVATION_INPUT", 2);
    }
    throw error;
  }
}

function validateBinding(bytes, tuple) {
  const binding = parseJson(bytes, "CANDIDATE_OBSERVATION_INPUT");
  if (
    !isExactObject(binding, BINDING_FIELDS) ||
    binding.schemaVersion !== "JOURNEY_RELEASE_CANDIDATE_BINDING_V1" ||
    binding.artifactKind !== "journey-release-candidate-binding" ||
    binding.orchestrator !== "COMPOSE" ||
    !SHA256_REFERENCE.test(binding.tupleSha256) ||
    !SHA256.test(binding.handoffSha256) ||
    !SHA256_REFERENCE.test(binding.serverRouteBundleDigest) ||
    binding.tupleSha256 !== tuple.tupleSha256 ||
    binding.deploymentRevision !== tuple.deploymentRevision ||
    binding.environmentIdentity !== tuple.environmentIdentity ||
    binding.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    !bytes.equals(Buffer.from(`${JSON.stringify(binding)}\n`))
  ) {
    throw failure("CANDIDATE_OBSERVATION_INPUT", 2);
  }
  return binding;
}

function validateRuntime(bytes) {
  const runtime = parseJson(bytes, "CANDIDATE_OBSERVATION_RUNTIME");
  if (
    !isExactObject(runtime, RUNTIME_FIELDS) ||
    runtime.schemaVersion !== "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1" ||
    runtime.artifactKind !== "journey-compose-candidate-runtime" ||
    runtime.orchestrator !== "COMPOSE" ||
    !Array.isArray(runtime.instances) ||
    runtime.instances.length !== 2 ||
    !runtime.instances.every(validateRuntimeInstance) ||
    new Set(runtime.instances.map((instance) => instance.instanceIdentity)).size !== 2 ||
    new Set(runtime.instances.map((instance) => instance.failureDomainIdentity)).size !== 2 ||
    runtime.instances[0].instanceIdentity >= runtime.instances[1].instanceIdentity ||
    !bytes.equals(Buffer.from(`${JSON.stringify(runtime, null, 2)}\n`))
  ) {
    throw failure("CANDIDATE_OBSERVATION_RUNTIME", 2);
  }
  return runtime;
}

function validateRuntimeInstance(instance) {
  return isExactObject(instance, RUNTIME_INSTANCE_FIELDS) &&
    matches(instance.instanceIdentity, SAFE_IDENTITY) &&
    matches(instance.failureDomainIdentity, SAFE_IDENTITY) &&
    validBaseUrl(instance.baseUrl);
}

function validBaseUrl(value) {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "" && url.pathname !== "/") return false;
    return ["http:", "https:"].includes(url.protocol) &&
      LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function validateCanary(bytes, tuple) {
  const canary = parseJson(bytes, "CANDIDATE_OBSERVATION_CANARY");
  if (
    !isExactObject(canary, CANARY_FIELDS) ||
    canary.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1" ||
    canary.artifactKind !== "journey-candidate-canary" ||
    canary.tupleSha256 !== tuple.tupleSha256 ||
    canary.passed !== true ||
    !matches(canary.evidenceDigest, SHA256_REFERENCE) ||
    ZERO_COUNTER_FIELDS.some((field) => canary[field] !== 0) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(canary, null, 2)}\n`))
  ) {
    throw failure("CANDIDATE_OBSERVATION_CANARY", 2);
  }
  return canary;
}

async function observeInstance({ instance, tuple, serviceToken, fetchImpl, observedAt }) {
  const url = new URL(CANDIDATE_PATH, `${instance.baseUrl}/`).href;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${serviceToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw failure("CANDIDATE_READINESS_NETWORK");
  }
  if (response?.status !== 200) throw failure("CANDIDATE_READINESS_HTTP");
  if (
    !response.headers?.get("content-type")?.toLowerCase().startsWith("application/json") ||
    !response.headers?.get("cache-control")?.toLowerCase().split(",")
      .map((value) => value.trim()).includes("no-store")
  ) {
    throw failure("CANDIDATE_READINESS_HTTP");
  }
  let bytes;
  try {
    bytes = await readBoundedResponse(response);
  } catch {
    throw failure("CANDIDATE_READINESS_RESPONSE");
  }
  if (bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES) {
    throw failure("CANDIDATE_READINESS_RESPONSE");
  }
  const value = parseJson(bytes, "CANDIDATE_READINESS_RESPONSE");
  validateCandidateResponse(value, instance, tuple, observedAt);
  return {
    instanceIdentity: instance.instanceIdentity,
    failureDomainIdentity: instance.failureDomainIdentity,
    tupleSha256: tuple.tupleSha256,
    backendImageDigest: tuple.backendImageDigest,
    backendConfigDigest: tuple.backendConfigDigest,
    journeyContractDigest: tuple.journeyContractDigest,
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    warmed: true,
    ready: true,
    readinessEvidenceDigest: `sha256:${value.evidenceSha256}`,
  };
}

async function readBoundedResponse(response) {
  if (typeof response.body?.getReader !== "function") {
    return Buffer.from(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw failure("CANDIDATE_READINESS_RESPONSE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function validateCandidateResponse(value, instance, tuple, observedAt) {
  if (
    !isExactObject(value, RESPONSE_FIELDS) ||
    value.schemaVersion !== 1 ||
    value.artifactKind !== "journey-v3-candidate-readiness" ||
    !matches(value.instanceId, SAFE_IDENTITY) ||
    !matches(value.releaseTupleSha256, SHA256) ||
    !matches(value.backendImageDigest, SHA256_REFERENCE) ||
    !matches(value.backendConfigSha256, SHA256) ||
    !matches(value.journeyContractSha256, SHA256) ||
    !matches(value.routeBundleManifestSha256, SHA256) ||
    !matches(value.bundleId, SAFE_IDENTITY) ||
    !positiveSafeInteger(value.bundleReleaseSequence) ||
    !positiveSafeInteger(value.generation) ||
    value.warmed !== true || value.ready !== true ||
    !matches(value.evidenceSha256, SHA256) ||
    ![value.freshUntil, value.verifiedAt, value.stagedAt].every(validInstant)
  ) {
    throw failure("CANDIDATE_READINESS_RESPONSE");
  }
  if (
    value.instanceId !== instance.instanceIdentity ||
    value.releaseTupleSha256 !== tuple.tupleSha256.slice(7) ||
    value.backendImageDigest !== tuple.backendImageDigest ||
    value.backendConfigSha256 !== tuple.backendConfigDigest.slice(7) ||
    value.journeyContractSha256 !== tuple.journeyContractDigest.slice(7) ||
    value.routeBundleManifestSha256 !== tuple.serverRouteBundleDigest.slice(7)
  ) {
    throw failure("CANDIDATE_READINESS_IDENTITY");
  }
  if (Date.parse(value.freshUntil) <= observedAt.valueOf()) {
    throw failure("CANDIDATE_READINESS_FRESHNESS");
  }
  if (candidateEvidenceSha256(value) !== value.evidenceSha256) {
    throw failure("CANDIDATE_READINESS_EVIDENCE");
  }
}

function candidateEvidenceSha256(value) {
  const values = [
    "schemaVersion", value.schemaVersion,
    "artifactKind", value.artifactKind,
    "instanceId", value.instanceId,
    "releaseTupleSha256", value.releaseTupleSha256,
    "backendImageDigest", value.backendImageDigest,
    "backendConfigSha256", value.backendConfigSha256,
    "journeyContractSha256", value.journeyContractSha256,
    "routeBundleManifestSha256", value.routeBundleManifestSha256,
    "bundleId", value.bundleId,
    "bundleReleaseSequence", value.bundleReleaseSequence,
    "generation", value.generation,
    "warmed", value.warmed,
    "ready", value.ready,
    "freshUntil", value.freshUntil,
    "verifiedAt", value.verifiedAt,
    "stagedAt", value.stagedAt,
  ];
  const canonical = values.map((entry) => {
    const text = String(entry);
    return `${Buffer.byteLength(text, "utf8")}:${text}`;
  }).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseJson(bytes, code) {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
    return JSON.parse(text);
  } catch {
    throw failure(code, code.startsWith("CANDIDATE_OBSERVATION_") ? 2 : 1);
  }
}

function validInstant(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isExactObject(value, fields) {
  return value !== null && !Array.isArray(value) && typeof value === "object" &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function sha256Reference(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function failure(code, exitCode = 1) {
  return new CandidateObservationError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== 8) throw failure("CANDIDATE_OBSERVATION_USAGE", 2);
  const expected = new Set(["--binding", "--tuple", "--runtime", "--canary"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!expected.has(flag) || values.has(flag) || !isNonemptyString(value) || value.startsWith("--")) {
      throw failure("CANDIDATE_OBSERVATION_USAGE", 2);
    }
    values.set(flag, value);
  }
  return {
    bindingPath: values.get("--binding"),
    tuplePath: values.get("--tuple"),
    runtimePath: values.get("--runtime"),
    canaryPath: values.get("--canary"),
  };
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const observations = await observeJourneyCandidateReadiness({
    ...input,
    serviceToken: process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
  });
  process.stdout.write(formatCandidateObservations(observations));
}

if (samePhysicalFile(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch((error) => {
    const candidate = error instanceof CandidateObservationError
      ? error
      : failure("CANDIDATE_OBSERVATION_INPUT_UNSTABLE");
    process.stderr.write(`${candidate.code} ${candidate.message}\n`);
    process.exitCode = candidate.exitCode;
  });
}

function samePhysicalFile(modulePath, entry) {
  if (!entry) return false;
  const entryPath = resolve(entry);
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    return modulePath === entryPath;
  }
}
