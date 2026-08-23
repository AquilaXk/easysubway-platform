import assert from "node:assert/strict";
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
