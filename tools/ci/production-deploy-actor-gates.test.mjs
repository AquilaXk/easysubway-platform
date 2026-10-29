import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { DEPLOY_ACTORS_BY_WORKFLOW } from "../platform/production-deploy-actor-allowlist.mjs";

// production-deploy 환경의 사람 승인을 없애도 쓰기 권한이 있는 다른 계정·App이 운영 배포 경로를 열지 못하게 하는 행위자 게이트 계약(platform#244).
// 일곱 workflow는 모두 workflow_dispatch만으로 시작하고(schedule·push·App dispatch 없음), 최근 run의 triggering_actor는 저장소 소유자뿐이다.
// 릴리스 체인 App은 source-free-journey-k3s-deploy만 dispatch하므로 여기서는 허용하지 않는다(최소 권한).
const ALLOWED = ["AquilaXk"];
const GATE_IF = "github.ref == 'refs/heads/main' && github.run_attempt == 1 && github.triggering_actor == 'AquilaXk'";
const STEP_NAME = "      - name: Require an authorized dispatcher\n";

const targets = [
  { file: "cd.yml", job: "preflight", concurrency: null, condition: GATE_IF },
  { file: "data-workflow-scheduler-deploy.yml", job: "scheduler", concurrency: "data-workflow-scheduler-production", condition: GATE_IF },
  { file: "observability-config-deploy.yml", job: "observability", concurrency: "observability-config-production", condition: GATE_IF },
  { file: "origin-certificate-renew.yml", job: "check", concurrency: "origin-certificate-production", condition: GATE_IF },
  { file: "origin-certificate-renew.yml", job: "renew", concurrency: "origin-certificate-production", condition: `${GATE_IF} && inputs.mode == 'RENEW'` },
  { file: "production-deploy-effective-admission-receipt.yml", job: "receipt", concurrency: null, condition: GATE_IF },
  { file: "source-free-journey-deploy.yml", job: "preview", concurrency: null, condition: "github.ref == 'refs/heads/main' && inputs.mode == 'PREVIEW' && github.run_attempt == 1 && github.triggering_actor == 'AquilaXk'" },
  { file: "source-reachability-probe-deploy.yml", job: "probe", concurrency: "source-reachability-probe-production", condition: GATE_IF },
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
    // job마다 job if에 허용 행위자 비교가 정확히 ALLOWED 수만큼 있다.
    assert.equal((header.match(/triggering_actor ==/gu) ?? []).length, ALLOWED.length);
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

// 영수증 검증기와 assembler가 쓰는 workflow별 허용 행위자 표(단일 출처)는 각 workflow의 실제 게이트와 같아야 한다(platform#247 F2).
test("영수증 허용 행위자 표는 검증기를 호출하는 모든 workflow의 job if·첫 step 게이트와 일치한다 (#247)", () => {
  const callers = readdirSync(new URL("../../.github/workflows/", import.meta.url))
    .filter((name) => /\.ya?ml$/u.test(name) && read(name).includes("verify-production-deploy-effective-admission-receipt.mjs"))
    .map((name) => `.github/workflows/${name}`).sort();
  assert.deepEqual(callers, Object.keys(DEPLOY_ACTORS_BY_WORKFLOW).sort());
  for (const [path, actors] of Object.entries(DEPLOY_ACTORS_BY_WORKFLOW)) {
    const workflow = read(path.replace(".github/workflows/", ""));
    const jobIf = workflow.split("\n").find((line) => /^ {4}if: /u.test(line) && line.includes("triggering_actor"));
    assert.ok(jobIf, path);
    assert.deepEqual([...jobIf.matchAll(/github\.triggering_actor == '([^']+)'/gu)].map((match) => match[1]).sort(), [...actors].sort(), `${path} job if`);
    const lines = workflow.split("\n");
    const caseLine = lines[lines.findIndex((line) => line.includes('case "${TRIGGERING_ACTOR}" in')) + 1];
    assert.ok(caseLine?.endsWith(") ;;"), `${path} case`);
    assert.deepEqual([...caseLine.matchAll(/"([^"]+)"/gu)].map((match) => match[1]).sort(), [...actors].sort(), `${path} first step case`);
  }
});

// 영수증은 환경 변수가 아니라 run 기록으로 행위자를 판정하지만, 어떤 workflow도 행위자·시도 변수를 덮어쓰지 않음을 함께 고정한다.
test("어떤 workflow도 GITHUB_ACTOR·GITHUB_RUN_ATTEMPT를 env로 덮어쓰지 않는다 (#247)", () => {
  for (const file of readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((name) => /\.ya?ml$/u.test(name))) {
    assert.doesNotMatch(read(file), /^\s*(GITHUB_ACTOR|GITHUB_TRIGGERING_ACTOR|GITHUB_RUN_ATTEMPT|GITHUB_RUN_ID)\s*:/mu, file);
  }
});

const REQUIRED_CODEOWNERS_PATHS = [
  ".github/workflows/**",
  ".github/CODEOWNERS",
  "tools/ci/production-deploy-actor-gates.test.mjs",
];

function verifyCodeownersContract(raw) {
  assert.equal(raw.includes("\r"), false, "CODEOWNERS must use LF line endings");
  const rules = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tokens = trimmed.split(/\s+/u);
    const [pattern, ...owners] = tokens;
    assert.ok(pattern && owners.length > 0, `line ${index + 1}: rule must specify pattern and owner`);
    rules.push({ line: index + 1, pattern: pattern.replace(/^\//u, ""), owners });
  }
  assert.deepEqual(
    rules.map(({ pattern }) => pattern),
    REQUIRED_CODEOWNERS_PATHS,
    "CODEOWNERS must declare the exact required trust-root paths in order without trailing override rules",
  );
  for (const rule of rules) {
    assert.deepEqual(rule.owners, ["@AquilaXk"], `${rule.pattern} must be owned exclusively by @AquilaXk`);
  }
  assert.match(raw, /require_code_owner_review:\s*false/u, "must document solo-repo require_code_owner_review: false constraint");
  assert.match(raw, /require_code_owner_review:\s*true/u, "must document collaborator transition procedure to require_code_owner_review: true");
}

test(".github/CODEOWNERS가 workflow·CODEOWNERS·게이트 계약 테스트의 단독 소유자를 @AquilaXk로 고정하고 전환 절차를 문서화한다 (#246)", () => {
  const codeowners = readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8");
  verifyCodeownersContract(codeowners);
});

test("CODEOWNERS 규칙 삭제·경로 제거·소유자 약화 변이는 게이트 계약을 깨뜨린다 (#246)", () => {
  const codeowners = readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8");
  const mutations = [
    ["빈 CODEOWNERS(전체 규칙 삭제)", "# comment only\n"],
    [
      "workflow 경로(.github/workflows/**) 제거",
      codeowners.replace(/^\.github\/workflows\/\*\*\s+@AquilaXk\n/mu, ""),
    ],
    [
      "CODEOWNERS 자기 보호 경로(.github/CODEOWNERS) 제거",
      codeowners.replace(/^\.github\/CODEOWNERS\s+@AquilaXk\n/mu, ""),
    ],
    [
      "게이트 계약 테스트 경로 제거",
      codeowners.replace(/^tools\/ci\/production-deploy-actor-gates\.test\.mjs\s+@AquilaXk\n/mu, ""),
    ],
    [
      "공동 소유자 추가로 단독 소유 약화",
      codeowners.replace(".github/workflows/** @AquilaXk", ".github/workflows/** @AquilaXk @other-collaborator"),
    ],
    [
      "소유자 누락(unowned pattern)",
      codeowners.replace(".github/workflows/** @AquilaXk", ".github/workflows/**"),
    ],
    [
      "후행 규칙으로 소유자 덮어쓰기",
      `${codeowners}.github/workflows/cd.yml @other-collaborator\n`,
    ],
  ];
  for (const [label, mutated] of mutations) {
    assert.throws(() => verifyCodeownersContract(mutated), label);
  }
});

