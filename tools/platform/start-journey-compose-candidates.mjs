#!/usr/bin/env node

import { createHash, createPublicKey } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AcquisitionError,
  inspectServerRouteBundlePublicationDescriptor,
} from "./acquire-server-route-bundle.mjs";
import {
  validateJourneyReleaseTupleBytes,
} from "./bind-journey-release-candidate.mjs";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMPOSE_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 1000;
const SHARED_LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_DEPLOY_ROOT = "/opt/easysubway";
const SHARED_LOCK_HOLDER_ARGUMENT = "--hold-shared-deploy-lock";
const SHARED_LOCK_READY = "EASYSUBWAY_STANDBY_LOCKED\n";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]{1,255}$/;
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SERVICES = Object.freeze(["backend-standby"]);
const DOCKER_OPERATIONAL_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
  "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY",
  "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
]);
const BINDING_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "orchestrator", "tupleSha256",
  "deploymentRevision", "environmentIdentity", "descriptorSha256",
  "serverRouteBundleDigest",
]);
const DESCRIPTOR_BINDING_FIELDS = Object.freeze([
  "schemaVersion", "artifactKind", "descriptorSha256", "producerGitSha",
  "tupleSha256", "serverRouteBundleDigest",
]);
const ERROR_MESSAGES = Object.freeze({
  CANDIDATE_START_USAGE: "expected exact candidate start arguments",
  CANDIDATE_START_INPUT: "candidate start input validation failed",
  CANDIDATE_START_IDENTITY: "candidate start identity validation failed",
  CANDIDATE_START_SECRET: "candidate start secret validation failed",
  CANDIDATE_START_EXISTS: "candidate runtime already exists",
  CANDIDATE_START_LOCKED: "candidate start operation is already running",
  CANDIDATE_START_COMPOSE: "candidate compose start failed",
  CANDIDATE_START_TIMEOUT: "candidate compose start timed out",
  CANDIDATE_START_INPUT_UNSTABLE: "candidate start input changed during execution",
});
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIR, "../..");
const BASE_COMPOSE_PATH = resolve(REPOSITORY_ROOT, "infra/docker-compose.yml");
const CANDIDATE_COMPOSE_PATH = resolve(
  REPOSITORY_ROOT,
  "infra/docker-compose.journey-candidate.yml",
);

