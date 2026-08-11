#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import https from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OBJECT_PATHS = Object.freeze([
  "compatibility.json",
  "manifest.json",
  "manifest.signing-input.json",
  "payload/accessibility.sqlite.zst",
  "payload/fare.sqlite.zst",
  "payload/timetable.sqlite.zst",
  "payload/topology.sqlite.zst",
  "provenance.json",
]);
const PRODUCER_GIT_SHA = "2b1390c1c764fde10b9da8ca8015a9252e5342fb";
const SCHEMA_IDENTITIES = Object.freeze([
  {
    role: "consumer-handoff",
    path: "contracts/datapack/server-route-bundle-consumer-handoff.schema.json",
    gitBlob: "b88c86f353310cd119ebb3fb0d76a4cc27251cb7",
    rawSha256: "9a6e691a8e029c21075a93f7da2b409ae5a0cde2d7bb8e02ff9c393157657d36",
  },
  {
    role: "publication-receipt",
    path: "contracts/datapack/server-route-bundle-publication-receipt.schema.json",
    gitBlob: "98395dc2928dc818b8b409b65c1ed1e19af9b9da",
    rawSha256: "79c2396c383461dc45b6503ccd3b85bdbf3fc64183e31042f09c92c84db44d3e",
  },
  {
    role: "component-manifest",
    path: "contracts/datapack/artifact-component-manifest.schema.json",
    gitBlob: "7ff2141895446876aeeaccd85d3bd7b2634f9c42",
    rawSha256: "64995e377b45aa86ff7dbd9635dd8248315bc74134040da6ff42ae82ed05c20b",
  },
]);
const CONSUMED_POINTERS = Object.freeze([
  "/publicationReceipt/repository/gitSha",
  "/publicationReceipt/candidate",
  "/publicationReceipt/locator",
  "/publicationReceipt/objects",
  "/release",
  "/platformRelease/serverRouteBundleDigest",
  "/handoffSha256",
]);
const REJECT_CONDITIONS = Object.freeze([
  "MISSING_OR_UNKNOWN_FIELD",
  "DUPLICATE_OR_REORDERED_OBJECT",
  "OBJECT_KEY_OR_PREFIX_MISMATCH",
  "EMPTY_PARTIAL_OR_OVERSIZED_OBJECT",
  "SIZE_OR_SHA256_MISMATCH",
  "TRANSPORT_INTERRUPTED",
  "CHANGED_SECOND_READ",
  "PATH_TRAVERSAL",
  "SYMLINK_OUTPUT",
]);
const FAILURE_CODES = Object.freeze([
  "HANDOFF_SHAPE_INVALID",
  "PRODUCER_IDENTITY_MISMATCH",
  "INVENTORY_INVALID",
  "LOCATOR_POLICY_VIOLATION",
  "OBJECT_IDENTITY_MISMATCH",
  "OBJECT_READ_UNSTABLE",
  "OUTPUT_POLICY_VIOLATION",
  "RETENTION_TARGET_PROTECTED",
  "CURRENT_OBJECT_UNAVAILABLE",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const KST_INSTANT =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}\+09:00$/;
const PUBLIC_BASE_URL =
  /^https:\/\/objectstorage\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.oraclecloud\.com\/n\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/b\/[A-Za-z0-9_~-](?:[A-Za-z0-9._~-]*[A-Za-z0-9_~-])?\/o$/;
const OBJECT_PREFIX = /^server-route-bundles\/v1\/[a-f0-9]{64}\/$/;
const SIGNATURE_VALUE = /^[A-Za-z0-9_-]+$/;
const SECOND_READ_CHUNK_BYTES = 64 * 1024;
const ERROR_MESSAGES = Object.freeze({
  HANDOFF_SHAPE_INVALID: "handoff validation failed",
  PRODUCER_IDENTITY_MISMATCH: "producer identity validation failed",
  INVENTORY_INVALID: "object inventory validation failed",
  LOCATOR_POLICY_VIOLATION: "object locator policy rejected the response",
  OBJECT_IDENTITY_MISMATCH: "object identity validation failed",
  OBJECT_READ_UNSTABLE: "object changed during local verification",
  OUTPUT_POLICY_VIOLATION: "output policy validation failed",
  CURRENT_OBJECT_UNAVAILABLE: "current object acquisition failed",
});

export class AcquisitionError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "bundle acquisition failed");
    this.name = "AcquisitionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function buildObjectUrl(publicBaseUrl, objectKey) {
  if (
    typeof publicBaseUrl !== "string" ||
    !PUBLIC_BASE_URL.test(publicBaseUrl) ||
    typeof objectKey !== "string" ||
    objectKey.length === 0 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw failure("LOCATOR_POLICY_VIOLATION");
  }
  return `${publicBaseUrl}/${objectKey}`;
}

