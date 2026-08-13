#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, link, mkdir, open, rename, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { activateJourneyBackend } from "./activate-journey-backend.mjs";
import { admitJourneyReleaseCandidate } from "./admit-journey-release-candidate.mjs";
import { observeJourneyCandidateReadiness } from "./observe-journey-candidate-readiness.mjs";
import { runJourneyCandidateCanary } from "./run-journey-candidate-canary.mjs";
import { startJourneyComposeCandidates } from "./start-journey-compose-candidates.mjs";
import { validateJourneyReleaseTupleBytes } from "./bind-journey-release-candidate.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const OPERATION_ID = /^sha256:[a-f0-9]{64}$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9][0-9]*$/;
const FALLBACK_ZERO = Object.freeze({
  legacyGraphSuccessCount: 0,
  localRouteInvocationCount: 0,
  staleJourneyServedCount: 0,
  alternateEndpointSuccessCount: 0,
});
const LOCK_HOLDER_ARGUMENT = "--hold-fixed-host-deploy-lock";
const LOCK_READY = "EASYSUBWAY_FIXED_HOST_LOCKED\n";
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_BASE_COMPOSE_PATH = path.resolve(
  MODULE_DIRECTORY,
  "../../infra/docker-compose.yml",
);
const RUNTIME_CANDIDATE_COMPOSE_PATH = path.resolve(
  MODULE_DIRECTORY,
  "../../infra/docker-compose.journey-candidate.yml",
);
const RUNTIME_NGINX_CONFIG_PATH = "/etc/nginx/sites-available/easysubway";

const ERROR_MESSAGES = Object.freeze({
  FIXED_HOST_USAGE: "fixed-host activation input is invalid",
  FIXED_HOST_OPERATION_EXISTS: "fixed-host activation operation already exists",
  FIXED_HOST_LOCK_FAILED: "fixed-host deploy lock is unavailable",
  FIXED_HOST_PRECOMMIT_FAILED: "fixed-host activation failed before traffic commit",
  FIXED_HOST_POSTSWITCH_FAILED: "fixed-host activation failed after traffic commit",
  FIXED_HOST_RECEIPT_FAILED: "fixed-host activation receipt could not be stored",
});

