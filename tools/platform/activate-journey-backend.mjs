#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const ACTIVATION_PATH = "/internal/v1/journey/activation";
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const INSTANCE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]{1,255}$/;
const ENVIRONMENT_IDENTITY = /^[A-Za-z0-9._-]{1,255}$/;
const ADMISSION_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "orchestrator", "tupleSha256",
  "backendImageDigest", "backendConfigDigest", "journeyContractDigest",
  "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity",
  "bindingSha256", "observationsSha256", "handoffSha256", "instanceCount",
  "failureDomainCount", "canaryEvidenceDigest", "candidateGeneration",
  "candidateAdmissionSha256",
]);
const ACTIVE_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "instanceId", "releaseTupleSha256",
  "backendImageDigest", "backendConfigSha256", "journeyContractSha256",
  "routeBundleManifestSha256", "bundleId", "bundleReleaseSequence",
  "generation", "trafficGeneration", "servingReady", "draining",
  "freshUntil", "activatedAt", "evidenceSha256",
]);
const ERROR_MESSAGES = Object.freeze({
  JOURNEY_ACTIVATION_USAGE: "expected exact Journey activation arguments",
  JOURNEY_ACTIVATION_INPUT: "Journey candidate admission validation failed",
  JOURNEY_ACTIVATION_SECRET: "Journey activation secret validation failed",
  JOURNEY_ACTIVATION_NETWORK: "Journey activation request failed",
  JOURNEY_ACTIVATION_HTTP: "Journey activation HTTP contract failed",
  JOURNEY_ACTIVATION_RESPONSE: "Journey active readiness response validation failed",
  JOURNEY_ACTIVATION_IDENTITY: "Journey active readiness identity validation failed",
  JOURNEY_ACTIVATION_FRESHNESS: "Journey active readiness freshness validation failed",
  JOURNEY_ACTIVATION_EVIDENCE: "Journey active readiness evidence validation failed",
  JOURNEY_ACTIVATION_INPUT_UNSTABLE: "Journey activation input changed during request",
});

export class JourneyBackendActivationError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "Journey activation failed");
    this.name = "JourneyBackendActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function activateJourneyBackend({
  admissionPath,
  baseUrl,
  instanceIdentity,
  activationRequestIdentity,
  trafficGeneration,
  serviceToken,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  validateInvocation({
    admissionPath,
    baseUrl,
    instanceIdentity,
    activationRequestIdentity,
    trafficGeneration,
    serviceToken,
    fetchImpl,
    now,
  });
  const input = await openStableInput(admissionPath);
  try {
    const admission = validateAdmission(input.bytes);
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.valueOf())) {
      throw failure("JOURNEY_ACTIVATION_USAGE", 2);
    }
    const command = {
      schemaVersion: 1,
      artifactKind: "journey-v3-activation-command",
      activationRequestIdentity,
      candidateManifestSha256: admission.serverRouteBundleDigest.slice(7),
      candidateGeneration: admission.candidateGeneration,
      expectedActiveGeneration: admission.candidateGeneration - 1,
      trafficGeneration,
    };
    const active = await requestActivation({
      admission,
      baseUrl,
      instanceIdentity,
      command,
      serviceToken,
      fetchImpl,
      observedAt,
    });
    await input.verify();
    return {
      schemaVersion: "PLATFORM_JOURNEY_BACKEND_ACTIVATION_V1",
      artifactKind: "journey-backend-activation",
      instanceIdentity,
      activationRequestIdentity,
      candidateAdmissionSha256: admission.candidateAdmissionSha256,
      candidateGeneration: admission.candidateGeneration,
      trafficGeneration,
      activeReadinessEvidenceDigest: `sha256:${active.evidenceSha256}`,
    };
  } finally {
    await input.close();
  }
}

export function formatJourneyBackendActivation(value) {
  return `${JSON.stringify(value)}\n`;
}

function validateInvocation(values) {
  if (
    !isNonemptyString(values.admissionPath) ||
    !validBaseUrl(values.baseUrl) ||
    !matches(values.instanceIdentity, INSTANCE_IDENTITY) ||
    !validActivationIdentity(values.activationRequestIdentity) ||
    !positiveSafeInteger(values.trafficGeneration) ||
    typeof values.fetchImpl !== "function" ||
    typeof values.now !== "function"
  ) {
    throw failure("JOURNEY_ACTIVATION_USAGE", 2);
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
    throw failure("JOURNEY_ACTIVATION_SECRET", 2);
  }
}

