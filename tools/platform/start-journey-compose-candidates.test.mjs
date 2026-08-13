import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import * as candidateStartModule from "./start-journey-compose-candidates.mjs";

const {
  CandidateStartError,
  formatCandidateRuntime,
  startJourneyComposeCandidates,
} = candidateStartModule;

const SCRIPT = new URL("./start-journey-compose-candidates.mjs", import.meta.url);
const OVERLAY = new URL("../../infra/docker-compose.journey-candidate.yml", import.meta.url);
const BASE_COMPOSE = new URL("../../infra/docker-compose.yml", import.meta.url);
const TOKEN = "candidate-readiness-token-0123456789abcdef";
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" });

test("exact immutable inputs start only the existing inactive standby and emit one-host runtime", async () => {
  const fixture = await createFixture();
  const calls = [];
  const runtime = await startJourneyComposeCandidates({
    ...fixture.input,
    serviceToken: TOKEN,
    currentPublicKeyPem: PUBLIC_KEY_PEM,
    inspectDescriptor: fixture.inspectDescriptor,
    ambientEnvironment: {
      PATH: process.env.PATH,
      DOCKER_CONTEXT: "verified-test-context",
      EASYSUBWAY_POSTGRES_DB: "ambient-must-not-win",
    },
    composeRunner: async (request) => {
      const envFile = request.args[request.args.indexOf("--env-file") + 1];
      assert.notEqual(envFile, fixture.input.composeEnvPath);
      assert.notEqual(request.env.EASYSUBWAY_BACKEND_ENV_FILE, fixture.input.backendEnvPath);
      assert.equal(await readFile(envFile, "utf8"), fixture.composeEnvText);
      assert.equal(
        await readFile(request.env.EASYSUBWAY_BACKEND_ENV_FILE, "utf8"),
        fixture.backendEnvText,
      );
      assert.equal((await stat(envFile)).mode & 0o777, 0o400);
      assert.equal(
        (await stat(request.env.EASYSUBWAY_BACKEND_ENV_FILE)).mode & 0o777,
        0o400,
      );
      assert.equal(request.env.DOCKER_CONTEXT, "verified-test-context");
      assert.equal(request.env.EASYSUBWAY_POSTGRES_DB, undefined);
      calls.push(request);
      return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(-4), [
    "ps", "--all", "--quiet",
    "backend-standby",
  ]);
  assert.deepEqual(calls[1].args.slice(-7), [
    "up", "--detach", "--no-deps", "--no-build", "--pull", "never",
    "backend-standby",
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
        instanceIdentity: "backend-standby",
        failureDomainIdentity: "oci-host-easysubway-a1",
        baseUrl: "http://127.0.0.1:8082",
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
    ["backend config digest mismatch", async (fixture) => {
      await writeFile(fixture.input.backendEnvPath, "EASYSUBWAY_OTHER_CONFIG=changed\n");
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

  const first = await createFixture();
  const second = await createFixture();
  let releasePreflight;
  let reachedPreflight;
  const preflightReached = new Promise((resolveReached) => { reachedPreflight = resolveReached; });
  const holdPreflight = new Promise((resolveRelease) => { releasePreflight = resolveRelease; });
  const firstStart = startJourneyComposeCandidates({
    ...first.input,
    serviceToken: TOKEN,
    currentPublicKeyPem: PUBLIC_KEY_PEM,
    inspectDescriptor: first.inspectDescriptor,
    composeRunner: async (request) => {
      if (request.args.includes("ps")) {
        reachedPreflight();
        await holdPreflight;
      }
      return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    },
  });
  await preflightReached;
  let secondAttempts = 0;
  await assert.rejects(
    startJourneyComposeCandidates({
      ...second.input,
      serviceToken: TOKEN,
      currentPublicKeyPem: PUBLIC_KEY_PEM,
      inspectDescriptor: second.inspectDescriptor,
      composeRunner: async () => {
        secondAttempts += 1;
        return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      },
    }),
    (error) => error instanceof CandidateStartError && error.code === "CANDIDATE_START_LOCKED",
  );
  assert.equal(secondAttempts, 0);
  releasePreflight();
  await firstStart;
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
    let cleanupUsedVerifiedCopy = false;
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
          const envFile = request.args[request.args.indexOf("--env-file") + 1];
          cleanupUsedVerifiedCopy = envFile !== fixture.input.composeEnvPath &&
            await readFile(envFile, "utf8") === fixture.composeEnvText;
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
    assert.deepEqual(calls[2].args.slice(-4), [
      "rm", "--force", "--stop",
      "backend-standby",
    ]);
    assert.equal(cleanupUsedVerifiedCopy, true, name);
  }

  const pathFixture = await createFixture();
  let pathCleanupVerified = false;
  await assert.rejects(
    startJourneyComposeCandidates({
      ...pathFixture.input,
      serviceToken: TOKEN,
      currentPublicKeyPem: PUBLIC_KEY_PEM,
      inspectDescriptor: pathFixture.inspectDescriptor,
      composeRunner: async (request) => {
        if (request.args.includes("ps")) {
          return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        }
        if (request.args.includes("up")) {
          await rename(
            pathFixture.input.composeEnvPath,
            `${pathFixture.input.composeEnvPath}.removed`,
          );
          return { status: 1, signal: null, timedOut: false, stdout: "", stderr: "" };
        }
        const envFile = request.args[request.args.indexOf("--env-file") + 1];
        pathCleanupVerified = envFile !== pathFixture.input.composeEnvPath &&
          await readFile(envFile, "utf8") === pathFixture.composeEnvText;
        return { status: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
      },
    }),
    (error) => error instanceof CandidateStartError && error.code === "CANDIDATE_START_COMPOSE",
  );
  assert.equal(pathCleanupVerified, true);

  assert.equal(typeof candidateStartModule.runComposeForTest, "function");
  const timeoutStartedAt = Date.now();
  const hardTimeout = await candidateStartModule.runComposeForTest({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    env: process.env,
    timeoutMs: 20,
    forceKillGraceMs: 20,
  });
  assert.equal(hardTimeout.timedOut, true);
  assert.ok(Date.now() - timeoutStartedAt < 1000);
});

test("candidate overlay reuses only base standby and keeps active traffic and secrets out", async () => {
  const overlay = await readFile(OVERLAY, "utf8");
  const baseCompose = await readFile(BASE_COMPOSE, "utf8");
  assert.match(overlay, /^x-journey-candidate-environment: &journey-candidate-environment/);
  assert.match(overlay, /\nservices:\n  backend-standby:/);
  assert.equal((overlay.match(/<<: \*journey-candidate-environment/g) ?? []).length, 1);
  assert.equal((overlay.match(/profiles:\n      - journey-candidate/g) ?? []).length, 1);
  assert.match(overlay, /EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: backend-standby/);
  assert.match(baseCompose, /\n  backend-standby:/);
  assert.match(baseCompose, /EASYSUBWAY_BACKEND_STANDBY_PORT:-8082}:8080/);
  for (const forbidden of [
    "backend-journey-candidate-a", "backend-journey-candidate-b", "18081", "18082",
    "route-v2-gateway", "nginx", "KUBERNETES", "\n  backend:",
  ]) {
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
  const composeEnvText = "EASYSUBWAY_POSTGRES_DB=easysubway\n";
  const backendEnvText = "EASYSUBWAY_DATASOURCE_USERNAME=private\n";
  const tuple = validTuple({
    backendConfigDigest: `sha256:${sha256(backendEnvText)}`,
  });
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
    writeFile(paths.composeEnvPath, composeEnvText),
    writeFile(paths.backendEnvPath, backendEnvText),
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
    composeEnvText,
    backendEnvText,
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

function validTuple(overrides = {}) {
  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: digest("a"),
    backendConfigDigest: digest("b"),
    journeyContractDigest: digest("c"),
    serverRouteBundleDigest: digest("d"),
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
    ...overrides,
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
