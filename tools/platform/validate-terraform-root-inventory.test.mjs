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
const tflintConfigPath = resolve(root, ".tflint.hcl");
const staticAnalysisRunnerPath = resolve(root, "tools/platform/terraform-static-analysis.mjs");
const terraformLockExpectations = new Map([
  ["oci-always-free-a1-flex", {
    version: "8.27.0",
    h1Hashes: [
      "h1:QrYgpQr9Vgd6sZ6WJi+jFDmSCfPtGil6+Oz84A+hWNA=",
      "h1:pJ7DmHo9MfhDM7gscoPE7OHqEKxwUNEwz2/A5ZOUUN0=",
    ],
    zhHashes: [
      "zh:17aac70ae4c46bd85a285420414fac19a4fe42a340c95c1cf4ab6d29da71e656",
      "zh:1cbbd87089cda3d67423927b431e4f0fceff17aa4dc13437909bbaaf306bd9f5",
      "zh:1cd6fb7b78af954620eae64431d6f123f3dd701320bc3ab8cb6b47f1480d79b9",
      "zh:3ca2f70cf877df758c3fca9b01138446728167e8cfba6556028e64df24903d37",
      "zh:490588f364393c8e53d8621aeaf5c23d92c55d32ebca2b1d1a48d93b1cd3ff9d",
      "zh:594cb7d04e1dde0ca0d848e1aa848ea136d0d9315cf77b2dd44df5af0e54156a",
      "zh:69f58679129f332798c3f5a9f249c1dd4d4a0f80a44c89a540a1907e0ac5f1c9",
      "zh:7a4f19a156084dc4ba8acf6117cee0de7c0d11574e99d2f6525df6da46f5d0d3",
      "zh:8378cc00db7b0f9fa1007ba105122fb2d4c052947db1b1c65fb0a1111670c001",
      "zh:9b12af85486a96aedd8d7984b0ff811a4b42e3d88dad1a3fb4c0b580d04fa425",
      "zh:a95ed489c8e00dbe950fb440dec6f51632b1401b738bd187384e33b3bcb393ad",
      "zh:c1bc19afd167c54789d21777f6ed60b472acf7d3e2d50ebc8691e7a1cd90c4f4",
      "zh:e1f7b2b516334ef070c6a94a85ce11560db9f2510f28128fc04b5ac724db3e55",
      "zh:f2c19157c2b4a79aea8bf89e76f51f9363dd743fc8607f5d9b87684a47444c99",
    ],
  }],
  ["oci-data-volume-backup-control", {
    version: "8.25.0",
    h1Hashes: [
      "h1:82a1SmkgRb6IrqlRUAiIZig3QFarzHGWEb1hxyuhwqc=",
      "h1:UArfUfUx/91zaCDHGmeew7gVxVl6VT2mAHRU1ylOCnM=",
    ],
    zhHashes: [
      "zh:185137d989290722d67f8e3395a431ffdf20fd15a908fb704a6c6973f7ed8a55",
      "zh:267e4d14769f24350d83e3f6e361270a7b0bd8f7da4157c4cea7d6e9e65a288f",
      "zh:2ec991cd28e4d4c7d80f744d5ae7c835797edfdd5ac57656e5050d3a8c55b163",
      "zh:43ad9128708010a154a73488eb8dea8b60a694c954c7ecadf4b9bff417fc50da",
      "zh:5a6405daa76e10cce58a788ac3181d382ba8d84a54ff8fe473622e20827269f3",
      "zh:7025de9e5d6fe999d4d1788dc0df425b803d92f45ab48e848b12d8e9c222ab8a",
      "zh:91b03d2f59200626528e0120bdc9d2d25597d79f0616256105b1bfce72627368",
      "zh:9b12af85486a96aedd8d7984b0ff811a4b42e3d88dad1a3fb4c0b580d04fa425",
      "zh:b432a1ab309911a4f4066cc1d5290db497b7579903747ea4e478d13224c0f78f",
      "zh:c40d410d9ba1bfcaef0a92d2df0c331c3005d90db0a9b78af9362c93ca270f09",
      "zh:ceccdbcbd52c989308e1e2fb202526416fd3af3559c7e0c00f44d4f4ba517a76",
      "zh:da1a13b86051135ada7e5079f1221d8632a005ad8346e97c0c3efefad9115408",
      "zh:da499bbfce5e862bbbb3f25ed7942025d71dddfaa765f36b46251a1ff0a5f1ba",
      "zh:da952700bf8a77123fa15fb15b10f0639903794f12f64e2f13de47a2e2592f85",
    ],
  }],
]);

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
  assert.equal(inventory.roots.length, 2);

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
    [
      "!infra/terraform/oci/always-free-a1-flex/.terraform.lock.hcl",
      "!infra/terraform/oci/data-volume-backup-control/.terraform.lock.hcl",
    ],
  );
  assert.match(workflow, /node --test tools\/platform\/validate-terraform-root-inventory\.test\.mjs/);
  const terraformStep = workflow.match(/      - name: Validate Terraform roots\n        shell: bash\n        run: \|\n((?:          [^\n]*\n?)*)/);
  assert.notEqual(terraformStep, null);
  const terraformRun = terraformStep[1];
  const terraformCommands = terraformRun
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:^|\s)terraform(?:\s|$)/.test(line));
  assert.deepEqual(terraformCommands, [
    "terraform fmt -check -recursive infra/terraform",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex init -backend=false -input=false -lockfile=readonly -no-color",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex validate -no-color",
    "terraform -chdir=infra/terraform/oci/data-volume-backup-control init -backend=false -input=false -lockfile=readonly -no-color",
    "terraform -chdir=infra/terraform/oci/data-volume-backup-control validate -no-color",
  ]);
  const steps = [
    "set -euo pipefail",
    "tf_data_dir=\"${RUNNER_TEMP}/terraform-data/oci-always-free-a1-flex\"",
    "rm -rf \"${tf_data_dir}\"",
    "mkdir -p \"${tf_data_dir}\"",
    "export TF_DATA_DIR=\"${tf_data_dir}\"",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex init -backend=false -input=false -lockfile=readonly -no-color",
    "terraform -chdir=infra/terraform/oci/always-free-a1-flex validate -no-color",
    "git diff --exit-code -- infra/terraform/oci/always-free-a1-flex/.terraform.lock.hcl",
    "backup_tf_data_dir=\"${RUNNER_TEMP}/terraform-data/data-volume-backup-control\"",
    "rm -rf \"${backup_tf_data_dir}\"",
    "mkdir -p \"${backup_tf_data_dir}\"",
    "export TF_DATA_DIR=\"${backup_tf_data_dir}\"",
    "terraform -chdir=infra/terraform/oci/data-volume-backup-control init -backend=false -input=false -lockfile=readonly -no-color",
    "terraform -chdir=infra/terraform/oci/data-volume-backup-control validate -no-color",
    "git diff --exit-code -- infra/terraform/oci/data-volume-backup-control/.terraform.lock.hcl",
  ];
  const indexes = steps.map((step) => terraformRun.indexOf(step));
  assert.equal(indexes.every((index) => index >= 0), true);
  assert.equal(indexes.every((index, position) => position === 0 || indexes[position - 1] < index), true);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/always-free-a1-flex init -backend=false -input=false -lockfile=readonly -no-color/g) ?? []).length, 1);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/always-free-a1-flex validate -no-color/g) ?? []).length, 1);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/data-volume-backup-control init -backend=false -input=false -lockfile=readonly -no-color/g) ?? []).length, 1);
  assert.equal((terraformRun.match(/terraform -chdir=infra\/terraform\/oci\/data-volume-backup-control validate -no-color/g) ?? []).length, 1);
});

