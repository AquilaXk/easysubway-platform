import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "validate-deployment-input.mjs");
const gitSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

test("accepts an exact producer artifact and immutable image digest", () => {
  const fixture = makeFixture();
  try {
    const result = JSON.parse(run(fixture));
    assert.deepEqual(result, {
      repository: "AquilaXk/easysubway",
      runId: 42,
      artifactName: `easysubway-backend-release-${gitSha}`,
      artifactSha256: "c".repeat(64),
      backendGitSha: gitSha,
      image: `ghcr.io/aquilaxk/easysubway-backend@${digest}`,
      imageDigest: digest,
      evidenceSha256: fixture.evidenceSha256,
    });
  } finally {
    fixture.cleanup();
  }
});

test("rejects mutable images, wrong identity, and changed evidence", () => {
  for (const options of [
    { imageDigest: "latest" },
    { repository: "AquilaXk/easysubway-mobile" },
    { artifactName: "easysubway-backend-release-main" },
    { artifactSha256: "bad" },
    { evidenceSha256: "0".repeat(64) },
  ]) {
    const fixture = makeFixture(options);
    try {
      assert.throws(() => run(fixture));
    } finally {
      fixture.cleanup();
    }
  }
});

test("deploy adapter derives the full image from the verified digest", () => {
  const root = new URL("../..", import.meta.url);
  const deploy = readFileSync(new URL("tools/deploy/deploy-backend.sh", root), "utf8");
  const allowlist = readFileSync(new URL("tools/deploy/compose-server-env.allowlist", root), "utf8");
  assert.match(deploy, /backend_image="ghcr\.io\/aquilaxk\/easysubway-backend@\$\{DEPLOY_IMAGE_DIGEST\}"/);
  assert.doesNotMatch(deploy, /EASYSUBWAY_BACKEND_IMAGE_TAG/);
  assert.doesNotMatch(allowlist, /EASYSUBWAY_BACKEND_IMAGE(?:_TAG)?/);
});

function makeFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-deploy-"));
  const evidence = join(directory, "release-metadata.txt");
  const evidenceBytes = "verified backend release\n";
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  const imageDigest = options.imageDigest ?? digest;
  const manifest = join(directory, "backend-component-manifest.json");
  const contract = join(directory, "deployment-contract.json");
  writeFileSync(evidence, evidenceBytes);
  writeFileSync(contract, `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "platform-deployment-contract",
    contractVersion: "platform-v1",
    allowedProducerRepositories: ["AquilaXk/easysubway", "AquilaXk/easysubway-backend"],
    artifactNamePattern: "^easysubway-backend-release-[a-f0-9]{40}$",
    imageRepository: "ghcr.io/aquilaxk/easysubway-backend",
    gitShaPattern: "^[a-f0-9]{40}$",
    sha256Pattern: "^[a-f0-9]{64}$",
    imageDigestPattern: "^sha256:[a-f0-9]{64}$",
    issueRefPattern: "^AquilaXk/(easysubway|easysubway-data|easysubway-platform|easysubway-backend|easysubway-mobile)#[1-9][0-9]*$",
  })}\n`);
  writeFileSync(manifest, `${JSON.stringify({
    schemaVersion: 1,
    component: "backend",
    repository: options.repository ?? "AquilaXk/easysubway",
    gitSha,
    artifactIdentity: { imageDigest, apiContractVersion: "1.0.0" },
    contractVersion: "1.0.0",
    evidenceSha256: options.evidenceSha256 ?? evidenceSha256,
    issueRefs: ["AquilaXk/easysubway#2712"],
  })}\n`);
  return {
    directory,
    manifest,
    evidence,
    contract,
    evidenceSha256,
    repository: options.repository ?? "AquilaXk/easysubway",
    artifactName: options.artifactName ?? `easysubway-backend-release-${gitSha}`,
    artifactSha256: options.artifactSha256 ?? "c".repeat(64),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function run(fixture) {
  return execFileSync(process.execPath, [
    script,
    "--contract", fixture.contract,
    "--manifest", fixture.manifest,
    "--evidence", fixture.evidence,
    "--producer-repository", fixture.repository,
    "--run-id", "42",
    "--artifact-name", fixture.artifactName,
    "--artifact-sha256", fixture.artifactSha256,
  ], { cwd: new URL("../..", import.meta.url), encoding: "utf8", stdio: "pipe" });
}
