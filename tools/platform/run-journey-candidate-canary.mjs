#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CandidateAdmissionError,
  openStableCandidateAdmissionInput,
} from "./admit-journey-release-candidate.mjs";
import {
  CandidateBindingError,
  validateJourneyReleaseTupleBytes,
} from "./bind-journey-release-candidate.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const CANARY_PATH = "/internal/v1/journey/canary";
const LOOPBACK_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
const SHA256 = /^[a-f0-9]{64}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const MOBILITY_PROFILES = new Set(["STANDARD", "SLOW", "NO_STAIRS", "STEP_FREE"]);
const CONSTRAINT_MODES = new Set(["NONE", "REQUIRE_STEP_FREE"]);
const isNonemptyString = (value) => typeof value === "string" && value.length > 0;
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const RESPONSE_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "canaryRequestIdentity", "requestId",
  "candidateManifestSha256", "candidateGeneration", "bundleId",
  "bundleReleaseSequence", "queryId", "capturedAt", "passed",
  "legacyGraphSuccessCount", "localRouteInvocationCount",
  "staleJourneyServedCount", "alternateEndpointSuccessCount",
  "evidenceSha256",
]);
const ZERO_COUNTER_FIELDS = Object.freeze([
  "legacyGraphSuccessCount", "localRouteInvocationCount",
  "staleJourneyServedCount", "alternateEndpointSuccessCount",
]);
const CLI_OPTIONS = new Map([
  ["--tuple", "tuplePath"],
  ["--base-url", "baseUrl"],
  ["--candidate-generation", "candidateGeneration"],
  ["--canary-request-identity", "canaryRequestIdentity"],
  ["--request-id", "requestId"],
  ["--origin-station-id", "originStationId"],
  ["--destination-station-id", "destinationStationId"],
  ["--mobility-profile", "mobilityProfile"],
  ["--constraint-mode", "constraintMode"],
  ["--max-transfers", "maxTransfers"],
  ["--alternative-count", "alternativeCount"],
]);
const ERROR_MESSAGES = Object.freeze({
  JOURNEY_CANARY_USAGE: "expected exact Journey candidate canary arguments",
  JOURNEY_CANARY_INPUT: "Journey release tuple validation failed",
  JOURNEY_CANARY_SECRET: "Journey canary secret validation failed",
  JOURNEY_CANARY_NETWORK: "Journey canary request failed",
  JOURNEY_CANARY_HTTP: "Journey canary HTTP contract failed",
  JOURNEY_CANARY_RESPONSE: "Journey canary response validation failed",
  JOURNEY_CANARY_IDENTITY: "Journey canary identity validation failed",
  JOURNEY_CANARY_TIMESTAMP: "Journey canary timestamp validation failed",
  JOURNEY_CANARY_EVIDENCE: "Journey canary evidence validation failed",
  JOURNEY_CANARY_INPUT_UNSTABLE: "Journey canary input changed during request",
});

export class JourneyCandidateCanaryAdapterError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "Journey candidate canary failed");
    this.name = "JourneyCandidateCanaryAdapterError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function runJourneyCandidateCanary({
  tuplePath,
  baseUrl,
  candidateGeneration,
  canaryRequestIdentity,
  requestId,
  originStationId,
  destinationStationId,
  mobilityProfile,
  constraintMode,
  maxTransfers,
  alternativeCount,
  serviceToken,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  validateInvocation({
    tuplePath,
    baseUrl,
    candidateGeneration,
    canaryRequestIdentity,
    requestId,
    originStationId,
    destinationStationId,
    mobilityProfile,
    constraintMode,
    maxTransfers,
    alternativeCount,
    serviceToken,
    fetchImpl,
    now,
  });
  const input = await openTupleInput(tuplePath);
  try {
    const tuple = validateTuple(input.bytes);
    const command = Object.freeze({
      schemaVersion: 1,
      artifactKind: "journey-v3-candidate-canary-command",
      canaryRequestIdentity,
      candidateManifestSha256: tuple.serverRouteBundleDigest.slice(7),
      candidateGeneration,
      requestId,
      originStationId,
      destinationStationId,
      mobilityProfile,
      constraintMode,
      maxTransfers,
      alternativeCount,
    });
    const result = await requestCanary({
      baseUrl,
      command,
      serviceToken,
      fetchImpl,
      now,
    });
    await verifyTupleInput(input);
    return {
      schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1",
      artifactKind: "journey-candidate-canary",
      tupleSha256: tuple.tupleSha256,
      passed: true,
      evidenceDigest: `sha256:${result.evidenceSha256}`,
      legacyGraphSuccessCount: 0,
      localRouteInvocationCount: 0,
      staleJourneyServedCount: 0,
      alternateEndpointSuccessCount: 0,
    };
  } finally {
    await input.close();
  }
}

