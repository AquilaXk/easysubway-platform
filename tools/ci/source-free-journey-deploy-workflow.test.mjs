import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.match(workflow.slice(writeIndex, prepareIndex), /node tools\/platform\/inject-datapack-callback-secrets\.mjs\n/);
  assert.doesNotMatch(workflow, /inject-datapack-callback-secrets\.mjs "\$\{RUNNER_TEMP\}/);
  assert.ok(writeIndex < injectionIndex && injectionIndex < prepareIndex);
  for (const productionMutation of [
    "${deploy_root}/source-free-inputs", "${deploy_root}/release-receipts",
    "acquire-platform-contract-bundle.mjs",
  ]) assert.ok(prepareIndex < workflow.indexOf(productionMutation), productionMutation);
});

test("both workflows inject Journey V3 runtime settings before environment preparation", () => {
  const k3sWorkflow = readFileSync(k3sWorkflowUrl, "utf8");
  const fixedHostWorkflow = readFileSync(fixedHostWorkflowUrl, "utf8");
  const injection = "node tools/platform/inject-journey-runtime-settings.mjs";

  assert.equal(count(k3sWorkflow, injection), 1);
  assert.equal(count(fixedHostWorkflow, injection), 1);

  const k3sInjectionIndex = k3sWorkflow.indexOf(injection);
  const k3sPrepareIndex = k3sWorkflow.indexOf("tools/deploy/prepare-deployment-env.sh");
  assert.ok(k3sInjectionIndex < k3sPrepareIndex);

  const fixedHostInjectionIndex = fixedHostWorkflow.indexOf(injection);
  const fixedHostPrepareIndex = fixedHostWorkflow.indexOf("tools/deploy/prepare-deployment-env.sh");
  assert.ok(fixedHostInjectionIndex < fixedHostPrepareIndex);
});

test("K3s run-name records the activation inputs in the fixed machine-readable form (#242)", () => {
  const workflow = readFileSync(k3sWorkflowUrl, "utf8");
  // 소비자(data 체인)가 정규식으로만 해석하는 고정 형식이다. 입력 순서와 구분자를 바꾸면 소비자가 해석 불가로 실패한다.
  assert.equal(
    count(workflow,
      "run-name: ${{ format('{0} backend={1}/{2} data={3}/{4}', inputs.mode, inputs.backend_run_id, inputs.backend_artifact_id, inputs.data_run_id, inputs.data_artifact_id) }}\n"),
    1);
  assert.ok(workflow.indexOf("\nrun-name:") < workflow.indexOf("\non:"));
  const consumer = /^(PREVIEW|DEPLOY) backend=([1-9][0-9]*)\/([1-9][0-9]*) data=([1-9][0-9]*)\/([1-9][0-9]*)$/u;
  assert.deepEqual(consumer.exec("DEPLOY backend=37912373228/11607367446 data=37930592937/11610000000")?.slice(1),
    ["DEPLOY", "37912373228", "11607367446", "37930592937", "11610000000"]);
  assert.equal(consumer.test("DEPLOY backend=1/2 data=3/4 extra"), false);
});

test("K3s workflow는 job 단계에서 허용 행위자만 통과시키고 건너뛴 job이 concurrency 슬롯을 차지하지 않게 한다 (#242 F2)", () => {
  const workflow = readFileSync(k3sWorkflowUrl, "utf8");
  const header = workflow.slice(workflow.indexOf("\njobs:\n"), workflow.indexOf("    environment: production-deploy"));
  assert.ok(header.includes("    if: github.ref == 'refs/heads/main' && github.run_attempt == 1 && (github.triggering_actor == 'easysubway-release-chain[bot]' || github.triggering_actor == 'AquilaXk')\n"));
  assert.ok(header.includes("    concurrency:\n      group: source-free-journey-k3s-production\n      cancel-in-progress: false\n"));
  // workflow 수준 concurrency는 없다: 있으면 job이 건너뛰어져도 슬롯을 차지한다.
  assert.equal(/^concurrency:/mu.test(workflow), false);
  // 소비자가 run-name만 믿지 않도록 확인할 run 필드를 run-name 위에 명시한다.
  const comment = workflow.slice(0, workflow.indexOf("\nrun-name:"));
  for (const field of ["conclusion=success", "event=workflow_dispatch", "head_branch=main", "triggering_actor"]) assert.ok(comment.includes(field), field);
});

// 행위자 step을 실제 bash로 실행한다. case subject를 상수로 바꾸거나 allow list를 넓히는 변이가 실패해야 한다(#242 F1).
function authorizedDispatcherScript() {
  const workflow = readFileSync(k3sWorkflowUrl, "utf8");
  const steps = workflow.slice(workflow.indexOf("    steps:\n"));
  const begin = steps.indexOf("      - name: Require an authorized dispatcher\n");
  const end = steps.indexOf("\n      - name: Checkout Platform");
  const body = steps.slice(begin, end);
  assert.match(body, /\n        env:\n          TRIGGERING_ACTOR: \$\{\{ github\.triggering_actor \}\}\n/u);
  assert.ok(body.includes('          case "${TRIGGERING_ACTOR}" in\n'));
  const marker = "\n        run: |\n";
  return body.slice(body.indexOf(marker) + marker.length).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

test("행위자 step은 허용 행위자만 통과시키고 비슷한 이름·빈 값·대소문자 변형은 거부한다 (#242 F1)", () => {
  const script = authorizedDispatcherScript();
  const run = (actor) => spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, TRIGGERING_ACTOR: actor } });
  for (const actor of ["easysubway-release-chain[bot]", "AquilaXk"]) assert.equal(run(actor).status, 0, actor);
  for (const actor of ["AquilaXk-evil", "aquilaxk", "easysubway-release-chain", "easysubway-release-chain[bot]x", "other-collaborator", "", "*", "AquilaXk\nother"]) {
    const result = run(actor);
    assert.notEqual(result.status, 0, JSON.stringify(actor));
    assert.match(result.stderr, /deploy dispatcher is not authorized/u, JSON.stringify(actor));
  }
  // 환경 변수가 없으면(set -u) 통과가 아니라 실패다.
  assert.notEqual(spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH } }).status, 0);
});

test("Platform CI owns the exact new focused contracts", () => {
  const ci = readFileSync(ciUrl, "utf8");
  for (const command of [
    "node --test tools/platform/bind-journey-release-candidate-v2.test.mjs",
    "node --test tools/platform/prepare-source-free-fixed-host-deployment.test.mjs",
    "node --test tools/platform/inject-datapack-callback-secrets.test.mjs",
    "node --test tools/platform/inject-journey-runtime-settings.test.mjs",
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
