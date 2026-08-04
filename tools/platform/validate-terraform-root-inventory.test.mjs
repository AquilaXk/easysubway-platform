import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const inventoryPath = resolve(root, "tools/platform/terraform-root-inventory.json");
const workflowPath = resolve(root, ".github/workflows/ci.yml");
const gitignorePath = resolve(root, ".gitignore");

test("Terraform candidate inventory is closed, exact, and tracked", () => {
  const inventoryBytes = readFileSync(inventoryPath, "utf8");
  assert.equal(inventoryBytes.includes("\r"), false);
  assert.equal(inventoryBytes, `${inventoryBytes.trimEnd()}\n`);

  const inventory = JSON.parse(inventoryBytes);
  assert.deepEqual(Object.keys(inventory), ["schemaVersion", "artifactKind", "roots", "moduleOnlyExclusions"]);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.artifactKind, "terraform-root-inventory-v1");
  assert.equal(Array.isArray(inventory.roots), true);
  assert.equal(Array.isArray(inventory.moduleOnlyExclusions), true);
  assert.deepEqual(inventory.moduleOnlyExclusions, []);
  assert.equal(inventory.roots.length, 1);

  const candidateDirectories = trackedTerraformDirectories();
  const classified = new Set();
  for (const entry of inventory.roots) {
    assert.deepEqual(Object.keys(entry), [
      "id",
      "path",
      "requiredTerraformVersion",
      "providers",
      "backendDisposition",
      "executionPlatforms",
      "ownerWorkflow",
      "ownerJob",
    ]);
    assert.match(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(isAbsolute(entry.path), false);
    assert.equal(normalize(entry.path), entry.path);
    assert.equal(entry.path.includes(".."), false);
    const absolutePath = resolve(root, entry.path);
    assert.equal(relative(root, absolutePath).startsWith(".."), false);
    assert.equal(lstatSync(absolutePath).isSymbolicLink(), false);
    assert.equal(candidateDirectories.has(entry.path), true, `${entry.path} must contain tracked .tf files`);
    assert.equal(classified.has(entry.path), false);
    classified.add(entry.path);
    assert.equal(entry.requiredTerraformVersion, ">= 1.6.0");
    assert.deepEqual(entry.providers, [{ source: "registry.terraform.io/oracle/oci", constraint: "~> 8.8" }]);
    assert.equal(entry.backendDisposition, "DISABLED_FOR_CI");
    assert.deepEqual(entry.executionPlatforms, ["darwin_arm64", "linux_amd64"]);
    assert.equal(entry.ownerWorkflow, ".github/workflows/ci.yml");
    assert.equal(entry.ownerJob, "platform");
    assertTerraformMetadataAndLock(entry);
  }
  assert.deepEqual([...classified].sort(), [...candidateDirectories].sort());
  const paths = inventory.roots.map(({ path }) => path);
  for (const path of paths) assert.equal(paths.some((other) => other !== path && path.startsWith(`${other}/`)), false);
});

test("Platform CI validates each inventory root using readonly backendless Terraform init", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const gitignore = readFileSync(gitignorePath, "utf8");
  assert.match(workflow, /terraform_version: 1\.14\.6/);
  assert.match(gitignore, /^\*\*\/\.terraform\.lock\.hcl$/m);
  assert.deepEqual(
    gitignore.split("\n").filter((line) => line.startsWith("!") && line.endsWith(".terraform.lock.hcl")),
    ["!infra/terraform/oci/always-free-a1-flex/.terraform.lock.hcl"],
  );
  assert.match(workflow, /node --test tools\/platform\/validate-terraform-root-inventory\.test\.mjs/);
  assert.doesNotMatch(workflow, /terraform (?:plan|apply|refresh|import)\b/);
  const terraformStep = workflow.match(/      - name: Validate Terraform roots\n        shell: bash\n        run: \|\n((?:          [^\n]*\n?)*)/);
  assert.notEqual(terraformStep, null);
  const terraformRun = terraformStep[1];
  const steps = [
    "set -euo pipefail",
    "tf_data_dir=\"${RUNNER_TEMP}/terraform-data/oci-always-free-a1-flex\"",
    "rm -rf \"${tf_data_dir}\"",
    "mkdir -p \"${tf_data_dir}\"",
    "export TF_DATA_DIR=\"${tf_data_dir}\"",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex init -backend=false -input=false -lockfile=readonly -no-color",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex validate -no-color",
    "git diff --exit-code -- infra/terraform/oci/always-free-a1-flex/.terraform.lock.hcl",
  ];
  const indexes = steps.map((step) => terraformRun.indexOf(step));
  assert.equal(indexes.every((index) => index >= 0), true);
  assert.equal(indexes.every((index, position) => position === 0 || indexes[position - 1] < index), true);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/always-free-a1-flex init -backend=false -input=false -lockfile=readonly -no-color/g) ?? []).length, 1);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/always-free-a1-flex validate -no-color/g) ?? []).length, 1);
});

function trackedTerraformDirectories() {
  const paths = execFileSync("git", ["ls-files", "--", "*.tf"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  return new Set(paths.map(dirname));
}

function assertTerraformMetadataAndLock(entry) {
  const directory = resolve(root, entry.path);
  const versions = readFileSync(resolve(directory, "versions.tf"), "utf8");
  assert.match(versions, /required_version\s*=\s*">= 1\.6\.0"/);
  assert.match(versions, /source\s*=\s*"oracle\/oci"/);
  assert.match(versions, /version\s*=\s*"~> 8\.8"/);
  const declaredSources = [...versions.matchAll(/source\s*=\s*"([^"]+)"/g)].map(([, source]) => `registry.terraform.io/${source}`);
  const declaredConstraints = [...versions.matchAll(/^\s+version\s*=\s*"([^"]+)"/gm)].map(([, constraint]) => constraint);
  assert.deepEqual(declaredSources, entry.providers.map(({ source }) => source));
  assert.deepEqual(declaredConstraints, entry.providers.map(({ constraint }) => constraint));
  const lock = readFileSync(resolve(directory, ".terraform.lock.hcl"), "utf8");
  assert.equal(lock.includes("\r"), false);
  assert.equal(lock, `${lock.trimEnd()}\n`);
  const lockProviders = [...lock.matchAll(/provider "([^"]+)"/g)].map(([, source]) => source);
  assert.deepEqual(lockProviders, entry.providers.map(({ source }) => source));
  assert.match(lock, /version\s*=\s*"8\.[0-9]+\.[0-9]+"/);
  const lockConstraints = [...lock.matchAll(/constraints\s*=\s*"([^"]+)"/g)].map(([, constraint]) => constraint);
  assert.deepEqual(lockConstraints, entry.providers.map(({ constraint }) => constraint));
  const hashes = [...lock.matchAll(/"((?:h1|zh):[^"\n]+)"/g)].map(([, hash]) => hash);
  const h1Hashes = hashes.filter((hash) => hash.startsWith("h1:"));
  assert.equal(h1Hashes.length, 2);
  for (const hash of h1Hashes) assert.match(hash, /^h1:[A-Za-z0-9+/]+={0,2}$/);
  const zhHashes = hashes.filter((hash) => hash.startsWith("zh:"));
  assert.equal(zhHashes.length > 0, true);
  for (const hash of zhHashes) assert.match(hash, /^zh:[a-f0-9]{64}$/);
}
