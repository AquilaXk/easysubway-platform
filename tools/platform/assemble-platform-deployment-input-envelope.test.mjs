import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  DeploymentEnvelopeError,
  assemblePlatformDeploymentInputEnvelope,
  formatPlatformDeploymentInputEnvelope,
} from "./assemble-platform-deployment-input-envelope.mjs";

const SCRIPT = new URL("./assemble-platform-deployment-input-envelope.mjs", import.meta.url);
const CREDENTIAL_INVENTORY = new URL(
  "../../contracts/release/platform-production-credential-reference-inventory.json",
  import.meta.url,
);
const ENVELOPE_SCHEMA = new URL(
  "../../contracts/release/platform-deployment-input-envelope.schema.json",
  import.meta.url,
);
const ACQUISITION_CONTRACT = new URL(
  "../../contracts/release/server-route-bundle-object-acquisition-contract.json",
  import.meta.url,
);
const LIFECYCLE_CONTRACT = new URL(
  "../../contracts/release/platform-journey-release-lifecycle-contract.json",
  import.meta.url,
);
const ACTIVATION_SCHEMA = new URL(
  "../../contracts/release/platform-activation-receipt.schema.json",
  import.meta.url,
);
const RUNTIME_INVENTORY = new URL(
  "../../contracts/release/platform-deployment-runtime-input-inventory.json",
  import.meta.url,
);

const PLATFORM_REVISION = "a".repeat(40);
const BACKEND_REVISION = "b".repeat(40);
const IMAGE_DIGEST = `sha256:${"1".repeat(64)}`;
const CONFIG_DIGEST = `sha256:${"2".repeat(64)}`;
const CONTRACT_DIGEST = `sha256:${"3".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"4".repeat(64)}`;

