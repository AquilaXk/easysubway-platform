import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// production-deploy 환경의 사람 승인을 없애도 쓰기 권한이 있는 다른 계정·App이 운영 배포 경로를 열지 못하게 하는 행위자 게이트 계약(platform#244).
// 다섯 workflow는 모두 workflow_dispatch만으로 시작하고(schedule·push·App dispatch 없음), 최근 run의 triggering_actor는 저장소 소유자뿐이다.
// 릴리스 체인 App은 source-free-journey-k3s-deploy만 dispatch하므로 여기서는 허용하지 않는다(최소 권한).
const ALLOWED = ["AquilaXk"];
const GATE_IF = "github.ref == 'refs/heads/main' && github.run_attempt == 1 && github.triggering_actor == 'AquilaXk'";
const STEP_NAME = "      - name: Require an authorized dispatcher\n";

const targets = [
  { file: "cd.yml", job: "preflight", concurrency: null, condition: GATE_IF },
  { file: "data-workflow-scheduler-deploy.yml", job: "scheduler", concurrency: "data-workflow-scheduler-production", condition: GATE_IF },
  { file: "observability-config-deploy.yml", job: "observability", concurrency: "observability-config-production", condition: GATE_IF },
  { file: "production-deploy-effective-admission-receipt.yml", job: "receipt", concurrency: null, condition: GATE_IF },
  { file: "source-free-journey-deploy.yml", job: "preview", concurrency: null, condition: "github.ref == 'refs/heads/main' && inputs.mode == 'PREVIEW' && github.run_attempt == 1 && github.triggering_actor == 'AquilaXk'" },
];

const read = (file) => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");

function jobBlock(workflow, job) {
  const begin = workflow.indexOf(`\n  ${job}:\n`);
  assert.notEqual(begin, -1, job);
  const rest = workflow.slice(begin + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function gateScript(workflow, job) {
  const block = jobBlock(workflow, job);
  const steps = block.slice(block.indexOf("    steps:\n") + "    steps:\n".length);
  // 행위자 확인은 checkout·secret·환경 접근 step보다 앞선 첫 step이어야 한다.
  assert.ok(steps.startsWith(STEP_NAME), "first step");
  const end = steps.indexOf("\n      - name:", STEP_NAME.length);
  const body = steps.slice(0, end === -1 ? undefined : end);
  assert.ok(body.includes("        env:\n          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n          DEPLOY_REF: ${{ github.ref }}\n          RUN_ATTEMPT: ${{ github.run_attempt }}\n"));
  assert.ok(body.includes('case "${TRIGGERING_ACTOR}" in\n'));
  const marker = "\n        run: |\n";
  return body.slice(body.indexOf(marker) + marker.length).split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

const runGate = (script, env) => spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const goodEnv = { DEPLOY_REF: "refs/heads/main", RUN_ATTEMPT: "1" };

for (const { file, job, concurrency, condition } of targets) {
  test(`${file}: job if가 허용 행위자만 통과시키고 concurrency는 job 단위다 (#244)`, () => {
    const workflow = read(file);
    const block = jobBlock(workflow, job);
    const header = block.slice(0, block.indexOf("    environment: production-deploy"));
    assert.ok(header.includes(`    if: ${condition}\n`), "job if");
    assert.equal((workflow.match(/triggering_actor ==/gu) ?? []).length, ALLOWED.length);
    // workflow 수준 concurrency는 건너뛴 job도 슬롯을 차지하므로 job 안에 둔다.
    assert.equal(/^concurrency:/mu.test(workflow), false);
    if (concurrency !== null) {
      assert.ok(header.includes(`    concurrency:\n      group: ${concurrency}\n      cancel-in-progress: false\n`));
    }
    assert.match(workflow, /\non:\n  workflow_dispatch:/u);
    assert.equal(/^  (schedule|push|pull_request|pull_request_target|workflow_run):/mu.test(workflow), false);
  });

  test(`${file}: 첫 step은 실제 bash에서 허용·유사 이름·대소문자·빈 값·와일드카드를 가른다 (#244)`, () => {
    const script = gateScript(read(file), job);
    for (const actor of ALLOWED) assert.equal(runGate(script, { ...goodEnv, TRIGGERING_ACTOR: actor }).status, 0, actor);
    for (const actor of ["AquilaXk-evil", "aquilaxk", "AQUILAXK", "AquilaXk[bot]", "easysubway-release-chain[bot]", "other-collaborator", "", "*", "AquilaXk\nother"]) {
      const result = runGate(script, { ...goodEnv, TRIGGERING_ACTOR: actor });
      assert.notEqual(result.status, 0, JSON.stringify(actor));
      assert.match(result.stderr, /deploy dispatcher is not authorized/u, JSON.stringify(actor));
    }
    // 재실행(run_attempt>1)과 main이 아닌 ref는 허용 행위자여도 거부한다.
    for (const env of [{ ...goodEnv, RUN_ATTEMPT: "2" }, { ...goodEnv, DEPLOY_REF: "refs/heads/feature" }, { ...goodEnv, DEPLOY_REF: "refs/heads/main-evil" }, { ...goodEnv, RUN_ATTEMPT: "" }]) {
      const result = runGate(script, { ...env, TRIGGERING_ACTOR: "AquilaXk" });
      assert.notEqual(result.status, 0, JSON.stringify(env));
    }
    // 환경 변수가 없으면(set -u) 통과가 아니라 실패다.
    assert.notEqual(runGate(script, goodEnv).status, 0);
  });
}

// production-deploy 환경을 선언한 모든 job은 게이트 대상 목록에 있어야 한다. 새 job이 게이트 없이 환경을 쓰면 이 테스트가 깨진다(#244 F2).
test("production-deploy 환경을 선언한 모든 job이 게이트 대상 목록에 있다 (#244 F2)", () => {
  const gated = new Set([...targets.map(({ file, job }) => `${file}#${job}`), "source-free-journey-k3s-deploy.yml#source-free-k3s"]);
  const found = new Set();
  for (const file of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((name) => /\.ya?ml$/u.test(name))) {
    const workflow = read(file);
    const jobsAt = workflow.indexOf("\njobs:\n");
    if (jobsAt === -1) continue;
    const jobs = workflow.slice(jobsAt + 1);
    for (const match of jobs.matchAll(/^  ([A-Za-z0-9_-]+):\n/gmu)) {
      if (/^    environment:\s*["']?production-deploy["']?\s*$/mu.test(jobBlock(workflow, match[1]))) found.add(`${file}#${match[1]}`);
    }
  }
  assert.deepEqual([...found].sort(), [...gated].sort());
});

test("Platform CI runs the actor gate contract (#244)", () => {
  assert.ok(read("ci.yml").includes("          node --test tools/ci/production-deploy-actor-gates.test.mjs\n"));
});