export function formatAcquisitionSuccess(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    !isSha256(result.handoffSha256) ||
    !isSha256Reference(result.serverRouteBundleDigest)
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
  return `ACQUIRED ${result.handoffSha256} ${result.serverRouteBundleDigest}\n`;
}

export async function acquireServerRouteBundle({
  contractPath,
  handoffPath,
  outputRoot,
  fetchObject = fetchHttpsObject,
  beforeSecondRead,
  openOutputFile = open,
  onSecondReadChunk,
}) {
  let stageRoot;
  try {
    const contractBytes = await readRegularFile(
      contractPath,
      "OUTPUT_POLICY_VIOLATION",
    );
    const handoffBytes = await readRegularFile(
      handoffPath,
      "HANDOFF_SHAPE_INVALID",
    );
    const contract = parseJson(contractBytes, "OUTPUT_POLICY_VIOLATION");
    const handoff = parseJson(handoffBytes, "HANDOFF_SHAPE_INVALID");

    validateRuntimeHooks({ beforeSecondRead, openOutputFile, onSecondReadChunk });
    validateContract(contract);
    validateHandoff(handoff, handoffBytes, contract);
    const safeOutputRoot = await validateEmptyOutputRoot(outputRoot);

    stageRoot = await mkdtemp(
      join(safeOutputRoot, ".server-route-bundle-"),
    ).catch(() => {
      throw failure("OUTPUT_POLICY_VIOLATION");
    });
    const objectRoot = join(stageRoot, "objects");
    await mkdir(objectRoot, { mode: 0o700 }).catch(() => {
      throw failure("OUTPUT_POLICY_VIOLATION");
    });

    for (const entry of handoff.publicationReceipt.objects) {
      const url = buildObjectUrl(
        handoff.publicationReceipt.locator.publicBaseUrl,
        entry.objectKey,
      );
      const target = join(objectRoot, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }).catch(() => {
        throw failure("OUTPUT_POLICY_VIOLATION");
      });
      await acquireOneObject({ fetchObject, url, entry, target, openOutputFile });
    }

    if (beforeSecondRead !== undefined) {
      if (typeof beforeSecondRead !== "function") {
        throw failure("OUTPUT_POLICY_VIOLATION", 2);
      }
      await beforeSecondRead({
        stageRoot,
        entries: handoff.publicationReceipt.objects.map((entry) => ({ ...entry })),
      });
    }

    await verifySecondRead(
      objectRoot,
      handoff.publicationReceipt.objects,
      onSecondReadChunk,
    );
    const handoffSecondRead = await readRegularFile(
      handoffPath,
      "OBJECT_READ_UNSTABLE",
    );
    if (!handoffBytes.equals(handoffSecondRead)) {
      throw failure("OBJECT_READ_UNSTABLE");
    }

    await writeNewFile(
      join(stageRoot, "handoff.json"),
      handoffBytes,
      openOutputFile,
    );
    const candidateRoot = join(safeOutputRoot, handoff.handoffSha256);
    await rename(stageRoot, candidateRoot).catch(() => {
      throw failure("OUTPUT_POLICY_VIOLATION");
    });
    stageRoot = undefined;

    return {
      handoffSha256: handoff.handoffSha256,
      serverRouteBundleDigest: handoff.platformRelease.serverRouteBundleDigest,
    };
  } catch (error) {
    if (stageRoot !== undefined) {
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (error instanceof AcquisitionError) throw error;
    throw failure("CURRENT_OBJECT_UNAVAILABLE");
  }
}

