import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("multi-probe canary executes all 5 regional probes and returns aggregated evidence", async () => {
  const fixture = await createFixture();
  const probes = [
    { regionId: "capital", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2V", originStationId: "station-6a5e08288b46", destinationStationId: "station-gangnam", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "busan", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2W", originStationId: "station-1fc7a7c971c8", destinationStationId: "station-3752d457e1c0", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "daegu", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2X", originStationId: "station-44dc03b65cae", destinationStationId: "station-5b51eac5a29c", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "daejeon", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2Y", originStationId: "station-ee3cc9d04ee7", destinationStationId: "station-b35cc28f2c19", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "gwangju", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2Z", originStationId: "station-45d732c94df2", destinationStationId: "station-956d3c1b71cf", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
  ];
  const calls = [];
  const responses = probes.map((p) => canaryResponse(fixture.tuple, { requestId: p.requestId, queryId: p.requestId }));
  let callIndex = 0;
  const result = await runJourneyCandidateCanary({
    tuplePath: fixture.path,
    baseUrl: "http://127.0.0.1:8082",
    candidateGeneration: 7,
    canaryRequestIdentity: "deploy-abc:standby",
    probes,
    serviceToken: TOKEN,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(responses[callIndex++]);
    },
    now: () => NOW,
  });

  assert.equal(calls.length, 5);
  for (let i = 0; i < 5; i++) {
    const body = JSON.parse(calls[i].options.body);
    assert.equal(body.requestId, probes[i].requestId);
    assert.equal(body.originStationId, probes[i].originStationId);
    assert.equal(body.destinationStationId, probes[i].destinationStationId);
  }
  const expectedDigest = `sha256:${createHash("sha256").update(responses.map((r) => r.evidenceSha256).join(",")).digest("hex")}`;
  assert.equal(result.passed, true);
  assert.equal(result.evidenceDigest, expectedDigest);
});

test("multi-probe canary fails closed if any regional probe fails", async () => {
  const fixture = await createFixture();
  const probes = [
    { regionId: "capital", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2V", originStationId: "station-6a5e08288b46", destinationStationId: "station-gangnam", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "busan", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2W", originStationId: "station-1fc7a7c971c8", destinationStationId: "station-3752d457e1c0", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "daegu", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2X", originStationId: "station-44dc03b65cae", destinationStationId: "station-5b51eac5a29c", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "daejeon", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2Y", originStationId: "station-ee3cc9d04ee7", destinationStationId: "station-b35cc28f2c19", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
    { regionId: "gwangju", requestId: "01K2H7Q5B7E3T19N8J4M6P0R2Z", originStationId: "station-45d732c94df2", destinationStationId: "station-956d3c1b71cf", mobilityProfile: "STANDARD", constraintMode: "NONE", maxTransfers: 3, alternativeCount: 3 },
  ];
  let callIndex = 0;
  await assert.rejects(
    runJourneyCandidateCanary({
      tuplePath: fixture.path,
      baseUrl: "http://127.0.0.1:8082",
      candidateGeneration: 7,
      canaryRequestIdentity: "deploy-abc:standby",
      probes,
      serviceToken: TOKEN,
      fetchImpl: async () => {
        callIndex++;
        if (callIndex === 3) {
          return response({ error: "journey routing failure" }, { status: 500 });
        }
        return response(canaryResponse(fixture.tuple, { requestId: probes[callIndex - 1].requestId, queryId: probes[callIndex - 1].requestId }));
      },
      now: () => NOW,
    }),
    (error) => error.code === "JOURNEY_CANARY_HTTP"
  );
  assert.equal(callIndex, 3);
});

const FAILURE_REASONS = ["SNAPSHOT_ERROR", "WINDOW_MISMATCH", "PLAN_ERROR", "NO_CANDIDATES"];

function canaryFailureBody(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "journey-v3-candidate-canary-failure",
    passed: false,
    reason: "UNAVAILABLE",
    ...overrides,
  };
}

