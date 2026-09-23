import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkDocumentationFragmentSync,
  parseArgs,
  runCli,
} from "./check-documentation-fragment-sync.mjs";
import { refreshDocumentationFragment } from "../repo/refresh-documentation-fragment.mjs";

function setupTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "check-doc-sync-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("git", ["config", "user.name", "Test Gate"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("git", ["config", "user.email", "gate@test.local"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "contracts/documentation"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Initial\n", "utf8");
  writeFileSync(join(dir, "unrelated.txt"), "hello\n", "utf8");

  execFileSync("git", ["add", "."], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("git", ["commit", "-m", "Initial commit on main"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

  const mainSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

  const readmeBlob = execFileSync(
    "git",
    ["rev-parse", `HEAD:README.md`],
    { cwd: dir, encoding: "utf8" },
  ).trim();

  const fragment = {
    $schema:
      "https://raw.githubusercontent.com/AquilaXk/easysubway/32ce139789b97ce1f0c9bb059966cfc19f497480/contracts/documentation/documentation-fragment.schema.json",
    schemaVersion: 1,
    repository: "AquilaXk/easysubway",
    sourceSha: mainSha,
    status: "ACTIVE",
    lastVerifiedAt: "2026-08-01T00:00:00.000Z",
    verificationEvidence: ["https://github.com/AquilaXk/easysubway/issues/2748"],
    resources: [
      {
        resource: "AquilaXk/easysubway:README.md",
        resourceClass: "CANONICAL_RESOURCE",
        documentationFamily: "PRODUCT",
        kindCandidate: "PRODUCT_README",
        sourceSurface: "TRACKED",
        canonicalIdentity: `git:${mainSha}:README.md:${readmeBlob}`,
        status: "ACTIVE",
        ownerRepository: "AquilaXk/easysubway",
        ownerIssue: "https://github.com/AquilaXk/easysubway/issues/2748",
        currentConsumers: ["consumer:product"],
        releaseReachability: "PUBLIC",
        publicSurfaceReachability: [],
        assertionState: "CURRENTLY_IMPLEMENTED_AND_EVIDENCED",
        sensitivity: "INTERNAL",
        duplicateGroup: null,
        disposition: "RETAIN_CANONICAL",
        deletePrerequisite: [],
        supersedes: [],
        supersededBy: null,
        invalidatedBy: null,
        invalidationReason: null,
        invalidationEvidence: [],
        mutationPolicy: "CURRENT_STATE_WITH_CHANGE",
        reviewPolicyId: "RELEASE_BOUND",
        reviewTrigger: ["event:change"],
        lastVerifiedAt: "2026-08-01T00:00:00.000Z",
        lastVerifiedIdentity: `git:${mainSha}:README.md:${readmeBlob}`,
        verificationMethod: "contract-test",
        verificationEvidence: ["https://github.com/AquilaXk/easysubway/issues/2748"],
        nextReviewAtOrSemanticExpiry: null,
        implementationPlan: "PLAN-DOC",
        workloadClass: null,
        orchestrationProfile: null,
        stateClass: null,
        configurationDelivery: null,
        healthContract: null,
        availabilityContract: null,
        securityContract: null,
        releaseContract: null,
        portabilityOwner: null,
        portabilityEvidence: [],
        portabilityGap: [],
      },
    ],
  };

  const fragPath = join(dir, "contracts/documentation/documentation-fragment.json");
  writeFileSync(fragPath, JSON.stringify(fragment, null, 2) + "\n", "utf8");

  // Commit fragment
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "Add fragment"], { cwd: dir });

  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

  // Create PR branch
  execFileSync("git", ["checkout", "-b", "feature-branch"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

  return { dir, baseSha, fragPath };
}

test("parseArgs parses preflight arguments properly", () => {
  const args = parseArgs([
    "--base",
    "origin/main",
    "--head",
    "HEAD",
    "--fragment",
    "contracts/doc.json",
    "--repo-root",
    "/custom/dir",
    "--check-all",
    "--quiet",
  ]);

  assert.equal(args.baseRef, "origin/main");
  assert.equal(args.headRef, "HEAD");
  assert.equal(args.fragmentPath, "contracts/doc.json");
  assert.equal(args.repoRoot, "/custom/dir");
  assert.equal(args.checkAll, true);
  assert.equal(args.quiet, true);

  assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

test("checkDocumentationFragmentSync passes when PR modifies only unrelated files", () => {
  const { dir, baseSha } = setupTestRepo();
  try {
    writeFileSync(join(dir, "unrelated.txt"), "modified unrelated content\n", "utf8");
    execFileSync("git", ["commit", "-am", "Modify unrelated file"], { cwd: dir });

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      baseRef: baseSha,
      headRef: "HEAD",
    });

    assert.equal(result.passed, true);
    assert.equal(result.reason, "NO_TRACKED_FILES_TOUCHED");
    assert.equal(result.changedTrackedFiles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync fails when tracked file is modified without fragment update", () => {
  const { dir, baseSha } = setupTestRepo();
  try {
    writeFileSync(join(dir, "README.md"), "# Modified in PR without fragment\n", "utf8");
    execFileSync("git", ["commit", "-am", "Modify README only"], { cwd: dir });

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      baseRef: baseSha,
      headRef: "HEAD",
    });

    assert.equal(result.passed, false);
    assert.equal(result.reason, "FRAGMENT_NOT_UPDATED_WITH_RESOURCE_CHANGES");
    assert.deepEqual(result.changedTrackedFiles, ["README.md"]);
    assert.equal(result.fragmentUpdated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync fails when fragment is touched but blob SHA is stale", () => {
  const { dir, baseSha, fragPath } = setupTestRepo();
  try {
    // Modify README
    writeFileSync(join(dir, "README.md"), "# Modified README\n", "utf8");
    // Touch fragment with wrong/old blob SHA
    const frag = JSON.parse(readFileSync(fragPath, "utf8"));
    frag.lastVerifiedAt = "2026-09-23T15:00:00.000Z";
    writeFileSync(fragPath, JSON.stringify(frag, null, 2) + "\n", "utf8");

    execFileSync("git", ["commit", "-am", "Modify README and touched fragment without fresh blob"], { cwd: dir });

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      baseRef: baseSha,
      headRef: "HEAD",
    });

    assert.equal(result.passed, false);
    assert.equal(result.reason, "BLOB_SHA_MISMATCH");
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync passes when tracked file and fragment are synchronized", () => {
  const { dir, baseSha } = setupTestRepo();
  try {
    // 1. Modify README
    writeFileSync(join(dir, "README.md"), "# New Valid Content\n", "utf8");
    execFileSync("git", ["commit", "-am", "Modify README"], { cwd: dir });

    // 2. Run refresh script to sync fragment with HEAD
    refreshDocumentationFragment({
      repoRoot: dir,
      observedAt: "2026-09-23T15:30:00.000Z",
    });
    execFileSync("git", ["commit", "-am", "Sync documentation-fragment.json"], { cwd: dir });

    // 3. Preflight check
    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      baseRef: baseSha,
      headRef: "HEAD",
    });

    assert.equal(result.passed, true);
    assert.equal(result.reason, "IN_SYNC");
    assert.deepEqual(result.changedTrackedFiles, ["README.md"]);
    assert.equal(result.fragmentUpdated, true);
    assert.equal(result.mismatches.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli returns 0 for passing PR gate and 1 for failure", () => {
  const { dir, baseSha } = setupTestRepo();
  try {
    // Failing case: modify README without fragment update
    writeFileSync(join(dir, "README.md"), "# Fail README\n", "utf8");
    execFileSync("git", ["commit", "-am", "Fail commit"], { cwd: dir });

    const exitCodeFail = runCli(["--repo-root", dir, "--base", baseSha, "--quiet"]);
    assert.equal(exitCodeFail, 1);

    // Sync fragment and commit
    refreshDocumentationFragment({ repoRoot: dir });
    execFileSync("git", ["commit", "-am", "Sync fragment"], { cwd: dir });

    const exitCodePass = runCli(["--repo-root", dir, "--base", baseSha, "--quiet"]);
    assert.equal(exitCodePass, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
