import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareSourceFreeFixedHostDeployment,
  SourceFreePreparationError,
} from "./prepare-source-free-fixed-host-deployment.mjs";

const SCRIPT = new URL(
  "./prepare-source-free-fixed-host-deployment.mjs",
  import.meta.url,
);
const IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const CONTRACT_DIGEST = `sha256:${"2".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"3".repeat(64)}`;
const DESCRIPTOR_DIGEST = "4".repeat(64);
const BACKEND_REVISION = "5".repeat(40);
const DATA_REVISION = "6".repeat(40);
const PLATFORM_REVISION = "7".repeat(40);

test("PREVIEW prepares exact descriptor-v2 inputs and one existing fixed-host request", async (t) => {
  const fixture = await createFixture(t);
  const result = await prepareSourceFreeFixedHostDeployment(
    fixture.input,
    fixture.dependencies,
  );
  const request = JSON.parse(await readFile(fixture.input.requestOutputPath, "utf8"));
  const tuple = JSON.parse(await readFile(request.tuplePath, "utf8"));
  const binding = JSON.parse(await readFile(request.bindingPath, "utf8"));

  assert.deepEqual(result, {
    schemaVersion: "PLATFORM_SOURCE_FREE_FIXED_HOST_PREPARATION_V1",
    artifactKind: "platform-source-free-fixed-host-preparation",
    mode: "PREVIEW",
    envelopeSha256: digest("envelope"),
    tupleSha256: tuple.tupleSha256,
    descriptorSha256: DESCRIPTOR_DIGEST,
    requestSha256: sha(await readFile(fixture.input.requestOutputPath)),
    requestPath: fixture.input.requestOutputPath,
    externalMutationCount: 0,
  });
  assert.equal(tuple.backendImageDigest, IMAGE_DIGEST);
  assert.equal(tuple.backendConfigDigest, sha(await readFile(fixture.input.backendEnvPath)));
  assert.equal(tuple.journeyContractDigest, CONTRACT_DIGEST);
  assert.equal(tuple.serverRouteBundleDigest, BUNDLE_DIGEST);
  assert.equal(tuple.deploymentRevision, BACKEND_REVISION);
  assert.equal(binding.schemaVersion, "JOURNEY_RELEASE_CANDIDATE_BINDING_V2");
  assert.equal(binding.descriptorSha256, DESCRIPTOR_DIGEST);
  assert.equal(Object.hasOwn(binding, "handoffSha256"), false);
  assert.equal(request.operationId, digest("envelope"));
  assert.equal(request.candidateGeneration, 1);
  assert.equal(request.trafficGeneration, 41);
  assert.equal(request.nginxConfigPath, "/etc/nginx/sites-available/easysubway");
  assert.equal(request.canary.originStationId, "station-sangnoksu");
  assert.equal(request.canary.destinationStationId, "station-sadang");
  assert.equal(request.operationDirectory, fixture.input.operationDirectory);
  assert.equal((await stat(request.tuplePath)).mode & 0o777, 0o400);
  assert.equal((await stat(request.backendEnvPath)).mode & 0o777, 0o400);
  assert.equal(fixture.assembled.length, 1);
  assert.equal(fixture.assembled[0].platformRevision, PLATFORM_REVISION);
  assert.equal(fixture.mutations.length, 0);
});

