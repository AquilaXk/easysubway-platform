import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const script = join(import.meta.dirname, "stage-contracts.mjs");
const componentSchema = readFileSync(join(root, "contracts/release/component-manifest.schema.json"));
const issueRefSchema = readFileSync(join(root, "contracts/release/issue-ref.schema.json"));
const deploymentContract = JSON.stringify({ schemaVersion: 1, artifactKind: "platform-deployment-contract" });

test("stages only the hash-pinned platform contract", () => {
  const fixture = makeFixture();
  try {
    run(fixture);
    assert.equal(readFileSync(join(fixture.output, "platform/deployment-contract.json"), "utf8"), deploymentContract);
  } finally {
    fixture.cleanup();
  }
});

test("rejects changed bytes, schema pins, resources, and output outside build", () => {
  for (const options of [
    { lockHash: "0".repeat(64) },
    { componentHash: "0".repeat(64) },
    { resources: { "platform/unapproved.json": "{}" } },
    { outside: true },
  ]) {
    const fixture = makeFixture(options);
    try {
      assert.throws(() => run(fixture));
    } finally {
      fixture.cleanup();
    }
  }
});

function makeFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-contracts-"));
  const bundle = {
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    componentManifestSchemaSha256: options.componentHash ?? sha(componentSchema),
    issueRefSchemaSha256: sha(issueRefSchema),
    resources: options.resources ?? { "platform/deployment-contract.json": deploymentContract },
  };
  const bytes = `${JSON.stringify(bundle)}\n`;
  const input = join(directory, "bundle.json");
  const lock = join(directory, "lock.json");
  const output = options.outside ? join(directory, "outside") : join(root, "build/test-contracts", directory.split("/").at(-1));
  writeFileSync(input, bytes);
  writeFileSync(lock, `${JSON.stringify({
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    artifactUrl: "https://raw.githubusercontent.com/AquilaXk/easysubway/main/contracts/bundles/platform-contracts-v1.0.0.json",
    sha256: options.lockHash ?? sha(bytes),
  })}\n`);
  return { directory, input, lock, output, cleanup: () => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  } };
}

function run(fixture) {
  return execFileSync(process.execPath, [script, "--lock", fixture.lock, "--input", fixture.input, "--output", fixture.output], { stdio: "pipe" });
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