function validBaseUrl(value) {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === "" || url.pathname === "/") &&
      ["http:", "https:"].includes(url.protocol) &&
      LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function validActivationIdentity(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    value === value.trim() &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x20 && codePoint !== 0x7f;
    });
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
      throw failure("JOURNEY_ACTIVATION_INPUT", 2);
    }
    const bytes = await handle.readFile();
    if (BigInt(bytes.length) !== identity.size) {
      throw failure("JOURNEY_ACTIVATION_INPUT_UNSTABLE");
    }
    await requireStableInput(handle, absolutePath, identity);
    return {
      bytes,
      verify: () => requireStableInput(handle, absolutePath, identity),
      close: () => handle.close().catch(() => {}),
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof JourneyBackendActivationError) throw error;
    throw failure("JOURNEY_ACTIVATION_INPUT", 2);
  }
}

async function requireStableInput(handle, path, expected) {
  let descriptor;
  let entry;
  try {
    descriptor = await handle.stat({ bigint: true });
    entry = await lstat(path, { bigint: true });
  } catch {
    throw failure("JOURNEY_ACTIVATION_INPUT_UNSTABLE");
  }
  if (
    !descriptor.isFile() || !entry.isFile() || entry.isSymbolicLink() ||
    !sameIdentity(expected, descriptor) || !sameIdentity(expected, entry)
  ) {
    throw failure("JOURNEY_ACTIVATION_INPUT_UNSTABLE");
  }
}

function sameIdentity(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .every((field) => left[field] === right[field]);
}