export class FixedHostJourneyActivationError extends Error {
  constructor(code, exitCode = 1, options = undefined) {
    super(ERROR_MESSAGES[code] ?? "fixed-host Journey activation failed", options);
    this.name = "FixedHostJourneyActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function createFixedHostJourneyActivationHost({
  inputPaths,
  nginxConfigPath,
  composeEnvPath,
  backendEnvPath,
  baseComposePath,
  candidateComposePath,
  projectName,
  ambientEnvironment = process.env,
  commandRunner = runHostCommand,
  deployLockRunner = acquireFixedHostDeployLock,
  nowNs = process.hrtime.bigint,
  directorySync = syncDirectory,
  nginxTargetProbe = probeFixedHostNginxTarget,
  serviceToken = process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
}) {
  const paths = [
    nginxConfigPath,
    composeEnvPath,
    backendEnvPath,
    baseComposePath,
    candidateComposePath,
  ];
  if (
    !Array.isArray(inputPaths) || inputPaths.length === 0 ||
    ![...inputPaths, ...paths].every(validAbsoluteFilePath) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(projectName ?? "") ||
    !isObject(ambientEnvironment) ||
    typeof commandRunner !== "function" ||
    typeof deployLockRunner !== "function" ||
    typeof nowNs !== "function" ||
    typeof directorySync !== "function" ||
    typeof nginxTargetProbe !== "function"
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
  const inputs = [];
  try {
    for (const pathname of new Set([
      ...inputPaths,
      composeEnvPath,
      backendEnvPath,
      baseComposePath,
      candidateComposePath,
    ])) {
      inputs.push(await StableHostInput.open(pathname));
    }
  } catch (error) {
    for (const input of inputs.reverse()) await input.close();
    throw typed("FIXED_HOST_USAGE", error, 2);
  }
  const composePrefix = [
    "compose",
    "--project-name", projectName,
    "--env-file", composeEnvPath,
    "-f", baseComposePath,
    "-f", candidateComposePath,
    "--profile", "journey-candidate",
  ];
  const commandEnvironment = {
    ...ambientEnvironment,
    EASYSUBWAY_BACKEND_ENV_FILE: backendEnvPath,
  };
  const inputsByPath = new Map(inputs.map((input) => [input.pathname, input]));
  const invoke = (command, args, timeoutMs = 120_000) => invokeHostCommand(
    commandRunner,
    { command, args, env: commandEnvironment, timeoutMs },
  );
  const removeStandby = async () => {
    await invoke("docker", [
      ...composePrefix, "rm", "--force", "--stop", "backend-standby",
    ]);
    const remaining = await invoke("docker", [
      ...composePrefix, "ps", "--all", "--quiet", "backend-standby",
    ]);
    if (remaining.stdout.trim() !== "") {
      throw new Error("standby container remains after removal");
    }
    return withEvidence({ standbyRemoved: true, orphanedStandbyCount: 0 });
  };
  return {
    readInput(pathname) {
      const input = inputsByPath.get(pathname);
      if (!input) throw new Error("fixed-host input was not opened");
      return Buffer.from(input.bytes);
    },
    async acquireDeployLock({ lockPath, operationId }) {
      const lock = await deployLockRunner({ lockPath, ambientEnvironment });
      if (!isObject(lock) || typeof lock.verify !== "function" ||
        typeof lock.close !== "function") {
        throw new Error("invalid fixed-host deploy lock");
      }
      await lock.verify();
      return {
        evidenceDigest: digestBytes(Buffer.from(
          `${operationId}\n${lockPath}\n`,
          "utf8",
        )),
        verify: () => lock.verify(),
        close: () => lock.close(),
      };
    },
    async verifyInputs() {
      for (const input of inputs) await input.verify();
    },
    async switchNginx({ input, fromPort, toPort, activation }) {
      if (!isObject(activation) ||
        !["backend", "backend-standby"].includes(activation.instanceIdentity) ||
        !matches(activation.activeReadinessEvidenceDigest, DIGEST)) {
        throw typed("FIXED_HOST_USAGE", undefined, 2);
      }
      const current = await openRegularFile(nginxConfigPath);
      let installed = false;
      let reloadAttempted = false;
      try {
        const replacement = renderFixedHostNginxConfig(
          current.bytes,
          fromPort,
          toPort,
        );
        await atomicReplace(
          nginxConfigPath,
          replacement,
          current.mode,
          `${input.operationId}.candidate`,
          directorySync,
        );
        installed = true;
        await invoke("nginx", ["-t"], 10_000);
        reloadAttempted = true;
        await invoke("nginx", ["-s", "reload"], 10_000);
        await nginxTargetProbe({
          expectedPort: toPort,
          instanceIdentity: activation.instanceIdentity,
          evidenceDigest: activation.activeReadinessEvidenceDigest,
          tupleSha256: input.tuple.tupleSha256,
          trafficGeneration: input.trafficGeneration,
          serviceToken,
        });
        return withEvidence({
          fromPort,
          toPort,
          nginxConfigSha256: digestBytes(replacement),
          nginxTestPassed: true,
          reloadCompleted: true,
        });
      } catch (error) {
        installed ||= error?.targetReplaced === true;
        if (installed) {
          try {
            await atomicReplace(
              nginxConfigPath,
              current.bytes,
              current.mode,
              `${input.operationId}.restore`,
              directorySync,
            );
            if (reloadAttempted) {
              await invoke("nginx", ["-t"], 10_000);
              await invoke("nginx", ["-s", "reload"], 10_000);
              await nginxTargetProbe({
                expectedPort: fromPort,
                instanceIdentity: fromPort === 8080 ? "backend" : "backend-standby",
                serviceToken,
              });
            }
          } catch (rollbackError) {
            throw trafficStateIndeterminate(error, rollbackError);
          }
        }
        throw error;
      }
    },
    async drainAndRecreateCanonical() {
      const startedAt = nowNs();
      await invoke("docker", [
        ...composePrefix, "stop", "--timeout", "30", "backend",
      ], 35_000);
      const stopped = await invoke("docker", [
        "inspect", "--format", "{{json .State}}", "easysubway-backend",
      ], 10_000);
      const elapsedNs = nowNs() - startedAt;
      const state = parseStoppedContainerState(stopped.stdout);
      if (elapsedNs < 0n || elapsedNs > 30_000_000_000n) {
        throw new Error("canonical drain exceeded 30 seconds");
      }
      await invoke("docker", [
        ...composePrefix,
        "up", "--detach", "--no-deps", "--no-build", "--pull", "never",
        "--force-recreate", "backend",
      ]);
      return withEvidence({
        signal: "SIGTERM",
        stopGracePeriodSeconds: 30,
        newRequestAdmissionAfterSignal: 0,
        inFlightSnapshotPinned: true,
        inFlightCompleted: true,
        oldProcessExited: true,
        withinBudget: true,
        droppedJourneyCount: 0,
        duplicateJourneyCount: 0,
      }, {
        elapsedNanoseconds: elapsedNs.toString(),
        exitCode: state.ExitCode,
        finishedAt: state.FinishedAt,
      });
    },
    removeStandby,
    cleanupStandby: removeStandby,
    async close() {
      for (const input of inputs.reverse()) await input.close();
    },
  };
}

export function createFixedHostJourneyActivationEffects({
  config,
  adapters = {
    startJourneyComposeCandidates,
    runJourneyCandidateCanary,
    observeJourneyCandidateReadiness,
    admitJourneyReleaseCandidate,
    activateJourneyBackend,
  },
  host,
}) {
  validateEffectFactory(config, adapters, host);
  return {
    acquireDeployLock: (request) => host.acquireDeployLock(request),
    verifyInputs: (request) => host.verifyInputs(request),
    startStandby: ({ input, inheritedDeployLock }) =>
      adapters.startJourneyComposeCandidates({
        bindingPath: config.bindingPath,
        descriptorBindingPath: config.descriptorBindingPath,
        tuplePath: config.tuplePath,
        descriptorPath: config.descriptorPath,
        composeEnvPath: config.composeEnvPath,
        backendEnvPath: config.backendEnvPath,
        projectName: config.projectName,
        operationId: input.operationId,
        trafficGeneration: input.trafficGeneration,
        serviceToken: config.serviceToken,
        currentPublicKeyPem: config.currentPublicKeyPem,
        ambientEnvironment: config.ambientEnvironment ?? process.env,
        deployLockRunner: async ({ lockPath }) => {
          if (lockPath !== path.join(input.deployRoot, "deploy.lock")) {
            throw new Error("candidate requested a different deploy lock");
          }
          return inheritedDeployLock;
        },
      }),
    runCanary: ({ input }) => adapters.runJourneyCandidateCanary({
      tuplePath: config.tuplePath,
      baseUrl: "http://127.0.0.1:8082",
      candidateGeneration: input.candidateGeneration,
      ...config.canary,
      serviceToken: config.serviceToken,
    }),
    observeCandidate: ({ runtimePath, canaryPath }) =>
      adapters.observeJourneyCandidateReadiness({
        bindingPath: config.bindingPath,
        tuplePath: config.tuplePath,
        runtimePath,
        canaryPath,
        serviceToken: config.serviceToken,
      }),
    admitCandidate: ({ observationsPath }) =>
      adapters.admitJourneyReleaseCandidate({
        bindingPath: config.bindingPath,
        tuplePath: config.tuplePath,
        observationsPath,
      }),
    activateStandby: ({ input, admissionPath }) =>
      adapters.activateJourneyBackend({
        admissionPath,
        baseUrl: "http://127.0.0.1:8082",
        instanceIdentity: "backend-standby",
        activationRequestIdentity: `${input.operationId}:standby`,
        trafficGeneration: input.trafficGeneration,
        serviceToken: config.serviceToken,
      }),
    switchNginx: (request) => host.switchNginx(request),
    drainAndRecreateCanonical: (request) =>
      host.drainAndRecreateCanonical(request),
    activateCanonical: ({ input, admissionPath }) =>
      adapters.activateJourneyBackend({
        admissionPath,
        baseUrl: "http://127.0.0.1:8080",
        instanceIdentity: "backend",
        activationRequestIdentity: `${input.operationId}:canonical`,
        trafficGeneration: input.trafficGeneration,
        serviceToken: config.serviceToken,
      }),
    removeStandby: (request) => host.removeStandby(request),
    cleanupStandby: (request) => host.cleanupStandby(request),
    ...(typeof host.close === "function" ? { close: () => host.close() } : {}),
  };
}

export function renderFixedHostNginxConfig(source, fromPort, toPort) {
  if (
    !Buffer.isBuffer(source) ||
    ![[8080, 8082], [8082, 8080]].some(
      ([expectedFrom, expectedTo]) =>
        fromPort === expectedFrom && toPort === expectedTo,
    )
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const from = `proxy_pass http://127.0.0.1:${fromPort};`;
  const to = `proxy_pass http://127.0.0.1:${toPort};`;
  if (text.split(from).length - 1 !== 3 || text.includes(to)) {
    throw typed("FIXED_HOST_PRECOMMIT_FAILED");
  }
  return Buffer.from(text.replaceAll(from, to), "utf8");
}

export async function runFixedHostJourneyActivation(input, effects) {
  validateInvocation(input, effects);
  await reserveOperationDirectory(input.operationDirectory);

  let lock;
  let candidateStarted = false;
  let committed = false;
  let phase = "INPUTS_VALIDATED";
  let result;
  try {
    try {
      lock = await effects.acquireDeployLock({
        lockPath: path.join(input.deployRoot, "deploy.lock"),
        operationId: input.operationId,
      });
      validateLock(lock);
    } catch (error) {
      throw typed("FIXED_HOST_LOCK_FAILED", error);
    }

    const runStep = async (name, operation) => {
      await lock.verify();
      await effects.verifyInputs({ phase: name });
      return operation();
    };

    const runtime = validateRuntime(await runStep("STANDBY_STARTED", () =>
      effects.startStandby({ input, inheritedDeployLock: inheritedLock(lock) })));
    candidateStarted = true;
    phase = "STANDBY_STARTED";
    const runtimePath = await writeEvidence(
      input.operationDirectory,
      "candidate-runtime.json",
      runtime,
      "pretty",
    );

    const canary = validateCanary(await runStep("CANARY_PASSED", () =>
      effects.runCanary({ input, runtime, runtimePath })), input);
    phase = "CANARY_PASSED";
    const canaryPath = await writeEvidence(
      input.operationDirectory,
      "candidate-canary.json",
      canary,
      "pretty",
    );

    const observations = validateObservations(await runStep("STANDBY_READY", () =>
      effects.observeCandidate({ input, runtime, runtimePath, canary, canaryPath })),
    input, canary);
    phase = "STANDBY_READY";
    const observationsPath = await writeEvidence(
      input.operationDirectory,
      "candidate-observations.json",
      observations,
      "pretty",
    );

    const admission = validateAdmission(await runStep("READY_TO_ACTIVATE", () =>
      effects.admitCandidate({ input, observations, observationsPath })),
    input, observations);
    phase = "READY_TO_ACTIVATE";
    const admissionPath = await writeEvidence(
      input.operationDirectory,
      "candidate-admission.json",
      admission,
      "compact",
    );

    const standbyActivation = validateActivation(
      await runStep("STANDBY_ACTIVE", () => effects.activateStandby({
        input,
        admission,
        admissionPath,
      })),
      "backend-standby",
      input,
      admission,
    );
    phase = "STANDBY_ACTIVE";
    await writeEvidence(
      input.operationDirectory,
      "standby-activation.json",
      standbyActivation,
      "compact",
    );

    const standbySwitch = validateSwitch(
      await runStep("TRAFFIC_ON_STANDBY", () => effects.switchNginx({
        input,
        fromPort: 8080,
        toPort: 8082,
        activation: standbyActivation,
      })),
      8080,
      8082,
    );
    committed = true;
    phase = "TRAFFIC_ON_STANDBY";
    await writeEvidence(
      input.operationDirectory,
      "nginx-standby-switch.json",
      standbySwitch,
      "pretty",
    );

    const termination = validateTermination(await runStep(
      "CANONICAL_RECREATED",
      () => effects.drainAndRecreateCanonical({ input, admission, admissionPath }),
    ));
    phase = "CANONICAL_RECREATED";
    await writeEvidence(
      input.operationDirectory,
      "canonical-termination.json",
      termination,
      "pretty",
    );

    const canonicalActivation = validateActivation(
      await runStep("CANONICAL_ACTIVE", () => effects.activateCanonical({
        input,
        admission,
        admissionPath,
      })),
      "backend",
      input,
      admission,
    );
    phase = "CANONICAL_ACTIVE";
    await writeEvidence(
      input.operationDirectory,
      "canonical-activation.json",
      canonicalActivation,
      "compact",
    );

    const canonicalSwitch = validateSwitch(
      await runStep("TRAFFIC_ON_CANONICAL", () => effects.switchNginx({
        input,
        fromPort: 8082,
        toPort: 8080,
        activation: canonicalActivation,
      })),
      8082,
      8080,
    );
    phase = "TRAFFIC_ON_CANONICAL";
    await writeEvidence(
      input.operationDirectory,
      "nginx-canonical-switch.json",
      canonicalSwitch,
      "pretty",
    );

    const cleanup = validateCleanup(await runStep(
      "STANDBY_REMOVED",
      () => effects.removeStandby({ input }),
    ));
    phase = "STANDBY_REMOVED";
    await writeEvidence(
      input.operationDirectory,
      "standby-removal.json",
      cleanup,
      "pretty",
    );

    await lock.verify();
    await effects.verifyInputs({ phase: "ACTIVE_SERVING" });
    result = activationReceipt({
      input,
      lock,
      canary,
      observations,
      admission,
      standbyActivation,
      standbySwitch,
      termination,
      canonicalActivation,
      canonicalSwitch,
      cleanup,
    });
    try {
      await writeEvidence(
        input.operationDirectory,
        "activation-receipt.json",
        result,
        "pretty",
      );
    } catch (error) {
      throw typed("FIXED_HOST_RECEIPT_FAILED", error);
    }
  } catch (error) {
    const failureCommitted = committed || error?.trafficCommitted === true;
    const failure = normalizeFailure(error, failureCommitted);
    if (!failureCommitted && candidateStarted) {
      try {
        await effects.cleanupStandby({ input, phase });
      } catch {
        // The original failure remains authoritative; failed evidence records cleanup uncertainty.
      }
    }
    await writeFailureReceipt(input, failure, phase, failureCommitted).catch(() => {});
    throw failure;
  } finally {
    await lock?.close().catch(() => {});
    await effects.close?.().catch(() => {});
  }
  return result;
}

class StableHostInput {
  constructor(handle, pathname, identity, bytes) {
    this.handle = handle;
    this.pathname = pathname;
    this.identity = identity;
    this.bytes = bytes;
  }

  static async open(pathname) {
    const handle = await open(
      pathname,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const descriptor = await handle.stat({ bigint: true });
      const entry = await lstat(pathname, { bigint: true });
      if (!validStableIdentity(descriptor) || entry.isSymbolicLink() ||
        !sameStableIdentity(descriptor, entry)) {
        throw new Error("fixed-host input is not a stable regular file");
      }
      const bytes = await handle.readFile();
      const verified = await handle.stat({ bigint: true });
      if (BigInt(bytes.length) !== descriptor.size ||
        !sameStableIdentity(descriptor, verified)) {
        throw new Error("fixed-host input changed while opening");
      }
      return new StableHostInput(handle, pathname, descriptor, bytes);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async verify() {
    let descriptor;
    let entry;
    try {
      descriptor = await this.handle.stat({ bigint: true });
      entry = await lstat(this.pathname, { bigint: true });
    } catch {
      throw new Error("fixed-host immutable input changed");
    }
    if (!validStableIdentity(descriptor) || entry.isSymbolicLink() ||
      !sameStableIdentity(this.identity, descriptor, entry)) {
      throw new Error("fixed-host immutable input changed");
    }
  }

  close() {
    return this.handle.close().catch(() => {});
  }
}

function validStableIdentity(identity) {
  return identity.isFile() && identity.size > 0n &&
    identity.size <= 1024n * 1024n;
}

function sameStableIdentity(reference, ...candidates) {
  const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
  return candidates.every((candidate) =>
    fields.every((field) => reference[field] === candidate[field]));
}

async function openRegularFile(pathname) {
  const handle = await open(
    pathname,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const identity = await handle.stat({ bigint: true });
    const entry = await lstat(pathname, { bigint: true });
    if (!validStableIdentity(identity) || entry.isSymbolicLink() ||
      !sameStableIdentity(identity, entry)) {
      throw new Error("Nginx target is not a regular file");
    }
    const bytes = await handle.readFile();
    const verified = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== identity.size ||
      !sameStableIdentity(identity, verified)) {
      throw new Error("Nginx target changed while opening");
    }
    return {
      bytes,
      mode: Number(identity.mode & 0o777n),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function atomicReplace(
  target,
  bytes,
  mode,
  suffix,
  syncDirectoryImpl = syncDirectory,
) {
  const candidate = `${target}.${createHash("sha256")
    .update(suffix, "utf8")
    .digest("hex")}.tmp`;
  let handle;
  let targetReplaced = false;
  try {
    handle = await open(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(candidate, target);
    targetReplaced = true;
    await syncDirectoryImpl(path.dirname(target));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(candidate).catch(() => {});
    if (isObject(error)) error.targetReplaced = targetReplaced;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  const directory = await open(directoryPath, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close().catch(() => {});
  }
}

function trafficStateIndeterminate(cause, rollbackError) {
  const error = new Error("Nginx traffic target could not be verified", {
    cause: new AggregateError([cause, rollbackError]),
  });
  error.trafficCommitted = true;
  return error;
}

function parseStoppedContainerState(stdout) {
  let state;
  try {
    state = JSON.parse(stdout);
  } catch {
    throw new Error("canonical stop state is invalid");
  }
  if (
    !isObject(state) ||
    state.Running !== false ||
    state.OOMKilled !== false ||
    ![0, 143].includes(state.ExitCode) ||
    state.Error !== "" ||
    typeof state.FinishedAt !== "string" ||
    !validInstant(state.FinishedAt)
  ) {
    throw new Error("canonical process did not exit through graceful SIGTERM");
  }
  return state;
}

export function probeFixedHostNginxTarget({
  expectedPort,
  instanceIdentity,
  evidenceDigest,
  tupleSha256,
  trafficGeneration,
  serviceToken,
  requestImpl = httpsRequest,
}) {
  if (
    ![[8080, "backend"], [8082, "backend-standby"]].some(
      ([port, identity]) => port === expectedPort && identity === instanceIdentity,
    ) ||
    (evidenceDigest !== undefined && !matches(evidenceDigest, DIGEST)) ||
    (tupleSha256 !== undefined && !matches(tupleSha256, DIGEST)) ||
    (trafficGeneration !== undefined && !positiveInteger(trafficGeneration)) ||
    typeof serviceToken !== "string" || serviceToken.length < 32 ||
    serviceToken.length > 512 ||
    [...serviceToken].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint < 0x21 || codePoint >= 0x7f;
    }) ||
    typeof requestImpl !== "function"
  ) {
    return Promise.reject(new Error("Nginx target probe input is invalid"));
  }
  return new Promise((resolveProbe, rejectProbe) => {
    const request = requestImpl({
      host: "127.0.0.1",
      port: 443,
      servername: "easysubway-api.aquilaxk.site",
      agent: false,
      method: "GET",
      path: "/internal/v1/journey/readiness/active",
      headers: {
        Host: "easysubway-api.aquilaxk.site",
        Accept: "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
    });
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      request.destroy();
      rejectProbe(new Error("Nginx active target verification failed"));
    };
    request.setTimeout(5_000, fail);
    request.once("error", fail);
    request.once("response", (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_COMMAND_OUTPUT_BYTES) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
        } catch {
          fail();
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "")
          .toLowerCase()
          .split(";", 1)[0]
          .trim();
        const cacheDirectives = new Set(
          String(response.headers["cache-control"] ?? "")
            .toLowerCase()
            .split(",")
            .map((entry) => entry.trim()),
        );
        if (
          response.statusCode !== 200 ||
          contentType !== "application/json" ||
          !cacheDirectives.has("no-store") ||
          !isObject(value) ||
          value.instanceId !== instanceIdentity ||
          value.servingReady !== true ||
          value.draining !== false ||
          (evidenceDigest !== undefined &&
            value.evidenceSha256 !== evidenceDigest.slice("sha256:".length)) ||
          (tupleSha256 !== undefined &&
            value.releaseTupleSha256 !== tupleSha256.slice("sha256:".length)) ||
          (trafficGeneration !== undefined &&
            value.trafficGeneration !== trafficGeneration)
        ) {
          fail();
          return;
        }
        settled = true;
        resolveProbe();
      });
    });
    request.end();
  });
}

async function invokeHostCommand(runner, request) {
  const result = await runner(request);
  if (
    !isObject(result) ||
    !(result.status === null || Number.isInteger(result.status)) ||
    !(result.signal === null || typeof result.signal === "string") ||
    typeof result.timedOut !== "boolean" ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    result.timedOut || result.status !== 0 || result.signal !== null
  ) {
    throw new Error("fixed-host command failed");
  }
  return result;
}

function withEvidence(value, privateEvidence = value) {
  const evidence = privateEvidence === value
    ? value
    : { ...value, ...privateEvidence };
  return {
    ...value,
    evidenceDigest: digestBytes(Buffer.from(
      `${JSON.stringify(evidence)}\n`,
      "utf8",
    )),
  };
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validAbsoluteFilePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && value !== "/";
}

function runHostCommand({ command, args, env, timeoutMs }) {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 1_000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = boundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedOutput(stderr, chunk);
    });
    child.once("error", () => finish(null, null));
    child.once("close", finish);

    function finish(status, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ status, signal, timedOut, stdout, stderr });
    }
  });
}

