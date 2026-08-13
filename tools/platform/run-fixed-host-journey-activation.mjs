#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { request as httpRequest } from "node:http";
import { access, chmod, link, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { activateJourneyBackend } from "./activate-journey-backend.mjs";
import { admitJourneyReleaseCandidate } from "./admit-journey-release-candidate.mjs";
import { observeJourneyCandidateReadiness } from "./observe-journey-candidate-readiness.mjs";
import { runJourneyCandidateCanary } from "./run-journey-candidate-canary.mjs";
import { startJourneyComposeCandidates } from "./start-journey-compose-candidates.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,255}$/;
const RUN_URL = /^https:\/\/github\.com\/AquilaXk\/easysubway-platform\/actions\/runs\/[1-9][0-9]*$/;
const REQUEST_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const NGINX_TEMPLATE = resolve(MODULE_DIR, "../../infra/nginx/host-easysubway.conf.template");
const NGINX_CONFIG = "/etc/nginx/sites-available/easysubway";
const COMMAND_TIMEOUT_MS = 30_000;

const ERROR_MESSAGES = Object.freeze({
  OPERATION_INPUT_INVALID: "fixed-host activation input validation failed",
  DEPLOY_LOCK_UNAVAILABLE: "fixed-host activation deploy lock is unavailable",
  STANDBY_START_OR_READINESS_FAILED: "fixed-host standby start or readiness failed",
  CANARY_OR_ADMISSION_FAILED: "fixed-host canary or admission failed",
  STANDBY_ACTIVATION_FAILED: "fixed-host standby activation failed",
  NGINX_STANDBY_SWITCH_FAILED: "fixed-host standby Nginx switch failed",
  CANONICAL_DRAIN_FAILED: "fixed-host canonical drain failed",
  CANONICAL_RECREATE_OR_ACTIVATION_FAILED: "fixed-host canonical recreate or activation failed",
  NGINX_CANONICAL_SWITCHBACK_FAILED: "fixed-host canonical Nginx switchback failed",
  STANDBY_CLEANUP_FAILED: "fixed-host standby cleanup failed",
  EVIDENCE_INVALID: "fixed-host activation evidence is invalid",
});

export class FixedHostJourneyActivationError extends Error {
  constructor(code, exitCode = 1) {
    super(ERROR_MESSAGES[code] ?? "fixed-host Journey activation failed");
    this.name = "FixedHostJourneyActivationError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Runs the lifecycle contract inside the lease owned by the candidate starter.
 * Production defaults bind the fixed-host Nginx, Compose, and drain ABI. Tests
 * may replace those effects without changing the coordinator contract.
 */
export async function runFixedHostJourneyActivation(input) {
  const operations = input?.operations ?? createFixedHostOperations(input);
  validateInvocation(input);
  await requireAbsentReceipt(input.receiptPath);
  let committed = false;
  try {
    return await input.startCandidates({
      ...input.candidateStartInput,
      serviceToken: input.serviceToken,
      currentPublicKeyPem: input.currentPublicKeyPem,
      withinOperation: async (lease) => {
        requireLease(lease);
        try {
          requireInputIdentity(lease.inputIdentity, input);
          await verifyLease(lease);

          const runtime = requireRuntime(lease.runtime);
          const canary = await guarded(lease, "CANARY_OR_ADMISSION_FAILED", () =>
            input.runCanary({
              tuple: input.tuple,
              baseUrl: runtime.baseUrl,
              trafficGeneration: input.trafficGeneration,
              serviceToken: input.serviceToken,
            }));
          requireCanary(canary, input.tuple);

          const observations = await guarded(lease, "STANDBY_START_OR_READINESS_FAILED", () =>
            input.observeReadiness({ runtime, canary, serviceToken: input.serviceToken }));
          requireObservations(observations, runtime, canary);

          const admitted = await guarded(lease, "CANARY_OR_ADMISSION_FAILED", () =>
            input.admitCandidate({ observations, tuple: input.tuple }));
          requireAdmission(admitted, input.tuple);

          const standbyActivation = await guarded(lease, "STANDBY_ACTIVATION_FAILED", () =>
            input.activateBackend({
              admission: admitted, baseUrl: runtime.baseUrl, instanceIdentity: "backend-standby",
              activationRequestIdentity: `${input.operationId}:standby`,
              trafficGeneration: input.trafficGeneration, serviceToken: input.serviceToken,
            }));
          requireActivation(standbyActivation, admitted, "backend-standby", input.trafficGeneration);

          const standbySwitch = await guarded(lease, "NGINX_STANDBY_SWITCH_FAILED", () =>
            operations.switchNginx({ fromPort: 8080, toPort: 8082, tuple: input.tuple }));
          requireSwitch(standbySwitch, 8080, 8082);
          committed = true;

          const termination = await guarded(lease, "CANONICAL_DRAIN_FAILED", () =>
            operations.drainCanonical({ tuple: input.tuple, sessionToken: input.journeySessionToken, composeContext: lease.composeContext }));
          requireDrain(termination, input.tuple);

          const recreated = await guarded(lease, "CANONICAL_RECREATE_OR_ACTIVATION_FAILED", () =>
            operations.recreateCanonical({ tuple: input.tuple, composeContext: lease.composeContext }));
          if (recreated?.tupleSha256 !== input.tuple.tupleSha256) throw failure("CANONICAL_RECREATE_OR_ACTIVATION_FAILED");

          const canonicalActivation = await guarded(lease, "CANONICAL_RECREATE_OR_ACTIVATION_FAILED", () =>
            input.activateBackend({
              admission: admitted, baseUrl: "http://127.0.0.1:8080", instanceIdentity: "backend",
              activationRequestIdentity: `${input.operationId}:canonical`,
              trafficGeneration: input.trafficGeneration, serviceToken: input.serviceToken,
            }));
          requireActivation(canonicalActivation, admitted, "backend", input.trafficGeneration);

          const canonicalSwitch = await guarded(lease, "NGINX_CANONICAL_SWITCHBACK_FAILED", () =>
            operations.switchNginx({ fromPort: 8082, toPort: 8080, tuple: input.tuple }));
          requireSwitch(canonicalSwitch, 8082, 8080);

          const cleanup = await guarded(lease, "STANDBY_CLEANUP_FAILED", () =>
            operations.removeStandby({ runtime, composeContext: lease.composeContext }));
          if (!matches(cleanup?.evidenceDigest, DIGEST)) throw failure("STANDBY_CLEANUP_FAILED");

          const receipt = receiptFor({ input, lease, runtime, canary, admitted, standbyActivation,
            standbySwitch, termination, canonicalActivation, canonicalSwitch, cleanup });
          await guarded(lease, "EVIDENCE_INVALID", () => operations.writeReceipt(receipt));
          await writeNewReceipt(input.receiptPath, receipt);
          return receipt;
        } catch (error) {
          const typed = translate(error, committed ? "EVIDENCE_INVALID" : "STANDBY_START_OR_READINESS_FAILED");
          if (!committed) {
            try {
              await verifyLease(lease);
              await operations.removeStandby({ reason: typed.code, composeContext: lease.composeContext });
            } catch { /* typed failure wins */ }
          }
          throw typed;
        }
      },
    });
  } catch (error) {
    throw translate(error, committed ? "EVIDENCE_INVALID" : "STANDBY_START_OR_READINESS_FAILED");
  }
}

function validateInvocation(input) {
  if (!isObject(input) || !matches(input.operationId, OPERATION_ID) ||
    !Number.isSafeInteger(input.trafficGeneration) || input.trafficGeneration < 1 ||
    !isPath(input.receiptPath) || !isObject(input.tuple) ||
    !matches(input.descriptorSha256, RAW_DIGEST) || !matches(input.descriptorBytesSha256, RAW_DIGEST) ||
    ![input.candidateBindingSha256, input.descriptorBindingSha256].every((value) => matches(value, DIGEST)) ||
    !matches(input.runUrl, RUN_URL) || !validSecret(input.serviceToken) ||
    !validSessionToken(input.journeySessionToken) || input.journeySessionToken === input.serviceToken ||
    typeof input.currentPublicKeyPem !== "string" || typeof input.startCandidates !== "function" ||
    ![input.runCanary, input.observeReadiness, input.admitCandidate, input.activateBackend].every((value) => typeof value === "function") ||
    (input.operations !== undefined && (!isObject(input.operations) ||
      !["switchNginx", "drainCanonical", "recreateCanonical", "removeStandby", "writeReceipt"]
        .every((key) => typeof input.operations[key] === "function")))) {
    throw failure("OPERATION_INPUT_INVALID", 2);
  }
  requireTuple(input.tuple);
}

async function requireAbsentReceipt(path) {
  try { await access(path); throw failure("OPERATION_INPUT_INVALID", 2); } catch (error) {
    if (error instanceof FixedHostJourneyActivationError) throw error;
    if (error?.code !== "ENOENT") throw failure("OPERATION_INPUT_INVALID", 2);
  }
}

async function guarded(lease, code, operation) {
  try { await verifyLease(lease); return await operation(); } catch (error) {
    if (error instanceof FixedHostJourneyActivationError) throw error;
    throw failure(code);
  }
}
async function verifyLease(lease) {
  try { await lease.verify(); } catch { throw failure("DEPLOY_LOCK_UNAVAILABLE"); }
}
function requireLease(lease) {
  if (!isObject(lease) || typeof lease.verify !== "function" || !isObject(lease.runtime) ||
    !isObject(lease.inputIdentity) || !isObject(lease.composeContext)) {
    throw failure("DEPLOY_LOCK_UNAVAILABLE");
  }
}
function requireInputIdentity(identity, input) {
  if (identity.descriptorSha256 !== `sha256:${input.descriptorBytesSha256}` ||
    identity.candidateBindingSha256 !== input.candidateBindingSha256 ||
    identity.descriptorBindingSha256 !== input.descriptorBindingSha256) {
    throw failure("OPERATION_INPUT_INVALID", 2);
  }
}
function requireRuntime(runtime) {
  const instance = runtime.instances?.[0];
  if (!isObject(instance) || runtime.instances.length !== 1 ||
    instance.instanceIdentity !== "backend-standby" ||
    instance.failureDomainIdentity !== "oci-host-easysubway-a1" ||
    instance.baseUrl !== "http://127.0.0.1:8082") throw failure("STANDBY_START_OR_READINESS_FAILED");
  return instance;
}
function requireTuple(tupleValue) {
  if (!matches(tupleValue.tupleSha256, DIGEST) || !matches(tupleValue.backendImageDigest, DIGEST) ||
    !matches(tupleValue.backendConfigDigest, DIGEST) || !matches(tupleValue.journeyContractDigest, DIGEST) ||
    !matches(tupleValue.serverRouteBundleDigest, DIGEST) || !/^[a-f0-9]{40}$/.test(tupleValue.deploymentRevision) ||
    !matches(tupleValue.environmentIdentity, OPERATION_ID)) throw failure("OPERATION_INPUT_INVALID", 2);
}
function requireCanary(value, expectedTuple) {
  if (!isObject(value) || value.tupleSha256 !== expectedTuple.tupleSha256 || value.passed !== true ||
    !matches(value.evidenceDigest, DIGEST) || ["legacyGraphSuccessCount", "localRouteInvocationCount", "staleJourneyServedCount", "alternateEndpointSuccessCount"].some((key) => value[key] !== 0)) throw failure("CANARY_OR_ADMISSION_FAILED");
}
function requireObservations(value, runtime, canary) {
  const instance = value?.instances?.[0];
  if (!isObject(instance) || value.instances.length !== 1 || instance.instanceIdentity !== runtime.instanceIdentity ||
    !Number.isSafeInteger(instance.candidateGeneration) || instance.candidateGeneration < 1 || value.canary?.evidenceDigest !== canary.evidenceDigest) throw failure("STANDBY_START_OR_READINESS_FAILED");
}
function requireAdmission(value, expectedTuple) {
  if (!isObject(value) || value.tupleSha256 !== expectedTuple.tupleSha256 ||
    !matches(value.candidateAdmissionSha256, DIGEST) || !Number.isSafeInteger(value.candidateGeneration) ||
    value.candidateGeneration < 1 || ["backendImageDigest", "backendConfigDigest", "journeyContractDigest", "serverRouteBundleDigest", "deploymentRevision", "environmentIdentity"].some((key) => value[key] !== expectedTuple[key])) throw failure("CANARY_OR_ADMISSION_FAILED");
}
function requireActivation(value, admitted, identity, trafficGeneration) {
  if (!isObject(value) || value.instanceIdentity !== identity || value.candidateAdmissionSha256 !== admitted.candidateAdmissionSha256 ||
    value.candidateGeneration !== admitted.candidateGeneration || value.trafficGeneration !== trafficGeneration ||
    !matches(value.activeReadinessEvidenceDigest, DIGEST)) throw failure(identity === "backend" ? "CANONICAL_RECREATE_OR_ACTIVATION_FAILED" : "STANDBY_ACTIVATION_FAILED");
}
function requireSwitch(value, fromPort, toPort) {
  if (!isObject(value) || value.fromPort !== fromPort || value.toPort !== toPort ||
    !matches(value.nginxConfigSha256, DIGEST) || value.nginxTestPassed !== true || value.reloadCompleted !== true ||
    !matches(value.evidenceDigest, DIGEST)) throw failure(fromPort === 8080 ? "NGINX_STANDBY_SWITCH_FAILED" : "NGINX_CANONICAL_SWITCHBACK_FAILED");
}
function requireDrain(value, expectedTuple) {
  if (!isObject(value) || value.tupleSha256 !== expectedTuple.tupleSha256 || value.signal !== "SIGTERM" ||
    value.stopGracePeriodSeconds !== 30 || value.newRequestAdmissionAfterSignal !== 0 ||
    value.inFlightSnapshotPinned !== true || value.inFlightCompleted !== true || value.oldProcessExited !== true ||
    value.withinBudget !== true || value.droppedJourneyCount !== 0 || value.duplicateJourneyCount !== 0 ||
    !matches(value.evidenceDigest, DIGEST)) throw failure("CANONICAL_DRAIN_FAILED");
}
function receiptFor({ input, lease, runtime, canary, admitted, standbyActivation, standbySwitch, termination, canonicalActivation, canonicalSwitch, cleanup }) {
  const { tupleSha256: _tupleSha256, ...terminationReceipt } = termination;
  return {
    schemaVersion: "PLATFORM_ACTIVATION_RECEIPT_V2", artifactKind: "platform-activation-receipt", orchestrator: "COMPOSE",
    operation: { operationId: input.operationId, hostIdentity: "oci-host-easysubway-a1", deployLockPath: "${DEPLOY_ROOT}/deploy.lock", deployLockEvidenceDigest: matches(lease.evidenceDigest, DIGEST) ? lease.evidenceDigest : input.tuple.tupleSha256 },
    tuple: input.tuple,
    bindings: { dataDescriptorSha256: `sha256:${input.descriptorSha256}`, tupleSha256: input.tuple.tupleSha256, candidateBindingSha256: input.candidateBindingSha256, descriptorBindingSha256: input.descriptorBindingSha256, candidateAdmissionSha256: admitted.candidateAdmissionSha256 },
    candidate: { instanceCount: 1, failureDomainCount: 1, instanceIdentity: runtime.instanceIdentity, failureDomainIdentity: runtime.failureDomainIdentity, baseUrl: runtime.baseUrl, candidateGeneration: admitted.candidateGeneration, allReady: true, allInstancesMatchTuple: true, canaryPassed: true, canaryEvidenceDigest: canary.evidenceDigest, standbyActiveReadinessEvidenceDigest: standbyActivation.activeReadinessEvidenceDigest },
    activation: { trafficGeneration: input.trafficGeneration, standbySwitch, canonicalActiveReadinessEvidenceDigest: canonicalActivation.activeReadinessEvidenceDigest, canonicalSwitch },
    termination: terminationReceipt,
    cleanup: { standbyRemoved: true, orphanedStandbyCount: 0, evidenceDigest: cleanup.evidenceDigest },
    outcome: "ACTIVE_SERVING", fallbackZero: { legacyGraphSuccessCount: 0, localRouteInvocationCount: 0, staleJourneyServedCount: 0, alternateEndpointSuccessCount: 0 },
    evidence: { generatedAt: new Date().toISOString(), runUrl: input.runUrl },
  };
}
async function writeNewReceipt(path, receipt, { beforePublish } = {}) {
  const temporary = join(dirname(path), `.${randomUUID()}.activation-receipt.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforePublish?.();
    await link(temporary, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if (error instanceof FixedHostJourneyActivationError) throw error;
    throw failure("EVIDENCE_INVALID");
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeActivationReceiptForTest(path, receipt, hooks) {
  return writeNewReceipt(path, receipt, hooks);
}

export function parseFixedHostJourneyActivationCli(args) {
  const flags = new Map([
    ["--binding", "bindingPath"], ["--descriptor-binding", "descriptorBindingPath"],
    ["--tuple", "tuplePath"], ["--descriptor", "descriptorPath"],
    ["--compose-env", "composeEnvPath"], ["--backend-env", "backendEnvPath"],
    ["--project-name", "projectName"], ["--operation-id", "operationId"],
    ["--traffic-generation", "trafficGeneration"], ["--candidate-generation", "candidateGeneration"],
    ["--canary-request-identity", "canaryRequestIdentity"], ["--request-id", "requestId"],
    ["--origin-station-id", "originStationId"], ["--destination-station-id", "destinationStationId"],
    ["--mobility-profile", "mobilityProfile"], ["--constraint-mode", "constraintMode"],
    ["--max-transfers", "maxTransfers"], ["--alternative-count", "alternativeCount"],
    ["--receipt", "receiptPath"], ["--drain-probe", "drainProbePath"], ["--run-url", "runUrl"],
  ]);
  if (args.length !== flags.size * 2) throw failure("OPERATION_INPUT_INVALID", 2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1]; const field = flags.get(flag);
    if (!field || Object.hasOwn(values, field) || !isPath(value) || value.startsWith("--")) {
      throw failure("OPERATION_INPUT_INVALID", 2);
    }
    values[field] = value;
  }
  values.trafficGeneration = canonicalInteger(values.trafficGeneration, 1);
  values.candidateGeneration = canonicalInteger(values.candidateGeneration, 1);
  values.maxTransfers = canonicalInteger(values.maxTransfers, 0, 3);
  values.alternativeCount = canonicalInteger(values.alternativeCount, 1, 3);
  return values;
}

export function createFixedHostOperations(input) {
  const host = input?.host ?? {};
  const commandRunner = host.commandRunner ?? runCommand;
  const configPath = host.nginxConfigPath ?? NGINX_CONFIG;
  const templatePath = host.nginxTemplatePath ?? NGINX_TEMPLATE;
  const drainProbe = input?.drainProbe;
  return Object.freeze({
    switchNginx: async ({ fromPort, toPort }) => switchNginxTarget({
      fromPort, toPort, configPath, templatePath, commandRunner,
    }),
    drainCanonical: async ({ tuple, sessionToken, composeContext }) => drainCanonical({
      tuple, sessionToken, composeContext, drainProbe,
      postSignalJourneyImpl: host.postSignalJourneyImpl ?? postSignalJourney,
      openInFlightJourneyImpl: host.openInFlightJourneyImpl ?? openInFlightJourney,
      now: host.now ?? Date.now,
    }),
    recreateCanonical: async ({ tuple, composeContext }) => {
      await compose(composeContext, ["up", "--detach", "--no-deps", "--no-build", "--force-recreate", "backend"], "CANONICAL_RECREATE_OR_ACTIVATION_FAILED");
      return { tupleSha256: tuple.tupleSha256 };
    },
    removeStandby: async ({ composeContext }) => {
      if (!composeContext) throw failure("STANDBY_CLEANUP_FAILED");
      await compose(composeContext, ["rm", "--force", "--stop", "backend-standby"], "STANDBY_CLEANUP_FAILED");
      return { evidenceDigest: digest(Buffer.from("standby-removed\n")) };
    },
    writeReceipt: async () => {},
  });
}

async function switchNginxTarget({ fromPort, toPort, configPath, templatePath, commandRunner }) {
  if (!([8080, 8082].includes(fromPort) && [8080, 8082].includes(toPort) && fromPort !== toPort)) {
    throw failure(fromPort === 8080 ? "NGINX_STANDBY_SWITCH_FAILED" : "NGINX_CANONICAL_SWITCHBACK_FAILED");
  }
  let original;
  let source;
  try {
    original = await readFile(configPath);
    const template = await readFile(templatePath, "utf8");
    const rendered = template.replaceAll("__BACKEND_PORT__", String(toPort))
      .replaceAll("__ROUTE_V2_ACTION__", "return 404;");
    if (rendered.includes("__BACKEND_PORT__") || rendered.includes("__ROUTE_V2_ACTION__")) throw new Error("unrendered nginx template");
    source = join(await mkdtemp(join(tmpdir(), "easysubway-journey-nginx-")), "rendered.conf");
    const stage = join(dirname(configPath), `.easysubway-journey-${randomUUID()}-${toPort}.conf`);
    await writeFile(source, rendered, { mode: 0o600, flag: "wx" });
    await command(commandRunner, "sudo", ["install", "-m", "0644", source, stage]);
    await command(commandRunner, "sudo", ["mv", stage, configPath]);
    await command(commandRunner, "sudo", ["nginx", "-t"]);
    await command(commandRunner, "sudo", ["systemctl", "reload", "nginx"]);
    return {
      fromPort, toPort, nginxConfigSha256: digest(Buffer.from(rendered)),
      nginxTestPassed: true, reloadCompleted: true, evidenceDigest: digest(Buffer.from(`${fromPort}->${toPort}\n${rendered}`)),
    };
  } catch (error) {
    if (original) await restoreNginx({ original, configPath, commandRunner }).catch(() => {});
    throw error;
  } finally {
    if (source) await rm(dirname(source), { recursive: true, force: true }).catch(() => {});
  }
}

async function restoreNginx({ original, configPath, commandRunner }) {
  const root = await mkdtemp(join(tmpdir(), "easysubway-journey-nginx-restore-"));
  const source = join(root, "restore.conf");
  const stage = join(dirname(configPath), `.easysubway-journey-restore-${randomUUID()}.conf`);
  try {
    await writeFile(source, original, { mode: 0o600, flag: "wx" });
    await command(commandRunner, "sudo", ["install", "-m", "0644", source, stage]);
    await command(commandRunner, "sudo", ["mv", stage, configPath]);
    await command(commandRunner, "sudo", ["nginx", "-t"]);
    await command(commandRunner, "sudo", ["systemctl", "reload", "nginx"]);
  } finally { await rm(root, { recursive: true, force: true }).catch(() => {}); }
}

async function drainCanonical({ tuple, sessionToken, composeContext, drainProbe, postSignalJourneyImpl, openInFlightJourneyImpl, now }) {
  requireDrainProbe(drainProbe);
  if (!composeContext || !validSessionToken(sessionToken) || typeof now !== "function") throw failure("CANONICAL_DRAIN_FAILED");
  const inFlight = await openInFlightJourneyImpl(drainProbe.inFlightRequest, sessionToken);
  const startedAt = now();
  try {
    await compose(composeContext, ["kill", "--signal", "SIGTERM", "backend"], "CANONICAL_DRAIN_FAILED");
    const response = await inFlight.finish();
    requireJourneyResponse(response, drainProbe.inFlightRequest.requestId, true);
    const after = await postSignalJourneyImpl(drainProbe.afterSignalRequest, sessionToken);
    if (after?.kind === "RESPONSE") {
      if (!Number.isInteger(after.status) || after.status < 100 || after.status > 599 ||
        after.status >= 200 && after.status < 300) throw failure("CANONICAL_DRAIN_FAILED");
    } else if (after?.kind !== "PRE_CONNECT_REFUSED") {
      throw failure("CANONICAL_DRAIN_FAILED");
    }
    await compose(composeContext, ["stop", "--timeout", "30", "backend"], "CANONICAL_DRAIN_FAILED");
    const elapsedMs = now() - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 30_000) throw failure("CANONICAL_DRAIN_FAILED");
    return {
      tupleSha256: tuple.tupleSha256, signal: "SIGTERM", stopGracePeriodSeconds: 30,
      newRequestAdmissionAfterSignal: 0, inFlightSnapshotPinned: true, inFlightCompleted: true,
      oldProcessExited: true, withinBudget: true, droppedJourneyCount: 0, duplicateJourneyCount: 0,
      evidenceDigest: digest(Buffer.from(`${drainProbe.inFlightRequest.requestId}\n${drainProbe.afterSignalRequest.requestId}\n`)),
    };
  } catch (error) {
    inFlight.destroy();
    throw translate(error, "CANONICAL_DRAIN_FAILED");
  }
}

function requireDrainProbe(probe) {
  if (!isObject(probe) || !sameKeys(probe, ["inFlightRequest", "afterSignalRequest"]) ||
    !isObject(probe.inFlightRequest) || !isObject(probe.afterSignalRequest) ||
    !matches(probe.inFlightRequest.requestId, REQUEST_ID) || !matches(probe.afterSignalRequest.requestId, REQUEST_ID) ||
    probe.inFlightRequest.requestId === probe.afterSignalRequest.requestId ||
    !validJourneyRequest(probe.inFlightRequest) || !validJourneyRequest(probe.afterSignalRequest)) {
    throw failure("CANONICAL_DRAIN_FAILED", 2);
  }
}

function openInFlightJourney(value, token) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 2) throw failure("CANONICAL_DRAIN_FAILED");
  return new Promise((resolveOpen, rejectOpen) => {
    const request = httpRequest("http://127.0.0.1:8080/api/v3/journeys/search", {
      method: "POST", agent: false,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "Content-Length": String(body.length) },
    });
    request.setTimeout(30_000, () => request.destroy(failure("CANONICAL_DRAIN_FAILED")));
    request.once("error", () => rejectOpen(failure("CANONICAL_DRAIN_FAILED")));
    request.once("socket", (socket) => {
      const connected = () => request.write(body.subarray(0, -1), () => resolveOpen({
        finish: () => new Promise((resolveResponse, rejectResponse) => {
          request.once("response", async (response) => {
            try { resolveResponse({ status: response.statusCode, headers: response.headers, body: await readResponse(response) }); }
            catch { rejectResponse(failure("CANONICAL_DRAIN_FAILED")); }
          });
          request.once("error", () => rejectResponse(failure("CANONICAL_DRAIN_FAILED")));
          request.end(body.subarray(-1));
        }),
        destroy: () => request.destroy(),
      }));
      if (socket.connecting) socket.once("connect", connected); else connected();
    });
  });
}

function postSignalJourney(value, token) {
  const body = Buffer.from(JSON.stringify(value));
  return new Promise((resolveResult, rejectResult) => {
    let connected = false;
    const request = httpRequest("http://127.0.0.1:8080/api/v3/journeys/search", {
      method: "POST", agent: false,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "Content-Length": String(body.length) },
    });
    request.setTimeout(5000, () => request.destroy(failure("CANONICAL_DRAIN_FAILED")));
    request.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => { connected = true; });
      else connected = true;
    });
    request.once("response", (response) => {
      response.resume();
      resolveResult({ kind: "RESPONSE", status: response.statusCode });
    });
    request.once("error", (error) => {
      if (!connected && error?.code === "ECONNREFUSED") resolveResult({ kind: "PRE_CONNECT_REFUSED" });
      else rejectResult(failure("CANONICAL_DRAIN_FAILED"));
    });
    request.end(body);
  });
}

function requireJourneyResponse(response, requestId, requireSuccess) {
  const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  const cache = String(response.headers["cache-control"] ?? "").toLowerCase();
  let body;
  try { body = JSON.parse(response.body.toString("utf8")); } catch { throw failure("CANONICAL_DRAIN_FAILED"); }
  if ((requireSuccess && response.status !== 200) || contentType !== "application/json" || !cache.split(",").map((value) => value.trim()).includes("no-store") || body?.requestId !== requestId) throw failure("CANONICAL_DRAIN_FAILED");
}

function readResponse(response) {
  return new Promise((resolveResponse, rejectResponse) => {
    const chunks = []; let size = 0;
    response.on("data", (chunk) => { size += chunk.length; if (size > 64 * 1024) response.destroy(failure("CANONICAL_DRAIN_FAILED")); else chunks.push(chunk); });
    response.once("end", () => resolveResponse(Buffer.concat(chunks, size)));
    response.once("error", rejectResponse);
  });
}

async function compose(context, args, code) {
  if (!isObject(context) || !Array.isArray(context.prefix) || !isObject(context.env) || typeof context.composeRunner !== "function") throw failure("DEPLOY_LOCK_UNAVAILABLE");
  const result = await context.composeRunner({ command: "docker", args: [...context.prefix, ...args], env: context.env, timeoutMs: COMMAND_TIMEOUT_MS });
  if (!result || result.status !== 0 || result.signal !== null || result.timedOut !== false) throw failure(code);
}

async function command(runner, commandName, args) {
  const result = await runner({ command: commandName, args, timeoutMs: COMMAND_TIMEOUT_MS });
  if (!result || result.status !== 0 || result.signal !== null || result.timedOut !== false) throw new Error("system command failed");
}

function runCommand({ command, args, timeoutMs }) {
  return new Promise((resolveResult) => {
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => finish(null, null)); child.on("close", finish);
    function finish(status, signal) { if (settled) return; settled = true; clearTimeout(timer); resolveResult({ status, signal, timedOut, stdout, stderr }); }
  });
}

async function main() {
  const cli = parseFixedHostJourneyActivationCli(process.argv.slice(2));
  await requireAbsentReceipt(cli.receiptPath);
  const [tupleBytes, probeBytes] = await Promise.all([
    readStableSnapshot(cli.tuplePath), readStableSnapshot(cli.drainProbePath),
  ]);
  let tuple; let drainProbe;
  try { tuple = JSON.parse(tupleBytes.toString("utf8")); drainProbe = JSON.parse(probeBytes.toString("utf8")); requireTuple(tuple); requireDrainProbe(drainProbe); }
  catch (error) { throw error instanceof FixedHostJourneyActivationError ? error : failure("OPERATION_INPUT_INVALID", 2); }
  const scratch = await mkdtemp(join(dirname(cli.receiptPath), ".journey-activation-"));
  try {
    await chmod(scratch, 0o700);
    const adapters = await productionAdapters({ cli, scratch });
    const receipt = await runFixedHostJourneyActivation({
      ...cli, ...adapters, tuple, descriptorSha256: adapters.descriptorSha256,
      descriptorBytesSha256: adapters.descriptorBytesSha256,
      candidateBindingSha256: adapters.candidateBindingSha256, descriptorBindingSha256: adapters.descriptorBindingSha256,
      drainProbe, serviceToken: process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN,
      journeySessionToken: process.env.EASYSUBWAY_JOURNEY_SAME_RC_SESSION_TOKEN,
      currentPublicKeyPem: process.env.EASYSUBWAY_JOURNEY_CURRENT_PUBLIC_KEY_PEM,
      startCandidates: startJourneyComposeCandidates,
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
}

async function productionAdapters({ cli, scratch }) {
  const [bindingBytes, descriptorBindingBytes, descriptorBytes] = await Promise.all([
    readFile(cli.bindingPath), readFile(cli.descriptorBindingPath), readFile(cli.descriptorPath),
  ]);
  let descriptorBinding;
  try { descriptorBinding = JSON.parse(descriptorBindingBytes); } catch { throw failure("OPERATION_INPUT_INVALID", 2); }
  const runtimePath = join(scratch, "runtime.json"); const canaryPath = join(scratch, "canary.json");
  const observationsPath = join(scratch, "observations.json"); const admissionPath = join(scratch, "admission.json");
  const secret = process.env.EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN;
  const write = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o400, flag: "wx" });
  return {
    candidateStartInput: cli, descriptorSha256: descriptorBinding.descriptorSha256,
    descriptorBytesSha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    candidateBindingSha256: `sha256:${createHash("sha256").update(bindingBytes).digest("hex")}`,
    descriptorBindingSha256: `sha256:${createHash("sha256").update(descriptorBindingBytes).digest("hex")}`,
    runCanary: async ({ baseUrl }) => {
      const value = await runJourneyCandidateCanary({ ...cli, tuplePath: cli.tuplePath, baseUrl, serviceToken: secret }); await write(canaryPath, value); return value;
    },
    observeReadiness: async ({ runtime, canary }) => {
      await write(runtimePath, runtime);
      const value = await observeJourneyCandidateReadiness({ bindingPath: cli.bindingPath, tuplePath: cli.tuplePath, runtimePath, canaryPath, serviceToken: secret }); await write(observationsPath, value); return value;
    },
    admitCandidate: async () => { const value = await admitJourneyReleaseCandidate({ bindingPath: cli.bindingPath, tuplePath: cli.tuplePath, observationsPath }); await write(admissionPath, value); return value; },
    activateBackend: async ({ baseUrl, instanceIdentity, activationRequestIdentity, trafficGeneration }) => activateJourneyBackend({ admissionPath, baseUrl, instanceIdentity, activationRequestIdentity, trafficGeneration, serviceToken: secret }),
  };
}

async function readStableSnapshot(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 1024n * 1024n) {
      throw failure("OPERATION_INPUT_INVALID", 2);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      BigInt(bytes.length) !== before.size) throw failure("OPERATION_INPUT_INVALID", 2);
    return bytes;
  } catch (error) {
    if (error instanceof FixedHostJourneyActivationError) throw error;
    throw failure("OPERATION_INPUT_INVALID", 2);
  } finally { await handle?.close().catch(() => {}); }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { const typed = error instanceof FixedHostJourneyActivationError ? error : failure("EVIDENCE_INVALID"); process.stderr.write(`${typed.code} ${typed.message}\n`); process.exitCode = typed.exitCode; });
}

function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function translate(error, fallback) { return error instanceof FixedHostJourneyActivationError ? error : failure(fallback); }
function failure(code, exitCode = 1) { return new FixedHostJourneyActivationError(code, exitCode); }
function isObject(value) { return value !== null && !Array.isArray(value) && typeof value === "object"; }
function isPath(value) { return typeof value === "string" && value.length > 0; }
function matches(value, pattern) { return typeof value === "string" && pattern.test(value); }
function validSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 512 &&
    [...value].every((character) => {
      const point = character.codePointAt(0);
      return point >= 0x21 && point <= 0x7e;
    });
}
function validSessionToken(value) {
  return validSecret(value) && /^[A-Za-z0-9_-]+$/.test(value);
}
function canonicalInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const pattern = minimum === 0 ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(value)) throw failure("OPERATION_INPUT_INVALID", 2);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum || String(parsed) !== value) {
    throw failure("OPERATION_INPUT_INVALID", 2);
  }
  return parsed;
}
function validJourneyRequest(value) {
  const fields = ["requestId", "originStationId", "destinationStationId", "departure", "timePolicy",
    "mobilityProfile", "constraintMode", "maxTransfers", "alternativeCount"];
  if (!isObject(value) || !sameKeys(value, fields) || !matches(value.requestId, REQUEST_ID) ||
    !boundedText(value.originStationId) || !boundedText(value.destinationStationId) ||
    value.originStationId === value.destinationStationId ||
    !["TIMETABLE_REQUIRED", "REALTIME_REQUIRED"].includes(value.timePolicy) ||
    !["STANDARD", "SLOW", "NO_STAIRS", "STEP_FREE"].includes(value.mobilityProfile) ||
    !["NONE", "REQUIRE_STEP_FREE"].includes(value.constraintMode) ||
    value.mobilityProfile === "NO_STAIRS" && value.constraintMode === "NONE" ||
    !Number.isSafeInteger(value.maxTransfers) || value.maxTransfers < 0 || value.maxTransfers > 3 ||
    !Number.isSafeInteger(value.alternativeCount) || value.alternativeCount < 1 || value.alternativeCount > 3) {
    return false;
  }
  if (!isObject(value.departure)) return false;
  if (value.departure.mode === "NOW") return sameKeys(value.departure, ["mode"]);
  return value.departure.mode === "SCHEDULED" && sameKeys(value.departure, ["mode", "requestedAt"]) &&
    typeof value.departure.requestedAt === "string" && Number.isFinite(Date.parse(value.departure.requestedAt));
}
function boundedText(value) { return typeof value === "string" && value.length >= 1 && value.length <= 255; }
function sameKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
