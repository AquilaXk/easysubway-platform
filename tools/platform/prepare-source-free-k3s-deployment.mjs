#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateJourneyReleaseTupleBytes } from "./bind-journey-release-candidate.mjs";
import { BUNDLE_SHA256, HUB_REVISION, RESOURCE_IDENTITIES, sha256 as rawSha256 } from "./acquire-platform-contract-bundle.mjs";
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9]\d*$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const FIXED_REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "operationDirectory", "operationId",
  "deployRoot", "runUrl", "generatedAt", "bindingPath",
  "descriptorBindingPath", "tuplePath", "descriptorPath", "composeEnvPath",
  "backendEnvPath", "projectName", "nginxConfigPath", "baseComposePath",
  "candidateComposePath", "candidateGeneration", "trafficGeneration", "canary",
]);
const CLI_OPTIONS = new Map([
  ["--mode", "mode"],
  ["--fixed-host-request", "fixedHostRequestPath"],
  ["--candidate-input-output", "candidateInputOutputPath"],
  ["--request-output", "requestOutputPath"],
  ["--node-internal-ip", "nodeInternalIp"],
  ["--public-base-url", "publicBaseUrl"],
  ["--platform-contract-bundle", "platformContractBundlePath"],
]);
const ERROR_MESSAGES = Object.freeze({
  K3S_PREPARE_USAGE: "expected exact source-free K3s preparation arguments",
  K3S_PREPARE_INPUT: "source-free K3s immutable input validation failed",
  K3S_PREPARE_OUTPUT: "source-free K3s request preparation failed",
});
export class SourceFreeK3sPreparationError extends Error {
  constructor(code, exitCode, options) {
    super(ERROR_MESSAGES[code] ?? "source-free K3s preparation failed", options);
    this.name = "SourceFreeK3sPreparationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
export async function prepareSourceFreeK3sDeployment(input) {
  validateInvocation(input);
  try {
    const fixedBytes = await readStableRegularFile(input.fixedHostRequestPath);
    const fixedRequest = JSON.parse(fixedBytes.toString("utf8"));
    validateFixedRequest(fixedRequest);
    const [tupleBytes, bindingBytes, descriptorBindingBytes, backendEnvBytes,
      bundle] = await Promise.all([
      readStableRegularFile(fixedRequest.tuplePath),
      readStableRegularFile(fixedRequest.bindingPath),
      readStableRegularFile(fixedRequest.descriptorBindingPath),
      readStableRegularFile(fixedRequest.backendEnvPath),
      readStagedPlatformBundle(input.platformContractBundlePath),
    ]);
    const tuple = validateJourneyReleaseTupleBytes(tupleBytes);
    const binding = parseJson(bindingBytes);
    const descriptorBinding = parseJson(descriptorBindingBytes);
    if (binding.orchestrator !== "COMPOSE" ||
      binding.tupleSha256 !== tuple.tupleSha256 ||
      descriptorBinding.tupleSha256 !== tuple.tupleSha256 ||
      tuple.backendConfigDigest !== digest(backendEnvBytes)) {
      throw new Error("fixed-host identity foundation is inconsistent");
    }
    const candidateInput = {
      schemaVersion: "PLATFORM_K3S_CANDIDATE_INPUT_V1",
      artifactKind: "platform-k3s-candidate-input",
      releaseTuple: {
        schemaVersion: tuple.schemaVersion,
        artifactKind: tuple.artifactKind,
        backendImageDigest: tuple.backendImageDigest,
        backendConfigDigest: tuple.backendConfigDigest,
        journeyContractDigest: tuple.journeyContractDigest,
        serverRouteBundleDigest: tuple.serverRouteBundleDigest,
        deploymentRevision: tuple.deploymentRevision,
        environmentIdentity: tuple.environmentIdentity,
      },
      tupleSha256: tuple.tupleSha256,
      candidateGeneration: fixedRequest.candidateGeneration,
      trafficGeneration: fixedRequest.trafficGeneration,
      nodeInternalIp: input.nodeInternalIp,
      postgresPort: 15432,
      objectStoragePort: 9000,
      secretIdentity: digest(backendEnvBytes),
    };
    const request = {
      schemaVersion: "PLATFORM_SOURCE_FREE_K3S_ACTIVATION_REQUEST_V1",
      artifactKind: "platform-source-free-k3s-activation-request",
      operationDirectory: fixedRequest.operationDirectory,
      operationId: fixedRequest.operationId,
      deployRoot: fixedRequest.deployRoot,
      runUrl: fixedRequest.runUrl,
      generatedAt: fixedRequest.generatedAt,
      runtimeContractSha256: bundle.runtimeContractSha256,
      candidateInputPath: input.candidateInputOutputPath,
      tuplePath: fixedRequest.tuplePath,
      bindingPath: fixedRequest.bindingPath,
      descriptorBindingPath: fixedRequest.descriptorBindingPath,
      composeEnvPath: fixedRequest.composeEnvPath,
      backendEnvPath: fixedRequest.backendEnvPath,
      baseComposePath: fixedRequest.baseComposePath,
      candidateComposePath: fixedRequest.candidateComposePath,
      projectName: fixedRequest.projectName,
      nginxConfigPath: fixedRequest.nginxConfigPath,
      publicBaseUrl: normalizeBaseUrl(input.publicBaseUrl),
      releaseTuple: tuple,
      candidateGeneration: fixedRequest.candidateGeneration,
      trafficGeneration: fixedRequest.trafficGeneration,
      canary: fixedRequest.canary,
      platformBundle: bundle.identity,
    };
    await writeCreateOnly(input.candidateInputOutputPath, candidateInput);
    await writeCreateOnly(input.requestOutputPath, request);
    return {
      schemaVersion: "PLATFORM_SOURCE_FREE_K3S_PREPARATION_V1",
      artifactKind: "platform-source-free-k3s-preparation",
      mode: input.mode,
      orchestrator: "K3S",
      preparationFoundation: "COMPOSE_INPUT_VALIDATION_ONLY",
      tupleSha256: tuple.tupleSha256,
      runtimeContractSha256: request.runtimeContractSha256,
      bundleAcquisitionEvidenceDigest: bundle.identity.acquisitionEvidenceDigest,
      candidateInputSha256: digest(jsonBytes(candidateInput)),
      requestSha256: digest(jsonBytes(request)),
      candidateInputPath: input.candidateInputOutputPath,
      requestPath: input.requestOutputPath,
      externalMutationCount: 0,
      fallbackInvocationCount: 0,
    };
  } catch (error) {
    if (error instanceof SourceFreeK3sPreparationError) throw error;
    throw new SourceFreeK3sPreparationError(
      error?.code === "EEXIST" ? "K3S_PREPARE_OUTPUT" : "K3S_PREPARE_INPUT",
      1,
      { cause: error },
    );
  }
}
function validateInvocation(input) {
  if (!input || typeof input !== "object" ||
    !["PREVIEW", "DEPLOY"].includes(input.mode) ||
    ![input.fixedHostRequestPath, input.candidateInputOutputPath,
      input.requestOutputPath, input.platformContractBundlePath].every(absolutePath) ||
    new Set([input.fixedHostRequestPath, input.candidateInputOutputPath,
      input.requestOutputPath, input.platformContractBundlePath]).size !== 4 ||
    !privateIpv4(input.nodeInternalIp) ||
    !validPublicBaseUrl(input.publicBaseUrl)) {
    throw new SourceFreeK3sPreparationError("K3S_PREPARE_USAGE", 2);
  }
}
function validateFixedRequest(request) {
  if (!exactObject(request, FIXED_REQUEST_FIELDS) ||
    request.schemaVersion !== "PLATFORM_FIXED_HOST_ACTIVATION_REQUEST_V1" ||
    request.artifactKind !== "platform-fixed-host-activation-request" ||
    ![request.operationDirectory, request.deployRoot, request.bindingPath,
      request.descriptorBindingPath, request.tuplePath, request.descriptorPath,
      request.composeEnvPath, request.backendEnvPath, request.baseComposePath,
      request.candidateComposePath].every(absolutePath) ||
    !request.operationDirectory.startsWith(`${request.deployRoot}${path.sep}`) ||
    !DIGEST.test(request.operationId) || !RUN_URL.test(request.runUrl) ||
    !validTimestamp(request.generatedAt) || !SAFE_PROJECT.test(request.projectName) ||
    request.nginxConfigPath !== "/etc/nginx/sites-available/easysubway" ||
    !Number.isSafeInteger(request.candidateGeneration) || request.candidateGeneration < 1 ||
    !Number.isSafeInteger(request.trafficGeneration) || request.trafficGeneration < 1 ||
    !request.canary || typeof request.canary !== "object") {
    throw new Error("fixed-host source-free request is invalid");
  }
}
async function readStagedPlatformBundle(bundleRoot) {
  const resources = await Promise.all(RESOURCE_IDENTITIES.map(async ([resourcePath, expected]) => {
    const bytes = await readStableRegularFile(path.join(bundleRoot, "resources", resourcePath));
    if (rawSha256(bytes) !== expected) throw new Error("staged Hub resource digest drift");
    return { resourcePath, sha256: `sha256:${expected}` };
  }));
  const evidenceBytes = await readStableRegularFile(path.join(bundleRoot, "evidence.json"));
  const evidence = parseJson(evidenceBytes);
  const resourceSetSha256 = `sha256:${rawSha256(Buffer.from(resources.map((entry) => `${entry.resourcePath}\n${entry.sha256.slice(7)}\n`).join(""), "utf8"))}`;
  if (!exactObject(evidence, ["schemaVersion", "artifactKind", "hubRevision", "bundleSha256", "resourceSetSha256", "resources"]) ||
    evidence.schemaVersion !== "PLATFORM_HUB_BUNDLE_ACQUISITION_EVIDENCE_V1" || evidence.artifactKind !== "platform-hub-bundle-acquisition-evidence" ||
    evidence.hubRevision !== HUB_REVISION || evidence.bundleSha256 !== `sha256:${BUNDLE_SHA256}` || evidence.resourceSetSha256 !== resourceSetSha256 ||
    JSON.stringify(evidence.resources) !== JSON.stringify(resources)) throw new Error("staged Hub evidence drift");
  return {
    runtimeContractSha256: `sha256:${RESOURCE_IDENTITIES[2][1]}`,
    identity: { hubRevision: HUB_REVISION, bundleSha256: `sha256:${BUNDLE_SHA256}`, resourceSetSha256, acquisitionEvidenceDigest: digest(evidenceBytes), runtimeContractPath: path.join(bundleRoot, "resources/platform/k3s-runtime-contract.json") },
  };
}
export async function readStableRegularFile(pathname) {
  const before = await lstat(pathname, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n ||
    before.size > 4n * 1024n * 1024n) {
    throw new Error("input must be a bounded regular file");
  }
  const bytes = await readFile(pathname);
  const after = await lstat(pathname, { bigint: true });
  if (!["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
    .every((field) => before[field] === after[field]) ||
    BigInt(bytes.length) !== before.size) {
    throw new Error("input changed while being read");
  }
  return bytes;
}
async function writeCreateOnly(pathname, value) {
  let handle;
  try {
    handle = await open(
      pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(jsonBytes(value));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
function parseCli(args) {
  if (args.length !== CLI_OPTIONS.size * 2) {
    throw new SourceFreeK3sPreparationError("K3S_PREPARE_USAGE", 2);
  }
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = CLI_OPTIONS.get(args[index]);
    const value = args[index + 1];
    if (!field || !value || value.startsWith("--") || Object.hasOwn(result, field)) {
      throw new SourceFreeK3sPreparationError("K3S_PREPARE_USAGE", 2);
    }
    result[field] = value;
  }
  return result;
}
function parseJson(bytes) {
  return JSON.parse(bytes.toString("utf8"));
}
export function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function exactObject(value, fields) {
  return value !== null && !Array.isArray(value) && typeof value === "object" &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}
export function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && value.length > 1;
}
function privateIpv4(value) {
  if (typeof value !== "string" || !isIPv4(value)) return false;
  const octets = value.split(".").map(Number);
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}
export function validPublicBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}
function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function validTimestamp(value) {
  return typeof value === "string" && value.endsWith("Z") &&
    Number.isFinite(Date.parse(value));
}
async function main() {
  const result = await prepareSourceFreeK3sDeployment(parseCli(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}
if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    const failure = error instanceof SourceFreeK3sPreparationError
      ? error
      : new SourceFreeK3sPreparationError("K3S_PREPARE_INPUT", 1, { cause: error });
    process.stderr.write(`${failure.code} ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}
