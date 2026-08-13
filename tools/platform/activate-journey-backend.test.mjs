import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JourneyBackendActivationError,
  activateJourneyBackend,
  formatJourneyBackendActivation,
} from "./activate-journey-backend.mjs";

const NOW = new Date("2026-08-13T03:00:00.000Z");
const TOKEN = "journey-readiness-token-0123456789abcdef";
const SCRIPT = new URL("./activate-journey-backend.mjs", import.meta.url);
let invalidAdmissionSequence = 0;

test("one authenticated activation POST returns canonical active evidence", async () => {
  const fixture = await createFixture();
  const calls = [];
  const result = await activateJourneyBackend({
    admissionPath: fixture.path,
    baseUrl: "http://127.0.0.1:8082",
    instanceIdentity: "backend-standby",
    activationRequestIdentity: "deploy-abc:standby",
    trafficGeneration: 31,
    serviceToken: TOKEN,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(activeResponse(fixture.admission, "backend-standby", 31));
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8082/internal/v1/journey/activation");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.equal(calls[0].options.body, JSON.stringify({
    schemaVersion: 1,
    artifactKind: "journey-v3-activation-command",
    activationRequestIdentity: "deploy-abc:standby",
    candidateManifestSha256: fixture.admission.serverRouteBundleDigest.slice(7),
    candidateGeneration: 7,
    expectedActiveGeneration: 6,
    trafficGeneration: 31,
  }));
  assert.deepEqual(result, {
    schemaVersion: "PLATFORM_JOURNEY_BACKEND_ACTIVATION_V1",
    artifactKind: "journey-backend-activation",
    instanceIdentity: "backend-standby",
    activationRequestIdentity: "deploy-abc:standby",
    candidateAdmissionSha256: fixture.admission.candidateAdmissionSha256,
    candidateGeneration: 7,
    trafficGeneration: 31,
    activeReadinessEvidenceDigest: `sha256:${activeResponse(
      fixture.admission, "backend-standby", 31,
    ).evidenceSha256}`,
  });
  assert.equal(formatJourneyBackendActivation(result), `${JSON.stringify(result)}\n`);
});

test("invalid admission, invocation, host, and secret fail before network", async () => {
  const fixture = await createFixture();
  const cases = [
    ["missing generation", await mutateAdmission(fixture, (value) => {
      delete value.candidateGeneration;
    }), {}, "JOURNEY_ACTIVATION_INPUT"],
    ["zero generation", await mutateAdmission(fixture, (value) => {
      value.candidateGeneration = 0;
    }), {}, "JOURNEY_ACTIVATION_INPUT"],
    ["extra field", await mutateAdmission(fixture, (value) => {
      value.extra = true;
    }), {}, "JOURNEY_ACTIVATION_INPUT"],
    ["reordered", await mutateAdmission(fixture, (value) => ({
      artifactKind: value.artifactKind,
      schemaVersion: value.schemaVersion,
      ...Object.fromEntries(Object.entries(value).slice(2)),
    })), {}, "JOURNEY_ACTIVATION_INPUT"],
    ["external host", fixture.path, { baseUrl: "https://backend.example.test" }, "JOURNEY_ACTIVATION_USAGE"],
    ["invalid instance", fixture.path, { instanceIdentity: "bad instance" }, "JOURNEY_ACTIVATION_USAGE"],
    ["zero traffic", fixture.path, { trafficGeneration: 0 }, "JOURNEY_ACTIVATION_USAGE"],
    ["short token", fixture.path, { serviceToken: "short" }, "JOURNEY_ACTIVATION_SECRET"],
  ];

  for (const [name, admissionPath, change, code] of cases) {
    let attempts = 0;
    await assert.rejects(
      activateJourneyBackend({
        admissionPath,
        baseUrl: "http://127.0.0.1:8082",
        instanceIdentity: "backend-standby",
        activationRequestIdentity: "deploy-abc:standby",
        trafficGeneration: 31,
        serviceToken: TOKEN,
        now: () => NOW,
        fetchImpl: async () => { attempts += 1; },
        ...change,
      }),
      (error) => error instanceof JourneyBackendActivationError && error.code === code,
      name,
    );
    assert.equal(attempts, 0, name);
  }
});

