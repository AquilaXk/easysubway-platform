#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { refreshDocumentationFragment } from "../repo/refresh-documentation-fragment.mjs";

const SHA_REGEX = /^[0-9a-f]{40}$/;

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseRef: null,
    headRef: "HEAD",
    fragmentPath: "contracts/documentation/documentation-fragment.json",
    repoRoot: null,
    checkAll: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") {
      options.baseRef = argv[++i];
    } else if (arg === "--head") {
      options.headRef = argv[++i];
    } else if (arg === "--fragment") {
      options.fragmentPath = argv[++i];
    } else if (arg === "--repo-root") {
      options.repoRoot = argv[++i];
    } else if (arg === "--check-all") {
      options.checkAll = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function checkDocumentationFragmentSync({
  baseRef = null,
  headRef = "HEAD",
  fragmentPath = "contracts/documentation/documentation-fragment.json",
  repoRoot = null,
  checkAll = false,
  exec = execFileSync,
} = {}) {
  const root = repoRoot
    ? resolve(repoRoot)
    : exec("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

  const resolvedFragmentPath = isAbsolute(fragmentPath)
    ? fragmentPath
    : join(root, fragmentPath);

  if (!existsSync(resolvedFragmentPath)) {
    throw new Error(`Documentation fragment not found at: ${resolvedFragmentPath}`);
  }

  const rawJson = readFileSync(resolvedFragmentPath, "utf8");
  const fragment = JSON.parse(rawJson);

  if (!fragment || typeof fragment !== "object" || !Array.isArray(fragment.resources)) {
    throw new Error(`Invalid fragment shape in: ${resolvedFragmentPath}`);
  }

  const fragmentRelPath = relative(root, resolvedFragmentPath).replace(/\\/g, "/");

  // Tracked resource relative paths
  const trackedResourcesMap = new Map();
  for (const record of fragment.resources) {
    if (record.sourceSurface === "TRACKED") {
      const resourcePrefix = `${fragment.repository}:`;
      const rel = record.resource.startsWith(resourcePrefix)
        ? record.resource.slice(resourcePrefix.length)
        : record.resource.split(":").slice(1).join(":");
      trackedResourcesMap.set(rel, record);
    }
  }

  // If checkAll or no baseRef, perform complete check
  if (checkAll || !baseRef) {
    const fullCheck = refreshDocumentationFragment({
      repoRoot: root,
      fragmentPath: resolvedFragmentPath,
      headSha: SHA_REGEX.test(headRef) ? headRef : null,
      check: true,
      exec,
    });

    return {
      mode: "FULL_CHECK",
      repository: fragment.repository,
      passed: fullCheck.driftCount === 0 && !fullCheck.sourceShaChanged,
      changedTrackedFiles: [],
      fragmentUpdated: false,
      mismatches: fullCheck.drift,
      details: fullCheck,
    };
  }

  // PR Mode: inspect diff between baseRef and headRef
  let changedFiles;
  try {
    const diffOutput = exec(
      "git",
      ["-C", root, "diff", "--name-only", baseRef, headRef],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    changedFiles = diffOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    throw new Error(
      `Failed to compute git diff between "${baseRef}" and "${headRef}": ${err.message}`,
    );
  }

  const changedTrackedFiles = [];
  for (const file of changedFiles) {
    if (trackedResourcesMap.has(file)) {
      changedTrackedFiles.push(file);
    }
  }

  // Case 1: No tracked documentation resources modified in PR
  if (changedTrackedFiles.length === 0) {
    return {
      mode: "PR_GATE",
      repository: fragment.repository,
      passed: true,
      changedTrackedFiles: [],
      fragmentUpdated: changedFiles.includes(fragmentRelPath),
      mismatches: [],
      reason: "NO_TRACKED_FILES_TOUCHED",
    };
  }

  // Case 2: Tracked resources modified, but fragment was NOT updated
  const fragmentUpdated = changedFiles.includes(fragmentRelPath);
  if (!fragmentUpdated) {
    return {
      mode: "PR_GATE",
      repository: fragment.repository,
      passed: false,
      changedTrackedFiles,
      fragmentUpdated: false,
      mismatches: [],
      reason: "FRAGMENT_NOT_UPDATED_WITH_RESOURCE_CHANGES",
    };
  }

  // Case 3: Tracked resources modified AND fragment updated — verify blob SHA sync
  const mismatches = [];
  for (const relPath of changedTrackedFiles) {
    const record = trackedResourcesMap.get(relPath);
    let headBlobSha;
    try {
      headBlobSha = exec(
        "git",
        ["-C", root, "rev-parse", `${headRef}:${relPath}`],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    } catch {
      mismatches.push({
        path: relPath,
        error: `Resource does not exist in HEAD ref (${headRef})`,
      });
      continue;
    }

    const recordedBlobSha = record.canonicalIdentity
      ? record.canonicalIdentity.split(":")[3]
      : null;

    if (recordedBlobSha !== headBlobSha) {
      mismatches.push({
        path: relPath,
        recordedBlobSha,
        headBlobSha,
      });
    }
  }

  const passed = mismatches.length === 0;

  return {
    mode: "PR_GATE",
    repository: fragment.repository,
    passed,
    changedTrackedFiles,
    fragmentUpdated: true,
    mismatches,
    reason: passed ? "IN_SYNC" : "BLOB_SHA_MISMATCH",
  };
}

function printHelp() {
  console.log(`
Usage: node tools/ci/check-documentation-fragment-sync.mjs [options]

Preflight CI gate to verify documentation fragment synchronization.
In PR mode, if any of the repository's 11 tracked documentation resources are modified,
verifies that documentation-fragment.json was also updated and matches PR HEAD blob SHAs.

Options:
  --base <ref>          Base Git reference to compare against (e.g. origin/main, pull_request.base.sha)
  --head <ref>          Head Git reference (default: HEAD)
  --check-all           Perform full repository synchronization check regardless of PR diff
  --fragment <path>     Path to documentation-fragment.json (default: contracts/documentation/documentation-fragment.json)
  --repo-root <path>    Repository root path
  --quiet               Suppress output
  -h, --help            Show this help message
`);
}

export function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    printHelp();
    return 1;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  try {
    const result = checkDocumentationFragmentSync(options);

    if (result.mode === "PR_GATE") {
      if (result.passed) {
        if (!options.quiet) {
          if (result.changedTrackedFiles.length === 0) {
            console.log(
              `✅ [Preflight Gate PASSED] No tracked documentation resources modified in PR. Gate OK.`,
            );
          } else {
            console.log(
              `✅ [Preflight Gate PASSED] Tracked documentation resource(s) [${result.changedTrackedFiles.join(", ")}] and documentation-fragment.json are correctly synchronized!`,
            );
          }
        }
        return 0;
      }

      if (!options.quiet) {
        console.error(
          `❌ [Preflight Gate FAILED] Documentation governance requirement violated in ${result.repository}:`,
        );

        if (result.reason === "FRAGMENT_NOT_UPDATED_WITH_RESOURCE_CHANGES") {
          console.error(
            `\n   The following tracked documentation resource(s) were modified in this PR:`,
          );
          for (const file of result.changedTrackedFiles) {
            console.error(`   • ${file}`);
          }
          console.error(
            `\n   However, "contracts/documentation/documentation-fragment.json" was NOT updated in this PR!`,
          );
          console.error(
            `   Per ADR-HUB-0001, PRs modifying canonical documentation must commit updated fragment SHAs in the same PR.`,
          );
          console.error(`\n👉 Quick fix:`);
          console.error(`   1. Run: node tools/repo/refresh-documentation-fragment.mjs`);
          console.error(`   2. Git commit contracts/documentation/documentation-fragment.json and push.`);
        } else if (result.reason === "BLOB_SHA_MISMATCH") {
          console.error(
            `\n   documentation-fragment.json was updated, but the recorded blob SHA does not match PR HEAD for:`,
          );
          for (const m of result.mismatches) {
            console.error(
              `   • ${m.path}: recorded=${m.recordedBlobSha?.slice(0, 8)}, actual PR HEAD=${m.headBlobSha?.slice(0, 8)}`,
            );
          }
          console.error(`\n👉 Quick fix:`);
          console.error(`   1. Run: node tools/repo/refresh-documentation-fragment.mjs`);
          console.error(`   2. Git commit the refreshed fragment and push.`);
        }
      }

      return 1;
    }

    // Full check mode
    if (result.passed) {
      if (!options.quiet) {
        console.log(`✅ [Full Check PASSED] All documentation resources in sync.`);
      }
      return 0;
    }

    if (!options.quiet) {
      console.error(`❌ [Full Check FAILED] Documentation fragment drift detected.`);
    }
    return 1;
  } catch (error) {
    if (!options.quiet) {
      console.error(`❌ Preflight Gate Error: ${error.message}`);
    }
    return 1;
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isDirectExecution) {
  process.exitCode = runCli();
}
