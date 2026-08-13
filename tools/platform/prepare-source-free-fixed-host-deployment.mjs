#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assemblePlatformDeploymentInputEnvelope,
} from "./assemble-platform-deployment-input-envelope.mjs";
import {
  bindJourneyReleaseDescriptorCandidate,
} from "./bind-journey-release-candidate.mjs";
import {
  bindServerRouteBundlePublicationDescriptor,
} from "./bind-server-route-bundle-publication-descriptor.mjs";
import {
  inspectServerRouteBundlePublicationDescriptor,
} from "./acquire-server-route-bundle.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9][0-9]*$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 4096;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const FIXED_PATHS = Object.freeze({
  credentialInventoryPath: path.join(
    REPOSITORY_ROOT,
    "contracts/release/platform-production-credential-reference-inventory.json",
  ),
  lifecycleContractPath: path.join(
    REPOSITORY_ROOT,
    "contracts/release/platform-journey-release-lifecycle-contract.json",
  ),
  activationReceiptSchemaPath: path.join(
    REPOSITORY_ROOT,
    "contracts/release/platform-activation-receipt.schema.json",
  ),
  runtimeInputInventoryPath: path.join(
    REPOSITORY_ROOT,
    "contracts/release/platform-deployment-runtime-input-inventory.json",
  ),
  canaryPolicyPath: path.join(
    REPOSITORY_ROOT,
    "contracts/release/platform-journey-canary-policy.json",
  ),
  baseComposePath: path.join(REPOSITORY_ROOT, "infra/docker-compose.yml"),
  candidateComposePath: path.join(
    REPOSITORY_ROOT,
    "infra/docker-compose.journey-candidate.yml",
  ),
});
const ARTIFACT_FILES = Object.freeze({
  component: "backend-component-manifest.json",
  contractReceipt: "journey-v3-contract-bundle-v2-receipt.json",
  descriptor: "server-route-bundle-publication-descriptor.json",
});
const ERROR_MESSAGES = Object.freeze({
  SOURCE_FREE_PREPARE_USAGE: "expected exact source-free preparation arguments",
  SOURCE_FREE_PREPARE_INPUT: "source-free immutable input validation failed",
  SOURCE_FREE_PREPARE_OUTPUT: "source-free request preparation failed",
});

