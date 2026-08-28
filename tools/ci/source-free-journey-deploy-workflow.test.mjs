import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixedHostWorkflowUrl = new URL("../../.github/workflows/source-free-journey-deploy.yml", import.meta.url);
const k3sWorkflowUrl = new URL("../../.github/workflows/source-free-journey-k3s-deploy.yml", import.meta.url);
const ciUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("fixed-host workflow is PREVIEW-only and K3s is the sole Journey DEPLOY owner", () => {
  const workflow = readFileSync(fixedHostWorkflowUrl, "utf8");
  const k3sWorkflow = readFileSync(k3sWorkflowUrl, "utf8");
  const preview = jobBody(workflow, "preview");

  for (const input of [
    "mode:",
    "backend_run_id:", "backend_artifact_id:", "backend_artifact_name:",
    "backend_archive_sha256:",
    "data_run_id:", "data_artifact_id:", "data_artifact_name:",
    "data_archive_sha256:",
  ]) assert.equal(workflow.includes(input), true, input);
  assert.match(workflow, /options:\s*\n\s*- PREVIEW\s*\n\s*backend_run_id:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\s*production-deploy/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.doesNotMatch(workflow, /  deploy:\n/);
  assert.doesNotMatch(workflow, /self-hosted/);
  assert.doesNotMatch(workflow, /DEPLOY_ROOT/);
  assert.doesNotMatch(workflow, /--mode DEPLOY/);
  assert.doesNotMatch(workflow, /run-fixed-host-journey-activation\.mjs/);
  assert.match(workflow, /EASYSUBWAY_RELEASE_ARTIFACTS_READ_TOKEN/);
  assert.match(workflow, /repository:\s*AquilaXk\/easysubway-backend/);
  assert.match(workflow, /repository:\s*AquilaXk\/easysubway-data/);
  assert.equal(count(workflow, "artifact-ids:"), 2);
  assert.equal(count(workflow, "run-id:"), 2);
  assert.equal(count(workflow, "skip-decompress: true"), 2);
  assert.equal(count(workflow, "prepare-source-free-fixed-host-deployment.mjs"), 1);
  assert.equal(count(preview, "--mode PREVIEW"), 1);
  assert.equal(count(preview, "run-fixed-host-journey-activation.mjs"), 0);
  assert.equal(count(workflow,
    'repos/AquilaXk/easysubway-backend/actions/runs/${BACKEND_RUN_ID}'), 1);
  assert.equal(count(workflow,
    'repos/AquilaXk/easysubway-data/actions/runs/${DATA_RUN_ID}'), 1);
  assert.equal(count(workflow, ".github/workflows/release-artifacts.yml"), 1);
  assert.equal(count(workflow, ".github/workflows/datapack-release.yml"), 1);
  assert.equal(count(workflow, "--backend-producer-sha"), 1);
  assert.equal(count(workflow, "--data-producer-sha"), 1);
  assert.equal(count(workflow, ".conclusion"), 2);
  assert.equal(count(workflow, ".head_branch"), 2);
  assert.equal(count(workflow, ".head_sha"), 2);

  assert.match(k3sWorkflow, /options:\s*\n\s*- PREVIEW\s*\n\s*- DEPLOY/);
  assert.match(k3sWorkflow, /cancel-in-progress: false/);
  assert.match(k3sWorkflow, /run-k3s-journey-activation\.mjs/);
  assert.doesNotMatch(k3sWorkflow, /run-fixed-host-journey-activation\.mjs/);
  assert.doesNotMatch(k3sWorkflow, /docker compose/);
  assert.equal(count(`${workflow}\n${k3sWorkflow}`, "--mode DEPLOY"), 0, "only K3s MODE dispatch may own DEPLOY");
  assert.equal(count(k3sWorkflow, "inputs.mode == 'DEPLOY'"), 5, "K3s owns the sole DEPLOY execution branch and conditional callback-secret exposure");
});

test("workflow has no sibling source checkout, legacy deploy, Route V2, retry or mutable artifact lookup", () => {
  const workflow = readFileSync(fixedHostWorkflowUrl, "utf8");
  for (const forbidden of [
    "easysubway-data.git", "easysubway-backend.git", "AquilaXk/easysubway.git",
    "deploy-backend.sh", "route-v2", "Route V2", "raw/main", "latest",
    "continue-on-error", "retry", "matrix:",
    "run-source-free-single-host-cutover.mjs",
  ].filter((value) => value !== "latest")) assert.equal(workflow.includes(forbidden), false, forbidden);
  for (const mutableLatest of ["@latest", ":latest", "/latest"]) {
    assert.equal(workflow.includes(mutableLatest), false, mutableLatest);
  }
  assert.equal(count(workflow, "actions/checkout@"), 1);
});

test("K3s injects DataPack callback secrets only for DEPLOY before environment preparation", () => {
  const workflow = readFileSync(k3sWorkflowUrl, "utf8");
  const injection = "inject-datapack-callback-secrets.mjs";
  const injectionIndex = workflow.indexOf(injection);
  const writeIndex = workflow.indexOf("printf '%s' \"${EASYSUBWAY_ENV}\" > \"${RUNNER_TEMP}/deployment.env\"");
  const prepareIndex = workflow.indexOf("tools/deploy/prepare-deployment-env.sh");

  assert.notEqual(injectionIndex, -1);
  assert.equal(count(workflow, injection), 1);
  assert.equal(count(workflow, "secrets.EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN"), 1);
  assert.equal(count(workflow, "secrets.EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY"), 1);
  assert.match(workflow.slice(writeIndex, prepareIndex), /if \[\[ "\$\{MODE\}" == "DEPLOY" \]\]; then/);
  assert.ok(writeIndex < injectionIndex && injectionIndex < prepareIndex);
  for (const productionMutation of [
    "${deploy_root}/source-free-inputs", "${deploy_root}/release-receipts",
    "acquire-platform-contract-bundle.mjs",
  ]) assert.ok(prepareIndex < workflow.indexOf(productionMutation), productionMutation);
});

test("Platform CI owns the exact new focused contracts", () => {
  const ci = readFileSync(ciUrl, "utf8");
  for (const command of [
    "node --test tools/platform/bind-journey-release-candidate-v2.test.mjs",
    "node --test tools/platform/prepare-source-free-fixed-host-deployment.test.mjs",
    "node --test tools/platform/inject-datapack-callback-secrets.test.mjs",
    "node --test tools/ci/source-free-journey-deploy-workflow.test.mjs",
  ]) assert.equal(count(ci, command), 1, command);
});

function count(value, token) {
  return value.split(token).length - 1;
}

function jobBody(workflow, name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job must exist`);
  const end = nextName === undefined ? workflow.length : workflow.indexOf(`  ${nextName}:\n`, start + 1);
  if (nextName !== undefined) assert.notEqual(end, -1, `${nextName} job must exist`);
  return workflow.slice(start, end);
}
