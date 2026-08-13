#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateJourneyReleaseTupleBytes } from "./bind-journey-release-candidate.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const PLATFORM_REPOSITORY = "AquilaXk/easysubway-platform";
const BACKEND_REPOSITORY = "AquilaXk/easysubway-backend";
const DATA_REPOSITORY = "AquilaXk/easysubway-data";
const PLATFORM_ENVIRONMENT = "production-deploy";
const DEPLOYMENT_ENVIRONMENT_IDENTITY = "production";
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const ERROR_MESSAGES = Object.freeze({
  DEPLOYMENT_ENVELOPE_USAGE: "expected exact deployment envelope inputs",
  DEPLOYMENT_ENVELOPE_INPUT_INVALID: "deployment envelope input validation failed",
  DEPLOYMENT_ENVELOPE_PLATFORM_MISMATCH: "Platform deployment identity mismatch",
  DEPLOYMENT_ENVELOPE_BACKEND_MISMATCH: "Backend deployment identity mismatch",
  DEPLOYMENT_ENVELOPE_RELEASE_MISMATCH: "release binding identity mismatch",
  DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE: "deployment envelope input changed during assembly",
  DEPLOYMENT_ENVELOPE_FAILURE: "deployment envelope assembly failed",
});
const INPUTS = Object.freeze([
  ["admissionReceiptPath", "compact"],
  ["credentialInventoryPath", "pretty"],
  ["tuplePath", "tuple"],
  ["candidateBindingPath", "compact"],
  ["descriptorBindingPath", "compact"],
  ["backendComponentManifestPath", "pretty"],
  ["lifecycleContractPath", "json"],
  ["activationReceiptSchemaPath", "json"],
  ["runtimeInputInventoryPath", "json"],
]);

