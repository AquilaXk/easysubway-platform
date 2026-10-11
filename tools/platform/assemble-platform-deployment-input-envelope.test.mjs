import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    serverRouteBundleDigest: BUNDLE_DIGEST,
  });
  assert.equal(parsed.release.tupleSha256, fixture.tuple.tupleSha256);
  assert.equal(parsed.release.candidateBindingSha256, await fileDigest(fixture.input.candidateBindingPath));
  assert.equal(parsed.release.descriptorBindingSha256, await fileDigest(fixture.input.descriptorBindingPath));
  assert.deepEqual(parsed.policies, {
    lifecycleContractSha256: await fileDigest(fixture.input.lifecycleContractPath),
    activationReceiptSchemaSha256: await fileDigest(fixture.input.activationReceiptSchemaPath),
    runtimeInputInventorySha256: await fileDigest(fixture.input.runtimeInputInventoryPath),
  });
  const preimage = structuredClone(parsed);
  delete preimage.envelopeSha256;
  assert.equal(parsed.envelopeSha256, digest(Buffer.from(`${JSON.stringify(preimage, null, 2)}\n`)));
});

test("deployment envelope rejects the old lifecycle and activation receipt V1 pair", async (t) => {
  const fixture = await createFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "platform-envelope-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lifecycleContractPath = join(directory, "lifecycle.json");
  const activationReceiptSchemaPath = join(directory, "activation-receipt.schema.json");
  const lifecycle = JSON.parse(await readFile(fixture.input.lifecycleContractPath, "utf8"));
  const activationSchema = JSON.parse(await readFile(fixture.input.activationReceiptSchemaPath, "utf8"));
  lifecycle.schemaVersion = "PLATFORM_JOURNEY_RELEASE_LIFECYCLE_CONTRACT_V1";
  activationSchema.properties.schemaVersion.const = "PLATFORM_ACTIVATION_RECEIPT_V1";
  await writePretty(lifecycleContractPath, lifecycle);
  await writePretty(activationReceiptSchemaPath, activationSchema);

  await assert.rejects(
    assemblePlatformDeploymentInputEnvelope({
      ...fixture.input,
      lifecycleContractPath,
      activationReceiptSchemaPath,
    }),
    matchesError("DEPLOYMENT_ENVELOPE_INPUT_INVALID", 2),
  );
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

const ACTOR_GATE_APPROVAL = () => ({
  mode: "ACTOR_GATE",
  canAdminsBypass: false,
  requiredReviewers: [],
  actorGate: {
    workflow: ".github/workflows/source-free-journey-k3s-deploy.yml",
    allowedActors: ["AquilaXk", "easysubway-release-chain[bot]"],
    triggeringActor: "easysubway-release-chain[bot]",
    runAttempt: 1,
  },
});
const OWNER_ONLY = ".github/workflows/observability-config-deploy.yml";

test("both approval modes of the V2 receipt assemble, and the receipt digest binds the mode (platform#247)", async (t) => {
  const reviewer = await createFixture(t);
  const reviewerEnvelope = await assemblePlatformDeploymentInputEnvelope(reviewer.input);
  const gated = await createFixture(t);
  const receipt = JSON.parse(await readFile(gated.input.admissionReceiptPath, "utf8"));
  receipt.approval = ACTOR_GATE_APPROVAL();
  await writeCompact(gated.input.admissionReceiptPath, receipt);
  const gatedEnvelope = await assemblePlatformDeploymentInputEnvelope(gated.input);
  assert.equal(gatedEnvelope.platform.admissionReceiptSha256, await fileDigest(gated.input.admissionReceiptPath));
  assert.notEqual(gatedEnvelope.platform.admissionReceiptSha256, reviewerEnvelope.platform.admissionReceiptSha256);
  // 소유자만 허용된 workflow의 영수증은 소유자 행위자로 받아들인다.
  const ownerOnly = await createFixture(t);
  const ownerReceipt = JSON.parse(await readFile(ownerOnly.input.admissionReceiptPath, "utf8"));
  ownerReceipt.approval = ACTOR_GATE_APPROVAL();
  ownerReceipt.approval.actorGate = { workflow: OWNER_ONLY, allowedActors: ["AquilaXk"], triggeringActor: "AquilaXk", runAttempt: 1 };
  await writeCompact(ownerOnly.input.admissionReceiptPath, ownerReceipt);
  await assemblePlatformDeploymentInputEnvelope(ownerOnly.input);
});

test("approval receipt rejects the V1 contract and every approval deviation", async (t) => {
  const cases = [
    ["V1 schema", (receipt) => { receipt.schemaVersion = "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V1"; }],
    ["V1 kind", (receipt) => { receipt.artifactKind = "production-deploy-effective-admission-receipt-v1"; }],
    ["no mode", (receipt) => { delete receipt.approval.mode; }],
    ["unknown mode", (receipt) => { receipt.approval.mode = "NONE"; }],
    ["reviewer mode with other login", (receipt) => { receipt.approval.requiredReviewers[0].login = "other"; }],
    ["reviewer mode without reviewers", (receipt) => { receipt.approval.requiredReviewers = []; }],
    ["reviewer mode with an actor gate", (receipt) => { receipt.approval.actorGate = ACTOR_GATE_APPROVAL().actorGate; }],
    ["actor gate with a reviewer", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.requiredReviewers = [{ type: "User", login: "AquilaXk" }]; }],
    ["actor gate with admin bypass", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.canAdminsBypass = true; }],
    ["actor gate with a wider allow-list", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.allowedActors.push("other"); }],
    ["release chain app on an owner-only workflow", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.workflow = OWNER_ONLY; }],
    ["owner-only allow-list with the app as actor", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.workflow = OWNER_ONLY; receipt.approval.actorGate.allowedActors = ["AquilaXk"]; }],
    ["unknown workflow", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.workflow = ".github/workflows/cd.yml"; }],
    ["prototype workflow key", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.workflow = "constructor"; }],
    ["missing workflow", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); delete receipt.approval.actorGate.workflow; }],
    ["actor gate with an unlisted actor", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.triggeringActor = "other"; }],
    ["actor gate rerun", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.runAttempt = 2; }],
    ["actor gate extra key", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); receipt.approval.actorGate.extra = true; }],
    ["actor gate missing gate", (receipt) => { receipt.approval = ACTOR_GATE_APPROVAL(); delete receipt.approval.actorGate; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await createFixture(subtest);
      const receipt = JSON.parse(await readFile(fixture.input.admissionReceiptPath, "utf8"));
      mutate(receipt);
      await writeCompact(fixture.input.admissionReceiptPath, receipt);
      await assert.rejects(
        assemblePlatformDeploymentInputEnvelope(fixture.input),
        matchesError("DEPLOYMENT_ENVELOPE_PLATFORM_MISMATCH", 2),
      );
    });
  }
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