export class SourceFreePreparationError extends Error {
  constructor(code, exitCode = 1, options) {
    super(ERROR_MESSAGES[code] ?? "source-free preparation failed", options);
    this.name = "SourceFreePreparationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function prepareSourceFreeFixedHostDeployment(
  input,
  dependencies = {},
) {
  validateInvocation(input, dependencies);
  const adapters = {
    inspectDescriptor:
      dependencies.inspectDescriptor ?? inspectServerRouteBundlePublicationDescriptor,
    bindDescriptor:
      dependencies.bindDescriptor ?? bindServerRouteBundlePublicationDescriptor,
    bindCandidate:
      dependencies.bindCandidate ?? bindJourneyReleaseDescriptorCandidate,
    assembleEnvelope:
      dependencies.assembleEnvelope ?? assemblePlatformDeploymentInputEnvelope,
    now: dependencies.now ?? (() => new Date()),
  };

  try {
    const [componentInput, contractInput, descriptorInput, backendConfigBytes] =
      await Promise.all([
        findArtifactInput(input.backendArtifactRoot, ARTIFACT_FILES.component),
        findArtifactInput(input.backendArtifactRoot, ARTIFACT_FILES.contractReceipt),
        findArtifactInput(input.dataArtifactRoot, ARTIFACT_FILES.descriptor),
        readStableFile(input.backendEnvPath),
      ]);
    const component = validateBackendComponent(componentInput.bytes);
    const contract = validateContractReceipt(contractInput.bytes, component.gitSha);
    const descriptor = adapters.inspectDescriptor(descriptorInput.bytes);
    if (
      component.gitSha !== input.backendProducerGitSha ||
      !matches(descriptor?.descriptorSha256, RAW_DIGEST) ||
      !matches(descriptor?.producerGitSha, REVISION) ||
      descriptor.producerGitSha !== input.dataProducerGitSha ||
      !matches(descriptor?.serverRouteBundleDigest, DIGEST)
    ) throw new Error("invalid Data publication descriptor projection");

    await createOutputRoot(input.deployRoot, input.outputRoot);
    const files = {
      tuplePath: path.join(input.outputRoot, "journey-release-tuple.json"),
      descriptorPath: path.join(
        input.outputRoot,
        ARTIFACT_FILES.descriptor,
      ),
      descriptorBindingPath: path.join(input.outputRoot, "descriptor-binding.json"),
      candidateBindingPath: path.join(input.outputRoot, "candidate-binding.json"),
      envelopePath: path.join(input.outputRoot, "deployment-envelope.json"),
      composeEnvPath: path.join(input.outputRoot, "compose.env"),
      backendEnvPath: path.join(input.outputRoot, "backend.env"),
      baseComposePath: path.join(input.outputRoot, "docker-compose.yml"),
      candidateComposePath: path.join(
        input.outputRoot,
        "docker-compose.journey-candidate.yml",
      ),
    };
    const tuple = createJourneyReleaseTuple({
      backendImageDigest: component.artifactIdentity.imageDigest,
      backendConfigDigest: digest(backendConfigBytes),
      journeyContractDigest: contract.artifact.manifestDigest,
      serverRouteBundleDigest: descriptor.serverRouteBundleDigest,
      deploymentRevision: component.gitSha,
    });
    await Promise.all([
      writeExclusive(files.tuplePath, pretty(tuple)),
      writeExclusive(files.descriptorPath, descriptorInput.bytes),
      writeExclusive(files.composeEnvPath, await readStableFile(input.composeEnvPath)),
      writeExclusive(files.backendEnvPath, backendConfigBytes),
      writeExclusive(files.baseComposePath, await readStableFile(FIXED_PATHS.baseComposePath)),
      writeExclusive(
        files.candidateComposePath,
        await readStableFile(FIXED_PATHS.candidateComposePath),
      ),
    ]);

    const descriptorBinding = await adapters.bindDescriptor({
      descriptorPath: files.descriptorPath,
      tuplePath: files.tuplePath,
    });
    await writeExclusive(files.descriptorBindingPath, compact(descriptorBinding));
    const candidateBinding = await adapters.bindCandidate({
      tuplePath: files.tuplePath,
      descriptorBindingPath: files.descriptorBindingPath,
      orchestrator: "COMPOSE",
    });
    await writeExclusive(files.candidateBindingPath, compact(candidateBinding));
    const envelope = await adapters.assembleEnvelope({
      admissionReceiptPath: input.admissionReceiptPath,
      credentialInventoryPath: FIXED_PATHS.credentialInventoryPath,
      tuplePath: files.tuplePath,
      candidateBindingPath: files.candidateBindingPath,
      descriptorBindingPath: files.descriptorBindingPath,
      backendComponentManifestPath: componentInput.path,
      lifecycleContractPath: FIXED_PATHS.lifecycleContractPath,
      activationReceiptSchemaPath: FIXED_PATHS.activationReceiptSchemaPath,
      runtimeInputInventoryPath: FIXED_PATHS.runtimeInputInventoryPath,
      platformRevision: input.platformRevision,
    });
    if (!matches(envelope?.envelopeSha256, DIGEST)) {
      throw new Error("invalid deployment envelope projection");
    }
    await writeExclusive(files.envelopePath, pretty(envelope));

    const generatedAt = adapters.now().toISOString();
    const request = {
      schemaVersion: "PLATFORM_FIXED_HOST_ACTIVATION_REQUEST_V1",
      artifactKind: "platform-fixed-host-activation-request",
      operationDirectory: input.operationDirectory,
      operationId: envelope.envelopeSha256,
      deployRoot: input.deployRoot,
      runUrl: input.runUrl,
      generatedAt,
      bindingPath: files.candidateBindingPath,
      descriptorBindingPath: files.descriptorBindingPath,
      tuplePath: files.tuplePath,
      descriptorPath: files.descriptorPath,
      composeEnvPath: files.composeEnvPath,
      backendEnvPath: files.backendEnvPath,
      projectName: input.projectName,
      nginxConfigPath: "/etc/nginx/sites-available/easysubway",
      baseComposePath: files.baseComposePath,
      candidateComposePath: files.candidateComposePath,
      candidateGeneration: 1,
      trafficGeneration: input.trafficGeneration,
      canary: await readCanaryPolicy(),
    };
    await writeExclusive(input.requestOutputPath, pretty(request));

    return {
      schemaVersion: "PLATFORM_SOURCE_FREE_FIXED_HOST_PREPARATION_V1",
      artifactKind: "platform-source-free-fixed-host-preparation",
      mode: input.mode,
      envelopeSha256: envelope.envelopeSha256,
      tupleSha256: tuple.tupleSha256,
      descriptorSha256: descriptor.descriptorSha256,
      requestSha256: digest(pretty(request)),
      requestPath: input.requestOutputPath,
      externalMutationCount: 0,
    };
  } catch (error) {
    if (error instanceof SourceFreePreparationError) throw error;
    throw new SourceFreePreparationError(
      error?.code === "EEXIST"
        ? "SOURCE_FREE_PREPARE_OUTPUT"
        : "SOURCE_FREE_PREPARE_INPUT",
      1,
      { cause: error },
    );
  }
}

function validateInvocation(input, dependencies) {
  if (
    !isObject(input) || !["PREVIEW", "DEPLOY"].includes(input.mode) ||
    ![
      input.backendArtifactRoot,
      input.dataArtifactRoot,
      input.admissionReceiptPath,
      input.composeEnvPath,
      input.backendEnvPath,
      input.deployRoot,
      input.outputRoot,
      input.operationDirectory,
      input.requestOutputPath,
    ].every(validAbsolutePath) ||
    !isStrictDescendant(input.deployRoot, input.outputRoot) ||
    !isStrictDescendant(input.deployRoot, input.operationDirectory) ||
    !matches(input.platformRevision, REVISION) ||
    !matches(input.backendProducerGitSha, REVISION) ||
    !matches(input.dataProducerGitSha, REVISION) ||
    !matches(input.runUrl, RUN_URL) ||
    !matches(input.projectName, SAFE_PROJECT) ||
    !Number.isSafeInteger(input.trafficGeneration) || input.trafficGeneration < 1 ||
    !isObject(dependencies) ||
    Object.values(dependencies).some((dependency) => typeof dependency !== "function")
  ) throw new SourceFreePreparationError("SOURCE_FREE_PREPARE_USAGE", 2);
}

async function createOutputRoot(deployRoot, outputRoot) {
  const parent = path.dirname(outputRoot);
  for (const candidate of [deployRoot, parent]) {
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("invalid output parent");
    }
  }
  await mkdir(outputRoot, { mode: 0o700 });
  const created = await lstat(outputRoot);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error("invalid output root");
  }
}