export class DeploymentEnvelopeError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.DEPLOYMENT_ENVELOPE_FAILURE);
    this.name = "DeploymentEnvelopeError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function assemblePlatformDeploymentInputEnvelope(input) {
  validateInvocation(input);
  const platformRevision = input.platformRevision;

  const snapshots = new Map();
  for (const [field] of INPUTS) {
    snapshots.set(field, await readInputSnapshot(
      input[field],
      false,
      field,
      input.beforeInputContentRead,
    ));
  }

  const receipt = parseCanonical(snapshots.get("admissionReceiptPath"), "compact");
  const credentialInventory = parseCanonical(snapshots.get("credentialInventoryPath"), "pretty");
  const tuple = parseTuple(snapshots.get("tuplePath"));
  const candidate = parseCanonical(snapshots.get("candidateBindingPath"), "compact");
  const descriptor = parseCanonical(snapshots.get("descriptorBindingPath"), "compact");
  const component = parseCanonical(snapshots.get("backendComponentManifestPath"), "pretty");
  const lifecycle = parseCanonical(snapshots.get("lifecycleContractPath"), "json");
  const activationSchema = parseCanonical(snapshots.get("activationReceiptSchemaPath"), "json");
  const runtimeInventory = parseCanonical(snapshots.get("runtimeInputInventoryPath"), "json");

  validateCredentialInventory(credentialInventory);
  validatePlatformReceipt(receipt, platformRevision);
  validateBackendComponent(component, tuple);
  validateReleaseBindings(candidate, descriptor, tuple);
  validatePolicies(lifecycle, activationSchema, runtimeInventory);

  await input.beforeInputVerification?.();
  for (const [field] of INPUTS) {
    const second = await readInputSnapshot(
      input[field],
      true,
      field,
      input.beforeInputContentRead,
    );
    if (!sameSnapshot(snapshots.get(field), second)) {
      throw failure("DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE");
    }
  }

  const envelope = {
    schemaVersion: "PLATFORM_DEPLOYMENT_INPUT_ENVELOPE_V1",
    artifactKind: "platform-deployment-input-envelope",
    orchestrator: "COMPOSE",
    platform: {
      repository: PLATFORM_REPOSITORY,
      gitSha: platformRevision,
      environment: PLATFORM_ENVIRONMENT,
      deploymentEnvironmentIdentity: DEPLOYMENT_ENVIRONMENT_IDENTITY,
      admissionReceiptSha256: digest(snapshots.get("admissionReceiptPath").bytes),
      credentialInventorySha256: digest(snapshots.get("credentialInventoryPath").bytes),
    },
    backend: {
      repository: BACKEND_REPOSITORY,
      gitSha: tuple.deploymentRevision,
      imageDigest: tuple.backendImageDigest,
      configDigest: tuple.backendConfigDigest,
      journeyContractDigest: tuple.journeyContractDigest,
      componentManifestSha256: digest(snapshots.get("backendComponentManifestPath").bytes),
    },
    data: {
      repository: DATA_REPOSITORY,
      producerGitSha: descriptor.producerGitSha,
      descriptorSha256: descriptor.descriptorSha256,
      serverRouteBundleDigest: tuple.serverRouteBundleDigest,
    },
    release: {
      tupleSha256: tuple.tupleSha256,
      candidateBindingSha256: digest(snapshots.get("candidateBindingPath").bytes),
      descriptorBindingSha256: digest(snapshots.get("descriptorBindingPath").bytes),
    },
    policies: {
      lifecycleContractSha256: digest(snapshots.get("lifecycleContractPath").bytes),
      activationReceiptSchemaSha256: digest(snapshots.get("activationReceiptSchemaPath").bytes),
      runtimeInputInventorySha256: digest(snapshots.get("runtimeInputInventoryPath").bytes),
    },
  };
  return {
    ...envelope,
    envelopeSha256: digest(Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`)),
  };
}

export function formatPlatformDeploymentInputEnvelope(envelope) {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function validateInvocation(input) {
  if (
    !isObject(input) ||
    !matchesString(input.platformRevision, REVISION) ||
    INPUTS.some(([field]) => !isPath(input[field])) ||
    (input.beforeInputVerification !== undefined &&
      typeof input.beforeInputVerification !== "function") ||
    (input.beforeInputContentRead !== undefined &&
      typeof input.beforeInputContentRead !== "function")
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_USAGE", 2);
  }
}

async function readInputSnapshot(path, secondRead, field, beforeInputContentRead) {
  let handle;
  const invalidCode = secondRead
    ? "DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE"
    : "DEPLOYMENT_ENVELOPE_INPUT_INVALID";
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_INPUT_BYTES)) {
      throw failure(invalidCode, secondRead ? 1 : 2);
    }
    await beforeInputContentRead?.(field);
    const bytes = await readBounded(handle);
    if (bytes.length > MAX_INPUT_BYTES) {
      throw failure("DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE");
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileStat(before, after) || BigInt(bytes.length) !== after.size) {
      throw failure("DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE");
    }
    return { bytes, stat: fileIdentity(after) };
  } catch (error) {
    if (error instanceof DeploymentEnvelopeError) throw error;
    throw failure(invalidCode, secondRead ? 1 : 2);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readBounded(handle) {
  const chunks = [];
  let length = 0;
  while (length <= MAX_INPUT_BYTES) {
    const remaining = MAX_INPUT_BYTES + 1 - length;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  return Buffer.concat(chunks, length);
}

function parseTuple(snapshot) {
  try {
    return validateJourneyReleaseTupleBytes(snapshot.bytes);
  } catch {
    throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
  }
}

function parseCanonical(snapshot, style) {
  let value;
  try {
    value = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
  }
  if (!isObject(value)) throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
  if (style !== "json") {
    const expected = Buffer.from(style === "compact"
      ? `${JSON.stringify(value)}\n`
      : `${JSON.stringify(value, null, 2)}\n`);
    if (!snapshot.bytes.equals(expected)) {
      throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
    }
  }
  return value;
}

function validateCredentialInventory(value) {
  if (
    !sameKeys(value, [
      "schemaVersion", "artifactKind", "environment", "valuesIncluded",
      "builtInToken", "environmentSecretReferences", "repositoryVariableReferences",
    ]) ||
    value.schemaVersion !== 1 ||
    value.artifactKind !== "platform-production-credential-reference-inventory-v1" ||
    value.environment !== PLATFORM_ENVIRONMENT ||
    value.valuesIncluded !== false ||
    !sameKeys(value.builtInToken, ["name", "permissions"]) ||
    value.builtInToken.name !== "GITHUB_TOKEN" ||
    !sameKeys(value.builtInToken.permissions, ["actions", "contents", "packages"]) ||
    value.builtInToken.permissions.actions !== "read" ||
    value.builtInToken.permissions.contents !== "read" ||
    value.builtInToken.permissions.packages !== "read" ||
    !sameArray(value.environmentSecretReferences, [
      "DATA_GO_KR_SERVICE_KEY", "EASYSUBWAY_ENV",
      "EASYSUBWAY_JOURNEY_CURRENT_PUBLIC_KEY_PEM",
      "EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN",
      "EASYSUBWAY_RELEASE_ARTIFACTS_READ_TOKEN",
      "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
    ]) ||
    !sameArray(value.repositoryVariableReferences, [
      "DEPLOY_COMPOSE_PROJECT", "DEPLOY_PUBLIC_API_BASE_URL", "DEPLOY_ROOT",
      "EASYSUBWAY_ADS_ASSET_ORIGIN", "EASYSUBWAY_ADS_EVENT_DAILY_CAP",
    ])
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
  }
}

function validatePlatformReceipt(receipt, platformRevision) {
  if (
    !sameKeys(receipt, [
      "schemaVersion", "artifactKind", "repository", "environment", "ref",
      "workflowSha", "runUrl", "observedAt", "approval", "branchPolicy",
    ]) ||
    receipt.schemaVersion !== "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V1" ||
    receipt.artifactKind !== "production-deploy-effective-admission-receipt-v1" ||
    receipt.repository !== PLATFORM_REPOSITORY ||
    receipt.environment !== PLATFORM_ENVIRONMENT ||
    receipt.ref !== "refs/heads/main" ||
    receipt.workflowSha !== platformRevision ||
    !new RegExp(`^https://github\\.com/${PLATFORM_REPOSITORY}/actions/runs/[1-9][0-9]*$`).test(receipt.runUrl) ||
    !isDateTime(receipt.observedAt) ||
    !sameKeys(receipt.approval, ["canAdminsBypass", "preventSelfReview", "requiredReviewers"]) ||
    receipt.approval.canAdminsBypass !== false ||
    receipt.approval.preventSelfReview !== false ||
    !Array.isArray(receipt.approval.requiredReviewers) ||
    receipt.approval.requiredReviewers.length !== 1 ||
    !sameKeys(receipt.approval.requiredReviewers[0], ["type", "login"]) ||
    receipt.approval.requiredReviewers[0].type !== "User" ||
    receipt.approval.requiredReviewers[0].login !== "AquilaXk" ||
    !sameKeys(receipt.branchPolicy, ["protectedBranches", "customBranchPolicies", "allowedRefs"]) ||
    receipt.branchPolicy.protectedBranches !== false ||
    receipt.branchPolicy.customBranchPolicies !== true ||
    !Array.isArray(receipt.branchPolicy.allowedRefs) ||
    receipt.branchPolicy.allowedRefs.length !== 1 ||
    !sameKeys(receipt.branchPolicy.allowedRefs[0], ["type", "name"]) ||
    receipt.branchPolicy.allowedRefs[0].type !== "branch" ||
    receipt.branchPolicy.allowedRefs[0].name !== "main"
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_PLATFORM_MISMATCH", 2);
  }
}

