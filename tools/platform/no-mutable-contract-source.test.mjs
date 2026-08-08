import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = resolve(root, ".github/workflows/ci.yml");
const legacyPaths = [
  "contracts.lock.json",
  "tools/platform/stage-contracts.mjs",
  "tools/platform/stage-contracts.test.mjs",
];

test("Platform CI has no mutable Hub contract staging source", () => {
  for (const path of legacyPaths) assert.equal(existsSync(resolve(root, path)), false, `${path} must stay absent`);

  const workflow = readFileSync(workflowPath, "utf8");
  for (const forbidden of [
    "raw.githubusercontent.com/AquilaXk/easysubway/main",
    "contracts/bundles/platform-contracts-v1.0.0.json",
    "stage-contracts.mjs",
    "contracts.lock.json",
    "build/contracts",
  ]) {
    assert.equal(workflow.includes(forbidden), false, `CI must not reference ${forbidden}`);
    assert.deepEqual(trackedReferences(forbidden), [], `tracked source must not reference ${forbidden}`);
  }
});

function trackedReferences(forbidden) {
  try {
    return execFileSync(
      "git",
      ["grep", "-l", "-F", "--", forbidden, ".", ":(exclude)tools/platform/no-mutable-contract-source.test.mjs"],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    assert.equal(error.status, 1, error.stderr);
    return [];
  }
}