test("Platform CI keeps Terraform static analysis inventory-driven and isolated", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const config = readFileSync(tflintConfigPath, "utf8");
  assert.equal(config, `tflint {\n  required_version = "= 0.64.0"\n}\n\nconfig {\n  call_module_type = "local"\n  force            = false\n}\n\nplugin "terraform" {\n  enabled = true\n  preset  = "recommended"\n}\n`);
  assert.match(workflow, /node --test tools\/platform\/terraform-static-analysis\.test\.mjs/);
  assert.match(workflow, /node tools\/platform\/terraform-static-analysis\.mjs validate-policy/);
  assert.equal((workflow.match(/node tools\/platform\/terraform-static-analysis\.mjs list-roots/g) ?? []).length, 2);
  assert.equal((workflow.match(/node tools\/platform\/terraform-static-analysis\.mjs list-fixtures (?:TFLINT|CHECKOV)/g) ?? []).length, 2);
  for (const image of [
    "ghcr.io/terraform-linters/tflint@sha256:1c595f42d794c32c45a6ea8b58655fd66433d4ca3b1bc631c574a48d120bd19f",
    "bridgecrew/checkov@sha256:12a62da01af22654883aee3b9da18ba4297f123f5122663bf65235db37934144",
  ]) assert.match(workflow, new RegExp(image));
  assert.equal((workflow.match(/docker pull (?:ghcr\.io\/terraform-linters\/tflint|bridgecrew\/checkov)@sha256:/g) ?? []).length, 2);
  assert.equal((workflow.match(/docker run --pull=never --rm --network none --read-only --tmpfs \/tmp/g) ?? []).length, 6);
  assert.equal((workflow.match(/--network none --read-only --tmpfs \/tmp/g) ?? []).length, 6);
  assert.match(workflow, /--download-external-modules false/);
  assert.match(workflow, /--skip-download/);
  assert.match(workflow, /--config=\/repo\/\.tflint\.hcl --chdir="\$\{root_path\}" --call-module-type=local --format=sarif --no-color/);
  assert.match(workflow, /-w "\/reports\/fixtures\/\$\{fixture_name\}"[\s\\]+-e TFLINT_DISABLE_VERSION_CHECK=1[\s\\]+ghcr\.io\/terraform-linters\/tflint@sha256:[0-9a-f]+[\s\\]+--config=\/repo\/\.tflint\.hcl --chdir=\. --call-module-type=local --format=sarif --no-color/);
  for (const forbiddenFixturePath of ["../reports/fixtures", "--chdir=\"/reports/fixtures/"]) assert.equal(workflow.includes(forbiddenFixturePath), false, `${forbiddenFixturePath} must not produce a traversal SARIF URI`);
  assert.equal((workflow.match(/record-scan (?:TFLINT|CHECKOV) "\$\{root_id\}" "\$\{scanner_exit\}"/g) ?? []).length, 2);
  assert.equal((workflow.match(/record-fixture (?:TFLINT|CHECKOV) "\$\{fixture_id\}" "\$\{scanner_exit\}"/g) ?? []).length, 2);
  assert.equal((workflow.match(/record-tool-check (?:TFLINT|CHECKOV) "\$\{version_exit\}"/g) ?? []).length, 2);
  assert.equal((workflow.match(/TFLINT_DISABLE_VERSION_CHECK=1/g) ?? []).length, 3);
  assert.match(workflow, /record-tool-check TFLINT "\$\{version_exit\}"/);
  assert.match(workflow, /record-tool-check CHECKOV "\$\{version_exit\}"/);
  assert.match(workflow, /--version > "\$\{report_dir\}\/tflint-version\.stdout" 2> "\$\{report_dir\}\/tflint-version\.stderr"/);
  assert.match(workflow, /--version > "\$\{report_dir\}\/checkov-version\.stdout" 2> "\$\{report_dir\}\/checkov-version\.stderr"/);
  assert.match(workflow, /-o sarif -o json --output-file-path/);
  assert.match(workflow, /-w "\/repo\/\$\{root_path\}"[\s\\]+bridgecrew\/checkov@[\s\S]*?--framework terraform --directory \./);
  assert.match(workflow, /-w "\/reports\/fixtures\/\$\{fixture_name\}"[\s\\]+bridgecrew\/checkov@[\s\S]*?--framework terraform --directory \./);
  assert.match(workflow, /node tools\/platform\/terraform-static-analysis\.mjs analyze\n\s+cat "\$\{RUNNER_TEMP\}\/terraform-static-analysis\/terraform-static-analysis-summary\.md" >> "\$\{GITHUB_STEP_SUMMARY\}"/);
  for (const command of ["record-tool-check", "record-scan", "record-fixture", "analyze", "enforce", "cleanup"]) assert.equal(new RegExp(`node tools/platform/terraform-static-analysis\\.mjs ${command}[^\\n]*(?:report_dir|root_path|fixture_name|rawSarifPath|structuredJsonPath)`).test(workflow), false, `${command} must not receive a filesystem path`);
  const runner = readFileSync(staticAnalysisRunnerPath, "utf8");
  assert.match(runner, /function productionReportDirectory\(\)/);
  assert.equal(runner.includes("GITHUB_STEP_SUMMARY"), false);
  const productionDirectorySource = runner.match(/function productionReportDirectory\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(productionDirectorySource);
  assert.match(productionDirectorySource, /RUNNER_TEMP/);
  assert.match(productionDirectorySource, /terraform-static-analysis/);
  assert.equal(productionDirectorySource.includes("tmpdir"), false);
  assert.equal(workflow.includes("combine-sarif"), false);
  assert.equal((workflow.match(/set \+e/g) ?? []).length, 6);
  assert.match(workflow, /name: terraform-static-analysis-\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /name: Enforce Terraform static analysis verdict/);
  for (const forbidden of ["continue-on-error", "--skip-check", "--soft-fail", "--init", "--force", "trivy", "terraform-linters/tflint:latest", "bridgecrew/checkov:latest", "exit 0"]) assert.equal(workflow.includes(forbidden), false, `${forbidden} must remain forbidden`);
});