async function findArtifactInput(root, fileName) {
  const absoluteRoot = path.resolve(root);
  const rootEntry = await lstat(absoluteRoot);
  if (
    absoluteRoot !== root || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()
  ) throw new Error("invalid artifact root");
  const matches = [];
  let visited = 0;
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ARTIFACT_ENTRIES || entry.isSymbolicLink()) {
        throw new Error("invalid artifact inventory");
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === fileName) matches.push(candidate);
    }
  }
  if (matches.length !== 1) throw new Error("artifact file must be exact-one");
  return { path: matches[0], bytes: await readStableFile(matches[0]) };
}

async function readStableFile(filePath) {
  const before = await lstat(filePath, { bigint: true });
  if (
    !before.isFile() || before.isSymbolicLink() || before.size < 1n ||
    before.size > BigInt(MAX_INPUT_BYTES)
  ) throw new Error("invalid immutable input file");
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const bytes = await handle.readFile();
    const descriptor = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    if (
      !descriptor.isFile() || !after.isFile() || after.isSymbolicLink() ||
      descriptor.dev !== before.dev || descriptor.ino !== before.ino ||
      descriptor.size !== before.size || descriptor.mtimeNs !== before.mtimeNs ||
      descriptor.ctimeNs !== before.ctimeNs || descriptor.dev !== after.dev ||
      descriptor.ino !== after.ino || descriptor.size !== after.size ||
      BigInt(bytes.length) !== after.size
    ) throw new Error("unstable immutable input file");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath, bytes) {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o400);
}

