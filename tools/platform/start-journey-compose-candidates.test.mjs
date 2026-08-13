import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CandidateStartError,
  formatCandidateRuntime,
  startJourneyComposeCandidates,
} from "./start-journey-compose-candidates.mjs";

const SCRIPT = new URL("./start-journey-compose-candidates.mjs", import.meta.url);
const OVERLAY = new URL("../../infra/docker-compose.journey-candidate.yml", import.meta.url);
const TOKEN = "candidate-readiness-token-0123456789abcdef";
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

test("exact immutable inputs start only two named candidates and emit observer runtime", async () => {
  const fixture = await createFixture();
  const calls = [];
  const runtime = await startJourneyComposeCandidates({
    ...fixture.input,
    serviceToken: TOKEN,
    currentPublicKeyPem: PUBLIC_KEY_PEM,
    inspectDescriptor: fixture.inspectDescriptor,
    composeRunner: async (request) => {
      calls.push(request);
      return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-5), [
    "ps", "--all", "--quiet",
    "backend-journey-candidate-a", "backend-journey-candidate-b",
  ]);
  assert.deepEqual(calls[1].args.slice(-8), [
    "up", "--detach", "--no-deps", "--no-build", "--pull", "never",
    "backend-journey-candidate-a", "backend-journey-candidate-b",
  ]);
  for (const call of calls) {
    assert.equal(call.command, "docker");
    assert.equal(call.args.includes("--profile"), true);
    assert.equal(call.args.includes("journey-candidate"), true);
    assert.equal(call.env.EASYSUBWAY_BACKEND_IMAGE,
      `ghcr.io/aquilaxk/easysubway-backend@${fixture.tuple.backendImageDigest}`);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_DESCRIPTOR_BASE64,
      fixture.descriptorBytes.toString("base64"));
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_ACTIVATION_REQUEST_IDENTITY,
      fixture.input.operationId);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_TRUSTED_RAW_DESCRIPTOR_BASE_URL,
      fixture.publicBaseUrl);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_KEY_ID,
      fixture.keyId);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_ROUTE_BUNDLE_STARTUP_CURRENT_PUBLIC_KEY_PEM,
      PUBLIC_KEY_PEM);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_READINESS_SERVICE_TOKEN, TOKEN);
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_READINESS_RELEASE_TUPLE_SHA256,
      fixture.tuple.tupleSha256.slice(7));
    assert.equal(call.env.EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION, "17");
  }
  assert.deepEqual(runtime, {
    schemaVersion: "PLATFORM_JOURNEY_COMPOSE_CANDIDATE_RUNTIME_V1",
    artifactKind: "journey-compose-candidate-runtime",
    orchestrator: "COMPOSE",
    instances: [
      {
        instanceIdentity: "candidate-01",
        failureDomainIdentity: "compose-candidate-a",
        baseUrl: "http://127.0.0.1:18081",
      },
      {
        instanceIdentity: "candidate-02",
        failureDomainIdentity: "compose-candidate-b",
        baseUrl: "http://127.0.0.1:18082",
      },
    ],
  });
  const serialized = formatCandidateRuntime(runtime);
  assert.equal(serialized, `${JSON.stringify(runtime, null, 2)}\n`);
  for (const secret of [TOKEN, PUBLIC_KEY_PEM, fixture.input.backendEnvPath]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("invalid identity, secret, key and existing runtime fail before candidate start", async () => {
  const cases = [
    ["binding mismatch", async (fixture) => {
      fixture.binding.tupleSha256 = digest("9");
      await writeFile(fixture.input.bindingPath, `${JSON.stringify(fixture.binding)}\n`);
    }, "CANDIDATE_START_IDENTITY"],
    ["descriptor mismatch", async (fixture) => {
      fixture.descriptorBinding.descriptorSha256 = "9".repeat(64);
      await writeFile(fixture.input.descriptorBindingPath,
        `${JSON.stringify(fixture.descriptorBinding)}\n`);
    }, "CANDIDATE_START_IDENTITY"],
    ["short token", async (fixture) => { fixture.serviceToken = "short"; },
      "CANDIDATE_START_SECRET"],
    ["invalid PEM", async (fixture) => { fixture.currentPublicKeyPem = "not a key"; },
      "CANDIDATE_START_SECRET"],
    ["zero generation", async (fixture) => { fixture.input.trafficGeneration = 0; },
      "CANDIDATE_START_USAGE"],
  ];

  for (const [name, mutate, code] of cases) {
    const fixture = await createFixture();
    fixture.serviceToken = TOKEN;
    fixture.currentPublicKeyPem = PUBLIC_KEY_PEM;
    await mutate(fixture);
    let starts = 0;
    await assert.rejects(
      startJourneyComposeCandidates({
        ...fixture.input,
        serviceToken: fixture.serviceToken,
        currentPublicKeyPem: fixture.currentPublicKeyPem,
        inspectDescriptor: fixture.inspectDescriptor,
        composeRunner: async () => { starts += 1; },
      }),
      (error) => error instanceof CandidateStartError && error.code === code,
      name,
    );
    assert.equal(starts, 0, name);
  }

  const fixture = await createFixture();
  const calls = [];
  await assert.rejects(
    startJourneyComposeCandidates({
      ...fixture.input,
      serviceToken: TOKEN,
      currentPublicKeyPem: PUBLIC_KEY_PEM,
      inspectDescriptor: fixture.inspectDescriptor,
      composeRunner: async (request) => {
        calls.push(request);
        return { status: 0, signal: null, timedOut: false, stdout: "container-id\n", stderr: "" };
      },
    }),
    (error) => error instanceof CandidateStartError && error.code === "CANDIDATE_START_EXISTS",
  );
  assert.equal(calls.length, 1);
});

test("failed or timed-out start performs only exact candidate cleanup and exposes no bytes", async () => {
  for (const [name, upResult, code] of [
    ["nonzero", { status: 1, signal: null, timedOut: false, stdout: "private", stderr: TOKEN },
      "CANDIDATE_START_COMPOSE"],
    ["timeout", { status: null, signal: "SIGTERM", timedOut: true, stdout: "private", stderr: TOKEN },
      "CANDIDATE_START_TIMEOUT"],
  ]) {
    const fixture = await createFixture();
    const calls = [];
    await assert.rejects(
      startJourneyComposeCandidates({
        ...fixture.input,
        serviceToken: TOKEN,
        currentPublicKeyPem: PUBLIC_KEY_PEM,
        inspectDescriptor: fixture.inspectDescriptor,
        composeRunner: async (request) => {
          calls.push(request);
          if (calls.length === 1) {
            return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
          }
          if (calls.length === 2) return upResult;
          return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        },
      }),
      (error) => {
        assert.ok(error instanceof CandidateStartError, name);
        assert.equal(error.code, code, name);
        assert.equal(error.message.includes(TOKEN), false);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
    assert.equal(calls.length, 3, name);
    assert.deepEqual(calls[2].args.slice(-5), [
      "rm", "--force", "--stop",
      "backend-journey-candidate-a", "backend-journey-candidate-b",
    ]);
  }
});

test("candidate overlay and CLI keep public traffic, canonical services and secrets out", async () => {
  const overlay = await readFile(OVERLAY, "utf8");
  assert.match(overlay, /^x-journey-candidate-common: &journey-candidate-common/);
  assert.match(overlay, /x-journey-candidate-environment: &journey-candidate-environment/);
  assert.match(overlay, /\nservices:\n  backend-journey-candidate-a:/);
  assert.match(overlay, /\n  backend-journey-candidate-b:/);
  assert.equal((overlay.match(/<<: \*journey-candidate-common/g) ?? []).length, 2);
  assert.equal((overlay.match(/<<: \*journey-candidate-environment/g) ?? []).length, 2);
  assert.equal((overlay.match(/profiles:\n    - journey-candidate/g) ?? []).length, 1);
  assert.equal((overlay.match(/restart: "no"/g) ?? []).length, 1);
  assert.equal((overlay.match(/user: "10001:10001"/g) ?? []).length, 1);
  assert.equal((overlay.match(/read_only: true/g) ?? []).length, 1);
  assert.equal((overlay.match(/no-new-privileges:true/g) ?? []).length, 1);
  assert.match(overlay, /EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: candidate-01/);
  assert.match(overlay, /EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: candidate-02/);
  assert.match(overlay, /127\.0\.0\.1:18081:8080/);
  assert.match(overlay, /127\.0\.0\.1:18082:8080/);
  for (const forbidden of ["backend-standby", "route-v2-gateway", "nginx", "KUBERNETES"] ) {
    assert.equal(overlay.includes(forbidden), false, forbidden);
  }

  const result = spawnSync(process.execPath, [SCRIPT.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      EASYSUBWAY_JOURNEY_READINESS_SERVICE_TOKEN: TOKEN,
      EASYSUBWAY_JOURNEY_CURRENT_PUBLIC_KEY_PEM: PUBLIC_KEY_PEM,
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^CANDIDATE_START_USAGE /);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(TOKEN), false);
  assert.equal(result.stderr.includes(PUBLIC_KEY_PEM), false);
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "journey-compose-start-"));
  const tuple = validTuple();
  const tupleBody = `${JSON.stringify(tuple, null, 2)}\n`;
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
  const keyId = "production-v1";
  const publicBaseUrl =
    "https://objectstorage.ap-seoul-1.oraclecloud.com/n/namespace/b/bucket/o";
  const descriptorPayload = {
    schemaVersion: 2,
    artifactKind: "server-route-bundle-publication-descriptor",
    producer: { repository: "AquilaXk/easysubway-data", gitSha: "e".repeat(40) },
    manifest: { keyId },
    publicationReceipt: { locator: { publicBaseUrl } },
  };
  const descriptor = {
    ...descriptorPayload,
    descriptorSha256: sha256(Buffer.from(canonicalJson(descriptorPayload))),
  };
  const descriptorBytes = Buffer.from(canonicalJson(descriptor));
  const descriptorBinding = {
    schemaVersion: "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1",
    artifactKind: "platform-server-route-bundle-descriptor-binding",
    descriptorSha256: descriptor.descriptorSha256,
    producerGitSha: descriptor.producer.gitSha,
    tupleSha256: tuple.tupleSha256,
    serverRouteBundleDigest: tuple.serverRouteBundleDigest,
  };
  const paths = {
    bindingPath: join(root, "binding.json"),
    descriptorBindingPath: join(root, "descriptor-binding.json"),
    tuplePath: join(root, "tuple.json"),
    descriptorPath: join(root, "descriptor.json"),
    composeEnvPath: join(root, "compose.env"),
    backendEnvPath: join(root, "backend.env"),
  };
  await Promise.all([
    writeFile(paths.bindingPath, `${JSON.stringify(binding)}\n`),
    writeFile(paths.descriptorBindingPath, `${JSON.stringify(descriptorBinding)}\n`),
    writeFile(paths.tuplePath, tupleBody),
    writeFile(paths.descriptorPath, descriptorBytes),
    writeFile(paths.composeEnvPath, "EASYSUBWAY_POSTGRES_DB=easysubway\n"),
    writeFile(paths.backendEnvPath, "EASYSUBWAY_DATASOURCE_USERNAME=private\n"),
  ]);
  return {
    root,
    tuple,
    binding,
    descriptor,
    descriptorBinding,
    descriptorBytes,
    keyId,
    publicBaseUrl,
    serviceToken: TOKEN,
    currentPublicKeyPem: PUBLIC_KEY_PEM,
    inspectDescriptor: () => ({
      descriptorSha256: descriptor.descriptorSha256,
      producerGitSha: descriptor.producer.gitSha,
      serverRouteBundleDigest: tuple.serverRouteBundleDigest,
    }),
    input: {
      ...paths,
      projectName: "easysubway-production",
      operationId: digest("8"),
      trafficGeneration: 17,
    },
  };
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
  return { ...tuple, tupleSha256: `sha256:${sha256(`${identity}\n`)}` };
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (["boolean", "number"].includes(typeof value)) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}