export class CandidateStartError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "candidate start failed");
    this.name = "CandidateStartError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function startJourneyComposeCandidates({
  bindingPath,
  descriptorBindingPath,
  tuplePath,
  descriptorPath,
  composeEnvPath,
  backendEnvPath,
  projectName,
  operationId,
  trafficGeneration,
  serviceToken,
  currentPublicKeyPem,
  ambientEnvironment = process.env,
  candidateEnvironmentConsumer,
  inspectDescriptor = inspectServerRouteBundlePublicationDescriptor,
  composeRunner = runCompose,
  deployLockRunner = acquireSharedDeployLock,
}) {
  validateInvocation({
    bindingPath,
    descriptorBindingPath,
    tuplePath,
    descriptorPath,
    composeEnvPath,
    backendEnvPath,
    projectName,
    operationId,
    trafficGeneration,
    serviceToken,
    currentPublicKeyPem,
    ambientEnvironment,
    candidateEnvironmentConsumer,
    inspectDescriptor,
    composeRunner,
    deployLockRunner,
  });

  const deployLock = await openSharedDeployLock(
    deployLockRunner,
    sharedDeployLockPath(ambientEnvironment),
    ambientEnvironment,
  );
  let operationLock;
  const inputs = [];
  let executionEnvironment;
  try {
    operationLock = await CandidateStartLock.acquire(projectName, operationId);
    inputs.push(...await openStableInputs([
      bindingPath,
      descriptorBindingPath,
      tuplePath,
      descriptorPath,
      composeEnvPath,
      backendEnvPath,
    ]));
    const [
      bindingInput,
      descriptorBindingInput,
      tupleInput,
      descriptorInput,
      composeEnvInput,
      backendEnvInput,
    ] = inputs;
    const tuple = validateTuple(tupleInput.bytes);
    const binding = validateBinding(bindingInput.bytes, tuple);
    const descriptorBinding = validateDescriptorBinding(
      descriptorBindingInput.bytes,
      tuple,
    );
    if (binding.descriptorSha256 !== descriptorBinding.descriptorSha256) {
      throw failure("CANDIDATE_START_IDENTITY", 2);
    }
    const descriptorFacts = validateDescriptor(
      descriptorInput.bytes,
      descriptorBinding,
      tuple,
      inspectDescriptor,
    );
    if (sha256Reference(backendEnvInput.bytes) !== tuple.backendConfigDigest) {
      throw failure("CANDIDATE_START_IDENTITY", 2);
    }
    validateCandidateComposeEnvironment(composeEnvInput.bytes);
    executionEnvironment = await materializeEnvironmentFiles(
      composeEnvInput.bytes,
      backendEnvInput.bytes,
    );
    const env = candidateEnvironment({
      tuple,
      descriptorBytes: descriptorInput.bytes,
      descriptorFacts,
      backendEnvPath: executionEnvironment.backendEnvPath,
      operationId,
      trafficGeneration,
      serviceToken,
      currentPublicKeyPem,
      ambientEnvironment,
    });
    candidateEnvironmentConsumer?.(Object.freeze({ ...env }));
    const prefix = [
      "compose",
      "--project-name", projectName,
      "--env-file", executionEnvironment.composeEnvPath,
      "-f", BASE_COMPOSE_PATH,
      "-f", CANDIDATE_COMPOSE_PATH,
      "--profile", "journey-candidate",
    ];

    await deployLock.verify();
    await verifyExecutionInputs(inputs, executionEnvironment);
    const existing = await invokeCompose(composeRunner, {
      command: "docker",
      args: [...prefix, "ps", "--all", "--quiet", ...SERVICES],
      env,
      timeoutMs: COMPOSE_TIMEOUT_MS,
    });
    if (!successful(existing)) throw failure(composeFailureCode(existing));
    if (existing.stdout.trim().length > 0) throw failure("CANDIDATE_START_EXISTS", 2);

    try {
      await deployLock.verify();
      await verifyExecutionInputs(inputs, executionEnvironment);
      const result = await invokeCompose(composeRunner, {
        command: "docker",
        args: [
          ...prefix,
          "up", "--detach", "--no-deps", "--no-build", "--pull", "always",
          ...SERVICES,
        ],
        env,
        timeoutMs: COMPOSE_TIMEOUT_MS,
      });
      if (!successful(result)) throw failure(composeFailureCode(result));
      await deployLock.verify();
      await verifyExecutionInputs(inputs, executionEnvironment);
    } catch (error) {
      try {
        await deployLock.verify();
        await cleanupCandidates(composeRunner, prefix, env);
      } catch {
        // Never touch the shared standby after losing the deploy lock.
      }
      if (error instanceof CandidateStartError) throw error;
      throw failure("CANDIDATE_START_COMPOSE");
    }

    return candidateRuntime();
  } finally {
    await executionEnvironment?.close();
    for (const input of inputs.reverse()) await input.close();
    await operationLock?.close();
    await deployLock.close();
  }
}

export function formatCandidateRuntime(runtime) {
  return `${JSON.stringify(runtime, null, 2)}\n`;
}

