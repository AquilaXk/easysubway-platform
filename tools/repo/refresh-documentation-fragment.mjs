#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SHA_REGEX = /^[0-9a-f]{40}$/;

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    check: false,
    worktree: false,
    quiet: false,
    headSha: null,
    observedAt: null,
    fragmentPath: "contracts/documentation/documentation-fragment.json",
    repoRoot: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--worktree") {
      options.worktree = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--head") {
      options.headSha = argv[++i];
    } else if (arg === "--observed-at") {
      options.observedAt = argv[++i];
    } else if (arg === "--fragment") {
      options.fragmentPath = argv[++i];
    } else if (arg === "--repo-root") {
      options.repoRoot = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function refreshDocumentationFragment({
  repoRoot = null,
  fragmentPath = "contracts/documentation/documentation-fragment.json",
  headSha = null,
  observedAt = null,
  check = false,
  worktree = false,
  exec = execFileSync,
} = {}) {
  const root = repoRoot
    ? resolve(repoRoot)
    : exec("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

  const effectiveHeadSha = headSha
    ? headSha.trim()
    : exec("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

  if (!SHA_REGEX.test(effectiveHeadSha)) {
    throw new Error(`Invalid HEAD commit SHA: ${effectiveHeadSha}`);
  }

  const effectiveObservedAt = observedAt || new Date().toISOString();

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

  const originalSourceSha = fragment.sourceSha;
  const drift = [];
  let trackedCount = 0;
  const uncommittedWarnings = [];

  for (const record of fragment.resources) {
    if (record.sourceSurface !== "TRACKED") {
      continue;
    }

    trackedCount++;
    const resourcePrefix = `${fragment.repository}:`;
    const relativePath = record.resource.startsWith(resourcePrefix)
      ? record.resource.slice(resourcePrefix.length)
      : record.resource.split(":").slice(1).join(":");

    let blobSha;
    if (worktree) {
      const targetFile = join(root, relativePath);
      if (!existsSync(targetFile)) {
        throw new Error(`Tracked resource file missing on disk: ${relativePath}`);
      }
      blobSha = exec("git", ["-C", root, "hash-object", relativePath], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } else {
      try {
        blobSha = exec(
          "git",
          ["-C", root, "rev-parse", `${effectiveHeadSha}:${relativePath}`],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
      } catch {
        throw new Error(
          `Tracked resource "${relativePath}" does not exist in commit ${effectiveHeadSha}`,
        );
      }
    }

    if (!SHA_REGEX.test(blobSha)) {
      throw new Error(`Invalid blob SHA for "${relativePath}": ${blobSha}`);
    }

    const currentBlobSha = record.canonicalIdentity
      ? record.canonicalIdentity.split(":")[3]
      : null;

    const targetIdentity = `git:${effectiveHeadSha}:${relativePath}:${blobSha}`;

    const isDifferent =
      record.canonicalIdentity !== targetIdentity ||
      currentBlobSha !== blobSha ||
      originalSourceSha !== effectiveHeadSha;

    if (isDifferent) {
      drift.push({
        resource: record.resource,
        path: relativePath,
        currentIdentity: record.canonicalIdentity,
        targetIdentity,
        currentBlobSha,
        targetBlobSha: blobSha,
        blobChanged: currentBlobSha !== blobSha,
      });
    }

    if (!check) {
      record.canonicalIdentity = targetIdentity;
      record.lastVerifiedIdentity = targetIdentity;
      record.lastVerifiedAt = effectiveObservedAt;
    }

    // Check if file has uncommitted changes in worktree when running in normal mode
    if (!worktree && !check) {
      try {
        const statusOutput = exec(
          "git",
          ["-C", root, "status", "--porcelain", "--", relativePath],
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        if (statusOutput.length > 0) {
          uncommittedWarnings.push(relativePath);
        }
      } catch {
        // Ignore git status errors
      }
    }
  }

  const sourceShaChanged = originalSourceSha !== effectiveHeadSha;
  const hasDrift = drift.length > 0 || sourceShaChanged;

  if (!check && hasDrift) {
    fragment.sourceSha = effectiveHeadSha;
    fragment.lastVerifiedAt = effectiveObservedAt;
    writeFileSync(
      resolvedFragmentPath,
      JSON.stringify(fragment, null, 2) + "\n",
      "utf8",
    );
  }

  return {
    repository: fragment.repository,
    fragmentPath: resolvedFragmentPath,
    headSha: effectiveHeadSha,
    previousSourceSha: originalSourceSha,
    sourceShaChanged,
    observedAt: effectiveObservedAt,
    totalResources: fragment.resources.length,
    trackedResources: trackedCount,
    driftCount: drift.length,
    drift,
    uncommittedWarnings,
    updated: !check && hasDrift,
  };
}

function printHelp() {
  console.log(`
Usage: node tools/repo/refresh-documentation-fragment.mjs [options]

One-click automated synchronization for documentation-fragment.json.
Reads Git HEAD commit SHA and blob SHAs for all tracked resources,
updating canonicalIdentity, lastVerifiedIdentity, and sourceSha in place.

Options:
  --check               Dry-run check mode: exit 0 if up-to-date, exit 1 if drift detected
  --worktree            Hash files from working tree directly via git hash-object
  --head <sha>          Specify explicit commit SHA to bind as sourceSha (default: Git HEAD)
  --observed-at <iso>   Specify verification timestamp in ISO format
  --fragment <path>     Path to documentation-fragment.json (default: contracts/documentation/documentation-fragment.json)
  --repo-root <path>    Path to repository root (default: detected via git rev-parse)
  --quiet               Suppress informational output
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
    const result = refreshDocumentationFragment(options);

    if (options.check) {
      if (result.driftCount > 0 || result.sourceShaChanged) {
        console.error(
          `❌ [DRIFT DETECTED] ${result.repository} documentation-fragment.json is out of sync with Git HEAD (${result.headSha.slice(0, 8)}):`,
        );
        if (result.sourceShaChanged) {
          console.error(
            `   - sourceSha: recorded=${result.previousSourceSha?.slice(0, 8)}, current HEAD=${result.headSha.slice(0, 8)}`,
          );
        }
        for (const item of result.drift) {
          if (item.blobChanged) {
            console.error(
              `   - ${item.path}: blob changed ${item.currentBlobSha?.slice(0, 8)} -> ${item.targetBlobSha?.slice(0, 8)}`,
            );
          } else {
            console.error(
              `   - ${item.path}: commit SHA binding out of sync`,
            );
          }
        }
        console.error(
          `\n👉 Run "node tools/repo/refresh-documentation-fragment.mjs" to synchronize.`,
        );
        return 1;
      }
      if (!options.quiet) {
        console.log(
          `✅ [IN SYNC] ${result.repository} documentation-fragment.json is up-to-date with Git HEAD (${result.headSha.slice(0, 8)}).`,
        );
      }
      return 0;
    }

    if (!options.quiet) {
      if (result.updated) {
        console.log(
          `🔄 [REFRESHED] ${result.repository} documentation-fragment.json updated successfully:`,
        );
        console.log(
          `   - sourceSha: ${result.previousSourceSha?.slice(0, 8)} -> ${result.headSha.slice(0, 8)}`,
        );
        console.log(
          `   - tracked resources updated: ${result.trackedResources}`,
        );
        const changedBlobs = result.drift.filter((d) => d.blobChanged);
        if (changedBlobs.length > 0) {
          console.log(`   - blob SHA changes detected (${changedBlobs.length}):`);
          for (const item of changedBlobs) {
            console.log(
              `     • ${item.path}: ${item.currentBlobSha?.slice(0, 8)} -> ${item.targetBlobSha?.slice(0, 8)}`,
            );
          }
        }
      } else {
        console.log(
          `✨ [ALREADY UP TO DATE] ${result.repository} documentation-fragment.json already matches Git HEAD (${result.headSha.slice(0, 8)}).`,
        );
      }

      if (result.uncommittedWarnings.length > 0) {
        console.warn(
          `\n⚠️  Notice: The following tracked file(s) have uncommitted working tree changes:`,
        );
        for (const file of result.uncommittedWarnings) {
          console.warn(`   • ${file}`);
        }
        console.warn(
          `   The fragment was refreshed against committed Git HEAD. If you want working tree changes, commit them and re-run.`,
        );
      }
    }

    return 0;
  } catch (error) {
    console.error(`❌ Error refreshing documentation fragment: ${error.message}`);
    return 1;
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (isDirectExecution) {
  process.exitCode = runCli();
}