async function acquireOneObject({
  fetchObject,
  url,
  entry,
  target,
  openOutputFile,
}) {
  const response = await requestCurrentObject(fetchObject, url, entry);
  validateObjectResponse(response, entry);
  const { size, sha256: actualSha256 } = await streamObjectToFile(
    response.body,
    target,
    entry.sizeBytes,
    openOutputFile,
  );
  if (size === 0 || size !== entry.sizeBytes || actualSha256 !== entry.sha256) {
    throw failure("OBJECT_IDENTITY_MISMATCH");
  }
}

async function requestCurrentObject(fetchObject, url, entry) {
  try {
    return await fetchObject(url, entry);
  } catch {
    throw failure("CURRENT_OBJECT_UNAVAILABLE");
  }
}

function validateObjectResponse(response, entry) {
  if (response?.statusCode !== 200) {
    destroyBody(response?.body);
    throw failure("CURRENT_OBJECT_UNAVAILABLE");
  }
  const headers = normalizeHeaders(response.headers);
  if (
    headers["content-encoding"] !== undefined &&
    headers["content-encoding"].toLowerCase() !== "identity"
  ) {
    destroyBody(response.body);
    throw failure("LOCATOR_POLICY_VIOLATION");
  }
  if (headers["content-length"] !== undefined) {
    const length = headers["content-length"];
    if (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) !== entry.sizeBytes) {
      destroyBody(response.body);
      throw failure("CURRENT_OBJECT_UNAVAILABLE");
    }
  }
}

async function streamObjectToFile(body, target, expectedSize, openOutputFile) {
  let handle;
  try {
    handle = await openOutputFile(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    destroyBody(body);
    throw failure("OUTPUT_POLICY_VIOLATION");
  }
  let size = 0;
  const digest = createHash("sha256");
  let streamError;
  try {
    for await (const rawChunk of bodyChunks(body)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > expectedSize) throw failure("OBJECT_IDENTITY_MISMATCH");
      digest.update(chunk);
      try {
        await writeAll(handle, chunk);
      } catch {
        throw failure("OUTPUT_POLICY_VIOLATION");
      }
    }
  } catch (error) {
    streamError = error instanceof AcquisitionError
      ? error
      : failure("CURRENT_OBJECT_UNAVAILABLE");
  }
  try {
    await handle.close();
  } catch {
    streamError ??= failure("OUTPUT_POLICY_VIOLATION");
  }
  if (streamError !== undefined) {
    destroyBody(body);
    throw streamError;
  }
  return { size, sha256: digest.digest("hex") };
}

async function verifySecondRead(objectRoot, entries, onSecondReadChunk) {
  for (const entry of entries) {
    const identity = await hashRegularFile(
      join(objectRoot, entry.path),
      "OBJECT_READ_UNSTABLE",
      (bytesRead) => onSecondReadChunk?.({ path: entry.path, bytesRead }),
    );
    if (identity.size !== entry.sizeBytes || identity.sha256 !== entry.sha256) {
      throw failure("OBJECT_READ_UNSTABLE");
    }
  }
}

async function writeNewFile(path, bytes, openOutputFile) {
  const handle = await openOutputFile(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  ).catch(() => {
    throw failure("OUTPUT_POLICY_VIOLATION");
  });
  let writeError;
  try {
    await handle.writeFile(bytes);
  } catch {
    writeError = failure("OUTPUT_POLICY_VIOLATION");
  }
  try {
    await handle.close();
  } catch {
    writeError ??= failure("OUTPUT_POLICY_VIOLATION");
  }
  if (writeError !== undefined) throw writeError;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten <= 0) throw failure("CURRENT_OBJECT_UNAVAILABLE");
    offset += bytesWritten;
  }
}

async function readRegularFile(path, code) {
  if (typeof path !== "string" || path.length === 0) throw failure(code, 2);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure(code, 2);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof AcquisitionError) throw error;
    throw failure(code, 2);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashRegularFile(path, code, onChunk) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure(code, 2);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof AcquisitionError) throw error;
    throw failure(code, 2);
  }

  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(SECOND_READ_CHUNK_BYTES);
  let size = 0;
  let readError;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
      onChunk?.(bytesRead);
    }
  } catch {
    readError = failure(code);
  }
  try {
    await handle.close();
  } catch {
    readError ??= failure(code);
  }
  if (readError !== undefined) throw readError;
  return { size, sha256: digest.digest("hex") };
}

