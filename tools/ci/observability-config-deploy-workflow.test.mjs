import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// AquilaXk/easysubway-platform#227: 운영 관측 설정 배포 workflow의 계약. 승인 환경·self-hosted DEPLOY·1회 실행·run 블록 무보간 등
// 기존 production deploy workflow 관례를 같은 기준으로 고정한다.
const workflowUrl = new URL("../../.github/workflows/observability-config-deploy.yml", import.meta.url);
const ciUrl = new URL("../../.github/workflows/ci.yml", import.meta.url);
const workflow = readFileSync(workflowUrl, "utf8");
const count = (text, needle) => text.split(needle).length - 1;

// `run: |` 블록 본문만 뽑는다(들여쓰기가 run 키보다 깊은 줄).
function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run: \|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const indent = /^(\s*)/u.exec(lines[next])[1].length;
      if (lines[next].trim() !== "" && indent <= match[1].length) break;
      body.push(lines[next]);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("workflow_dispatch로만 실행되고 mode는 PREVIEW와 DEPLOY만 받는다", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule|workflow_run):/mu);
  assert.match(workflow, /options:\s*\n\s*- PREVIEW\s*\n\s*- DEPLOY\s*\n/u);
  assert.match(workflow, /commit:\n\s+description:[^\n]+\n\s+required: false\n\s+default: ""\n\s+type: string/u);
});

test("main의 첫 시도에서만, production-deploy 승인 환경에서만 돈다", () => {
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1 && github\.triggering_actor == 'AquilaXk'/u);
  assert.match(workflow, /environment: production-deploy/u);
  assert.equal(count(workflow, "environment:"), 1);
  assert.match(workflow, /\n    concurrency:\n      group: observability-config-production\n      cancel-in-progress: false/u);
});

test("DEPLOY만 self-hosted production runner를 쓰고 PREVIEW는 GitHub-hosted다", () => {
  assert.match(workflow, /runs-on: \$\{\{ fromJSON\(inputs\.mode == 'DEPLOY' && '\["self-hosted","Linux","ARM64","easysubway-production"\]' \|\| '\["ubuntu-latest"\]'\) \}\}/u);
  const code = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.equal(count(code, "self-hosted"), 1);
});

test("권한은 읽기뿐이고 secret을 쓰지 않으며 자격 증명을 checkout에 남기지 않는다", () => {
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read\n/u);
  assert.doesNotMatch(workflow, /: write/u);
  assert.equal(count(workflow, "secrets."), 0);
  assert.equal(count(workflow, "actions/checkout@"), 2);
  assert.equal(count(workflow, "persist-credentials: false"), 2);
  assert.equal(count(workflow, "continue-on-error"), 0);
  for (const [, action, ref] of workflow.matchAll(/uses: ([\w./-]+)@(\S+)/gu)) assert.match(ref, /^[0-9a-f]{40}$/u, `${action} must be pinned to a commit SHA`);
});

test("run 블록에는 ${{ }} 보간이 없고 입력은 env를 거친다", () => {
  const blocks = runBlocks(workflow);
  assert.ok(blocks.length >= 4);
  for (const block of blocks) assert.equal(block.includes("${{"), false, block);
  assert.match(workflow, /COMMIT_INPUT: \$\{\{ inputs\.commit \}\}/u);
  assert.match(workflow, /MODE: \$\{\{ inputs\.mode \}\}/u);
  assert.match(workflow, /DEPLOY_ROOT: \$\{\{ vars\.DEPLOY_ROOT \}\}/u);
});

test("승인 receipt 검증 → 커밋 입력 검증 → 설정 커밋 checkout → main 포함 확인 → 배포 도구 순서다", () => {
  const order = [
    "verify-production-deploy-effective-admission-receipt.mjs",
    "COMMIT_INPUT: ${{ inputs.commit }}",
    "path: config-source",
    "merge-base --is-ancestor HEAD origin/main",
    "node tools/platform/deploy-observability-config.mjs --mode",
  ].map((needle) => workflow.indexOf(needle));
  for (const index of order) assert.notEqual(index, -1);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(workflow, /ref: \$\{\{ inputs\.commit != '' && inputs\.commit \|\| github\.sha \}\}/u);
  assert.match(workflow, /\[\[ -z "\$\{COMMIT_INPUT\}" \|\| "\$\{COMMIT_INPUT\}" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
});

test("경로·커밋·run 정보는 인자가 아니라 env로 넘기고, DEPLOY일 때만 호스트 입력을 내보낸다", () => {
  assert.equal(count(workflow, "deploy-observability-config.mjs"), 1);
  assert.match(workflow, /node tools\/platform\/deploy-observability-config\.mjs --mode "\$\{MODE\}"/u);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("Preview or deploy Prometheus config")), /--(commit|source-root|deploy-root|compose-env|run-url|run-id)/u);
  const deployBranch = workflow.slice(workflow.indexOf('if [[ "${MODE}" == "DEPLOY" ]]; then'), workflow.indexOf("fi\n          node tools/platform/deploy-observability-config.mjs"));
  for (const assignment of [
    'OBSERVABILITY_DEPLOY_ROOT="${DEPLOY_ROOT}"',
    'OBSERVABILITY_COMPOSE_ENV="${DEPLOY_ROOT}/shared/current-env/compose.env"',
    "OBSERVABILITY_RUN_URL=",
    'OBSERVABILITY_RUN_ID="${GITHUB_RUN_ID}"',
  ]) assert.ok(deployBranch.includes(assignment), assignment);
  const beforeBranch = workflow.slice(0, workflow.indexOf('if [[ "${MODE}" == "DEPLOY" ]]; then'));
  for (const hostVariable of ["DEPLOY_ROOT=", "COMPOSE_ENV", "RUN_ID", "RUN_URL"]) assert.equal(beforeBranch.includes(`OBSERVABILITY_${hostVariable}`), false, hostVariable);
  assert.match(beforeBranch, /OBSERVABILITY_COMMIT="\$\(git -C config-source rev-parse HEAD\)"/u);
  assert.match(workflow, /\[\[ -n "\$\{DEPLOY_ROOT\}" \]\]/u);
});

test("결과를 step summary와 artifact로 남긴다", () => {
  assert.match(workflow, /observability-result\.json/u);
  assert.match(workflow, />> "\$\{GITHUB_STEP_SUMMARY\}"/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
});

test("Platform CI가 새 계약 테스트를 실행한다", () => {
  const ci = readFileSync(ciUrl, "utf8");
  for (const command of [
    "node --test tools/platform/deploy-observability-config.test.mjs",
    "node --test tools/ci/observability-config-deploy-workflow.test.mjs",
  ]) assert.ok(ci.includes(command), command);
});
