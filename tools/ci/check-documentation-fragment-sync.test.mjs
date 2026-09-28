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

test("checkDocumentationFragmentSync passes in --check-all mode when HEAD commit SHA changes but all tracked blob SHAs remain identical", () => {
  const { dir } = setupTestRepo();
  try {
    // Commit several unrelated code files to move HEAD far ahead of fragment.sourceSha
    writeFileSync(join(dir, "unrelated.txt"), "modified code file 1\n", "utf8");
    execFileSync("git", ["commit", "-am", "Code change 1"], { cwd: dir });

    writeFileSync(join(dir, "unrelated2.txt"), "modified code file 2\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "Code change 2"], { cwd: dir });

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const frag = JSON.parse(readFileSync(join(dir, "contracts/documentation/documentation-fragment.json"), "utf8"));
    assert.notEqual(headSha, frag.sourceSha, "Precondition: HEAD SHA must differ from fragment sourceSha");

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      checkAll: true,
    });

    assert.equal(result.passed, true);
    assert.equal(result.mode, "FULL_CHECK");
    assert.equal(result.reason, "IN_SYNC");
    assert.equal(result.totalTrackedCount, 1);
    assert.equal(result.mismatches.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync fails in --check-all mode when a tracked documentation resource has modified blob SHA", () => {
  const { dir } = setupTestRepo();
  try {
    // Modify README
    writeFileSync(join(dir, "README.md"), "# Modified Content That Drifts\n", "utf8");
    execFileSync("git", ["commit", "-am", "Modify README without updating fragment"], { cwd: dir });

    const expectedNewBlob = execFileSync("git", ["rev-parse", "HEAD:README.md"], { cwd: dir, encoding: "utf8" }).trim();

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      checkAll: true,
    });

    assert.equal(result.passed, false);
    assert.equal(result.mode, "FULL_CHECK");
    assert.equal(result.reason, "BLOB_SHA_MISMATCH");
    assert.equal(result.totalTrackedCount, 1);
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "README.md");
    assert.equal(result.mismatches[0].headBlobSha, expectedNewBlob);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync fails in --check-all mode when a tracked resource is deleted", () => {
  const { dir } = setupTestRepo();
  try {
    execFileSync("git", ["rm", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "Delete README"], { cwd: dir });

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      checkAll: true,
    });

    assert.equal(result.passed, false);
    assert.equal(result.mode, "FULL_CHECK");
    assert.equal(result.reason, "BLOB_SHA_MISMATCH");
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "README.md");
    assert.match(result.mismatches[0].error, /does not exist in HEAD ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli returns 0 for --check-all when blobs match, and 1 when blobs drift", () => {
  const { dir } = setupTestRepo();
  try {
    // Case 1: Unrelated commit does NOT cause --check-all failure
    writeFileSync(join(dir, "unrelated.txt"), "another change\n", "utf8");
    execFileSync("git", ["commit", "-am", "unrelated commit"], { cwd: dir });

    const passExitCode = runCli(["--repo-root", dir, "--check-all", "--quiet"]);
    assert.equal(passExitCode, 0);

    // Case 2: Tracked file modified causes --check-all failure
    writeFileSync(join(dir, "README.md"), "# Drifted Documentation\n", "utf8");
    execFileSync("git", ["commit", "-am", "drift documentation"], { cwd: dir });

    const failExitCode = runCli(["--repo-root", dir, "--check-all", "--quiet"]);
    assert.equal(failExitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync with --worktree detects uncommitted working tree modifications", () => {
  const { dir } = setupTestRepo();
  try {
    // Modify README on disk without committing
    writeFileSync(join(dir, "README.md"), "# Dirty working tree content\n", "utf8");

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      checkAll: true,
      worktree: true,
    });

    assert.equal(result.passed, false);
    assert.equal(result.reason, "BLOB_SHA_MISMATCH");
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkDocumentationFragmentSync fails in PR mode when fragment is modified alone with mismatched blob SHA", () => {
  const { dir } = setupTestRepo();
  try {
    // Checkout PR branch
    execFileSync("git", ["checkout", "-b", "feature/bad-fragment"], { cwd: dir });

    // Modify ONLY documentation-fragment.json with an invalid blob SHA for README.md
    const fragPath = join(dir, "contracts/documentation/documentation-fragment.json");
    const frag = JSON.parse(readFileSync(fragPath, "utf8"));
    frag.resources[0].canonicalIdentity = `git:${frag.sourceSha}:README.md:0000000000000000000000000000000000000000`;
    writeFileSync(fragPath, JSON.stringify(frag, null, 2) + "\n", "utf8");
    execFileSync("git", ["commit", "-am", "Corrupt fragment blob SHA without modifying README"], { cwd: dir });

    const result = checkDocumentationFragmentSync({
      repoRoot: dir,
      baseRef: "main",
      headRef: "HEAD",
    });

    assert.equal(result.passed, false, "PR gate must reject PR when fragment has mismatched blob SHA");
    assert.equal(result.reason, "BLOB_SHA_MISMATCH");
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].path, "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli in PR mode correctly outputs error message when tracked resource is deleted in PR", () => {
  const { dir } = setupTestRepo();
  try {
    // Checkout PR branch
    execFileSync("git", ["checkout", "-b", "feature/delete-tracked"], { cwd: dir });

    // Delete README.md and touch fragment
    execFileSync("git", ["rm", "README.md"], { cwd: dir });
    const fragPath = join(dir, "contracts/documentation/documentation-fragment.json");
    const frag = JSON.parse(readFileSync(fragPath, "utf8"));
    frag.lastVerifiedAt = new Date().toISOString();
    writeFileSync(fragPath, JSON.stringify(frag, null, 2) + "\n", "utf8");
    execFileSync("git", ["commit", "-am", "Delete README and update fragment"], { cwd: dir });

    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    let exitCode;
    try {
      exitCode = runCli(["--repo-root", dir, "--base", "main", "--head", "HEAD"]);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(exitCode, 1);
    const combinedErrors = errors.join("\n");
    assert.match(combinedErrors, /Resource does not exist in HEAD ref/);
    assert.doesNotMatch(combinedErrors, /recorded=undefined, actual PR HEAD=undefined/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli in --check-all --worktree mode formats actual worktree label instead of HEAD", () => {
  const { dir } = setupTestRepo();
  try {
    // Modify README on disk without committing
    writeFileSync(join(dir, "README.md"), "# Modified in worktree\n", "utf8");

    const errors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    let exitCode;
    try {
      exitCode = runCli(["--repo-root", dir, "--check-all", "--worktree"]);
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(exitCode, 1);
    const combinedErrors = errors.join("\n");
    assert.match(combinedErrors, /actual worktree=/);
    assert.doesNotMatch(combinedErrors, /actual HEAD=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
