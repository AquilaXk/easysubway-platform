import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPlatformContractBundle } from "./acquire-platform-contract-bundle.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const identities = [["platform/a.json", sha256("{}")], ["platform/b.json", sha256("[]")]];
const bundleFixture = (overrides = {}) => Buffer.from(JSON.stringify({
  schemaVersion: 1,
  bundleVersion: "1.2.0",
  componentManifestSchemaSha256: "0".repeat(64),
  issueRefSchemaSha256: "0".repeat(64),
  resources: { "platform/a.json": "{}", "platform/b.json": "[]" },
  ...overrides,
}));
// 각 가드만 겨냥하도록 fixture의 번들 digest를 다시 계산해 주입한다.
const inspect = (bytes) => inspectPlatformContractBundle(bytes, { bundleSha256: sha256(bytes), resourceIdentities: identities });
const codeOf = (action) => {
  try { action(); } catch (error) { return error.code; }
  return undefined;
};

test("Hub contract bundle accepts a bundle that satisfies every pin", () => {
  const inspected = inspect(bundleFixture());
  assert.deepEqual(inspected.resources.map(({ resourcePath }) => resourcePath), ["platform/a.json", "platform/b.json"]);
});

test("Hub contract bundle rejects a bundle whose digest differs from the pin", () => {
  for (const bytes of [Buffer.from("{}"), bundleFixture()]) {
    assert.equal(codeOf(() => inspectPlatformContractBundle(bytes)), "HUB_BUNDLE_DIGEST_DRIFT");
  }
  assert.equal(codeOf(() => inspectPlatformContractBundle("not a buffer")), "HUB_BUNDLE_DIGEST_DRIFT");
  const bytes = bundleFixture();
  assert.equal(codeOf(() => inspectPlatformContractBundle(bytes, { bundleSha256: "f".repeat(64), resourceIdentities: identities })), "HUB_BUNDLE_DIGEST_DRIFT");
});

test("Hub contract bundle rejects a stale or unexpected bundleVersion even when its digest matches", () => {
  for (const bundleVersion of ["1.1.0", "1.3.0", undefined]) {
    assert.equal(codeOf(() => inspect(bundleFixture({ bundleVersion }))), "HUB_BUNDLE_MALFORMED", String(bundleVersion));
  }
});

test("Hub contract bundle rejects malformed structure even when its digest matches", () => {
  assert.equal(codeOf(() => inspect(Buffer.from("not json"))), "HUB_BUNDLE_MALFORMED");
  assert.equal(codeOf(() => inspect(bundleFixture({ extra: true }))), "HUB_BUNDLE_MALFORMED");
  assert.equal(codeOf(() => inspect(bundleFixture({ schemaVersion: 2 }))), "HUB_BUNDLE_MALFORMED");
});

test("Hub contract bundle rejects incomplete or reordered resource sets", () => {
  assert.equal(codeOf(() => inspect(bundleFixture({ resources: { "platform/a.json": "{}" } }))), "HUB_BUNDLE_RESOURCE_SET_DRIFT");
  assert.equal(codeOf(() => inspect(bundleFixture({ resources: { "platform/b.json": "[]", "platform/a.json": "{}" } }))), "HUB_BUNDLE_RESOURCE_SET_DRIFT");
});

test("Hub contract bundle rejects a resource whose digest differs from its pin", () => {
  assert.equal(codeOf(() => inspect(bundleFixture({ resources: { "platform/a.json": "{}", "platform/b.json": "[1]" } }))), "HUB_BUNDLE_RESOURCE_DIGEST_DRIFT");
  assert.equal(codeOf(() => inspect(bundleFixture({ resources: { "platform/a.json": "", "platform/b.json": "[]" } }))), "HUB_BUNDLE_RESOURCE_DIGEST_DRIFT");
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