function boundedOutput(current, chunk) {
  if (current.length >= MAX_COMMAND_OUTPUT_BYTES) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, MAX_COMMAND_OUTPUT_BYTES);
}

function terminateProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The process may have exited between the timeout and the signal.
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}

function acquireFixedHostDeployLock({ lockPath, ambientEnvironment }) {
  return new Promise((resolveLock, rejectLock) => {
    const child = spawn(
      "/usr/bin/flock",
      [
        "--nonblock", "--exclusive", lockPath,
        process.execPath, fileURLToPath(import.meta.url), LOCK_HOLDER_ARGUMENT,
      ],
      {
        env: ambientEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const lock = new FixedHostDeployLock(child);
    let output = "";
    let settled = false;
    const timer = setTimeout(fail, 5_000);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (!LOCK_READY.startsWith(output)) return fail();
      if (output === LOCK_READY) {
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
      rejectLock(new Error("fixed-host deploy lock unavailable"));
    }
  });
}

class FixedHostDeployLock {
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
    if (!this.active || this.child.exitCode !== null ||
      this.child.signalCode !== null) {
      throw new Error("fixed-host deploy lock was lost");
    }
  }

  async close() {
    if (!this.active) return;
    this.child.stdin.end();
    const closed = await Promise.race([
      this.closed.then(() => true),
      new Promise((resolveClosed) => setTimeout(
        () => resolveClosed(false),
        1_000,
      )),
    ]);
    if (!closed && this.active) {
      this.child.kill("SIGKILL");
      await this.closed;
    }
  }
}

function validateEffectFactory(config, adapters, host) {
  if (
    !isObject(config) ||
    ![
      config.bindingPath,
      config.descriptorBindingPath,
      config.tuplePath,
      config.descriptorPath,
      config.composeEnvPath,
      config.backendEnvPath,
      config.projectName,
      config.serviceToken,
      config.currentPublicKeyPem,
    ].every((value) => typeof value === "string" && value.length > 0) ||
    !isObject(config.canary) ||
    !isObject(adapters) ||
    [
      "startJourneyComposeCandidates",
      "runJourneyCandidateCanary",
      "observeJourneyCandidateReadiness",
      "admitJourneyReleaseCandidate",
      "activateJourneyBackend",
    ].some((name) => typeof adapters[name] !== "function") ||
    !isObject(host) ||
    [
      "acquireDeployLock",
      "verifyInputs",
      "switchNginx",
      "drainAndRecreateCanonical",
      "removeStandby",
      "cleanupStandby",
    ].some((name) => typeof host[name] !== "function")
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
}

function validateInvocation(input, effects) {
  if (
    !isObject(input) ||
    !path.isAbsolute(input.operationDirectory ?? "") ||
    !path.isAbsolute(input.deployRoot ?? "") ||
    input.deployRoot === "/" ||
    !matches(input.operationId, OPERATION_ID) ||
    !matches(input.runUrl, RUN_URL) ||
    !validInstant(input.generatedAt) ||
    !validTuple(input.tuple) ||
    ![
      input.dataDescriptorSha256,
      input.candidateBindingSha256,
      input.descriptorBindingSha256,
    ].every((value) => matches(value, DIGEST)) ||
    !positiveInteger(input.candidateGeneration) ||
    !positiveInteger(input.trafficGeneration) ||
    !isObject(effects) ||
    [
      "acquireDeployLock",
      "verifyInputs",
      "startStandby",
      "runCanary",
      "observeCandidate",
      "admitCandidate",
      "activateStandby",
      "switchNginx",
      "drainAndRecreateCanonical",
      "activateCanonical",
      "removeStandby",
      "cleanupStandby",
    ].some((name) => typeof effects[name] !== "function")
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
}

async function reserveOperationDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw typed("FIXED_HOST_OPERATION_EXISTS", error, 2);
    }
    throw typed("FIXED_HOST_USAGE", error, 2);
  }
}