test("HTTP, response, identity, freshness, evidence, and network failures make one attempt", async () => {
  const cases = [
    ["401", () => response({}, { status: 401 }), "JOURNEY_ACTIVATION_HTTP"],
    ["409", () => response({}, { status: 409 }), "JOURNEY_ACTIVATION_HTTP"],
    ["503", () => response({}, { status: 503 }), "JOURNEY_ACTIVATION_HTTP"],
    ["non-JSON", ({ valid }) => response(valid, { contentType: "text/plain" }), "JOURNEY_ACTIVATION_HTTP"],
    ["cacheable", ({ valid }) => response(valid, { cacheControl: "max-age=60" }), "JOURNEY_ACTIVATION_HTTP"],
    ["oversize", () => response("x".repeat(64 * 1024 + 1)), "JOURNEY_ACTIVATION_RESPONSE"],
    ["extra field", ({ valid }) => response({ ...valid, extra: true }), "JOURNEY_ACTIVATION_RESPONSE"],
    ["identity", ({ valid }) => response({ ...valid, instanceId: "other" }), "JOURNEY_ACTIVATION_IDENTITY"],
    ["generation", ({ valid }) => response({ ...valid, generation: 8 }), "JOURNEY_ACTIVATION_IDENTITY"],
    ["traffic", ({ valid }) => response({ ...valid, trafficGeneration: 32 }), "JOURNEY_ACTIVATION_IDENTITY"],
    ["stale", ({ valid }) => response({ ...valid, freshUntil: NOW.toISOString() }), "JOURNEY_ACTIVATION_FRESHNESS"],
    ["evidence", ({ valid }) => response({ ...valid, evidenceSha256: "0".repeat(64) }), "JOURNEY_ACTIVATION_EVIDENCE"],
    ["network", () => { throw new TypeError("private response"); }, "JOURNEY_ACTIVATION_NETWORK"],
  ];

  for (const [name, mutate, code] of cases) {
    const fixture = await createFixture();
    let attempts = 0;
    await assert.rejects(
      activateJourneyBackend({
        admissionPath: fixture.path,
        baseUrl: "http://127.0.0.1:8082",
        instanceIdentity: "backend-standby",
        activationRequestIdentity: "deploy-abc:standby",
        trafficGeneration: 31,
        serviceToken: TOKEN,
        now: () => NOW,
        fetchImpl: async () => {
          attempts += 1;
          const valid = activeResponse(fixture.admission, "backend-standby", 31);
          return mutate({ valid });
        },
      }),
      (error) => error instanceof JourneyBackendActivationError && error.code === code,
      name,
    );
    assert.equal(attempts, 1, name);
  }
});

test("CLI failure emits only a closed code", async () => {
  const fixture = await createFixture();
  const result = spawnSync(process.execPath, [
    SCRIPT.pathname,
    "--admission", fixture.path,
    "--base-url", "http://127.0.0.1:8082",
    "--instance-identity", "backend-standby",
    "--activation-request-identity", "deploy-abc:standby",
    "--traffic-generation", "31",
  ], {
    encoding: "utf8",
    env: { ...process.env, EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN: "private" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^JOURNEY_ACTIVATION_SECRET /);
  for (const forbidden of [fixture.root, "private", "127.0.0.1", "backend-standby"]) {
    assert.equal(result.stderr.includes(forbidden), false);
  }
  assert.equal(result.stdout, "");
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "journey-backend-activation-"));
  const body = {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_ADMISSION_V1",
    artifactKind: "journey-candidate-admission",
    orchestrator: "COMPOSE",
    tupleSha256: digest("1"),
    backendImageDigest: digest("2"),
    backendConfigDigest: digest("3"),
    journeyContractDigest: digest("4"),
    serverRouteBundleDigest: digest("5"),
    deploymentRevision: "6".repeat(40),
    environmentIdentity: "production",
    bindingSha256: digest("7"),
    observationsSha256: digest("8"),
    handoffSha256: "9".repeat(64),
    instanceCount: 1,
    failureDomainCount: 1,
    canaryEvidenceDigest: digest("a"),
    candidateGeneration: 7,
  };
  const admission = {
    ...body,
    candidateAdmissionSha256: digest(Buffer.from(`${JSON.stringify(body)}\n`)),
  };
  const path = join(root, "admission.json");
  await writeFile(path, `${JSON.stringify(admission)}\n`);
  return { root, path, admission };
}

async function mutateAdmission(fixture, mutate) {
  const value = structuredClone(fixture.admission);
  const changed = mutate(value) ?? value;
  const path = join(fixture.root, `invalid-${invalidAdmissionSequence++}.json`);
  await writeFile(path, `${JSON.stringify(changed)}\n`);
  return path;
}

function activeResponse(admission, instanceId, trafficGeneration) {
  const value = {
    schemaVersion: 1,
    artifactKind: "journey-v3-active-readiness",
    instanceId,
    releaseTupleSha256: admission.tupleSha256.slice(7),
    backendImageDigest: admission.backendImageDigest,
    backendConfigSha256: admission.backendConfigDigest.slice(7),
    journeyContractSha256: admission.journeyContractDigest.slice(7),
    routeBundleManifestSha256: admission.serverRouteBundleDigest.slice(7),
    bundleId: "b".repeat(200),
    bundleReleaseSequence: 23,
    generation: admission.candidateGeneration,
    trafficGeneration,
    servingReady: true,
    draining: false,
    freshUntil: "2026-08-14T03:00:00Z",
    activatedAt: "2026-08-13T03:00:01Z",
  };
  return { ...value, evidenceSha256: activeEvidenceSha256(value) };
}

function activeEvidenceSha256(value) {
  const values = Object.entries(value).flat();
  const canonical = values.map((entry) => {
    const text = String(entry);
    return `${Buffer.byteLength(text, "utf8")}:${text}`;
  }).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function response(value, {
  status = 200,
  contentType = "application/json",
  cacheControl = "no-store",
} = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": cacheControl },
  });
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