test("duplicate artifact names and producer identity mismatch fail before request output", async (t) => {
  const duplicate = await createFixture(t);
  const nested = path.join(duplicate.backendArtifactRoot, "duplicate");
  await mkdir(nested);
  await writeFile(
    path.join(nested, "backend-component-manifest.json"),
    await readFile(path.join(duplicate.backendArtifactRoot, "backend-component-manifest.json")),
  );
  await assert.rejects(
    prepareSourceFreeFixedHostDeployment(duplicate.input, duplicate.dependencies),
    matchesError("SOURCE_FREE_PREPARE_INPUT", 1),
  );

  const mismatch = await createFixture(t);
  const receiptPath = path.join(
    mismatch.backendArtifactRoot,
    "journey-v3-contract-bundle-v2-receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.producer.gitSha = "9".repeat(40);
  await writeFile(receiptPath, compact(receipt));
  await assert.rejects(
    prepareSourceFreeFixedHostDeployment(mismatch.input, mismatch.dependencies),
    matchesError("SOURCE_FREE_PREPARE_INPUT", 1),
  );
});

test("existing output root is never reused and CLI usage is typed stdout-zero", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.input.outputRoot);
  await assert.rejects(
    prepareSourceFreeFixedHostDeployment(fixture.input, fixture.dependencies),
    matchesError("SOURCE_FREE_PREPARE_OUTPUT", 1),
  );

  const result = spawnSync(process.execPath, [SCRIPT.pathname, "--mode", "PREVIEW"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "SOURCE_FREE_PREPARE_USAGE expected exact source-free preparation arguments\n",
  );
});

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "source-free-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backendArtifactRoot = path.join(root, "backend-artifact");
  const dataArtifactRoot = path.join(root, "data-artifact");
  const deployRoot = path.join(root, "deploy");
  const inputParent = path.join(deployRoot, "source-free-inputs");
  const receiptParent = path.join(deployRoot, "release-receipts");
  await Promise.all([
    mkdir(backendArtifactRoot),
    mkdir(dataArtifactRoot),
    mkdir(deployRoot),
  ]);
  await Promise.all([mkdir(inputParent), mkdir(receiptParent)]);
  const outputRoot = path.join(inputParent, "operation-41");
  const operationDirectory = path.join(receiptParent, "operation-41");
  const requestOutputPath = path.join(root, "fixed-host-request.json");
  const admissionReceiptPath = path.join(root, "admission-receipt.json");
  const composeEnvPath = path.join(root, "compose.env");
  const backendEnvPath = path.join(root, "backend.env");
  await Promise.all([
    writeFile(admissionReceiptPath, "{}\n"),
    writeFile(composeEnvPath, "EASYSUBWAY_POSTGRES_DB=easysubway\n"),
    writeFile(backendEnvPath, "EASYSUBWAY_TEST_CONFIG=bound\n"),
    writeFile(
      path.join(backendArtifactRoot, "backend-component-manifest.json"),
      pretty({
        schemaVersion: 1,
        component: "backend",
        repository: "AquilaXk/easysubway-backend",
        gitSha: BACKEND_REVISION,
        artifactIdentity: {
          imageDigest: IMAGE_DIGEST,
          apiContractVersion: "1.0.0",
        },
        contractVersion: "1.0.0",
        evidenceSha256: "8".repeat(64),
        issueRefs: ["AquilaXk/easysubway-backend#236"],
      }),
    ),
    writeFile(
      path.join(
        backendArtifactRoot,
        "journey-v3-contract-bundle-v2-receipt.json",
      ),
      compact({
        schemaVersion: 1,
        component: "backend",
        bundleVersion: "2.0.0",
        producer: {
          repository: "AquilaXk/easysubway-backend",
          gitSha: BACKEND_REVISION,
        },
        artifact: {
          repository: "ghcr.io/aquilaxk/easysubway-backend-contracts",
          manifestDigest: CONTRACT_DIGEST,
          artifactType: "application/vnd.easysubway.journey.contract-bundle.v2",
        },
        payload: {
          fileName: "journey-v3-contract-bundle-v2.json",
          mediaType: "application/vnd.easysubway.journey.contract-bundle.v2+json",
          sha256: "9".repeat(64),
        },
      }),
    ),
    writeFile(
      path.join(dataArtifactRoot, "server-route-bundle-publication-descriptor.json"),
      "{\"fixture\":true}\n",
    ),
  ]);

  const assembled = [];
  const mutations = [];
  const input = {
    mode: "PREVIEW",
    backendArtifactRoot,
    dataArtifactRoot,
    admissionReceiptPath,
    composeEnvPath,
    backendEnvPath,
    deployRoot,
    outputRoot,
    operationDirectory,
    requestOutputPath,
    platformRevision: PLATFORM_REVISION,
    trafficGeneration: 41,
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/41",
    projectName: "easysubway",
  };
  const dependencies = {
    inspectDescriptor: () => ({
      descriptorSha256: DESCRIPTOR_DIGEST,
      producerGitSha: DATA_REVISION,
      serverRouteBundleDigest: BUNDLE_DIGEST,
    }),
    bindDescriptor: async ({ tuplePath }) => {
      const tuple = JSON.parse(await readFile(tuplePath, "utf8"));
      return {
        schemaVersion: "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1",
        artifactKind: "platform-server-route-bundle-descriptor-binding",
        descriptorSha256: DESCRIPTOR_DIGEST,
        producerGitSha: DATA_REVISION,
        tupleSha256: tuple.tupleSha256,
        serverRouteBundleDigest: BUNDLE_DIGEST,
      };
    },
    bindCandidate: async ({ tuplePath }) => {
      const tuple = JSON.parse(await readFile(tuplePath, "utf8"));
      return {
        schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V2",
        artifactKind: "journey-release-candidate-binding",
        orchestrator: "COMPOSE",
        tupleSha256: tuple.tupleSha256,
        deploymentRevision: tuple.deploymentRevision,
        environmentIdentity: tuple.environmentIdentity,
        descriptorSha256: DESCRIPTOR_DIGEST,
        serverRouteBundleDigest: tuple.serverRouteBundleDigest,
      };
    },
    assembleEnvelope: async (value) => {
      assembled.push(value);
      return { envelopeSha256: digest("envelope") };
    },
    now: () => new Date("2026-08-13T06:00:00.000Z"),
  };
  return {
    input,
    dependencies,
    backendArtifactRoot,
    dataArtifactRoot,
    assembled,
    mutations,
  };
}

function matchesError(code, exitCode) {
  return (error) => error instanceof SourceFreePreparationError &&
    error.code === code && error.exitCode === exitCode;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compact(value) {
  return `${JSON.stringify(value)}\n`;
}

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
