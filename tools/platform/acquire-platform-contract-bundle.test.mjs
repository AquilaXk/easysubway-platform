import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPlatformContractBundle } from "./acquire-platform-contract-bundle.mjs";

test("Hub contract bundle rejects malformed, incomplete, and reordered resources before staging", () => {
  for (const source of ["{}", JSON.stringify({ resources: {} }), JSON.stringify({
    schemaVersion: 1,
    bundleVersion: "1.1.0",
    componentManifestSchemaSha256: "0".repeat(64),
    issueRefSchemaSha256: "0".repeat(64),
    resources: { "platform/k3s-runtime-contract.json": "{}" },
  })]) {
    assert.throws(() => inspectPlatformContractBundle(Buffer.from(source)));
  }
});

test("Hub bundle CLI reports malformed arguments as one typed line without a stack", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./acquire-platform-contract-bundle.mjs", import.meta.url)),
    "--wrong",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "HUB_BUNDLE_USAGE\n");
});