export function formatJourneyCandidateCanary(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateInvocation(values) {
  if (
    !isNonemptyString(values.tuplePath) ||
    !validBaseUrl(values.baseUrl) ||
    !positiveSafeInteger(values.candidateGeneration) ||
    !validRawText(values.canaryRequestIdentity, 512) ||
    !matches(values.requestId, ULID) ||
    !validRawText(values.originStationId, 255) ||
    !validRawText(values.destinationStationId, 255) ||
    values.originStationId === values.destinationStationId ||
    !MOBILITY_PROFILES.has(values.mobilityProfile) ||
    !CONSTRAINT_MODES.has(values.constraintMode) ||
    (values.mobilityProfile === "NO_STAIRS" && values.constraintMode === "NONE") ||
    !Number.isSafeInteger(values.maxTransfers) ||
    values.maxTransfers < 0 || values.maxTransfers > 3 ||
    !Number.isSafeInteger(values.alternativeCount) ||
    values.alternativeCount < 1 || values.alternativeCount > 3 ||
    typeof values.fetchImpl !== "function" ||
    typeof values.now !== "function"
  ) {
    throw failure("JOURNEY_CANARY_USAGE", 2);
  }
  if (!validServiceToken(values.serviceToken)) {
    throw failure("JOURNEY_CANARY_SECRET", 2);
  }
}

function validServiceToken(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x21 && codePoint < 0x7f;
    });
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

function validRawText(value, maxLength) {
  if (
    typeof value !== "string" ||
    value.length < 1 || value.length > maxLength ||
    value !== value.trim() || value.trim().length === 0 ||
    !hasWellFormedUtf16(value)
  ) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

function hasWellFormedUtf16(value) {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function openTupleInput(path) {
  try {
    return await openStableCandidateAdmissionInput(path);
  } catch (error) {
    throw translateInputError(error);
  }
}

async function verifyTupleInput(input) {
  try {
    await input.verify();
  } catch (error) {
    throw translateInputError(error);
  }
}

function translateInputError(error) {
  if (!(error instanceof CandidateAdmissionError)) return error;
  const code = error.code === "CANDIDATE_ADMISSION_INPUT_UNSTABLE"
    ? "JOURNEY_CANARY_INPUT_UNSTABLE"
    : "JOURNEY_CANARY_INPUT";
  return failure(code, error.exitCode);
}

function validateTuple(bytes) {
  try {
    return validateJourneyReleaseTupleBytes(bytes);
  } catch (error) {
    if (error instanceof CandidateBindingError) {
      throw failure("JOURNEY_CANARY_INPUT", 2);
    }
    throw error;
  }
}

async function requestCanary({ baseUrl, command, serviceToken, fetchImpl, now }) {
  const url = new URL(CANARY_PATH, `${baseUrl}/`).href;
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
    throw failure("JOURNEY_CANARY_NETWORK");
  }
  requireHttpContract(response);
  const bytes = await readResponse(response);
  const receivedAt = now();
  if (!(receivedAt instanceof Date) || !Number.isFinite(receivedAt.valueOf())) {
    throw failure("JOURNEY_CANARY_USAGE", 2);
  }
  const result = parseJson(bytes);
  validateResult(result, bytes, command, receivedAt);
  return result;
}

function requireHttpContract(response) {
  const contentType = response?.headers?.get("content-type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0].trim();
  const cacheDirectives = new Set(
    (response?.headers?.get("cache-control") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim()),
  );
  if (
    response?.status !== 200 ||
    mediaType !== "application/json" ||
    !cacheDirectives.has("no-store")
  ) {
    throw failure("JOURNEY_CANARY_HTTP");
  }
}

async function readResponse(response) {
  try {
    const bytes = await readBoundedResponse(response);
    if (bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES) {
      throw failure("JOURNEY_CANARY_RESPONSE");
    }
    return bytes;
  } catch (error) {
    if (error instanceof JourneyCandidateCanaryAdapterError) throw error;
    throw failure("JOURNEY_CANARY_RESPONSE");
  }
}

async function readBoundedResponse(response) {
  if (typeof response?.body?.getReader !== "function") {
    throw failure("JOURNEY_CANARY_RESPONSE");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value)) throw failure("JOURNEY_CANARY_RESPONSE");
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw failure("JOURNEY_CANARY_RESPONSE");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, length);
  } finally {
    reader.releaseLock?.();
  }
}

async function cancelReader(reader) {
  try {
    await reader.cancel?.();
  } catch {
    // The bounded failure remains authoritative even if cancellation fails.
  }
}