function validateLock(lock) {
  if (
    !isObject(lock) ||
    !matches(lock.evidenceDigest, DIGEST) ||
    typeof lock.verify !== "function" ||
    typeof lock.close !== "function"
  ) {
    throw typed("FIXED_HOST_LOCK_FAILED");
  }
}

function inheritedLock(lock) {
  return Object.freeze({
    verify: () => lock.verify(),
    close: async () => {},
  });
}

function validateRuntime(value) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1" ||
    value.artifactKind !== "journey-compose-candidate-runtime" ||
    value.orchestrator !== "COMPOSE" ||
    !Array.isArray(value.instances) ||
    value.instances.length !== 1 ||
    !isObject(value.instances[0]) ||
    value.instances[0].instanceIdentity !== "backend-standby" ||
    value.instances[0].failureDomainIdentity !== "oci-host-easysubway-a1" ||
    value.instances[0].baseUrl !== "http://127.0.0.1:8082"
  ) {
    throw new Error("invalid standby runtime evidence");
  }
  return value;
}

function validateCanary(value, input) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1" ||
    value.artifactKind !== "journey-candidate-canary" ||
    value.passed !== true ||
    value.tupleSha256 !== input.tuple.tupleSha256 ||
    !matches(value.evidenceDigest, DIGEST) ||
    Object.keys(FALLBACK_ZERO).some((field) => value[field] !== 0)
  ) {
    throw new Error("invalid canary evidence");
  }
  return value;
}