function validateRuntimeHooks({ beforeSecondRead, openOutputFile, onSecondReadChunk }) {
  if (
    (beforeSecondRead !== undefined && typeof beforeSecondRead !== "function") ||
    typeof openOutputFile !== "function" ||
    (onSecondReadChunk !== undefined && typeof onSecondReadChunk !== "function")
  ) throw failure("OUTPUT_POLICY_VIOLATION", 2);
}

async function validateEmptyOutputRoot(outputRoot) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0) {
    throw failure("OUTPUT_POLICY_VIOLATION", 2);
  }
  const absoluteRoot = resolve(outputRoot);
  const physicalRoot = await realpath(absoluteRoot).catch(() => {
    throw failure("OUTPUT_POLICY_VIOLATION", 2);
  });
  if (physicalRoot !== absoluteRoot) {
    throw failure("OUTPUT_POLICY_VIOLATION", 2);
  }
  const ancestors = [];
  for (let current = absoluteRoot; ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) break;
  }
  for (const current of ancestors.toReversed()) {
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      throw failure("OUTPUT_POLICY_VIOLATION", 2);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw failure("OUTPUT_POLICY_VIOLATION", 2);
    }
  }
  const children = await readdir(absoluteRoot).catch(() => {
    throw failure("OUTPUT_POLICY_VIOLATION", 2);
  });
  if (children.length !== 0) throw failure("OUTPUT_POLICY_VIOLATION", 2);
  return absoluteRoot;
}

function validateContract(contract) {
  if (
    !isExactObject(contract, [
      "schemaVersion",
      "artifactKind",
      "issueRef",
      "producer",
      "consumedJsonPointers",
      "acquisition",
      "candidateOutput",
      "retention",
      "failure",
    ]) ||
    contract.schemaVersion !== 1 ||
    contract.artifactKind !== "server-route-bundle-object-acquisition-contract-v1" ||
    contract.issueRef !== "AquilaXk/easysubway-platform#60" ||
    !isExactObject(contract.producer, ["repository", "gitSha", "schemas"]) ||
    contract.producer.repository !== "AquilaXk/easysubway-data" ||
    contract.producer.gitSha !== PRODUCER_GIT_SHA ||
    canonicalJson(contract.producer.schemas) !== canonicalJson(SCHEMA_IDENTITIES) ||
    !sameArray(contract.consumedJsonPointers, CONSUMED_POINTERS) ||
    !isExactObject(contract.acquisition, [
      "inventoryPointer",
      "objectCount",
      "objectIdentityFields",
      "transport",
      "rejectConditions",
    ]) ||
    contract.acquisition.inventoryPointer !== "/publicationReceipt/objects" ||
    contract.acquisition.objectCount !== 8 ||
    !sameArray(contract.acquisition.objectIdentityFields, [
      "objectKey",
      "sizeBytes",
      "sha256",
    ]) ||
    !isExactObject(contract.acquisition.transport, [
      "scheme",
      "redirectsAllowed",
      "locatorPointer",
      "objectPrefixPolicy",
    ]) ||
    contract.acquisition.transport.scheme !== "HTTPS" ||
    contract.acquisition.transport.redirectsAllowed !== false ||
    contract.acquisition.transport.locatorPointer !== "/publicationReceipt/locator" ||
    contract.acquisition.transport.objectPrefixPolicy !== "EXACT_RECEIPT_PREFIX_AND_KEY" ||
    !sameArray(contract.acquisition.rejectConditions, REJECT_CONDITIONS) ||
    !isExactObject(contract.candidateOutput, [
      "ownership",
      "overwriteAllowed",
      "visibility",
      "partialOutputOnFailure",
    ]) ||
    contract.candidateOutput.ownership !== "TASK_OWNED" ||
    contract.candidateOutput.overwriteAllowed !== false ||
    contract.candidateOutput.visibility !==
      "AFTER_ALL_OBJECTS_AND_HANDOFF_IDENTITIES_VALIDATE" ||
    contract.candidateOutput.partialOutputOnFailure !== 0 ||
    !isExactObject(contract.retention, [
      "protectedTargets",
      "currentObjectUnavailableAction",
      "forbiddenAlternateSources",
      "alternateSelectionCount",
    ]) ||
    !sameArray(contract.retention.protectedTargets, [
      "ACTIVE",
      "EXPLICIT_VALIDATED_ROLLBACK",
    ]) ||
    contract.retention.currentObjectUnavailableAction !== "TYPED_NONZERO_FAILURE" ||
    !sameArray(contract.retention.forbiddenAlternateSources, [
      "OLDER_OBJECT",
      "LOCAL_CACHE",
      "HUB_SOURCE",
      "PREVIOUS_ARTIFACT",
    ]) ||
    contract.retention.alternateSelectionCount !== 0 ||
    !isExactObject(contract.failure, [
      "result",
      "codes",
      "stateMutationOnFailure",
      "alternateInvocationCount",
    ]) ||
    contract.failure.result !== "TYPED_NONZERO" ||
    !sameArray(contract.failure.codes, FAILURE_CODES) ||
    contract.failure.alternateInvocationCount !== 0 ||
    !isExactObject(contract.failure.stateMutationOnFailure, [
      "candidate",
      "active",
      "traffic",
    ]) ||
    Object.values(contract.failure.stateMutationOnFailure).some((value) => value !== 0)
  ) {
    throw failure("OUTPUT_POLICY_VIOLATION", 2);
  }
}

