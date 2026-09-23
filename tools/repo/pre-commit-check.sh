#!/usr/bin/env bash

# ==============================================================================
# EasySubway Pre-commit Hook & Documentation Fragment Synchronization Guard
# ==============================================================================
# Verifies that changes to tracked documentation resources (11 documentation families)
# are properly synchronized with contracts/documentation/documentation-fragment.json.
#
# Usage:
#   tools/repo/pre-commit-check.sh [--fix]
# Install as git hook:
#   ln -sf ../../tools/repo/pre-commit-check.sh .git/hooks/pre-commit
# ==============================================================================

set -euo pipefail

AUTO_FIX="${1:-}"

# 1. Locate repository root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${REPO_ROOT}"

FRAGMENT_FILE="contracts/documentation/documentation-fragment.json"
FRAGMENT_TOOL="tools/repo/refresh-documentation-fragment.mjs"

# 2. Check if documentation fragment tool and file exist
if [[ ! -f "${FRAGMENT_TOOL}" || ! -f "${FRAGMENT_FILE}" ]]; then
  exit 0
fi

# 3. Check if any tracked documentation files were modified in staged or working tree
MODIFIED_TRACKED=$(node -e '
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const fragmentPath = "contracts/documentation/documentation-fragment.json";
if (!existsSync(fragmentPath)) process.exit(0);

const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
const trackedPrefix = `${fragment.repository}:`;
const trackedFiles = new Set(
  fragment.resources
    .filter(r => r.sourceSurface === "TRACKED")
    .map(r => r.resource.startsWith(trackedPrefix) ? r.resource.slice(trackedPrefix.length) : r.resource.split(":").slice(1).join(":"))
);

let staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
  .split("\n")
  .map(s => s.trim())
  .filter(Boolean);

if (staged.length === 0) {
  staged = execFileSync("git", ["diff", "--name-only", "HEAD"], { encoding: "utf8" })
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

const modifiedTracked = staged.filter(f => trackedFiles.has(f));
if (modifiedTracked.length > 0) {
  console.log(modifiedTracked.join(" "));
}
' 2>/dev/null || true)

if [[ -z "${MODIFIED_TRACKED}" ]]; then
  # No tracked documentation resources modified
  exit 0
fi

echo "🔍 [PRE-COMMIT] Tracked documentation resource(s) modified: ${MODIFIED_TRACKED}"

# 4. Check for documentation fragment drift
if ! node "${FRAGMENT_TOOL}" --worktree --check > /dev/null 2>&1; then
  echo "⚠️  [PRE-COMMIT] documentation-fragment.json drift detected for tracked files!"
  
  if [[ "${AUTO_FIX}" == "--fix" || "${EASYSUBWAY_AUTO_REFRESH_FRAGMENT:-true}" == "true" ]]; then
    echo "🔄 [PRE-COMMIT] Auto-synchronizing documentation-fragment.json..."
    node "${FRAGMENT_TOOL}" --worktree
    git add "${FRAGMENT_FILE}" 2>/dev/null || true
    echo "✅ [PRE-COMMIT] documentation-fragment.json synchronized and staged."
  else
    echo "❌ [PRE-COMMIT] Commit blocked. Run: node tools/repo/refresh-documentation-fragment.mjs --worktree" >&2
    exit 1
  fi
fi

exit 0