test("an UNAVAILABLE probe reports the backend failure reason and the failing probe id", async () => {
  for (const failureReason of FAILURE_REASONS) {
    const fixture = await createFixture();
    let attempts = 0;
    await assert.rejects(
      runJourneyCandidateCanary({
        ...validInput(fixture),
        fetchImpl: async () => {
          attempts += 1;
          return response(canaryFailureBody({ failureReason, probeId: REQUEST_ID }), { status: 503 });
        },
      }),
      (error) => {
        assert.ok(error instanceof JourneyCandidateCanaryAdapterError);
        assert.equal(error.code, "JOURNEY_CANARY_HTTP");
        assert.equal(error.exitCode, 1);
        assert.equal(error.httpStatus, 503);
        assert.equal(error.failureReason, failureReason);
        assert.equal(error.probeId, REQUEST_ID);
        assert.match(error.message, new RegExp(`probeId=${REQUEST_ID}\\b`));
        assert.match(error.message, new RegExp(`httpStatus=503\\b`));
        assert.match(error.message, new RegExp(`failureReason=${failureReason}\\b`));
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
      failureReason,
    );
    assert.equal(attempts, 1, failureReason);
  }
});

test("a backend without the additive reason field still names the failing probe and never invents a reason", async () => {
  const bodies = [
    {},
    canaryFailureBody(),
    canaryFailureBody({ failureReason: "SOMETHING_ELSE", probeId: "attacker\ninjected" }),
    canaryFailureBody({ failureReason: 7 }),
  ];
  for (const body of bodies) {
    const fixture = await createFixture();
    await assert.rejects(
      runJourneyCandidateCanary({
        ...validInput(fixture),
        fetchImpl: async () => response(body, { status: 503 }),
      }),
      (error) => {
        assert.equal(error.code, "JOURNEY_CANARY_HTTP");
        assert.equal(error.failureReason, undefined);
        assert.equal(error.probeId, REQUEST_ID);
        assert.equal(error.httpStatus, 503);
        assert.match(error.message, new RegExp(`probeId=${REQUEST_ID}\\b`));
        assert.equal(error.message.includes("failureReason="), false);
        assert.equal(error.message.includes("injected"), false);
        return true;
      },
      JSON.stringify(body),
    );
  }
  const fixture = await createFixture();
  await assert.rejects(
    runJourneyCandidateCanary({
      ...validInput(fixture),
      fetchImpl: async () => response("not json", { status: 503, contentType: "text/plain" }),
    }),
    (error) => error.code === "JOURNEY_CANARY_HTTP" && error.failureReason === undefined &&
      error.probeId === REQUEST_ID,
  );
});

test("a closed-set failureReason in a body of another artifactKind is never reported", async () => {
  const bodies = [
    { failureReason: "NO_CANDIDATES" },
    { artifactKind: "something-else", failureReason: "NO_CANDIDATES", probeId: REQUEST_ID },
    { artifactKind: "journey-v3-candidate-canary-result", failureReason: "PLAN_ERROR" },
    { artifactKind: null, failureReason: "WINDOW_MISMATCH" },
    { artifactKind: ["journey-v3-candidate-canary-failure"], failureReason: "SNAPSHOT_ERROR" },
  ];
  for (const body of bodies) {
    const fixture = await createFixture();
    await assert.rejects(
      runJourneyCandidateCanary({
        ...validInput(fixture),
        fetchImpl: async () => response(body, { status: 503 }),
      }),
      (error) => {
        assert.equal(error.code, "JOURNEY_CANARY_HTTP");
        assert.equal(error.failureReason, undefined);
        assert.equal(error.probeId, REQUEST_ID);
        assert.equal(error.message.includes("failureReason="), false);
        return true;
      },
      JSON.stringify(body),
    );
  }
});

test("a failing regional probe aborts activation and names its region, probe id and reason", async () => {
  const fixture = await createFixture();
  const probes = regionalProbes();
  let callIndex = 0;
  await assert.rejects(
    runJourneyCandidateCanary({
      tuplePath: fixture.path,
      baseUrl: "http://127.0.0.1:8082",
      candidateGeneration: 7,
      canaryRequestIdentity: "deploy-abc:standby",
      probes,
      serviceToken: TOKEN,
      fetchImpl: async () => {
        callIndex += 1;
        if (callIndex === 3) {
          return response(canaryFailureBody({
            failureReason: "NO_CANDIDATES", probeId: probes[2].requestId,
          }), { status: 503 });
        }
        const probe = probes[callIndex - 1];
        return response(canaryResponse(fixture.tuple, { requestId: probe.requestId, queryId: probe.requestId }));
      },
      now: () => NOW,
    }),
    (error) => {
      assert.equal(error.code, "JOURNEY_CANARY_HTTP");
      assert.equal(error.probeId, probes[2].requestId);
      assert.equal(error.regionId, "daegu");
      assert.equal(error.failureReason, "NO_CANDIDATES");
      assert.match(error.message, /regionId=daegu\b/);
      assert.match(error.message, new RegExp(`probeId=${probes[2].requestId}\\b`));
      assert.match(error.message, /failureReason=NO_CANDIDATES\b/);
      return true;
    },
  );
  assert.equal(callIndex, 3);
});

test("non-HTTP probe failures also name the failing probe", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    runJourneyCandidateCanary({
      ...validInput(fixture),
      fetchImpl: async () => response(canaryResponse(fixture.tuple, { candidateGeneration: 8 })),
    }),
    (error) => error.code === "JOURNEY_CANARY_IDENTITY" && error.probeId === REQUEST_ID &&
      error.message.includes(`probeId=${REQUEST_ID}`),
  );
});