function validateBackendComponent(bytes) {
  const value = parseJson(bytes);
  if (
    !bytes.equals(pretty(value)) ||
    !exactKeys(value, [
      "schemaVersion", "component", "repository", "gitSha",
      "artifactIdentity", "contractVersion", "evidenceSha256", "issueRefs",
    ]) ||
    value.schemaVersion !== 1 || value.component !== "backend" ||
    value.repository !== "AquilaXk/easysubway-backend" ||
    !matches(value.gitSha, REVISION) ||
    !exactKeys(value.artifactIdentity, ["imageDigest", "apiContractVersion"]) ||
    !matches(value.artifactIdentity.imageDigest, DIGEST) ||
    value.artifactIdentity.apiContractVersion !== value.contractVersion ||
    typeof value.contractVersion !== "string" || value.contractVersion.length < 1 ||
    !matches(value.evidenceSha256, RAW_DIGEST) ||
    !Array.isArray(value.issueRefs) || value.issueRefs.length < 1
  ) throw new Error("invalid Backend component manifest");
  return value;
}

function validateContractReceipt(bytes, backendRevision) {
  const value = parseJson(bytes);
  if (
    !bytes.equals(compact(value)) ||
    !exactKeys(value, [
      "schemaVersion", "component", "bundleVersion", "producer", "artifact",
      "payload",
    ]) ||
    value.schemaVersion !== 1 || value.component !== "backend" ||
    value.bundleVersion !== "2.0.0" ||
    !exactKeys(value.producer, ["repository", "gitSha"]) ||
    value.producer.repository !== "AquilaXk/easysubway-backend" ||
    value.producer.gitSha !== backendRevision ||
    !exactKeys(value.artifact, ["repository", "manifestDigest", "artifactType"]) ||
    value.artifact.repository !== "ghcr.io/aquilaxk/easysubway-backend-contracts" ||
    !matches(value.artifact.manifestDigest, DIGEST) ||
    value.artifact.artifactType !==
      "application/vnd.easysubway.journey.contract-bundle.v2" ||
    !exactKeys(value.payload, ["fileName", "mediaType", "sha256"]) ||
    value.payload.fileName !== "journey-v3-contract-bundle-v2.json" ||
    value.payload.mediaType !==
      "application/vnd.easysubway.journey.contract-bundle.v2+json" ||
    !matches(value.payload.sha256, RAW_DIGEST)
  ) throw new Error("invalid Backend contract publication receipt");
  return value;
}