test("exact producer identities assemble one closed canonical COMPOSE envelope", async (t) => {
  const fixture = await createFixture(t);
  const envelope = await assemblePlatformDeploymentInputEnvelope(fixture.input);
  const formatted = formatPlatformDeploymentInputEnvelope(envelope);
  const parsed = JSON.parse(formatted);

  assert.equal(formatted, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.deepEqual(Object.keys(parsed), [
    "schemaVersion", "artifactKind", "orchestrator", "platform", "backend",
    "data", "release", "policies", "envelopeSha256",
  ]);
  const schema = JSON.parse(await readFile(ENVELOPE_SCHEMA, "utf8"));
  assert.deepEqual(schema.required, Object.keys(parsed));
  assert.equal(schema.properties.schemaVersion.const, parsed.schemaVersion);
  assert.equal(schema.properties.artifactKind.const, parsed.artifactKind);
  assert.equal(schema.properties.orchestrator.const, parsed.orchestrator);
  assert.deepEqual(parsed.platform, {
    repository: "AquilaXk/easysubway-platform",
    gitSha: PLATFORM_REVISION,
    environment: "production-deploy",
    deploymentEnvironmentIdentity: "production",
    admissionReceiptSha256: await fileDigest(fixture.input.admissionReceiptPath),
    credentialInventorySha256: await fileDigest(fixture.input.credentialInventoryPath),
  });
  assert.deepEqual(parsed.backend, {
    repository: "AquilaXk/easysubway-backend",
    gitSha: BACKEND_REVISION,
    imageDigest: IMAGE_DIGEST,
    configDigest: CONFIG_DIGEST,
    journeyContractDigest: CONTRACT_DIGEST,
    componentManifestSha256: await fileDigest(fixture.input.backendComponentManifestPath),
  });
  assert.deepEqual(parsed.data, {
    repository: "AquilaXk/easysubway-data",
    producerGitSha: "c".repeat(40),
    descriptorSha256: "5".repeat(64),
    handoffSha256: "6".repeat(64),
    serverRouteBundleDigest: BUNDLE_DIGEST,
  });
  assert.equal(parsed.release.tupleSha256, fixture.tuple.tupleSha256);
  assert.equal(parsed.release.candidateBindingSha256, await fileDigest(fixture.input.candidateBindingPath));
  assert.equal(parsed.release.descriptorBindingSha256, await fileDigest(fixture.input.descriptorBindingPath));
  assert.deepEqual(parsed.policies, {
    bundleAcquisitionContractSha256: await fileDigest(fixture.input.acquisitionContractPath),
    lifecycleContractSha256: await fileDigest(fixture.input.lifecycleContractPath),
    activationReceiptSchemaSha256: await fileDigest(fixture.input.activationReceiptSchemaPath),
    runtimeInputInventorySha256: await fileDigest(fixture.input.runtimeInputInventoryPath),
  });
  const preimage = structuredClone(parsed);
  delete preimage.envelopeSha256;
  assert.equal(parsed.envelopeSha256, digest(Buffer.from(`${JSON.stringify(preimage, null, 2)}\n`)));
});

test("approval receipt is bound to the exact Platform revision", async (t) => {
  const fixture = await createFixture(t);
  const receipt = JSON.parse(await readFile(fixture.input.admissionReceiptPath, "utf8"));
  receipt.workflowSha = "f".repeat(40);
  await writeCompact(fixture.input.admissionReceiptPath, receipt);

  await assert.rejects(
    assemblePlatformDeploymentInputEnvelope(fixture.input),
    matchesError("DEPLOYMENT_ENVELOPE_PLATFORM_MISMATCH", 2),
  );
});

test("Backend component identity must equal the Journey release tuple", async (t) => {
  const fixture = await createFixture(t);
  const component = JSON.parse(await readFile(fixture.input.backendComponentManifestPath, "utf8"));
  component.artifactIdentity.imageDigest = `sha256:${"9".repeat(64)}`;
  await writePretty(fixture.input.backendComponentManifestPath, component);

  await assert.rejects(
    assemblePlatformDeploymentInputEnvelope(fixture.input),
    matchesError("DEPLOYMENT_ENVELOPE_BACKEND_MISMATCH", 2),
  );
});

test("candidate and descriptor bindings must match one COMPOSE tuple", async (t) => {
  const cases = [
    ["candidate orchestrator", "candidateBindingPath", (value) => { value.orchestrator = "KUBERNETES"; }],
    ["candidate tuple", "candidateBindingPath", (value) => { value.tupleSha256 = `sha256:${"8".repeat(64)}`; }],
    ["descriptor bundle", "descriptorBindingPath", (value) => { value.serverRouteBundleDigest = `sha256:${"7".repeat(64)}`; }],
  ];
  for (const [name, pathField, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      const value = JSON.parse(await readFile(fixture.input[pathField], "utf8"));
      mutate(value);
      await writeCompact(fixture.input[pathField], value);
      await assert.rejects(
        assemblePlatformDeploymentInputEnvelope(fixture.input),
        matchesError("DEPLOYMENT_ENVELOPE_RELEASE_MISMATCH", 2),
      );
    });
  }
});