function trackedTerraformDirectories() {
  const paths = execFileSync("git", ["ls-files", "--", "*.tf"], { cwd: root, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  return new Set(paths.map(dirname));
}

function assertTerraformMetadataAndLock(entry) {
  const lockExpectation = terraformLockExpectations.get(entry.id);
  assert.ok(lockExpectation, `${entry.id} must have an exact lock expectation`);
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
  const lockVersions = [...lock.matchAll(/^\s+version\s*=\s*"([^"]+)"/gm)].map(([, version]) => version);
  assert.deepEqual(lockVersions, [lockExpectation.version]);
  const lockConstraints = [...lock.matchAll(/constraints\s*=\s*"([^"]+)"/g)].map(([, constraint]) => constraint);
  assert.deepEqual(lockConstraints, entry.providers.map(({ constraint }) => constraint));
  const hashes = [...lock.matchAll(/"((?:h1|zh):[^"\n]+)"/g)].map(([, hash]) => hash);
  const h1Hashes = hashes.filter((hash) => hash.startsWith("h1:"));
  assert.deepEqual(h1Hashes, lockExpectation.h1Hashes);
  const zhHashes = hashes.filter((hash) => hash.startsWith("zh:"));
  assert.deepEqual(zhHashes, lockExpectation.zhHashes);
}