test("night and daytime runs send the same request and reach the same verdict", async () => {
  const outcomes = [];
  for (const wallClock of [
    new Date("2026-08-13T05:00:00.000Z"),
    new Date("2026-08-13T14:50:00.000Z"),
    new Date("2026-08-13T15:06:00.000Z"),
  ]) {
    const fixture = await createFixture();
    const bodies = [];
    const result = await runJourneyCandidateCanary({
      ...validInput(fixture),
      now: () => wallClock,
      fetchImpl: async (_url, options) => {
        bodies.push(options.body);
        return response(canaryResponse(fixture.tuple, { capturedAt: wallClock.toISOString().replace(".000Z", "Z") }));
      },
    });
    outcomes.push({ bodies, passed: result.passed });
  }
  assert.deepEqual(outcomes.map((outcome) => outcome.passed), [true, true, true]);
  assert.equal(new Set(outcomes.map((outcome) => outcome.bodies.join("\n"))).size, 1);
  assert.equal(Object.keys(JSON.parse(outcomes[0].bodies[0])).some((key) => /time|clock|depart/i.test(key)), false);
});

test("CLI failure for an UNAVAILABLE probe prints the closed code, probe id and reason without secrets", async () => {
  const fixture = await createFixture();
  const cliRoot = await mkdtemp(join(tmpdir(), "journey canary cli "));
  const cliScript = join(cliRoot, "canary.mjs");
  await symlink(fileURLToPath(SCRIPT), cliScript);
  const server = createServer((_request, reply) => {
    reply.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    reply.end(JSON.stringify(canaryFailureBody({ failureReason: "NO_CANDIDATES", probeId: REQUEST_ID })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runCli(cliScript, [
      "--tuple", fixture.path,
      "--base-url", `http://127.0.0.1:${server.address().port}`,
      "--candidate-generation", "7",
      "--canary-request-identity", "deploy-abc:standby",
      "--request-id", REQUEST_ID,
      "--origin-station-id", "0108",
      "--destination-station-id", "0201",
      "--mobility-profile", "STANDARD",
      "--constraint-mode", "NONE",
      "--max-transfers", "3",
      "--alternative-count", "3",
    ], { EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN: TOKEN });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^JOURNEY_CANARY_HTTP /);
    assert.match(result.stderr, new RegExp(`probeId=${REQUEST_ID}`));
    assert.match(result.stderr, /failureReason=NO_CANDIDATES/);
    for (const forbidden of [TOKEN, fixture.root, "0108", "0201"]) {
      assert.equal(result.stderr.includes(forbidden), false);
    }
    assert.equal(result.stdout, "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function runCli(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function regionalProbes() {
  const stations = [
    ["capital", "station-6a5e08288b46", "station-gangnam"],
    ["busan", "station-1fc7a7c971c8", "station-3752d457e1c0"],
    ["daegu", "station-44dc03b65cae", "station-5b51eac5a29c"],
    ["daejeon", "station-ee3cc9d04ee7", "station-b35cc28f2c19"],
    ["gwangju", "station-45d732c94df2", "station-956d3c1b71cf"],
  ];
  return stations.map(([regionId, originStationId, destinationStationId], index) => ({
    regionId,
    requestId: `01K2H7Q5B7E3T19N8J4M6P0R2${"VWXYZ"[index]}`,
    originStationId,
    destinationStationId,
    mobilityProfile: "STANDARD",
    constraintMode: "NONE",
    maxTransfers: 3,
    alternativeCount: 3,
  }));
}

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
    ["stale capturedAt", ({ valid }) => {
      const { evidenceSha256: _evidenceSha256, ...stale } = valid;
      stale.capturedAt = "2026-08-13T02:59:59Z";
      return response({ ...stale, evidenceSha256: canaryEvidenceSha256(stale) });
    }, "JOURNEY_CANARY_TIMESTAMP"],
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
  const cliRoot = await mkdtemp(join(tmpdir(), "journey canary % 한글 "));
  const cliScript = join(cliRoot, "canary #.mjs");
  await symlink(fileURLToPath(SCRIPT), cliScript);
  const cliUrl = pathToFileURL(cliScript);
  const result = spawnSync(process.execPath, [
    fileURLToPath(cliUrl),
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

function canaryResponse(tuple, overrides = {}) {
  const reqId = overrides.requestId ?? REQUEST_ID;
  const value = {
    schemaVersion: 1,
    artifactKind: "journey-v3-candidate-canary-result",
    canaryRequestIdentity: "deploy-abc:standby",
    requestId: reqId,
    candidateManifestSha256: tuple.serverRouteBundleDigest.slice(7),
    candidateGeneration: 7,
    bundleId: "route-bundle-20260813",
    bundleReleaseSequence: 23,
    queryId: reqId,
    capturedAt: "2026-08-13T03:00:00Z",
    passed: true,
    legacyGraphSuccessCount: 0,
    localRouteInvocationCount: 0,
    staleJourneyServedCount: 0,
    alternateEndpointSuccessCount: 0,
    ...overrides,
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