function validateHandoff(handoff, rawBytes, contract) {
  if (!isExactObject(handoff, [
    "schemaVersion",
    "artifactKind",
    "manifest",
    "sourceSnapshotSetHash",
    "publicationReceipt",
    "release",
    "backendAdmission",
    "platformRelease",
    "handoffSha256",
  ])) throw failure("HANDOFF_SHAPE_INVALID", 2);
  if (
    handoff.schemaVersion !== 1 ||
    handoff.artifactKind !== "server-route-bundle-consumer-handoff" ||
    !isSha256(handoff.sourceSnapshotSetHash) ||
    !isSha256(handoff.handoffSha256) ||
    canonicalJson(handoff) !== rawBytes.toString("utf8")
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);

  const handoffPayload = { ...handoff };
  delete handoffPayload.handoffSha256;
  if (sha256(Buffer.from(canonicalJson(handoffPayload))) !== handoff.handoffSha256) {
    throw failure("HANDOFF_SHAPE_INVALID", 2);
  }

  validateManifest(handoff.manifest);
  validateReceipt(handoff.publicationReceipt);
  validateRelease(handoff.release);
  validateAdmission(handoff.backendAdmission);
  if (
    !isExactObject(handoff.platformRelease, ["serverRouteBundleDigest"]) ||
    !isSha256Reference(handoff.platformRelease.serverRouteBundleDigest)
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);

  const receipt = handoff.publicationReceipt;
  if (
    receipt.repository.name !== contract.producer.repository ||
    receipt.repository.gitSha !== contract.producer.gitSha
  ) throw failure("PRODUCER_IDENTITY_MISMATCH");

  validateInventory(receipt);
  const receiptPayload = { ...receipt };
  delete receiptPayload.receiptSha256;
  const receiptRawSha256 = sha256(Buffer.from(canonicalJson(receipt)));
  if (
    sha256(Buffer.from(canonicalJson(receiptPayload))) !== receipt.receiptSha256 ||
    handoff.release.publicationReceiptSha256 !== receipt.receiptSha256 ||
    handoff.release.publicationReceiptRawSha256 !== receiptRawSha256 ||
    handoff.backendAdmission.immutablePublicationReceiptIdentity !==
      `sha256:${receiptRawSha256}`
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);

  const manifestBytes = Buffer.from(canonicalJson(handoff.manifest));
  const manifestSha256 = sha256(manifestBytes);
  const candidate = receipt.candidate;
  const manifest = handoff.manifest;
  const components = candidate.componentDigests;
  const objectByPath = new Map(receipt.objects.map((entry) => [entry.path, entry]));
  const payloadInventory = ["accessibility", "fare", "timetable", "topology"]
    .map((component) => {
      const entry = objectByPath.get(`payload/${component}.sqlite.zst`);
      return {
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      };
    })
    .sort((left, right) => compareCodePoint(left.path, right.path));
  const componentInventorySha256 = sha256(
    Buffer.from(canonicalJson(payloadInventory)),
  );
  if (
    handoff.sourceSnapshotSetHash !== candidate.sourceSnapshotSetHash ||
    manifest.bundleId !== candidate.bundleId ||
    manifest.releaseSequence !== candidate.releaseSequence ||
    manifest.stationSetSha256 !== candidate.stationSetSha256 ||
    manifest.activeFrom !== candidate.activeFrom ||
    manifest.freshUntil !== candidate.freshUntil ||
    manifest.keyId !== candidate.keyId ||
    manifest.payloadSha256 !== candidate.payloadRootSha256 ||
    manifest.payloadSha256 !== candidate.componentInventorySha256 ||
    manifest.payloadSha256 !== componentInventorySha256 ||
    manifest.accessibilitySha256 !== components.accessibility ||
    manifest.fareSha256 !== components.fare ||
    manifest.timetableSha256 !== components.timetable ||
    manifest.topologySha256 !== components.topology ||
    candidate.signedManifestRawSha256 !== manifestSha256 ||
    objectByPath.get("manifest.json").sha256 !== manifestSha256 ||
    objectByPath.get("manifest.json").sizeBytes !== manifestBytes.length ||
    objectByPath.get("manifest.signing-input.json").sha256 !==
      candidate.signingInputSha256 ||
    objectByPath.get("payload/accessibility.sqlite.zst").sha256 !==
      components.accessibility ||
    objectByPath.get("payload/fare.sqlite.zst").sha256 !== components.fare ||
    objectByPath.get("payload/timetable.sqlite.zst").sha256 !==
      components.timetable ||
    objectByPath.get("payload/topology.sqlite.zst").sha256 !==
      components.topology ||
    objectByPath.get("provenance.json").sha256 !== manifest.provenanceSha256 ||
    objectByPath.get("compatibility.json").sha256 !==
      manifest.compatibilitySha256 ||
    handoff.backendAdmission.manifestSha256 !== manifestSha256 ||
    handoff.platformRelease.serverRouteBundleDigest !== `sha256:${manifestSha256}` ||
    handoff.backendAdmission.finalEvidenceReference !==
      `sha256:${handoff.release.finalRawSha256}` ||
    handoff.backendAdmission.promotionEvidenceReference !==
      `sha256:${handoff.release.promotionEvidenceSha256}`
  ) throw failure("OBJECT_IDENTITY_MISMATCH");
}