test("noncanonical or changed input fails closed", async (t) => {
  await t.test("extra tuple field", async (subtest) => {
    const fixture = await createFixture(subtest);
    const tuple = JSON.parse(await readFile(fixture.input.tuplePath, "utf8"));
    tuple.extra = true;
    await writePretty(fixture.input.tuplePath, tuple);
    await assert.rejects(
      assemblePlatformDeploymentInputEnvelope(fixture.input),
      matchesError("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2),
    );
  });

  await t.test("changed after read", async (subtest) => {
    const fixture = await createFixture(subtest);
    await assert.rejects(
      assemblePlatformDeploymentInputEnvelope({
        ...fixture.input,
        beforeInputVerification: async () => {
          const value = JSON.parse(await readFile(fixture.input.descriptorBindingPath, "utf8"));
          await writeCompact(fixture.input.descriptorBindingPath, value);
        },
      }),
      matchesError("DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE", 1),
    );
  });
});

test("CLI failure is typed nonzero with stdout zero", async (t) => {
  const fixture = await createFixture(t);
  const result = spawnSync(process.execPath, [
    SCRIPT.pathname,
    ...cliArguments({ ...fixture.input, platformRevision: "invalid" }),
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "DEPLOYMENT_ENVELOPE_USAGE expected exact deployment envelope inputs\n");
});

async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "platform-envelope-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = Object.fromEntries([
    "admissionReceipt", "tuple", "candidateBinding", "descriptorBinding", "backendComponentManifest",
  ].map((name) => [`${name}Path`, join(directory, `${name}.json`)]));

  const tuple = {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: IMAGE_DIGEST,
    backendConfigDigest: CONFIG_DIGEST,
    journeyContractDigest: CONTRACT_DIGEST,
    serverRouteBundleDigest: BUNDLE_DIGEST,
    deploymentRevision: BACKEND_REVISION,
    environmentIdentity: "production",
  };
  tuple.tupleSha256 = digest(Buffer.from(`${[
    tuple.backendImageDigest,
    tuple.backendConfigDigest,
    tuple.journeyContractDigest,
    tuple.serverRouteBundleDigest,
    tuple.deploymentRevision,
    tuple.environmentIdentity,
  ].join("\n")}\n`));

  await writeCompact(paths.admissionReceiptPath, {
    schemaVersion: "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V1",
    artifactKind: "production-deploy-effective-admission-receipt-v1",
    repository: "AquilaXk/easysubway-platform",
    environment: "production-deploy",
    ref: "refs/heads/main",
    workflowSha: PLATFORM_REVISION,
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/123",
    observedAt: "2026-08-13T03:30:00.000Z",
    approval: {
      canAdminsBypass: false,
      preventSelfReview: false,
      requiredReviewers: [{ type: "User", login: "AquilaXk" }],
    },
    branchPolicy: {
      protectedBranches: false,
      customBranchPolicies: true,
      allowedRefs: [{ type: "branch", name: "main" }],
    },
  });
  await writePretty(paths.tuplePath, tuple);
  await writeCompact(paths.candidateBindingPath, {
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V1",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: BACKEND_REVISION,
    environmentIdentity: "production",
    handoffSha256: "6".repeat(64),
    serverRouteBundleDigest: BUNDLE_DIGEST,
  });
  await writeCompact(paths.descriptorBindingPath, {
    schemaVersion: "PLATFORM_SERVER_ROUTE_BUNDLE_DESCRIPTOR_BINDING_V1",
    artifactKind: "platform-server-route-bundle-descriptor-binding",
    descriptorSha256: "5".repeat(64),
    producerGitSha: "c".repeat(40),
    tupleSha256: tuple.tupleSha256,
    serverRouteBundleDigest: BUNDLE_DIGEST,
  });
  await writePretty(paths.backendComponentManifestPath, {
    schemaVersion: 1,
    component: "backend",
    repository: "AquilaXk/easysubway-backend",
    gitSha: BACKEND_REVISION,
    artifactIdentity: { imageDigest: IMAGE_DIGEST, apiContractVersion: "1.0.0" },
    contractVersion: "1.0.0",
    evidenceSha256: "d".repeat(64),
    issueRefs: ["AquilaXk/easysubway-backend#236"],
  });

  return {
    tuple,
    input: {
      ...paths,
      credentialInventoryPath: CREDENTIAL_INVENTORY,
      acquisitionContractPath: ACQUISITION_CONTRACT,
      lifecycleContractPath: LIFECYCLE_CONTRACT,
      activationReceiptSchemaPath: ACTIVATION_SCHEMA,
      runtimeInputInventoryPath: RUNTIME_INVENTORY,
      platformRevision: PLATFORM_REVISION,
    },
  };
}

function cliArguments(input) {
  return [
    "--admission-receipt", input.admissionReceiptPath,
    "--credential-inventory", input.credentialInventoryPath.pathname,
    "--tuple", input.tuplePath,
    "--candidate-binding", input.candidateBindingPath,
    "--descriptor-binding", input.descriptorBindingPath,
    "--backend-component-manifest", input.backendComponentManifestPath,
    "--acquisition-contract", input.acquisitionContractPath.pathname,
    "--lifecycle-contract", input.lifecycleContractPath.pathname,
    "--activation-receipt-schema", input.activationReceiptSchemaPath.pathname,
    "--runtime-input-inventory", input.runtimeInputInventoryPath.pathname,
    "--platform-revision", input.platformRevision,
  ];
}

function matchesError(code, exitCode) {
  return (error) => error instanceof DeploymentEnvelopeError &&
    error.code === code && error.exitCode === exitCode;
}

async function writeCompact(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function writePretty(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileDigest(path) {
  return digest(await readFile(path));
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