function validateAdmission(bytes) {
  const admission = parseJson(bytes, "JOURNEY_ACTIVATION_INPUT", 2);
  if (
    !isExactObject(admission, ADMISSION_FIELDS) ||
    admission.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1" ||
    admission.artifactKind !== "journey-candidate-admission" ||
    admission.orchestrator !== "COMPOSE" ||
    ![admission.tupleSha256, admission.backendImageDigest,
      admission.backendConfigDigest, admission.journeyContractDigest,
      admission.serverRouteBundleDigest, admission.bindingSha256,
      admission.observationsSha256, admission.canaryEvidenceDigest,
      admission.candidateAdmissionSha256].every((value) => matches(value, DIGEST)) ||
    !matches(admission.handoffSha256, SHA256) ||
    !matches(admission.deploymentRevision, REVISION) ||
    !matches(admission.environmentIdentity, ENVIRONMENT_IDENTITY) ||
    admission.instanceCount !== 1 || admission.failureDomainCount !== 1 ||
    !positiveSafeInteger(admission.candidateGeneration) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(admission)}\n`))
  ) {
    throw failure("JOURNEY_ACTIVATION_INPUT", 2);
  }
  const { candidateAdmissionSha256, ...body } = admission;
  if (sha256Reference(Buffer.from(`${JSON.stringify(body)}\n`)) !== candidateAdmissionSha256) {
    throw failure("JOURNEY_ACTIVATION_INPUT", 2);
  }
  return admission;
}

async function requestActivation({
  admission,
  baseUrl,
  instanceIdentity,
  command,
  serviceToken,
  fetchImpl,
  observedAt,
}) {
  const url = new URL(ACTIVATION_PATH, `${baseUrl}/`).href;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw failure("JOURNEY_ACTIVATION_NETWORK");
  }
  if (response?.status !== 200) throw failure("JOURNEY_ACTIVATION_HTTP");
  if (
    !response.headers?.get("content-type")?.toLowerCase().startsWith("application/json") ||
    !response.headers?.get("cache-control")?.toLowerCase().split(",")
      .map((value) => value.trim()).includes("no-store")
  ) {
    throw failure("JOURNEY_ACTIVATION_HTTP");
  }
  let bytes;
  try {
    bytes = await readBoundedResponse(response);
  } catch {
    throw failure("JOURNEY_ACTIVATION_RESPONSE");
  }
  if (bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES) {
    throw failure("JOURNEY_ACTIVATION_RESPONSE");
  }
  const active = parseJson(bytes, "JOURNEY_ACTIVATION_RESPONSE", 1);
  validateActiveReadiness(active, admission, instanceIdentity, command, observedAt);
  return active;
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
        throw failure("JOURNEY_ACTIVATION_RESPONSE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

function validateActiveReadiness(value, admission, instanceIdentity, command, observedAt) {
  if (
    !isExactObject(value, ACTIVE_FIELDS) ||
    value.schemaVersion !== 1 ||
    value.artifactKind !== "journey-v3-active-readiness" ||
    !matches(value.instanceId, INSTANCE_IDENTITY) ||
    !matches(value.releaseTupleSha256, SHA256) ||
    !matches(value.backendImageDigest, DIGEST) ||
    !matches(value.backendConfigSha256, SHA256) ||
    !matches(value.journeyContractSha256, SHA256) ||
    !matches(value.routeBundleManifestSha256, SHA256) ||
    !matches(value.bundleId, SAFE_IDENTITY) ||
    !positiveSafeInteger(value.bundleReleaseSequence) ||
    !positiveSafeInteger(value.generation) ||
    !positiveSafeInteger(value.trafficGeneration) ||
    value.servingReady !== true || value.draining !== false ||
    !validInstant(value.freshUntil) || !validInstant(value.activatedAt) ||
    !matches(value.evidenceSha256, SHA256)
  ) {
    throw failure("JOURNEY_ACTIVATION_RESPONSE");
  }
  if (
    value.instanceId !== instanceIdentity ||
    value.releaseTupleSha256 !== admission.tupleSha256.slice(7) ||
    value.backendImageDigest !== admission.backendImageDigest ||
    value.backendConfigSha256 !== admission.backendConfigDigest.slice(7) ||
    value.journeyContractSha256 !== admission.journeyContractDigest.slice(7) ||
    value.routeBundleManifestSha256 !== admission.serverRouteBundleDigest.slice(7) ||
    value.generation !== command.candidateGeneration ||
    value.trafficGeneration !== command.trafficGeneration
  ) {
    throw failure("JOURNEY_ACTIVATION_IDENTITY");
  }
  if (
    Date.parse(value.freshUntil) <= observedAt.valueOf() ||
    Date.parse(value.activatedAt) >= Date.parse(value.freshUntil)
  ) {
    throw failure("JOURNEY_ACTIVATION_FRESHNESS");
  }
  if (activeEvidenceSha256(value) !== value.evidenceSha256) {
    throw failure("JOURNEY_ACTIVATION_EVIDENCE");
  }
}

function activeEvidenceSha256(value) {
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
    "trafficGeneration", value.trafficGeneration,
    "servingReady", value.servingReady,
    "draining", value.draining,
    "freshUntil", value.freshUntil,
    "activatedAt", value.activatedAt,
  ];
  const canonical = values.map((entry) => {
    const text = String(entry);
    return `${Buffer.byteLength(text, "utf8")}:${text}`;
  }).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function parseJson(bytes, code, exitCode) {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
    return JSON.parse(text);
  } catch {
    throw failure(code, exitCode);
  }
}

function validInstant(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isExactObject(value, fields) {
  return value !== null && !Array.isArray(value) && typeof value === "object" &&
    sameArray(Object.keys(value), fields);
}

function sameArray(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
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
  return new JourneyBackendActivationError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== 10) throw failure("JOURNEY_ACTIVATION_USAGE", 2);
  const expected = new Set([
    "--admission", "--base-url", "--instance-identity",
    "--activation-request-identity", "--traffic-generation",
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!expected.has(flag) || values.has(flag) || !isNonemptyString(value) || value.startsWith("--")) {
      throw failure("JOURNEY_ACTIVATION_USAGE", 2);
    }
    values.set(flag, value);
  }
  const traffic = values.get("--traffic-generation");
  if (!/^[1-9][0-9]*$/.test(traffic)) throw failure("JOURNEY_ACTIVATION_USAGE", 2);
  const trafficGeneration = Number(traffic);
  if (!positiveSafeInteger(trafficGeneration) || String(trafficGeneration) !== traffic) {
    throw failure("JOURNEY_ACTIVATION_USAGE", 2);
  }
  return {
    admissionPath: values.get("--admission"),
    baseUrl: values.get("--base-url"),
    instanceIdentity: values.get("--instance-identity"),
    activationRequestIdentity: values.get("--activation-request-identity"),
    trafficGeneration,
  };
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const result = await activateJourneyBackend({
    ...input,
    serviceToken: process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
  });
  process.stdout.write(formatJourneyBackendActivation(result));
}

if (isMainModule()) {
  main().catch((error) => {
    const activationError = error instanceof JourneyBackendActivationError
      ? error
      : failure("JOURNEY_ACTIVATION_INPUT_UNSTABLE");
    process.stderr.write(`${activationError.code} ${activationError.message}\n`);
    process.exitCode = activationError.exitCode;
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
