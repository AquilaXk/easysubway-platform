import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { admitJourneyReleaseCandidate } from "./admit-journey-release-candidate.mjs";
import {
  CandidateObservationError,
  formatCandidateObservations,
  observeJourneyCandidateReadiness,
} from "./observe-journey-candidate-readiness.mjs";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const SCRIPT = new URL("./observe-journey-candidate-readiness.mjs", import.meta.url);
const TOKEN = "candidate-readiness-token-0123456789abcdef";

test("one authenticated inactive candidate response normalizes into the admission contract", async () => {
  const fixture = await createFixture();
  const calls = [];
  const responses = new Map(fixture.runtime.instances.map((instance, index) => [
    `${instance.baseUrl}/internal/v1/journey/readiness/candidate`,
    response(candidateResponse(fixture.tuple, instance.instanceIdentity, index + 1)),
  ]));

  const observations = await observeJourneyCandidateReadiness({
    ...fixture.paths,
    serviceToken: TOKEN,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.get(url);
    },
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "http://127.0.0.1:18081/internal/v1/journey/readiness/candidate",
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.options.headers.Accept, "application/json");
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.deepEqual(observations.instances.map((instance) => [
    instance.instanceIdentity,
    instance.failureDomainIdentity,
    instance.tupleSha256,
    instance.candidateGeneration,
    instance.readinessEvidenceDigest,
  ]), [
    ["candidate-01", "oci-host-easysubway-a1", fixture.tuple.tupleSha256, 1,
      `sha256:${candidateResponse(fixture.tuple, "candidate-01", 1).evidenceSha256}`],
  ]);
  assert.deepEqual(observations.canary, {
    passed: true,
    evidenceDigest: digest("9"),
    legacyGraphSuccessCount: 0,
    localRouteInvocationCount: 0,
    staleJourneyServedCount: 0,
    alternateEndpointSuccessCount: 0,
  });

  const observationsPath = join(fixture.root, "observations.json");
  await writeFile(observationsPath, formatCandidateObservations(observations));
  const admission = await admitJourneyReleaseCandidate({
    bindingPath: fixture.paths.bindingPath,
    tuplePath: fixture.paths.tuplePath,
    observationsPath,
  });
  assert.equal(admission.instanceCount, 1);
  assert.equal(admission.failureDomainCount, 1);
  assert.equal(admission.tupleSha256, fixture.tuple.tupleSha256);
  assert.equal(admission.candidateGeneration, 1);
});

test("HTTP, schema, identity, freshness and evidence failures are closed and bounded", async () => {
  const cases = [
    ["401", () => response({}, { status: 401 }), "CANDIDATE_READINESS_HTTP"],
    ["403", () => response({}, { status: 403 }), "CANDIDATE_READINESS_HTTP"],
    ["503", () => response({}, { status: 503 }), "CANDIDATE_READINESS_HTTP"],
    ["non-JSON", ({ valid }) => response(valid, { contentType: "text/plain" }), "CANDIDATE_READINESS_HTTP"],
    ["oversize", () => response("x".repeat(64 * 1024 + 1)), "CANDIDATE_READINESS_RESPONSE"],
    ["extra field", ({ valid }) => response({ ...valid, extra: true }), "CANDIDATE_READINESS_RESPONSE"],
    ["zero generation", ({ valid }) => response({ ...valid, generation: 0 }), "CANDIDATE_READINESS_RESPONSE"],
    ["identity mismatch", ({ valid }) => response({ ...valid, releaseTupleSha256: "0".repeat(64) }), "CANDIDATE_READINESS_IDENTITY"],
    ["stale", ({ valid }) => response({ ...valid, freshUntil: NOW.toISOString() }), "CANDIDATE_READINESS_FRESHNESS"],
    ["evidence mismatch", ({ valid }) => response({ ...valid, evidenceSha256: "0".repeat(64) }), "CANDIDATE_READINESS_EVIDENCE"],
    ["network", () => { throw new TypeError("private endpoint and token must not escape"); }, "CANDIDATE_READINESS_NETWORK"],
  ];

  for (const [name, mutate, code] of cases) {
    const fixture = await createFixture();
    let attempts = 0;
    await assert.rejects(
      observeJourneyCandidateReadiness({
        ...fixture.paths,
        serviceToken: TOKEN,
        now: () => NOW,
        fetchImpl: async (_url, _options) => {
          const index = attempts++;
          const valid = candidateResponse(
            fixture.tuple,
            fixture.runtime.instances[index].instanceIdentity,
            index + 1,
          );
          return index === 0 ? mutate({ valid }) : response(valid);
        },
      }),
      (error) => error instanceof CandidateObservationError && error.code === code,
      name,
    );
    assert.equal(attempts, 1, `${name} must make one bounded attempt for the inactive candidate`);
  }
});