function validateInvocation(values) {
  if (
    ![
      values.bindingPath,
      values.descriptorBindingPath,
      values.tuplePath,
      values.descriptorPath,
      values.composeEnvPath,
      values.backendEnvPath,
    ].every(isNonemptyString) ||
    !matches(values.projectName, SAFE_PROJECT) ||
    !matches(values.operationId, DIGEST) ||
    !Number.isSafeInteger(values.trafficGeneration) ||
    values.trafficGeneration < 1 ||
    typeof values.inspectDescriptor !== "function" ||
    typeof values.composeRunner !== "function" ||
    typeof values.deployLockRunner !== "function" ||
    (values.candidateEnvironmentConsumer !== undefined &&
      typeof values.candidateEnvironmentConsumer !== "function") ||
    values.ambientEnvironment === null ||
    typeof values.ambientEnvironment !== "object" ||
    Array.isArray(values.ambientEnvironment)
  ) {
    throw failure("CANDIDATE_START_USAGE", 2);
  }
  validateSecrets(values.serviceToken, values.currentPublicKeyPem);
}

function validateCandidateComposeEnvironment(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
  const assignments = new Map([
    ["EASYSUBWAY_BACKEND_BIND", []],
    ["EASYSUBWAY_BACKEND_STANDBY_PORT", []],
  ]);
  const targetAssignment = /^\s*(?:export\s+)?(EASYSUBWAY_BACKEND_BIND|EASYSUBWAY_BACKEND_STANDBY_PORT)\s*=/;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const match = line.match(targetAssignment);
    if (match) assignments.get(match[1]).push(line);
  }
  if (
    !validOptionalAssignment(
      assignments.get("EASYSUBWAY_BACKEND_BIND"),
      "EASYSUBWAY_BACKEND_BIND=127.0.0.1",
    ) ||
    !validOptionalAssignment(
      assignments.get("EASYSUBWAY_BACKEND_STANDBY_PORT"),
      "EASYSUBWAY_BACKEND_STANDBY_PORT=8082",
    )
  ) {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
}

function validOptionalAssignment(lines, expected) {
  return lines.length === 0 || (lines.length === 1 && lines[0] === expected);
}

function sharedDeployLockPath(ambientEnvironment) {
  const deployRoot = ambientEnvironment.DEPLOY_ROOT ?? DEFAULT_DEPLOY_ROOT;
  if (
    !isNonemptyString(deployRoot) ||
    resolve(deployRoot) !== deployRoot ||
    deployRoot === "/"
  ) {
    throw failure("CANDIDATE_START_USAGE", 2);
  }
  return join(deployRoot, "deploy.lock");
}

async function openSharedDeployLock(runner, lockPath, ambientEnvironment) {
  try {
    const lock = await runner({ lockPath, ambientEnvironment });
    if (
      lock === null ||
      typeof lock !== "object" ||
      typeof lock.verify !== "function" ||
      typeof lock.close !== "function"
    ) {
      throw new Error("invalid deploy lock");
    }
    await lock.verify();
    return lock;
  } catch {
    throw failure("CANDIDATE_START_LOCKED", 2);
  }
}

function acquireSharedDeployLock({ lockPath, ambientEnvironment }) {
  return new Promise((resolveLock, rejectLock) => {
    const child = spawn(
      "/usr/bin/flock",
      [
        "--nonblock",
        "--exclusive",
        lockPath,
        process.execPath,
        fileURLToPath(import.meta.url),
        SHARED_LOCK_HOLDER_ARGUMENT,
      ],
      {
        env: dockerOperationalEnvironment(ambientEnvironment),
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const lock = new SharedDeployLock(child);
    let output = "";
    let settled = false;
    const timer = setTimeout(() => fail(), SHARED_LOCK_ACQUIRE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (!SHARED_LOCK_READY.startsWith(output)) {
        fail();
        return;
      }
      if (output === SHARED_LOCK_READY) {
        settled = true;
        clearTimeout(timer);
        resolveLock(lock);
      }
    });
    child.once("error", fail);
    child.once("close", () => {
      if (!settled) fail();
    });

    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill("SIGTERM");
      rejectLock(new Error("shared deploy lock unavailable"));
    }
  });
}

class SharedDeployLock {
  constructor(child) {
    this.child = child;
    this.active = true;
    this.closed = new Promise((resolveClosed) => {
      child.once("close", () => {
        this.active = false;
        resolveClosed();
      });
    });
  }