function validateManifest(value) {
  const keys = [
    "manifestVersion", "artifactKind", "bundleId", "releaseSequence",
    "stationSetSha256", "payloadSha256", "topologySha256", "timetableSha256",
    "accessibilitySha256", "fareSha256", "provenanceSha256",
    "compatibilitySha256", "serviceTimezone", "activeFrom", "freshUntil",
    "schemaCompatibility", "keyId", "signature",
  ];
  if (
    !isExactObject(value, keys) ||
    value.manifestVersion !== 1 ||
    value.artifactKind !== "server-route-bundle" ||
    !isRawString(value.bundleId) ||
    !isSafeInteger(value.releaseSequence) ||
    !["stationSetSha256", "payloadSha256", "topologySha256", "timetableSha256",
      "accessibilitySha256", "fareSha256", "provenanceSha256",
      "compatibilitySha256"].every((key) => isSha256(value[key])) ||
    value.serviceTimezone !== "Asia/Seoul" ||
    !isKstInstant(value.activeFrom) ||
    !isKstInstant(value.freshUntil) ||
    !isExactObject(value.schemaCompatibility, ["backendMin", "backendMax"]) ||
    value.schemaCompatibility.backendMin !== 3 ||
    value.schemaCompatibility.backendMax !== 3 ||
    !isRawString(value.keyId) ||
    !isExactObject(value.signature, ["algorithm", "value"]) ||
    value.signature.algorithm !== "rsa-sha256-server-route-bundle-v1" ||
    !matchesString(value.signature.value, SIGNATURE_VALUE)
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
}

function validateReceipt(value) {
  if (
    !isExactObject(value, [
      "schemaVersion", "artifactKind", "repository", "candidate", "locator",
      "objects", "receiptSha256",
    ]) ||
    value.schemaVersion !== 1 ||
    value.artifactKind !== "server-route-bundle-publication-receipt" ||
    !isExactObject(value.repository, ["name", "gitSha"]) ||
    value.repository.name !== "AquilaXk/easysubway-data" ||
    !matchesString(value.repository.gitSha, GIT_SHA) ||
    !isSha256(value.receiptSha256) ||
    !isExactObject(value.locator, ["publicBaseUrl", "objectPrefix"])
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
  if (
    !matchesString(value.locator.publicBaseUrl, PUBLIC_BASE_URL) ||
    !matchesString(value.locator.objectPrefix, OBJECT_PREFIX)
  ) throw failure("LOCATOR_POLICY_VIOLATION", 2);
  validateCandidate(value.candidate);
}

function validateCandidate(value) {
  const digestKeys = ["accessibility", "fare", "timetable", "topology"];
  const shaKeys = [
    "stationSetSha256", "sourceSnapshotSetHash", "signingInputSha256",
    "signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256",
    "prePublicationFinalSha256",
  ];
  if (
    !isExactObject(value, [
      "bundleId", "releaseSequence", ...shaKeys.slice(0, 6), "componentDigests",
      "activeFrom", "freshUntil", "keyId", "prePublicationFinalSha256",
    ]) ||
    !isRawString(value.bundleId) ||
    !isSafeInteger(value.releaseSequence) ||
    !shaKeys.every((key) => isSha256(value[key])) ||
    !isExactObject(value.componentDigests, digestKeys) ||
    !digestKeys.every((key) => isSha256(value.componentDigests[key])) ||
    !isKstInstant(value.activeFrom) ||
    !isKstInstant(value.freshUntil) ||
    !isRawString(value.keyId)
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
}

function validateRelease(value) {
  const shaKeys = [
    "finalSha256", "finalRawSha256", "publicationReceiptSha256",
    "publicationReceiptRawSha256", "promotionEvidenceSha256",
  ];
  if (
    !isExactObject(value, ["result", ...shaKeys]) ||
    value.result !== "GO" ||
    !shaKeys.every((key) => isSha256(value[key]))
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
}

function validateAdmission(value) {
  if (
    !isExactObject(value, [
      "manifestSha256", "finalEvidenceReference", "promotionEvidenceReference",
      "immutablePublicationReceiptIdentity",
    ]) ||
    !isSha256(value.manifestSha256) ||
    !["finalEvidenceReference", "promotionEvidenceReference",
      "immutablePublicationReceiptIdentity"].every((key) =>
      isSha256Reference(value[key]))
  ) throw failure("HANDOFF_SHAPE_INVALID", 2);
}

function validateInventory(receipt) {
  if (!Array.isArray(receipt.objects) || receipt.objects.length !== OBJECT_PATHS.length) {
    throw failure("INVENTORY_INVALID", 2);
  }
  for (let index = 0; index < OBJECT_PATHS.length; index += 1) {
    const entry = receipt.objects[index];
    const expectedPath = OBJECT_PATHS[index];
    if (
      !isExactObject(entry, ["path", "objectKey", "sizeBytes", "sha256"]) ||
      entry.path !== expectedPath ||
      entry.objectKey !== `${receipt.locator.objectPrefix}${expectedPath}` ||
      !isSafeInteger(entry.sizeBytes) ||
      !isSha256(entry.sha256)
    ) throw failure("INVENTORY_INVALID", 2);
  }
}

function parseJson(bytes, code) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseJsonWithoutDuplicateKeys(text);
  } catch {
    throw failure(code, 2);
  }
}

function parseJsonWithoutDuplicateKeys(text) {
  let index = 0;
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  };
  const parseValue = () => {
    whitespace();
    if (text[index] === "{") return parseObject();
    if (text[index] === "[") return parseArray();
    if (text[index] === '"') return parseString();
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return JSON.parse(literal);
      }
    }
    return parseNumber();
  };
  const parseNumber = () => {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
    } else {
      requireDigit(/[1-9]/);
      while (/\d/.test(text[index])) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      requireDigit(/\d/);
      while (/\d/.test(text[index])) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      requireDigit(/\d/);
      while (/\d/.test(text[index])) index += 1;
    }
    return JSON.parse(text.slice(start, index));
  };
  const requireDigit = (pattern) => {
    if (!pattern.test(text[index])) throw new SyntaxError("invalid JSON number");
    index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (text.codePointAt(index) < 0x20) throw new SyntaxError("invalid JSON string");
      index += 1;
    }
    throw new SyntaxError("unterminated JSON string");
  };
  const parseObject = () => {
    const result = {};
    const keys = new Set();
    index += 1;
    whitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (true) {
      whitespace();
      if (text[index] !== '"') throw new SyntaxError("invalid JSON object");
      const key = parseString();
      if (keys.has(key)) throw new SyntaxError("duplicate JSON key");
      keys.add(key);
      whitespace();
      if (text[index] !== ":") throw new SyntaxError("invalid JSON object");
      index += 1;
      result[key] = parseValue();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") throw new SyntaxError("invalid JSON object");
      index += 1;
    }
  };
  const parseArray = () => {
    const result = [];
    index += 1;
    whitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (true) {
      result.push(parseValue());
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") throw new SyntaxError("invalid JSON array");
      index += 1;
    }
  };
  const value = parseValue();
  whitespace();
  if (index !== text.length) throw new SyntaxError("trailing JSON data");
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareCodePoint)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const normalizedValue = Array.isArray(value) ? value.join(",") : String(value);
      return [key.toLowerCase(), normalizedValue];
    }),
  );
}