test("runtime, canary and secret validation fail before network", async () => {
  const fixture = await createFixture();
  const invalids = [
    ["short token", { serviceToken: "short" }, "CANDIDATE_OBSERVATION_SECRET"],
    ["missing candidate", {
      runtime: {
        ...fixture.runtime,
        instances: [],
      },
    }, "CANDIDATE_OBSERVATION_RUNTIME"],
    ["external HTTPS host", {
      runtime: {
        ...fixture.runtime,
        instances: fixture.runtime.instances.map((instance, index) => ({
          ...instance,
          baseUrl: index === 0 ? "https://readiness.example.test" : instance.baseUrl,
        })),
      },
    }, "CANDIDATE_OBSERVATION_RUNTIME"],
    ["nonzero fallback", {
      canary: { ...fixture.canary, legacyGraphSuccessCount: 1 },
    }, "CANDIDATE_OBSERVATION_CANARY"],
  ];

  for (const [name, change, code] of invalids) {
    const paths = { ...fixture.paths };
    if (change.runtime) {
      paths.runtimePath = join(fixture.root, `${name}-runtime.json`);
      await writeFile(paths.runtimePath, canonical(change.runtime));
    }
    if (change.canary) {
      paths.canaryPath = join(fixture.root, `${name}-canary.json`);
      await writeFile(paths.canaryPath, canonical(change.canary));
    }
    let attempts = 0;
    await assert.rejects(
      observeJourneyCandidateReadiness({
        ...paths,
        serviceToken: change.serviceToken ?? TOKEN,
        now: () => NOW,
        fetchImpl: async () => { attempts += 1; },
      }),
      (error) => error instanceof CandidateObservationError && error.code === code,
      name,
    );
    assert.equal(attempts, 0);
  }
});

test("CLI failures expose only a closed code", async () => {
  const fixture = await createFixture();
  const result = spawnSync(process.execPath, [
    SCRIPT.pathname,
    "--binding", fixture.paths.bindingPath,
    "--tuple", fixture.paths.tuplePath,
    "--runtime", fixture.paths.runtimePath,
    "--canary", fixture.paths.canaryPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN: "private" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^CANDIDATE_OBSERVATION_SECRET /);
  for (const forbidden of [fixture.root, "private", "127.0.0.1", "candidate-01"]) {
    assert.equal(result.stderr.includes(forbidden), false);
  }
  assert.equal(result.stdout, "");
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "journey-readiness-observation-"));
  const tuple = validTuple();
  const tupleBody = canonical(tuple);
  const binding = {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: tuple.deploymentRevision,
    environmentIdentity: tuple.environmentIdentity,
    handoffSha256: "f".repeat(64),
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
  };
  const runtime = {
    schemaVersion: "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1",
    artifactKind: "journey-compose-candidate-runtime",
    orchestrator: "COMPOSE",
    instances: [
      { instanceIdentity: "candidate-01", failureDomainIdentity: "oci-host-easysubway-a1", baseUrl: "http://127.0.0.1:18081" },
    ],
  };
  const canary = {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1",
    artifactKind: "journey-candidate-canary",
    tupleSha256: tuple.tupleSha256,
    passed: true,
    evidenceDigest: digest("9"),
    legacyGraphSuccessCount: 0,
    localRouteInvocationCount: 0,
    staleJourneyServedCount: 0,
    alternateEndpointSuccessCount: 0,
  };
  const paths = {
    bindingPath: join(root, "binding.json"),
    tuplePath: join(root, "tuple.json"),
    runtimePath: join(root, "runtime.json"),
    canaryPath: join(root, "canary.json"),
  };
  await Promise.all([
    writeFile(paths.bindingPath, `${JSON.stringify(binding)}\n`),
    writeFile(paths.tuplePath, tupleBody),
    writeFile(paths.runtimePath, canonical(runtime)),
    writeFile(paths.canaryPath, canonical(canary)),
  ]);
  return { root, tuple, binding, runtime, canary, paths };
}

function validTuple() {
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("a"),
    backendConfigDigest: digest("b"),
    journeyContractDigest: digest("c"),
    serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
  };
  const identity = [
    tuple.backendImageDigest,
    tuple.backendConfigDigest,
    tuple.journeyContractDigest,
    tuple.serverRouteBundleDigest,
    tuple.deploymentRevision,
    tuple.environmentIdentity,
  ].join("\n");
  return { ...tuple, tupleSha256: sha256(`${identity}\n`) };
}

function candidateResponse(tuple, instanceId, evidenceCharacter) {
  const value = {
    schemaVersion: 1,
    artifactKind: "journey-v3-candidate-readiness",
    instanceId,
    releaseTupleSha256: tuple.tupleSha256.slice(7),
    backendImageDigest: tuple.backendImageDigest,
    backendConfigSha256: tuple.backendConfigDigest.slice(7),
    journeyContractSha256: tuple.journeyContractDigest.slice(7),
    routeBundleManifestSha256: tuple.serverRouteBundleDigest.slice(7),
    bundleId: "itx-current-20260813",
    bundleReleaseSequence: 7,
    generation: evidenceCharacter,
    warmed: true,
    ready: true,
    freshUntil: "2026-08-13T01:00:00Z",
    verifiedAt: "2026-08-12T23:58:00Z",
    stagedAt: "2026-08-12T23:57:00Z",
  };
  return { ...value, evidenceSha256: readinessEvidence(value) };
}

function readinessEvidence(value) {
  const fields = [
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
    "warmed", value.warmed,
    "ready", value.ready,
    "freshUntil", value.freshUntil,
    "verifiedAt", value.verifiedAt,
    "stagedAt", value.stagedAt,
  ];
  const canonicalEvidence = fields.map((field) => {
    const text = String(field);
    return `${Buffer.byteLength(text, "utf8")}:${text}`;
  }).join("");
  return createHash("sha256").update(canonicalEvidence, "utf8").digest("hex");
}

function response(body, { status = 200, contentType = "application/json" } = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        if (name.toLowerCase() === "cache-control") return "no-store";
        return null;
      },
    },
    async arrayBuffer() { return bytes; },
  };
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}