  async verify() {
    if (!this.active || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw failure("CANDIDATE_START_LOCKED", 2);
    }
  }

  async close() {
    if (!this.active) return;
    this.child.stdin.end();
    const closed = await Promise.race([
      this.closed.then(() => true),
      new Promise((resolveClosed) => setTimeout(
        () => resolveClosed(false),
        FORCE_KILL_GRACE_MS,
      )),
    ]);
    if (!closed && this.active) {
      this.child.kill("SIGKILL");
      await this.closed;
    }
  }
}

function validateSecrets(serviceToken, currentPublicKeyPem) {
  if (
    typeof serviceToken !== "string" ||
    serviceToken.length < 32 ||
    serviceToken.length > 512 ||
    [...serviceToken].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x21 || codePoint === 0x7f;
    }) ||
    typeof currentPublicKeyPem !== "string" ||
    currentPublicKeyPem.length < 256 ||
    currentPublicKeyPem.length > 8192 ||
    currentPublicKeyPem.includes("\r") ||
    !currentPublicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n") ||
    !currentPublicKeyPem.endsWith("-----END PUBLIC KEY-----\n")
  ) {
    throw failure("CANDIDATE_START_SECRET", 2);
  }
  try {
    const key = createPublicKey(currentPublicKeyPem);
    if (key.asymmetricKeyType !== "rsa") throw new Error("unexpected key type");
  } catch {
    throw failure("CANDIDATE_START_SECRET", 2);
  }
}