function bodyChunks(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return [body];
  if (body && typeof body[Symbol.asyncIterator] === "function") return body;
  throw failure("CURRENT_OBJECT_UNAVAILABLE");
}

function destroyBody(body) {
  if (body && typeof body.destroy === "function") {
    try {
      body.destroy();
    } catch {
      // The typed acquisition error remains authoritative.
    }
  }
}

function fetchHttpsObject(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.get(
      url,
      { headers: { "Accept-Encoding": "identity" } },
      (response) => resolvePromise({
        statusCode: response.statusCode,
        headers: response.headers,
        body: response,
      }),
    );
    request.setTimeout(30_000, () => request.destroy());
    request.once("error", rejectPromise);
  });
}

function isExactObject(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function sameArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isRawString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function matchesString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isSha256(value) {
  return matchesString(value, SHA256);
}

function isSha256Reference(value) {
  return matchesString(value, SHA256_REFERENCE);
}

function compareCodePoint(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isKstInstant(value) {
  if (typeof value !== "string") return false;
  const match = KST_INSTANT.exec(value);
  if (match === null) return false;
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function failure(code, exitCode = 1) {
  return new AcquisitionError(code, exitCode);
}

function parseCliArguments(args) {
  if (args.length !== 6) throw failure("OUTPUT_POLICY_VIOLATION", 2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--contract", "--handoff", "--output-root"].includes(name) ||
      Object.hasOwn(values, name) ||
      typeof value !== "string" ||
      value.length === 0
    ) throw failure("OUTPUT_POLICY_VIOLATION", 2);
    values[name] = value;
  }
  if (Object.keys(values).length !== 3) throw failure("OUTPUT_POLICY_VIOLATION", 2);
  return {
    contractPath: values["--contract"],
    handoffPath: values["--handoff"],
    outputRoot: values["--output-root"],
  };
}

async function main() {
  try {
    const result = await acquireServerRouteBundle(parseCliArguments(process.argv.slice(2)));
    process.stdout.write(formatAcquisitionSuccess(result));
  } catch (error) {
    const safeError = error instanceof AcquisitionError
      ? error
      : failure("CURRENT_OBJECT_UNAVAILABLE");
    process.stderr.write(`${safeError.code} ${safeError.message}\n`);
    process.exitCode = safeError.exitCode;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