function createJourneyReleaseTuple(values) {
  if (
    !matches(values.backendImageDigest, DIGEST) ||
    !matches(values.backendConfigDigest, DIGEST) ||
    !matches(values.journeyContractDigest, DIGEST) ||
    !matches(values.serverRouteBundleDigest, DIGEST) ||
    !matches(values.deploymentRevision, REVISION)
  ) throw new Error("invalid Journey release tuple identity");
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: values.backendImageDigest,
    backendConfigDigest: values.backendConfigDigest,
    journeyContractDigest: values.journeyContractDigest,
    serverRouteBundleDigest: values.serverRouteBundleDigest,
    deploymentRevision: values.deploymentRevision,
    environmentIdentity: "production",
  };
  return {
    ...tuple,
    tupleSha256: digest(Buffer.from(`${[
      tuple.backendImageDigest,
      tuple.backendConfigDigest,
      tuple.journeyContractDigest,
      tuple.serverRouteBundleDigest,
      tuple.deploymentRevision,
      tuple.environmentIdentity,
    ].join("\n")}\n`, "utf8")),
  };
}

async function readCanaryPolicy() {
  const bytes = await readStableFile(FIXED_PATHS.canaryPolicyPath);
  const value = parseJson(bytes);
  if (
    !bytes.equals(pretty(value)) ||
    !exactKeys(value, [
      "schemaVersion", "artifactKind", "canaryRequestIdentity", "requestId",
      "originStationId", "destinationStationId", "mobilityProfile",
      "constraintMode", "maxTransfers", "alternativeCount",
    ]) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANARY_POLICY_V1" ||
    value.artifactKind !== "platform-journey-canary-policy" ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.requestId) ||
    value.originStationId === value.destinationStationId ||
    value.mobilityProfile !== "STANDARD" || value.constraintMode !== "NONE" ||
    value.maxTransfers !== 3 || value.alternativeCount !== 3
  ) throw new Error("invalid Journey canary policy");
  const { schemaVersion, artifactKind, ...canary } = value;
  void schemaVersion;
  void artifactKind;
  return canary;
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid JSON input");
  }
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length &&
    keys.every((key, index) => Object.keys(value)[index] === key);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function validAbsolutePath(value) {
  return typeof value === "string" && value.length > 1 && path.resolve(value) === value;
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compact(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function pretty(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseCliArguments(args) {
  const fields = new Map([
    ["--mode", "mode"],
    ["--backend-artifact-root", "backendArtifactRoot"],
    ["--data-artifact-root", "dataArtifactRoot"],
    ["--admission-receipt", "admissionReceiptPath"],
    ["--compose-env", "composeEnvPath"],
    ["--backend-env", "backendEnvPath"],
    ["--deploy-root", "deployRoot"],
    ["--output-root", "outputRoot"],
    ["--operation-directory", "operationDirectory"],
    ["--request-output", "requestOutputPath"],
    ["--backend-producer-sha", "backendProducerGitSha"],
    ["--data-producer-sha", "dataProducerGitSha"],
    ["--platform-revision", "platformRevision"],
    ["--traffic-generation", "trafficGeneration"],
    ["--run-url", "runUrl"],
    ["--project-name", "projectName"],
  ]);
  if (args.length !== fields.size * 2) {
    throw new SourceFreePreparationError("SOURCE_FREE_PREPARE_USAGE", 2);
  }
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = fields.get(args[index]);
    const value = args[index + 1];
    if (!field || Object.hasOwn(result, field) || !value || value.startsWith("--")) {
      throw new SourceFreePreparationError("SOURCE_FREE_PREPARE_USAGE", 2);
    }
    result[field] = value;
  }
  if (!/^[1-9][0-9]*$/.test(result.trafficGeneration)) {
    throw new SourceFreePreparationError("SOURCE_FREE_PREPARE_USAGE", 2);
  }
  result.trafficGeneration = Number(result.trafficGeneration);
  return result;
}

async function main() {
  const result = await prepareSourceFreeFixedHostDeployment(
    parseCliArguments(process.argv.slice(2)),
  );
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
  main().catch((error) => {
    const failure = error instanceof SourceFreePreparationError
      ? error
      : new SourceFreePreparationError("SOURCE_FREE_PREPARE_INPUT", 1, {
        cause: error,
      });
    process.stderr.write(`${failure.code} ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  });
}