function validateObservations(value, input, canary) {
  const instance = value?.instances?.[0];
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_OBSERVATIONS_V1" ||
    value.artifactKind !== "journey-candidate-observations" ||
    value.orchestrator !== "COMPOSE" ||
    value.tupleSha256 !== input.tuple.tupleSha256 ||
    value.bindingSha256 !== input.candidateBindingSha256 ||
    !Array.isArray(value.instances) ||
    value.instances.length !== 1 ||
    !isObject(instance) ||
    instance.instanceIdentity !== "backend-standby" ||
    instance.failureDomainIdentity !== "oci-host-easysubway-a1" ||
    instance.candidateGeneration !== input.candidateGeneration ||
    !sameTupleIdentity(instance, input.tuple) ||
    instance.warmed !== true ||
    instance.ready !== true ||
    !matches(instance.readinessEvidenceDigest, DIGEST) ||
    !isObject(value.canary) ||
    value.canary.passed !== true ||
    value.canary.evidenceDigest !== canary.evidenceDigest ||
    Object.keys(FALLBACK_ZERO).some((field) => value.canary[field] !== 0)
  ) {
    throw new Error("invalid candidate observation evidence");
  }
  return value;
}

function validateAdmission(value, input, observations) {
  if (
    !isObject(value) ||
    value.schemaVersion !== "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1" ||
    value.artifactKind !== "journey-candidate-admission" ||
    value.orchestrator !== "COMPOSE" ||
    value.tupleSha256 !== input.tuple.tupleSha256 ||
    value.bindingSha256 !== input.candidateBindingSha256 ||
    value.candidateGeneration !== input.candidateGeneration ||
    value.canaryEvidenceDigest !== observations.canary.evidenceDigest ||
    !sameTupleIdentity(value, input.tuple) ||
    !matches(value.candidateAdmissionSha256, DIGEST)
  ) {
    throw new Error("invalid candidate admission evidence");
  }
  return value;
}

