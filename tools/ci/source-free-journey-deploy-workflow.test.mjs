import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowUrl = new URL("../../.github/workflows/source-free-journey-deploy.yml", import.meta.url);
const ciUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);

test("source-free workflow pins exact artifacts, keeps PREVIEW read-only, and reuses one fixed-host runner", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  const preview = jobBody(workflow, "preview", "deploy");
  const deploy = jobBody(workflow, "deploy");

  for (const input of [
    "mode:",
    "backend_run_id:", "backend_artifact_id:", "backend_artifact_name:",
    "backend_archive_sha256:",
    "data_run_id:", "data_artifact_id:", "data_artifact_name:",
    "data_archive_sha256:",
  ]) assert.equal(workflow.includes(input), true, input);
  assert.match(workflow, /options:\s*\n\s*- PREVIEW\s*\n\s*- DEPLOY/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\s*production-deploy/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /runs-on:\s*\[self-hosted, Linux, ARM64, easysubway-production\]/);
  assert.match(workflow, /EASYSUBWAY_RELEASE_ARTIFACTS_READ_TOKEN/);
  assert.match(workflow, /repository:\s*AquilaXk\/easysubway-backend/);
  assert.match(workflow, /repository:\s*AquilaXk\/easysubway-data/);
  assert.equal(count(workflow, "artifact-ids:"), 4);
  assert.equal(count(workflow, "run-id:"), 4);
  assert.equal(count(workflow, "skip-decompress: true"), 4);
  assert.equal(count(workflow, "prepare-source-free-fixed-host-deployment.mjs"), 2);
  assert.equal(count(workflow, "run-fixed-host-journey-activation.mjs"), 1);
  assert.equal(count(preview, "--mode PREVIEW"), 1);
  assert.equal(count(preview, "run-fixed-host-journey-activation.mjs"), 0);
  assert.equal(count(deploy, "--mode DEPLOY"), 1);
  assert.equal(count(deploy, "run-fixed-host-journey-activation.mjs"), 1);
  assert.equal(count(deploy, "--request \"${RUNNER_TEMP}/fixed-host-request.json\""), 1);
});

test("workflow has no sibling source checkout, legacy deploy, Route V2, retry or mutable artifact lookup", () => {
  const workflow = readFileSync(workflowUrl, "utf8");
  for (const forbidden of [
    "easysubway-data.git", "easysubway-backend.git", "AquilaXk/easysubway.git",
    "deploy-backend.sh", "route-v2", "Route V2", "raw/main", "latest",
    "continue-on-error", "retry", "matrix:",
    "run-source-free-single-host-cutover.mjs",
  ].filter((value) => value !== "latest")) assert.equal(workflow.includes(forbidden), false, forbidden);
  for (const mutableLatest of ["@latest", ":latest", "/latest"]) {
    assert.equal(workflow.includes(mutableLatest), false, mutableLatest);
  }
  assert.equal(count(workflow, "actions/checkout@"), 2);
});

test("Platform CI owns the exact new focused contracts", () => {
  const ci = readFileSync(ciUrl, "utf8");
  for (const command of [
    "node --test tools/platform/bind-journey-release-candidate-v2.test.mjs",
    "node --test tools/platform/prepare-source-free-fixed-host-deployment.test.mjs",
    "node --test tools/ci/source-free-journey-deploy-workflow.test.mjs",
  ]) assert.equal(count(ci, command), 1, command);
});

function count(value, token) {
  return value.split(token).length - 1;
}

function jobBody(workflow, name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job must exist`);
  const end = nextName === undefined
    ? workflow.length
    : workflow.indexOf(`  ${nextName}:\n`, start + 1);
  assert.notEqual(end, -1, `${nextName} job must exist`);
  return workflow.slice(start, end);
}
