import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JourneyCandidateCanaryAdapterError,
  formatJourneyCandidateCanary,
  runJourneyCandidateCanary,
} from "./run-journey-candidate-canary.mjs";

const NOW = new Date("2026-08-13T03:00:00.000Z");
const TOKEN = "journey-readiness-token-0123456789abcdef";
const REQUEST_ID = "01K2H7Q5B7E3T19N8J4M6P0R2V";
const SCRIPT = new URL("./run-journey-candidate-canary.mjs", import.meta.url);
let invalidTupleSequence = 0;

test("one authenticated canary POST returns canonical Platform evidence", async () => {
  const fixture = await createFixture();
  const calls = [];
  const result = await runJourneyCandidateCanary({
    ...validInput(fixture),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(canaryResponse(fixture.tuple));
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8082/internal/v1/journey/canary");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls[0].options.headers, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.equal(calls[0].options.body, JSON.stringify(command(fixture.tuple)));
  assert.deepEqual(result, {
    schemaVersion: "PLATFORM_JOURNEY_CANDIDATE_CANARY_V1",
    artifactKind: "journey-candidate-canary",
    tupleSha256: fixture.tuple.tupleSha256,
    passed: true,
    evidenceDigest: `sha256:${canaryResponse(fixture.tuple).evidenceSha256}`,
    legacyGraphSuccessCount: 0,
    localRouteInvocationCount: 0,
    staleJourneyServedCount: 0,
    alternateEndpointSuccessCount: 0,
  });
  assert.equal(
    formatJourneyCandidateCanary(result),
    `${JSON.stringify(result, null, 2)}\n`,
  );
});

test("tuple, command, host, and secret failures make no network request", async () => {
  const fixture = await createFixture();
  const cases = [
    ["tuple extra", await mutateTuple(fixture, (value) => { value.extra = true; }), {}, "JOURNEY_CANARY_INPUT"],
    ["external host", fixture.path, { baseUrl: "https://backend.example.test" }, "JOURNEY_CANARY_USAGE"],
    ["zero generation", fixture.path, { candidateGeneration: 0 }, "JOURNEY_CANARY_USAGE"],
    ["lowercase ULID", fixture.path, { requestId: REQUEST_ID.toLowerCase() }, "JOURNEY_CANARY_USAGE"],
    ["same station", fixture.path, { destinationStationId: "0108" }, "JOURNEY_CANARY_USAGE"],
    ["invalid enum", fixture.path, { mobilityProfile: "LEGACY" }, "JOURNEY_CANARY_USAGE"],
    ["invalid mobility constraint", fixture.path, {
      mobilityProfile: "NO_STAIRS", constraintMode: "NONE",
    }, "JOURNEY_CANARY_USAGE"],
    ["transfer bound", fixture.path, { maxTransfers: 4 }, "JOURNEY_CANARY_USAGE"],
    ["alternative bound", fixture.path, { alternativeCount: 0 }, "JOURNEY_CANARY_USAGE"],
    ["short token", fixture.path, { serviceToken: "short" }, "JOURNEY_CANARY_SECRET"],
    ["non-ASCII token", fixture.path, {
      serviceToken: `${"a".repeat(31)}界`,
    }, "JOURNEY_CANARY_SECRET"],
  ];

  for (const [name, tuplePath, change, code] of cases) {
    let attempts = 0;
    await assert.rejects(
      runJourneyCandidateCanary({
        ...validInput(fixture),
        tuplePath,
        fetchImpl: async () => { attempts += 1; },
        ...change,
      }),
      (error) => error instanceof JourneyCandidateCanaryAdapterError && error.code === code,
      name,
    );
    assert.equal(attempts, 0, name);
  }
});

test("HTTP, bounded body, response, identity, timestamp, and evidence failures make one attempt", async () => {
  const cases = [
    ...[400, 401, 403, 409, 503].map((status) => [
      `${status}`, () => response({}, { status }), "JOURNEY_CANARY_HTTP",
    ]),
    ["non-JSON", ({ valid }) => response(valid, { contentType: "text/plain" }), "JOURNEY_CANARY_HTTP"],
    ["cacheable", ({ valid }) => response(valid, { cacheControl: "max-age=60" }), "JOURNEY_CANARY_HTTP"],
    ["redirect", () => { throw new TypeError("redirected private URL"); }, "JOURNEY_CANARY_NETWORK"],
    ["timeout", () => { throw new DOMException("private", "TimeoutError"); }, "JOURNEY_CANARY_NETWORK"],
    ["oversize", () => response("x".repeat(64 * 1024 + 1)), "JOURNEY_CANARY_RESPONSE"],
    ["non-stream", ({ valid }) => nonStreamResponse(valid), "JOURNEY_CANARY_RESPONSE"],
    ["reordered", ({ valid }) => response({
      artifactKind: valid.artifactKind,
      schemaVersion: valid.schemaVersion,
      ...Object.fromEntries(Object.entries(valid).slice(2)),
    }), "JOURNEY_CANARY_RESPONSE"],
    ["extra", ({ valid }) => response({ ...valid, extra: true }), "JOURNEY_CANARY_RESPONSE"],
    ["wrong type", ({ valid }) => response({ ...valid, candidateGeneration: "7" }), "JOURNEY_CANARY_RESPONSE"],
    ["manifest identity", ({ valid }) => response({
      ...valid, candidateManifestSha256: "f".repeat(64),
    }), "JOURNEY_CANARY_IDENTITY"],
    ["generation identity", ({ valid }) => response({
      ...valid, candidateGeneration: 8,
    }), "JOURNEY_CANARY_IDENTITY"],
    ["request identity", ({ valid }) => response({
      ...valid, canaryRequestIdentity: "other",
    }), "JOURNEY_CANARY_IDENTITY"],
    ["query identity", ({ valid }) => response({
      ...valid, queryId: "01K2H7Q5B7E3T19N8J4M6P0R2W",
    }), "JOURNEY_CANARY_IDENTITY"],
    ["counter", ({ valid }) => response({
      ...valid, localRouteInvocationCount: 1,
    }), "JOURNEY_CANARY_RESPONSE"],
    ["future capturedAt", ({ valid }) => response({
      ...valid, capturedAt: "2026-08-13T03:00:01Z",
    }), "JOURNEY_CANARY_TIMESTAMP"],
    ["impossible capturedAt", ({ valid }) => response({
      ...valid, capturedAt: "2026-02-30T03:00:00Z",
    }), "JOURNEY_CANARY_RESPONSE"],
    ["evidence", ({ valid }) => response({
      ...valid, evidenceSha256: "0".repeat(64),
    }), "JOURNEY_CANARY_EVIDENCE"],
  ];

  for (const [name, mutate, code] of cases) {
    const fixture = await createFixture();
    let attempts = 0;
    await assert.rejects(
      runJourneyCandidateCanary({
        ...validInput(fixture),
        fetchImpl: async () => {
          attempts += 1;
          return mutate({ valid: canaryResponse(fixture.tuple) });
        },
      }),
      (error) => error instanceof JourneyCandidateCanaryAdapterError && error.code === code,
      name,
    );
    assert.equal(attempts, 1, name);
  }
});

test("tuple drift after the request fails closed", async () => {
  const fixture = await createFixture();
  let attempts = 0;
  await assert.rejects(
    runJourneyCandidateCanary({
      ...validInput(fixture),
      fetchImpl: async () => {
        attempts += 1;
        await writeFile(fixture.path, `${JSON.stringify({ ...fixture.tuple, extra: true })}\n`);
        return response(canaryResponse(fixture.tuple));
      },
    }),
    (error) => error instanceof JourneyCandidateCanaryAdapterError &&
      error.code === "JOURNEY_CANARY_INPUT_UNSTABLE",
  );
  assert.equal(attempts, 1);
});

test("CLI failure emits only a closed code", async () => {
  const fixture = await createFixture();
  const result = spawnSync(process.execPath, [
    SCRIPT.pathname,
    "--tuple", fixture.path,
    "--base-url", "http://127.0.0.1:8082",
    "--candidate-generation", "7",
    "--canary-request-identity", "deploy-abc:standby",
    "--request-id", REQUEST_ID,
    "--origin-station-id", "0108",
    "--destination-station-id", "0201",
    "--mobility-profile", "STANDARD",
    "--constraint-mode", "NONE",
    "--max-transfers", "3",
    "--alternative-count", "3",
  ], {
    encoding: "utf8",
    env: { ...process.env, EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN: "private" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^JOURNEY_CANARY_SECRET /);
  for (const forbidden of [fixture.root, "private", "127.0.0.1", "0108", "0201"]) {
    assert.equal(result.stderr.includes(forbidden), false);
  }
  assert.equal(result.stdout, "");
});

function validInput(fixture) {
  return {
    tuplePath: fixture.path,
    baseUrl: "http://127.0.0.1:8082",
    candidateGeneration: 7,
    canaryRequestIdentity: "deploy-abc:standby",
    requestId: REQUEST_ID,
    originStationId: "0108",
    destinationStationId: "0201",
    mobilityProfile: "STANDARD",
    constraintMode: "NONE",
    maxTransfers: 3,
    alternativeCount: 3,
    serviceToken: TOKEN,
    now: () => NOW,
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "journey-candidate-canary-"));
  const tuple = createTuple();
  const path = join(root, "tuple.json");
  await writeFile(path, `${JSON.stringify(tuple, null, 2)}\n`);
  return { root, path, tuple };
}

async function mutateTuple(fixture, mutate) {
  const value = structuredClone(fixture.tuple);
  mutate(value);
  const path = join(fixture.root, `invalid-${invalidTupleSequence++}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function createTuple() {
  const value = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digestReference("backend-image"),
    backendConfigDigest: digestReference("backend-config"),
    journeyContractDigest: digestReference("journey-contract"),
    serverRouteBundleDigest: digestReference("route-bundle"),
    deploymentRevision: "6".repeat(40),
    environmentIdentity: "production",
  };
  const identity = [
    value.backendImageDigest,
    value.backendConfigDigest,
    value.journeyContractDigest,
    value.serverRouteBundleDigest,
    value.deploymentRevision,
    value.environmentIdentity,
  ];
  return {
    ...value,
    tupleSha256: digestReference(`${identity.join("\n")}\n`),
  };
}

function command(tuple) {
  return {
    schemaVersion: 1,
    artifactKind: "journey-v3-candidate-canary-command",
    canaryRequestIdentity: "deploy-abc:standby",
    candidateManifestSha256: tuple.serverRouteBundleDigest.slice(7),
    candidateGeneration: 7,
    requestId: REQUEST_ID,
    originStationId: "0108",
    destinationStationId: "0201",
    mobilityProfile: "STANDARD",
    constraintMode: "NONE",
    maxTransfers: 3,
    alternativeCount: 3,
  };
}

function canaryResponse(tuple) {
  const value = {
    schemaVersion: 1,
    artifactKind: "journey-v3-candidate-canary-result",
    canaryRequestIdentity: "deploy-abc:standby",
    requestId: REQUEST_ID,
    candidateManifestSha256: tuple.serverRouteBundleDigest.slice(7),
    candidateGeneration: 7,
    bundleId: "route-bundle-20260813",
    bundleReleaseSequence: 23,
    queryId: REQUEST_ID,
    capturedAt: "2026-08-13T02:59:59Z",
    passed: true,
    legacyGraphSuccessCount: 0,
    localRouteInvocationCount: 0,
    staleJourneyServedCount: 0,
    alternateEndpointSuccessCount: 0,
  };
  return { ...value, evidenceSha256: canaryEvidenceSha256(value) };
}

function canaryEvidenceSha256(value) {
  const canonical = Object.entries(value).flat().reduce((result, entry) => {
    const text = String(entry);
    return `${result}${Buffer.byteLength(text, "utf8")}:${text}`;
  }, "");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function response(value, {
  status = 200,
  contentType = "application/json; charset=utf-8",
  cacheControl = "no-store",
} = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": cacheControl },
  });
}

function nonStreamResponse(value) {
  return {
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    }),
    body: Buffer.from(JSON.stringify(value)),
    arrayBuffer: async () => Buffer.from(JSON.stringify(value)),
  };
}

function digestReference(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