class CandidateStartLock {
  static async acquire(projectName, operationId) {
    const path = join(
      tmpdir(),
      `.easysubway-journey-candidate-${projectName}.lock`,
    );
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${operationId}\n`, "utf8");
      await handle.sync();
      const identity = await handle.stat({ bigint: true });
      if (!identity.isFile()) throw new Error("lock is not regular");
      return new CandidateStartLock(handle, path, identity);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (handle) await unlink(path).catch(() => {});
      if (error?.code === "EEXIST") {
        throw failure("CANDIDATE_START_LOCKED", 2);
      }
      throw failure("CANDIDATE_START_INPUT", 2);
    }
  }

  constructor(handle, path, identity) {
    this.handle = handle;
    this.path = path;
    this.identity = identity;
    this.closed = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const descriptor = await this.handle.stat({ bigint: true });
      const entry = await lstat(this.path, { bigint: true });
      if (
        descriptor.isFile() &&
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        identitiesMatch(this.identity, descriptor, entry)
      ) {
        await unlink(this.path);
      }
    } catch {
      // A changed lock is preserved rather than deleting an unowned entry.
    } finally {
      await this.handle.close().catch(() => {});
    }
  }
}

async function materializeEnvironmentFiles(composeBytes, backendBytes) {
  const root = await mkdtemp(join(tmpdir(), "easysubway-journey-candidate-env-"));
  const composeEnvPath = join(root, "compose.env");
  const backendEnvPath = join(root, "backend.env");
  let stableInputs = [];
  try {
    await chmod(root, 0o700);
    await writeProtectedFile(composeEnvPath, composeBytes);
    await writeProtectedFile(backendEnvPath, backendBytes);
    stableInputs = await openStableInputs([composeEnvPath, backendEnvPath]);
    await chmod(root, 0o500);
    return new MaterializedEnvironment(
      root,
      composeEnvPath,
      backendEnvPath,
      stableInputs,
    );
  } catch (error) {
    for (const input of stableInputs.reverse()) await input.close();
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    if (error instanceof CandidateStartError) throw error;
    throw failure("CANDIDATE_START_INPUT", 2);
  }
}

async function writeProtectedFile(path, bytes) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  await chmod(path, 0o400);
}

class MaterializedEnvironment {
  constructor(root, composeEnvPath, backendEnvPath, stableInputs) {
    this.root = root;
    this.composeEnvPath = composeEnvPath;
    this.backendEnvPath = backendEnvPath;
    this.stableInputs = stableInputs;
    this.closed = false;
  }

  async verify() {
    await verifyInputs(this.stableInputs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const input of this.stableInputs.reverse()) await input.close();
    await chmod(this.root, 0o700).catch(() => {});
    await rm(this.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function openStableInputs(paths) {
  const loaded = [];
  try {
    for (const path of paths) {
      const absolutePath = resolve(path);
      const handle = await open(
        absolutePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let identity;
      let bytes;
      try {
        identity = await handle.stat({ bigint: true });
        if (!validInputIdentity(identity)) {
          throw failure("CANDIDATE_START_INPUT", 2);
        }
        bytes = await handle.readFile();
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
      const input = new StableInput(handle, absolutePath, identity, bytes);
      loaded.push(input);
      await input.verify();
    }
    return loaded;
  } catch (error) {
    for (const input of loaded.reverse()) await input.close();
    if (error instanceof CandidateStartError) throw error;
    throw failure("CANDIDATE_START_INPUT", 2);
  }
}

class StableInput {
  constructor(handle, path, identity, bytes) {
    this.handle = handle;
    this.path = path;
    this.identity = identity;
    this.bytes = bytes;
  }

  async verify() {
    let currentDescriptor;
    let currentEntry;
    try {
      currentDescriptor = await this.handle.stat({ bigint: true });
      currentEntry = await lstat(this.path, { bigint: true });
    } catch {
      throw failure("CANDIDATE_START_INPUT_UNSTABLE");
    }
    if (
      BigInt(this.bytes.length) !== this.identity.size ||
      currentEntry.isSymbolicLink() ||
      !validInputIdentity(currentDescriptor) ||
      !validInputIdentity(currentEntry) ||
      !identitiesMatch(this.identity, currentDescriptor, currentEntry)
    ) {
      throw failure("CANDIDATE_START_INPUT_UNSTABLE");
    }
  }

  close() {
    return this.handle.close().catch(() => {});
  }
}

function validInputIdentity(identity) {
  return identity.isFile() &&
    identity.size > 0n &&
    identity.size <= BigInt(MAX_INPUT_BYTES);
}

function identitiesMatch(reference, ...candidates) {
  const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
  return candidates.every((candidate) =>
    fields.every((field) => candidate[field] === reference[field]));
}

function validateTuple(bytes) {
  try {
    return validateJourneyReleaseTupleBytes(bytes);
  } catch {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
}

function validateBinding(bytes, tuple) {
  const binding = parseJson(bytes);
  if (
    !isExactObject(binding, BINDING_FIELDS) ||
    binding.schemaVersion !== "JOURNEY_RELEASE_CANDIDATE_BINDING_V2" ||
    binding.artifactKind !== "journey-release-candidate-binding" ||
    binding.orchestrator !== "COMPOSE" ||
    !matches(binding.descriptorSha256, SHA256) ||
    binding.tupleSha256 !== tuple.tupleSha256 ||
    binding.deploymentRevision !== tuple.deploymentRevision ||
    binding.environmentIdentity !== tuple.environmentIdentity ||
    binding.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    !bytes.equals(Buffer.from(`${JSON.stringify(binding)}\n`))
  ) {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
  return binding;
}

function validateDescriptorBinding(bytes, tuple) {
  const binding = parseJson(bytes);
  if (
    !isExactObject(binding, DESCRIPTOR_BINDING_FIELDS) ||
    binding.schemaVersion !== "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1" ||
    binding.artifactKind !== "platform-server-route-bundle-descriptor-binding" ||
    !matches(binding.descriptorSha256, SHA256) ||
    !matches(binding.producerGitSha, GIT_SHA) ||
    binding.tupleSha256 !== tuple.tupleSha256 ||
    binding.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    !bytes.equals(Buffer.from(`${JSON.stringify(binding)}\n`))
  ) {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
  return binding;
}

function validateDescriptor(bytes, binding, tuple, inspectDescriptor) {
  let inspected;
  let descriptor;
  try {
    inspected = inspectDescriptor(bytes);
    descriptor = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof AcquisitionError) {
      throw failure("CANDIDATE_START_IDENTITY", 2);
    }
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
  const keyId = descriptor?.manifest?.keyId;
  const publicBaseUrl = descriptor?.publicationReceipt?.locator?.publicBaseUrl;
  if (
    inspected?.descriptorSha256 !== binding.descriptorSha256 ||
    inspected?.producerGitSha !== binding.producerGitSha ||
    inspected?.serverRouteBundleDigest !== binding.serverRouteBundleDigest ||
    inspected.serverRouteBundleDigest !== tuple.serverRouteBundleDigest ||
    !matches(keyId, SAFE_IDENTITY) ||
    !validPublicBaseUrl(publicBaseUrl)
  ) {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
  return { keyId, publicBaseUrl };
}

function validPublicBaseUrl(value) {
  if (!isNonemptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" &&
      url.hostname.length > 0;
  } catch {
    return false;
  }
}

function candidateEnvironment({
  tuple,
  descriptorBytes,
  descriptorFacts,
  backendEnvPath,
  operationId,
  trafficGeneration,
  serviceToken,
  currentPublicKeyPem,
  ambientEnvironment,
}) {
  return {
    ...dockerOperationalEnvironment(ambientEnvironment),
    EASYSUBWAY_BACKEND_ENV_FILE: backendEnvPath,
    EASYSUBWAY_BACKEND_IMAGE:
      `ghcr.io/aquilaxk/easysubway-backend@${tuple.backendImageDigest}`,
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_DESCRIPTOR_BASE64:
      descriptorBytes.toString("base64"),
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_ACTIVATION_REQUEST_IDENTITY:
      operationId,
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_TRUSTED_RAW_DESCRIPTOR_BASE_URL:
      descriptorFacts.publicBaseUrl,
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_KEY_ID:
      descriptorFacts.keyId,
    EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_PUBLIC_KEY_PEM:
      currentPublicKeyPem,
    EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN: serviceToken,
    EASYSUBWAY_JOURNEY_V3_READINESS_RELEASE_TUPLE_SHA256:
      tuple.tupleSha256.slice("sha256:".length),
    EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST:
      tuple.backendImageDigest,
    EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_CONFIG_SHA256:
      tuple.backendConfigDigest.slice("sha256:".length),
    EASYSUBWAY_JOURNEY_V3_READINESS_JOURNEY_CONTRACT_SHA256:
      tuple.journeyContractDigest.slice("sha256:".length),
    EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION:
      String(trafficGeneration),
  };
}

function dockerOperationalEnvironment(ambientEnvironment) {
  return Object.fromEntries(
    DOCKER_OPERATIONAL_ENV_KEYS
      .filter((key) => typeof ambientEnvironment[key] === "string")
      .map((key) => [key, ambientEnvironment[key]]),
  );
}

function sha256Reference(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function verifyInputs(inputs) {
  for (const input of inputs) await input.verify();
}

async function verifyExecutionInputs(inputs, executionEnvironment) {
  await verifyInputs(inputs);
  await executionEnvironment.verify();
}

async function invokeCompose(composeRunner, request) {
  try {
    const result = await composeRunner(request);
    if (
      result === null ||
      typeof result !== "object" ||
      !(result.status === null || Number.isInteger(result.status)) ||
      !(result.signal === null || typeof result.signal === "string") ||
      typeof result.timedOut !== "boolean" ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string"
    ) {
      throw new Error("invalid compose result");
    }
    return result;
  } catch (error) {
    if (error instanceof CandidateStartError) throw error;
    throw failure("CANDIDATE_START_COMPOSE");
  }
}

function successful(result) {
  return !result.timedOut && result.status === 0 && result.signal === null;
}

function composeFailureCode(result) {
  return result.timedOut ? "CANDIDATE_START_TIMEOUT" : "CANDIDATE_START_COMPOSE";
}

async function cleanupCandidates(composeRunner, prefix, env) {
  try {
    await composeRunner({
      command: "docker",
      args: [...prefix, "rm", "--force", "--stop", ...SERVICES],
      env,
      timeoutMs: COMPOSE_TIMEOUT_MS,
    });
  } catch {
    // The original typed failure remains authoritative.
  }
}

function candidateRuntime() {
  return {
    schemaVersion: "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1",
    artifactKind: "journey-compose-candidate-runtime",
    orchestrator: "COMPOSE",
    instances: [
      {
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        baseUrl: "http://127.0.0.1:8082",
      },
    ],
  };
}

export function runComposeForTest(request) {
  return runCompose(request);
}

function runCompose({
  command,
  args,
  env,
  timeoutMs,
  forceKillGraceMs = FORCE_KILL_GRACE_MS,
}) {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    let forcedSettlementTimer;
    const child = spawn(command, args, {
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateChildGroup(child, "SIGKILL");
        forcedSettlementTimer = setTimeout(
          () => finish(null, "SIGKILL"),
          forceKillGraceMs,
        );
      }, forceKillGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    });
    child.on("error", () => finish(null, null));
    child.on("close", (status, signal) => finish(status, signal));

    function finish(status, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(forcedSettlementTimer);
      resolveResult({ status, signal, timedOut, stdout, stderr });
    }
  });
}

function terminateChildGroup(child, signal) {
  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to the direct child signal.
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between timeout and signal delivery.
  }
}

function parseJson(bytes) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("object required");
    }
    return value;
  } catch {
    throw failure("CANDIDATE_START_IDENTITY", 2);
  }
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

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function failure(code, exitCode = 1) {
  return new CandidateStartError(code, exitCode);
}

function parseCliArguments(args) {
  const flags = new Set([
    "--binding",
    "--descriptor-binding",
    "--tuple",
    "--descriptor",
    "--compose-env",
    "--backend-env",
    "--project-name",
    "--operation-id",
    "--traffic-generation",
  ]);
  if (args.length !== flags.size * 2) throw failure("CANDIDATE_START_USAGE", 2);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flags.has(flag) || values.has(flag) || !isNonemptyString(value) || value.startsWith("--")) {
      throw failure("CANDIDATE_START_USAGE", 2);
    }
    values.set(flag, value);
  }
  return {
    bindingPath: values.get("--binding"),
    descriptorBindingPath: values.get("--descriptor-binding"),
    tuplePath: values.get("--tuple"),
    descriptorPath: values.get("--descriptor"),
    composeEnvPath: values.get("--compose-env"),
    backendEnvPath: values.get("--backend-env"),
    projectName: values.get("--project-name"),
    operationId: values.get("--operation-id"),
    trafficGeneration: Number(values.get("--traffic-generation")),
    serviceToken: process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
    currentPublicKeyPem: process.env.EASYSUBWAY_JOURNEY_CURRENT_PUBLIC_KEY_PEM,
  };
}

async function main() {
  const runtime = await startJourneyComposeCandidates(
    parseCliArguments(process.argv.slice(2)),
  );
  process.stdout.write(formatCandidateRuntime(runtime));
}

async function holdSharedDeployLock() {
  process.stdout.write(SHARED_LOCK_READY);
  process.stdin.resume();
  await new Promise((resolveEnd) => {
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      resolveEnd();
    };
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
  });
}

if (isMainModule()) {
  const lockHolder = process.argv.length === 3 &&
    process.argv[2] === SHARED_LOCK_HOLDER_ARGUMENT;
  const entrypoint = lockHolder ? holdSharedDeployLock : main;
  entrypoint().catch((error) => {
    const typed = error instanceof CandidateStartError
      ? error
      : failure("CANDIDATE_START_COMPOSE");
    process.stderr.write(`${typed.code} ${typed.message}\n`);
    process.exitCode = typed.exitCode;
  });
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