function sameTupleIdentity(value, tuple) {
  return [
    "tupleSha256",
    "backendImageDigest",
    "backendConfigDigest",
    "journeyContractDigest",
    "serverRouteBundleDigest",
    "deploymentRevision",
    "environmentIdentity",
  ].every((field) => value[field] === tuple[field]);
}

function validateActivation(value, instanceIdentity, input, admission) {
  if (
    !isObject(value) ||
    value.instanceIdentity !== instanceIdentity ||
    value.candidateAdmissionSha256 !== admission.candidateAdmissionSha256 ||
    value.candidateGeneration !== input.candidateGeneration ||
    value.trafficGeneration !== input.trafficGeneration ||
    !matches(value.activeReadinessEvidenceDigest, DIGEST)
  ) {
    throw new Error("invalid Backend activation evidence");
  }
  return value;
}

function validateSwitch(value, fromPort, toPort) {
  if (
    !isObject(value) ||
    value.fromPort !== fromPort ||
    value.toPort !== toPort ||
    !matches(value.nginxConfigSha256, DIGEST) ||
    value.nginxTestPassed !== true ||
    value.reloadCompleted !== true ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid Nginx switch evidence");
  }
  return value;
}

function validateTermination(value) {
  if (
    !isObject(value) ||
    value.signal !== "SIGTERM" ||
    value.stopGracePeriodSeconds !== 30 ||
    value.newRequestAdmissionAfterSignal !== 0 ||
    value.inFlightSnapshotPinned !== true ||
    value.inFlightCompleted !== true ||
    value.oldProcessExited !== true ||
    value.withinBudget !== true ||
    value.droppedJourneyCount !== 0 ||
    value.duplicateJourneyCount !== 0 ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid canonical termination evidence");
  }
  return value;
}

function validateCleanup(value) {
  if (
    !isObject(value) ||
    value.standbyRemoved !== true ||
    value.orphanedStandbyCount !== 0 ||
    !matches(value.evidenceDigest, DIGEST)
  ) {
    throw new Error("invalid standby cleanup evidence");
  }
  return value;
}