test("binding digest and revision fields reject coercible non-string values", async (t) => {
  const cases = [
    ["candidate descriptor digest", "candidateBindingPath", (value) => {
      value.descriptorSha256 = [value.descriptorSha256];
    }],
    ["descriptor digest", "descriptorBindingPath", (value) => {
      value.descriptorSha256 = [value.descriptorSha256];
    }],
    ["producer revision", "descriptorBindingPath", (value) => {
      value.producerGitSha = [value.producerGitSha];
    }],
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

test("approved Platform revision is immutable during assembly", async (t) => {
  const fixture = await createFixture(t);
  const input = { ...fixture.input };
  input.beforeInputVerification = async () => {
    input.platformRevision = "f".repeat(40);
  };

  const envelope = await assemblePlatformDeploymentInputEnvelope(input);

  assert.equal(envelope.platform.gitSha, PLATFORM_REVISION);
});

test("input growth after initial stat is rejected within the byte budget", async (t) => {
  const fixture = await createFixture(t);
  let expanded = false;
  await assert.rejects(
    assemblePlatformDeploymentInputEnvelope({
      ...fixture.input,
      beforeInputContentRead: async (field) => {
        if (field === "admissionReceiptPath" && !expanded) {
          expanded = true;
          await appendFile(fixture.input.admissionReceiptPath, Buffer.alloc(1024 * 1024, 0x20));
        }
      },
    }),
    matchesError("DEPLOYMENT_ENVELOPE_INPUT_UNSTABLE", 1),
  );
  assert.equal(expanded, true);
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
    schemaVersion: "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2",
    artifactKind: "production-deploy-effective-admission-receipt-v2",
    repository: "AquilaXk/easysubway-platform",
    environment: "production-deploy",
    ref: "refs/heads/main",
    workflowSha: PLATFORM_REVISION,
    runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/123",
    observedAt: "2026-08-13T03:30:00.000Z",
    approval: {
      mode: "REVIEWER",
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
    schemaVersion: "JOURNEY_RELEASE_CANDIDATE_BINDING_V2",
    artifactKind: "journey-release-candidate-binding",
    orchestrator: "COMPOSE",
    tupleSha256: tuple.tupleSha256,
    deploymentRevision: BACKEND_REVISION,
    environmentIdentity: "production",
    descriptorSha256: "5".repeat(64),
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