function parseJson(bytes) {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
    return JSON.parse(text);
  } catch {
    throw failure("JOURNEY_CANARY_RESPONSE");
  }
}

function validateResult(value, bytes, command, receivedAt) {
  if (
    !isExactObject(value, RESPONSE_FIELDS) ||
    value.schemaVersion !== 1 ||
    value.artifactKind !== "journey-v3-candidate-canary-result" ||
    !validRawText(value.canaryRequestIdentity, 512) ||
    !matches(value.requestId, ULID) ||
    !matches(value.candidateManifestSha256, SHA256) ||
    !positiveSafeInteger(value.candidateGeneration) ||
    !matches(value.bundleId, BUNDLE_ID) ||
    !positiveSafeInteger(value.bundleReleaseSequence) ||
    !matches(value.queryId, ULID) ||
    !validInstant(value.capturedAt) ||
    value.passed !== true ||
    ZERO_COUNTER_FIELDS.some((field) => value[field] !== 0) ||
    !matches(value.evidenceSha256, SHA256) ||
    !bytes.equals(Buffer.from(JSON.stringify(value)))
  ) {
    throw failure("JOURNEY_CANARY_RESPONSE");
  }
  if (
    value.canaryRequestIdentity !== command.canaryRequestIdentity ||
    value.requestId !== command.requestId ||
    value.candidateManifestSha256 !== command.candidateManifestSha256 ||
    value.candidateGeneration !== command.candidateGeneration ||
    value.queryId !== command.requestId
  ) {
    throw failure("JOURNEY_CANARY_IDENTITY");
  }
  if (Date.parse(value.capturedAt) > receivedAt.valueOf()) {
    throw failure("JOURNEY_CANARY_TIMESTAMP");
  }
  if (canaryEvidenceSha256(value) !== value.evidenceSha256) {
    throw failure("JOURNEY_CANARY_EVIDENCE");
  }
}

function canaryEvidenceSha256(value) {
  const canonical = RESPONSE_FIELDS.slice(0, -1).flatMap((field) => [field, value[field]])
    .reduce((result, entry) => {
      const text = String(entry);
      return `${result}${Buffer.byteLength(text, "utf8")}:${text}`;
    }, "");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validInstant(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed)) return false;
  const instant = new Date(parsed);
  const actual = [
    instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate(),
    instant.getUTCHours(), instant.getUTCMinutes(), instant.getUTCSeconds(),
  ];
  return actual.every((part, index) => part === Number(match[index + 1]));
}

function isExactObject(value, fields) {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const actual = Object.keys(value);
  return actual.length === fields.length &&
    fields.every((field, index) => actual[index] === field);
}

function failure(code, exitCode = 1) {
  return new JourneyCandidateCanaryAdapterError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== CLI_OPTIONS.size * 2) throw failure("JOURNEY_CANARY_USAGE", 2);
  const values = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const name = CLI_OPTIONS.get(flag);
    if (!name || Object.hasOwn(values, name) || !isNonemptyString(value) || value.startsWith("--")) {
      throw failure("JOURNEY_CANARY_USAGE", 2);
    }
    values[name] = value;
  }
  return {
    ...values,
    candidateGeneration: parseCanonicalInteger(values.candidateGeneration, 1),
    maxTransfers: parseCanonicalInteger(values.maxTransfers, 0),
    alternativeCount: parseCanonicalInteger(values.alternativeCount, 1),
  };
}

function parseCanonicalInteger(value, minimum) {
  const pattern = minimum === 0 ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(value)) throw failure("JOURNEY_CANARY_USAGE", 2);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || String(result) !== value) {
    throw failure("JOURNEY_CANARY_USAGE", 2);
  }
  return result;
}

async function runCli(args, environment) {
  const input = parseCliArguments(args);
  const result = await runJourneyCandidateCanary({
    ...input,
    serviceToken: environment.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
  });
  return formatJourneyCandidateCanary(result);
}

if (isEntryPoint(process.argv[1])) {
  runCli(process.argv.slice(2), process.env).then(
    (output) => process.stdout.write(output),
    (error) => {
    const canaryError = error instanceof JourneyCandidateCanaryAdapterError
      ? error
      : failure("JOURNEY_CANARY_INPUT_UNSTABLE");
    process.stderr.write(`${canaryError.code} ${canaryError.message}\n`);
    process.exitCode = canaryError.exitCode;
    },
  );
}

function isEntryPoint(entry) {
  if (!entry) return false;
  try {
    const moduleUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return moduleUrl === pathToFileURL(realpathSync(resolve(entry))).href;
  } catch {
    return false;
  }
}