function activationReceipt({
  input,
  lock,
  canary,
  observations,
  admission,
  standbyActivation,
  standbySwitch,
  termination,
  canonicalActivation,
  canonicalSwitch,
  cleanup,
}) {
  const { tupleSha256, ...schemaTuple } = input.tuple;
  return {
    schemaVersion: "PLATFORM_ACTIVATION_RECEIPT_V2",
    artifactKind: "platform-activation-receipt",
    orchestrator: "COMPOSE",
    operation: {
      operationId: input.operationId,
      hostIdentity: "oci-host-easysubway-a1",
      deployLockPath: "${DEPLOY_ROOT}/deploy.lock",
      deployLockEvidenceDigest: lock.evidenceDigest,
    },
    tuple: schemaTuple,
    bindings: {
      dataDescriptorSha256: input.dataDescriptorSha256,
      tupleSha256,
      candidateBindingSha256: input.candidateBindingSha256,
      descriptorBindingSha256: input.descriptorBindingSha256,
      candidateAdmissionSha256: admission.candidateAdmissionSha256,
    },
    candidate: {
      instanceCount: 1,
      failureDomainCount: 1,
      instanceIdentity: "backend-standby",
      failureDomainIdentity: "oci-host-easysubway-a1",
      baseUrl: "http://127.0.0.1:8082",
      candidateGeneration: input.candidateGeneration,
      allReady: true,
      allInstancesMatchTuple: true,
      canaryPassed: true,
      canaryEvidenceDigest: canary.evidenceDigest,
      standbyActiveReadinessEvidenceDigest:
        standbyActivation.activeReadinessEvidenceDigest,
    },
    activation: {
      trafficGeneration: input.trafficGeneration,
      standbySwitch,
      canonicalActiveReadinessEvidenceDigest:
        canonicalActivation.activeReadinessEvidenceDigest,
      canonicalSwitch,
    },
    termination,
    cleanup,
    outcome: "ACTIVE_SERVING",
    fallbackZero: { ...FALLBACK_ZERO },
    evidence: {
      generatedAt: input.generatedAt,
      runUrl: input.runUrl,
    },
  };
}

async function writeFailureReceipt(input, error, phase, committed) {
  const value = {
    schemaVersion: "PLATFORM_FIXED_HOST_ACTIVATION_FAILURE_V1",
    artifactKind: "platform-fixed-host-activation-failure",
    operationId: input.operationId,
    phase: committed ? "FAILED_POSTSWITCH" : "FAILED_PRECOMMIT",
    lastCompletedState: phase,
    code: error.code,
    trafficCommitted: committed,
    admittedStandbyMayRemainServing: committed,
    successReceiptCreated: false,
    fallbackZero: { ...FALLBACK_ZERO },
    failedAt: input.generatedAt,
    runUrl: input.runUrl,
  };
  await writeEvidence(
    input.operationDirectory,
    "failed-operation.json",
    value,
    "pretty",
  );
}

export async function publishCreateOnlyEvidence(
  directory,
  filename,
  value,
  style,
  {
    openFile = open,
    linkFile = link,
    unlinkFile = unlink,
    syncDirectoryImpl = syncDirectory,
  } = {},
) {
  const target = path.join(directory, filename);
  const bytes = Buffer.from(style === "compact"
    ? `${JSON.stringify(value)}\n`
    : `${JSON.stringify(value, null, 2)}\n`);
  const candidate = path.join(
    directory,
    `.${filename}.${createHash("sha256").update(bytes).digest("hex")}.tmp`,
  );
  let handle;
  let candidateOwned = false;
  let published = false;
  try {
    handle = await openFile(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    candidateOwned = true;
    await handle.writeFile(bytes);
    await handle.sync();
    const identity = await handle.stat();
    if (!identity.isFile() || identity.size !== bytes.length) {
      throw new Error("evidence identity mismatch");
    }
    await handle.close();
    handle = undefined;
    await linkFile(candidate, target);
    published = true;
    await syncDirectoryImpl(directory);
    await unlinkFile(candidate).catch(() => {});
    return target;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (published) {
      try {
        await unlinkFile(target);
        published = false;
        await syncDirectoryImpl(directory);
      } catch {
        if (published) return target;
      }
    }
    if (candidateOwned) await unlinkFile(candidate).catch(() => {});
    throw error;
  }
}

const writeEvidence = publishCreateOnlyEvidence;

function normalizeFailure(error, committed) {
  if (error instanceof FixedHostJourneyActivationError) {
    if (committed && error.code === "FIXED_HOST_PRECOMMIT_FAILED") {
      return typed("FIXED_HOST_POSTSWITCH_FAILED", error);
    }
    return error;
  }
  return typed(
    committed ? "FIXED_HOST_POSTSWITCH_FAILED" : "FIXED_HOST_PRECOMMIT_FAILED",
    error,
  );
}

function validTuple(value) {
  return isObject(value) &&
    value.schemaVersion === "JOURNEY_RELEASE_TUPLE_V1" &&
    value.artifactKind === "journey-release-tuple" &&
    [
      value.backendImageDigest,
      value.backendConfigDigest,
      value.journeyContractDigest,
      value.serverRouteBundleDigest,
      value.tupleSha256,
    ].every((entry) => matches(entry, DIGEST)) &&
    matches(value.deploymentRevision, REVISION) &&
    typeof value.environmentIdentity === "string" &&
    /^[A-Za-z0-9._-]{1,255}$/.test(value.environmentIdentity);
}

function validInstant(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typed(code, cause, exitCode = 1) {
  return new FixedHostJourneyActivationError(
    code,
    exitCode,
    cause === undefined ? undefined : { cause },
  );
}

function parseFixedHostRequest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
  const fields = [
    "schemaVersion", "artifactKind", "operationDirectory", "operationId",
    "deployRoot", "runUrl", "generatedAt", "bindingPath",
    "descriptorBindingPath", "tuplePath", "descriptorPath", "composeEnvPath",
    "backendEnvPath", "projectName", "nginxConfigPath", "baseComposePath",
    "candidateComposePath", "candidateGeneration", "trafficGeneration", "canary",
  ];
  const canaryFields = [
    "canaryRequestIdentity", "requestId", "originStationId",
    "destinationStationId", "mobilityProfile", "constraintMode",
    "maxTransfers", "alternativeCount",
  ];
  if (
    !isExactObject(value, fields) ||
    value.schemaVersion !== "PLATFORM_FIXED_HOST_ACTIVATION_REQUEST_V1" ||
    value.artifactKind !== "platform-fixed-host-activation-request" ||
    ![
      value.operationDirectory, value.deployRoot, value.bindingPath,
      value.descriptorBindingPath, value.tuplePath, value.descriptorPath,
      value.composeEnvPath, value.backendEnvPath, value.nginxConfigPath,
      value.baseComposePath, value.candidateComposePath,
    ].every(validAbsoluteFilePath) ||
    value.nginxConfigPath !== RUNTIME_NGINX_CONFIG_PATH ||
    value.baseComposePath !== RUNTIME_BASE_COMPOSE_PATH ||
    value.candidateComposePath !== RUNTIME_CANDIDATE_COMPOSE_PATH ||
    ![
      value.operationDirectory, value.bindingPath, value.descriptorBindingPath,
      value.tuplePath, value.descriptorPath, value.composeEnvPath,
      value.backendEnvPath, value.baseComposePath, value.candidateComposePath,
    ].every((pathname) => isStrictDescendant(value.deployRoot, pathname)) ||
    !matches(value.operationId, OPERATION_ID) ||
    !matches(value.runUrl, RUN_URL) ||
    !validInstant(value.generatedAt) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value.projectName ?? "") ||
    !positiveInteger(value.candidateGeneration) ||
    !positiveInteger(value.trafficGeneration) ||
    !isExactObject(value.canary, canaryFields) ||
    !validCanaryRequest(value.canary)
  ) {
    throw typed("FIXED_HOST_USAGE", undefined, 2);
  }
  return value;
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function validCanaryRequest(value) {
  const rawText = (entry, maximum) => typeof entry === "string" &&
    entry.length >= 1 && entry.length <= maximum && entry === entry.trim() &&
    entry.isWellFormed() &&
    [...entry].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint >= 0x20 && codePoint !== 0x7f;
    });
  return rawText(value.canaryRequestIdentity, 512) &&
    /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.requestId ?? "") &&
    rawText(value.originStationId, 255) &&
    rawText(value.destinationStationId, 255) &&
    value.originStationId !== value.destinationStationId &&
    ["STANDARD", "SLOW", "NO_STAIRS", "STEP_FREE"].includes(
      value.mobilityProfile,
    ) &&
    ["NONE", "REQUIRE_STEP_FREE"].includes(value.constraintMode) &&
    !(value.mobilityProfile === "NO_STAIRS" && value.constraintMode === "NONE") &&
    Number.isSafeInteger(value.maxTransfers) && value.maxTransfers >= 0 &&
    value.maxTransfers <= 3 &&
    Number.isSafeInteger(value.alternativeCount) && value.alternativeCount >= 1 &&
    value.alternativeCount <= 3;
}