function validateBackendComponent(component, tuple) {
  if (
    !sameKeys(component, [
      "schemaVersion", "component", "repository", "gitSha", "artifactIdentity",
      "contractVersion", "evidenceSha256", "issueRefs",
    ]) ||
    component.schemaVersion !== 1 ||
    component.component !== "backend" ||
    component.repository !== BACKEND_REPOSITORY ||
    component.gitSha !== tuple.deploymentRevision ||
    !sameKeys(component.artifactIdentity, ["imageDigest", "apiContractVersion"]) ||
    component.artifactIdentity.imageDigest !== tuple.backendImageDigest ||
    typeof component.contractVersion !== "string" ||
    component.contractVersion.length === 0 ||
    component.artifactIdentity.apiContractVersion !== component.contractVersion ||
    !matchesString(component.evidenceSha256, RAW_DIGEST) ||
    !Array.isArray(component.issueRefs) ||
    component.issueRefs.length < 1 ||
    component.issueRefs.some((reference) =>
      !/^AquilaXk\/easysubway-backend#[1-9][0-9]*$/.test(reference))
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_BACKEND_MISMATCH", 2);
  }
}

function validateReleaseBindings(candidate, descriptor, tuple) {
  if (
    !sameKeys(candidate, [
      "schemaVersion", "artifactKind", "orchestrator", "tupleSha256",
      "deploymentRevision", "environmentIdentity", "descriptorSha256",
      "serverRouteBundleDigest",
    ]) ||
    candidate.schemaVersion !== "JOURNEY_RELEASE_CANDIDATE_BINDING_V2" ||
    candidate.artifactKind !== "journey-release-candidate-binding" ||
    candidate.orchestrator !== "COMPOSE" ||
    candidate.tupleSha256 !== tuple.tupleSha256 ||
    candidate.deploymentRevision !== tuple.deploymentRevision ||
    candidate.environmentIdentity !== tuple.environmentIdentity ||
    !matchesString(candidate.descriptorSha256, RAW_DIGEST) ||
    candidate.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    !sameKeys(descriptor, [
      "schemaVersion", "artifactKind", "descriptorSha256", "producerGitSha",
      "tupleSha256", "serverRouteBundleDigest",
    ]) ||
    descriptor.schemaVersion !== "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1" ||
    descriptor.artifactKind !== "platform-server-route-bundle-descriptor-binding" ||
    !matchesString(descriptor.descriptorSha256, RAW_DIGEST) ||
    !matchesString(descriptor.producerGitSha, REVISION) ||
    descriptor.tupleSha256 !== tuple.tupleSha256 ||
    descriptor.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    candidate.descriptorSha256 !== descriptor.descriptorSha256
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_RELEASE_MISMATCH", 2);
  }
}

function validatePolicies(lifecycle, activationSchema, runtimeInventory) {
  if (
    lifecycle.schemaVersion !== "PLATFORM_JOURNEY_RELEASE_LIFECYCLE_CONTRACT_V2" ||
    lifecycle.artifactKind !== "platform-journey-release-lifecycle-contract" ||
    activationSchema.properties?.schemaVersion?.const !== "PLATFORM_ACTIVATION_RECEIPT_V2" ||
    activationSchema.properties?.artifactKind?.const !== "platform-activation-receipt" ||
    runtimeInventory.schemaVersion !== 1 ||
    runtimeInventory.artifactKind !== "platform-deployment-runtime-input-inventory-v1" ||
    !Array.isArray(runtimeInventory.sourcePaths) ||
    runtimeInventory.sourcePaths.length < 1 ||
    !Array.isArray(runtimeInventory.entries) ||
    runtimeInventory.entries.length < 1
  ) {
    throw failure("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2);
  }
}

function sameSnapshot(left, right) {
  return left.bytes.equals(right.bytes) &&
    Object.keys(left.stat).every((field) => left.stat[field] === right.stat[field]);
}

function sameFileStat(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function fileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameKeys(value, keys) {
  return isObject(value) && sameArray(Object.keys(value), keys);
}

function sameArray(left, right) {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPath(value) {
  return (typeof value === "string" && value.length > 0) || value instanceof URL;
}

function matchesString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isDateTime(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function failure(code, exitCode = 1) {
  return new DeploymentEnvelopeError(code, exitCode);
}

function parseCliArguments(args) {
  const fields = new Map([
    ["--admission-receipt", "admissionReceiptPath"],
    ["--credential-inventory", "credentialInventoryPath"],
    ["--tuple", "tuplePath"],
    ["--candidate-binding", "candidateBindingPath"],
    ["--descriptor-binding", "descriptorBindingPath"],
    ["--backend-component-manifest", "backendComponentManifestPath"],
    ["--lifecycle-contract", "lifecycleContractPath"],
    ["--activation-receipt-schema", "activationReceiptSchemaPath"],
    ["--runtime-input-inventory", "runtimeInputInventoryPath"],
    ["--platform-revision", "platformRevision"],
  ]);
  if (args.length !== fields.size * 2) {
    throw failure("DEPLOYMENT_ENVELOPE_USAGE", 2);
  }
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const field = fields.get(flag);
    const value = args[index + 1];
    if (!field || Object.hasOwn(parsed, field) ||
      typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw failure("DEPLOYMENT_ENVELOPE_USAGE", 2);
    }
    parsed[field] = value;
  }
  return parsed;
}

async function main() {
  const input = parseCliArguments(process.argv.slice(2));
  const envelope = await assemblePlatformDeploymentInputEnvelope(input);
  process.stdout.write(formatPlatformDeploymentInputEnvelope(envelope));
}

if (isMainModule()) {
  main().catch((error) => {
    const envelopeError = error instanceof DeploymentEnvelopeError
      ? error
      : failure("DEPLOYMENT_ENVELOPE_FAILURE");
    process.stderr.write(`${envelopeError.code} ${envelopeError.message}\n`);
    process.exitCode = envelopeError.exitCode;
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