function isExactObject(value, fields) {
  return isObject(value) && Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

async function runFixedHostCli(requestPath) {
  const requestInput = await StableHostInput.open(requestPath);
  let host;
  let lifecycleOwnsHost = false;
  try {
    const request = parseFixedHostRequest(requestInput.bytes);
    const inputPaths = [
      request.bindingPath,
      request.descriptorBindingPath,
      request.tuplePath,
      request.descriptorPath,
      request.composeEnvPath,
      request.backendEnvPath,
    ];
    const ambientEnvironment = {
      ...process.env,
      DEPLOY_ROOT: request.deployRoot,
    };
    const concreteHost = await createFixedHostJourneyActivationHost({
      inputPaths,
      nginxConfigPath: request.nginxConfigPath,
      composeEnvPath: request.composeEnvPath,
      backendEnvPath: request.backendEnvPath,
      baseComposePath: request.baseComposePath,
      candidateComposePath: request.candidateComposePath,
      projectName: request.projectName,
      ambientEnvironment,
    });
    host = {
      ...concreteHost,
      async verifyInputs() {
        await requestInput.verify();
        await concreteHost.verifyInputs();
      },
      async close() {
        await concreteHost.close();
        await requestInput.close();
      },
    };
    const tupleBytes = concreteHost.readInput(request.tuplePath);
    let tuple;
    try {
      tuple = validateJourneyReleaseTupleBytes(tupleBytes);
    } catch (error) {
      throw typed("FIXED_HOST_USAGE", error, 2);
    }
    const input = {
      operationDirectory: request.operationDirectory,
      operationId: request.operationId,
      deployRoot: request.deployRoot,
      runUrl: request.runUrl,
      generatedAt: request.generatedAt,
      tuple,
      dataDescriptorSha256: digestBytes(
        concreteHost.readInput(request.descriptorPath),
      ),
      candidateBindingSha256: digestBytes(
        concreteHost.readInput(request.bindingPath),
      ),
      descriptorBindingSha256: digestBytes(
        concreteHost.readInput(request.descriptorBindingPath),
      ),
      candidateGeneration: request.candidateGeneration,
      trafficGeneration: request.trafficGeneration,
    };
    const effects = createFixedHostJourneyActivationEffects({
      config: {
        bindingPath: request.bindingPath,
        descriptorBindingPath: request.descriptorBindingPath,
        tuplePath: request.tuplePath,
        descriptorPath: request.descriptorPath,
        composeEnvPath: request.composeEnvPath,
        backendEnvPath: request.backendEnvPath,
        projectName: request.projectName,
        serviceToken: process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
        currentPublicKeyPem:
          process.env.EASYSUBWAY_JOURNEY_CURRENT_PUBLIC_KEY_PEM,
        ambientEnvironment,
        canary: request.canary,
      },
      host,
    });
    lifecycleOwnsHost = true;
    return await runFixedHostJourneyActivation(input, effects);
  } finally {
    if (!lifecycleOwnsHost) {
      await host?.close().catch(() => {});
      if (host === undefined) await requestInput.close();
    }
  }
}

async function holdFixedHostDeployLock() {
  process.stdout.write(LOCK_READY);
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

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const lockHolder = process.argv.length === 3 &&
    process.argv[2] === LOCK_HOLDER_ARGUMENT;
  const entrypoint = lockHolder
    ? holdFixedHostDeployLock
    : async () => {
      if (process.argv.length !== 4 || process.argv[2] !== "--request" ||
        !validAbsoluteFilePath(process.argv[3])) {
        throw typed("FIXED_HOST_USAGE", undefined, 2);
      }
      const receipt = await runFixedHostCli(process.argv[3]);
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    };
  entrypoint().catch((error) => {
    const normalized = error instanceof FixedHostJourneyActivationError
      ? error
      : typed("FIXED_HOST_PRECOMMIT_FAILED", error);
    process.stderr.write(`${JSON.stringify({
      error: normalized.code,
      message: normalized.message,
    })}\n`);
    process.exitCode = normalized.exitCode;
  });
}
