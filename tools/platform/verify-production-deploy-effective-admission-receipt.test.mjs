import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEPLOY_ACTORS_BY_WORKFLOW, allowedActorsFor } from "./production-deploy-actor-allowlist.mjs";
import { verifyEffectiveAdmissionReceipt } from "./verify-production-deploy-effective-admission-receipt.mjs";

const context = {
  repository: "AquilaXk/easysubway-platform",
  ref: "refs/heads/main",
  workflowSha: "a".repeat(40),
  runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/68",
};
const environment = {
  name: "production-deploy",
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "AquilaXk" } }] },
    { type: "branch_policy" },
  ],
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const policies = { total_count: 1, branch_policies: [{ type: "branch", name: "main" }] };
// 사람 승인을 없앤 환경(platform#247): 보호 규칙은 배포 브랜치 정책 하나뿐이다. 승인 대신 행위자 게이트가 배포를 연다.
const unattendedEnvironment = { ...environment, protection_rules: [{ type: "branch_policy" }] };
// ACTOR_GATE는 환경 변수가 아니라 현재 run 기록(Actions API)으로 행위자를 판정한다(platform#247 F1). 호출 workflow는 run 기록의 path로 판별한다(F2).
const K3S_WORKFLOW = ".github/workflows/source-free-journey-k3s-deploy.yml";
const OWNER_ONLY_WORKFLOW = ".github/workflows/observability-config-deploy.yml";
const runRecord = (overrides = {}) => ({
  id: 68, status: "in_progress", event: "workflow_dispatch", head_branch: "main", head_sha: context.workflowSha, run_attempt: 1,
  path: K3S_WORKFLOW, triggering_actor: { login: "easysubway-release-chain[bot]" }, ...overrides,
});

test("emits one canonical effective-admission receipt from the exact live contract", async () => {
  const requests = [];
  const receipt = await verifyEffectiveAdmissionReceipt(context, stubFetch({}, requests));
  assert.deepEqual(receipt, {
    schemaVersion: "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2",
    artifactKind: "production-deploy-effective-admission-receipt-v2",
    repository: context.repository,
    environment: "production-deploy",
    ref: context.ref,
    workflowSha: context.workflowSha,
    runUrl: context.runUrl,
    observedAt: receipt.observedAt,
    approval: { mode: "REVIEWER", canAdminsBypass: false, preventSelfReview: false, requiredReviewers: [{ type: "User", login: "AquilaXk" }] },
    branchPolicy: { protectedBranches: false, customBranchPolicies: true, allowedRefs: [{ type: "branch", name: "main" }] },
  });
  assert.match(receipt.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  assert.deepEqual(requests.map(({ url, options }) => [url, options]), [
    ["https://api.github.com/repos/AquilaXk/easysubway-platform/environments/production-deploy", { method: "GET", signal: requests[0].options.signal, headers: { "X-GitHub-Api-Version": "2022-11-28" } }],
    ["https://api.github.com/repos/AquilaXk/easysubway-platform/environments/production-deploy/deployment-branch-policies", { method: "GET", signal: requests[1].options.signal, headers: { "X-GitHub-Api-Version": "2022-11-28" } }],
  ]);
});

test("emits an ACTOR_GATE receipt from the run record when the environment has no human reviewer (platform#247)", async () => {
  const requests = [];
  for (const [path, actor] of [[K3S_WORKFLOW, "AquilaXk"], [K3S_WORKFLOW, "easysubway-release-chain[bot]"], [OWNER_ONLY_WORKFLOW, "AquilaXk"]]) {
    const receipt = await verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment, run: runRecord({ path, triggering_actor: { login: actor } }) }, requests));
    assert.equal(receipt.schemaVersion, "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2");
    assert.deepEqual(receipt.approval, {
      mode: "ACTOR_GATE",
      canAdminsBypass: false,
      requiredReviewers: [],
      actorGate: { workflow: path, allowedActors: allowedActorsFor(path), triggeringActor: actor, runAttempt: 1 },
    });
    assert.deepEqual(receipt.branchPolicy, { protectedBranches: false, customBranchPolicies: true, allowedRefs: [{ type: "branch", name: "main" }] });
  }
  assert.deepEqual(allowedActorsFor(K3S_WORKFLOW), ["AquilaXk", "easysubway-release-chain[bot]"]);
  assert.deepEqual(allowedActorsFor(OWNER_ONLY_WORKFLOW), ["AquilaXk"]);
  // 현재 run 기록은 환경·브랜치 정책 다음에 같은 저장소의 run 한 건만 읽는다.
  assert.equal(requests[2].url, "https://api.github.com/repos/AquilaXk/easysubway-platform/actions/runs/68");
  assert.equal(requests[2].options.method, "GET");
  // 검토자가 있는 환경은 run 기록을 읽지 않고 기존 REVIEWER 모드로 통과한다.
  const before = requests.length;
  const reviewerReceipt = await verifyEffectiveAdmissionReceipt(context, stubFetch({}, requests));
  assert.equal(reviewerReceipt.approval.mode, "REVIEWER");
  assert.equal(requests.length - before, 2);
  // 내보낸 두 모드의 키 집합과 순서는 스키마의 required와 같다(소비자 assembler가 순서까지 검사한다).
  const schema = JSON.parse(readFileSync(new URL("../../contracts/release/production-deploy-effective-admission-receipt.schema.json", import.meta.url)));
  const gated = await verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment, run: runRecord() }));
  assert.deepEqual(Object.keys(reviewerReceipt.approval), schema.properties.approval.oneOf[0].required);
  assert.deepEqual(Object.keys(gated.approval), schema.properties.approval.oneOf[1].required);
  assert.deepEqual(Object.keys(gated.approval.actorGate), schema.properties.approval.oneOf[1].properties.actorGate.required);
  assert.deepEqual(Object.keys(gated), Object.keys(schema.properties));
});

test("ACTOR_GATE rejects an actor outside the calling workflow's allow-list, a rerun and a mismatched run record", async () => {
  const gate = (run) => stubFetch({ environment: unattendedEnvironment, run });
  const denied = (run, label) => assert.rejects(verifyEffectiveAdmissionReceipt(context, gate(run)), { code: "E_PD_EAR_ACTOR_GATE" }, label);
  // 같은 App이라도 k3s 배포 workflow만 허용된다. 나머지 workflow는 소유자만이다(F2).
  for (const path of [OWNER_ONLY_WORKFLOW, ".github/workflows/data-workflow-scheduler-deploy.yml", ".github/workflows/source-free-journey-deploy.yml", ".github/workflows/production-deploy-effective-admission-receipt.yml"]) {
    await denied(runRecord({ path, triggering_actor: { login: "easysubway-release-chain[bot]" } }), path);
  }
  for (const login of ["write-collaborator", "AquilaXk-evil", "aquilaxk", "AQUILAXK", "AquilaXk[bot]", "github-actions[bot]", "easysubway-release-chain", "", null, 7]) {
    await denied(runRecord({ triggering_actor: { login } }), String(login));
  }
  await denied(runRecord({ triggering_actor: null }), "no actor");
  await denied(runRecord({ triggering_actor: undefined }), "missing actor");
  // 호출 workflow를 알 수 없거나 ref가 붙은 path는 거부한다.
  for (const path of [".github/workflows/cd.yml", ".github/workflows/unknown.yml", `${K3S_WORKFLOW}@refs/heads/feature`, "", null, undefined, "constructor", "__proto__"]) await denied(runRecord({ path }), String(path));
  // 재실행, 다른 run·commit·branch·event, 끝난 run은 거부한다.
  for (const [label, overrides] of [
    ["rerun", { run_attempt: 2 }], ["attempt string", { run_attempt: "1" }], ["attempt missing", { run_attempt: undefined }],
    ["other run", { id: 69 }], ["other sha", { head_sha: "b".repeat(40) }], ["other branch", { head_branch: "feature" }],
    ["push event", { event: "push" }], ["completed", { status: "completed" }], ["queued", { status: "queued" }],
  ]) await denied(runRecord(overrides), label);
  // 환경 변수는 판정에 쓰이지 않는다: 값이 있어도 run 기록이 허용하지 않으면 거부한다.
  process.env.GITHUB_ACTOR = "AquilaXk";
  process.env.GITHUB_RUN_ATTEMPT = "1";
  try { await denied(runRecord({ triggering_actor: { login: "write-collaborator" }, run_attempt: 2 }), "env spoof"); } finally { delete process.env.GITHUB_ACTOR; delete process.env.GITHUB_RUN_ATTEMPT; }
  // run 기록을 읽지 못하면 성공으로 대체하지 않는다(fail-closed).
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment })), { code: "E_PD_EAR_ACTOR_GATE" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment, run: "not-an-object" })), { code: "E_PD_EAR_ACTOR_GATE" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment, runStatus: 404 })), { code: "E_PD_EAR_HTTP" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ environment: unattendedEnvironment, runJsonError: true })), { code: "E_PD_EAR_JSON" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, (url, options) => (url.includes("/actions/runs/") ? new Promise(() => {}) : stubFetch({ environment: unattendedEnvironment })(url, options)), 1), { code: "E_PD_EAR_TIMEOUT" });
});

test("ACTOR_GATE still rejects every environment deviation, so removing the reviewer cannot open more than the branch-policy rule", async () => {
  const withRules = (rules) => ({ ...unattendedEnvironment, protection_rules: rules });
  const cases = [
    { environment: withRules([]) },
    { environment: withRules([{ type: "branch_policy" }, { type: "wait_timer" }]) },
    { environment: withRules([{ type: "branch_policy" }, { type: "branch_policy" }]) },
    { environment: withRules([{ type: "wait_timer" }]) },
    { environment: withRules([{ type: "required_reviewers", prevent_self_review: false, reviewers: [] }, { type: "branch_policy" }]) },
    { environment: withRules([{ type: "branch_policy" }, "not-a-rule"]) },
    { environment: { ...unattendedEnvironment, can_admins_bypass: true } },
    { environment: { ...unattendedEnvironment, can_admins_bypass: undefined } },
    { environment: { ...unattendedEnvironment, deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } } },
    { environment: { ...unattendedEnvironment, protection_rules: "none" } },
    { environment: unattendedEnvironment, policies: { total_count: 2, branch_policies: [{ type: "branch", name: "main" }, { type: "branch", name: "release" }] } },
    { environment: unattendedEnvironment, policies: { total_count: 1, branch_policies: [{ type: "branch", name: "release" }] } },
  ];
  for (const values of cases) await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ run: runRecord(), ...values })), { code: /^E_PD_EAR_(APPROVAL|BRANCH_POLICY)$/ });
});

test("rejects every reviewer and branch-policy deviation", async () => {
  const cases = [
    { environment: { ...environment, protection_rules: [] } },
    { environment: reviewers([{ type: "User", reviewer: { login: "AquilaXk" } }, { type: "User", reviewer: { login: "AquilaXk" } }]) },
    { environment: reviewers([{ type: "Team", reviewer: { login: "AquilaXk" } }]) },
    { environment: reviewers([{ type: "User", reviewer: { login: "other" } }]) },
    { environment: { ...environment, protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { login: "AquilaXk" } }] }, { type: "branch_policy" }] } },
    { environment: { ...environment, protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "AquilaXk" } }] }, { type: "branch_policy" }, { type: "wait_timer" }] } },
    { environment: { ...environment, can_admins_bypass: true } },
    { environment: { ...environment, name: "other" } },
    { environment: { ...environment, deployment_branch_policy: { protected_branches: true, custom_branch_policies: true } } },
    { environment: { ...environment, deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } } },
    { policies: { total_count: 0, branch_policies: [] } },
    { policies: { total_count: 2, branch_policies: [{ type: "branch", name: "main" }] } },
    { policies: { total_count: 1, branch_policies: [{ type: "branch", name: "main" }, { type: "branch", name: "main" }] } },
    { policies: { total_count: 1, branch_policies: [{ type: "tag", name: "main" }] } },
    { policies: { total_count: 1, branch_policies: [{ type: "branch", name: "release" }] } },
  ];
  for (const values of cases) await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch(values)));
});

test("rejects malformed provider data and context mismatches without leaking provider data", async () => {
  for (const values of [
    { environment: "not-json-object" },
    { policies: { total_count: 1, branch_policies: "not-an-array" } },
    { jsonError: true },
    { status: 201 },
    { status: 500, body: "token=super-secret&raw-provider-body" },
  ]) {
    await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch(values)), (error) => {
      assert.doesNotMatch(error.message, /super-secret|raw-provider-body|raw-provider-node-id|token=/);
      return true;
    });
  }
  for (const mismatch of [
    { repository: "AquilaXk/other" }, { ref: "refs/heads/release" }, { workflowSha: "A".repeat(40) }, { runUrl: "https://github.com/AquilaXk/easysubway-platform/actions/runs/0?token=secret" },
  ]) await assert.rejects(verifyEffectiveAdmissionReceipt({ ...context, ...mismatch }, stubFetch()));
});

test("never-settling requests and response JSON abort with a typed sanitized failure", async () => {
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, () => new Promise(() => {}), 1), { code: "E_PD_EAR_TIMEOUT" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stubFetch({ jsonNeverSettles: true }), 1), { code: "E_PD_EAR_TIMEOUT" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, (_, options) => abortOnSignal(options.signal), 1), { code: "E_PD_EAR_TIMEOUT" });
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, (_, options) => Promise.resolve({ ok: true, status: 200, json: () => abortOnSignal(options.signal) }), 1), { code: "E_PD_EAR_TIMEOUT" });
});

test("CLI failures are typed, silent on stdout, and redact supplied secrets", () => {
  const script = fileURLToPath(new URL("./verify-production-deploy-effective-admission-receipt.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--repository", "AquilaXk/other", "--ref", "refs/heads/main", "--workflow-sha", "a".repeat(40), "--run-url", "https://github.com/AquilaXk/easysubway-platform/actions/runs/68?token=super-secret"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_TOKEN: "super-secret" },
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^E_PD_EAR_CONTEXT\n$/);
  assert.doesNotMatch(result.stderr, /super-secret|token=|raw-provider-body/);

  const timeoutResult = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent("globalThis.fetch=()=>new Promise(()=>{});")}`, script, "--repository", context.repository, "--ref", context.ref, "--workflow-sha", context.workflowSha, "--run-url", context.runUrl], {
    encoding: "utf8",
    timeout: 7_000,
    env: { ...process.env, GITHUB_TOKEN: "super-secret" },
  });
  assert.equal(timeoutResult.error, undefined);
  assert.notEqual(timeoutResult.status, 0);
  assert.equal(timeoutResult.stdout, "");
  assert.match(timeoutResult.stderr, /^E_PD_EAR_TIMEOUT\n$/);
  assert.doesNotMatch(timeoutResult.stderr, /super-secret|token=|raw-provider-body/);
});

test("CLI judges the actor by the run record, never by environment variables or arguments", () => {
  const script = fileURLToPath(new URL("./verify-production-deploy-effective-admission-receipt.mjs", import.meta.url));
  const args = ["--repository", context.repository, "--ref", context.ref, "--workflow-sha", context.workflowSha, "--run-url", context.runUrl];
  // 가짜 fetch 모듈은 코드 문자열이 아니라 임시 파일로 주입한다(데이터를 코드로 조립하지 않는다).
  const directory = mkdtempSync(join(tmpdir(), "receipt-cli-"));
  try {
    let stubCount = 0;
    const stubFor = (run) => {
      const file = join(directory, `stub-${stubCount += 1}.mjs`);
      writeFileSync(file, [
        "const body = JSON.parse(process.env.STUB_BODIES);",
        "globalThis.fetch = async (url) => { const u = String(url); const value = u.endsWith('/deployment-branch-policies') ? body.policies : u.includes('/actions/runs/') ? body.run : body.environment; return { ok: true, status: 200, json: async () => value }; };",
      ].join("\n"));
      return [file, JSON.stringify({ policies, environment: unattendedEnvironment, run })];
    };
    const run = (record, extra = [], env = {}) => {
      const [file, bodies] = stubFor(record);
      return spawnSync(process.execPath, ["--import", pathToFileURL(file).href, script, ...args, ...extra], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_TOKEN: "t", STUB_BODIES: bodies, ...env } });
    };
    const ok = run(runRecord());
    assert.equal(ok.status, 0, ok.stderr);
    const receipt = JSON.parse(ok.stdout);
    assert.equal(receipt.approval.mode, "ACTOR_GATE");
    assert.equal(receipt.approval.actorGate.triggeringActor, "easysubway-release-chain[bot]");
    // 환경 변수로 행위자·시도를 지어내도 run 기록이 허용하지 않으면 거부한다.
    const spoof = run(runRecord({ triggering_actor: { login: "other" } }), [], { GITHUB_ACTOR: "AquilaXk", GITHUB_RUN_ATTEMPT: "1" });
    assert.notEqual(spoof.status, 0);
    assert.equal(spoof.stdout, "");
    assert.match(spoof.stderr, /^E_PD_EAR_ACTOR_GATE\n$/);
    // 행위자는 인자로 줄 수 없다: 인자 집합은 그대로 닫혀 있다.
    const extra = run(runRecord(), ["--actor", "AquilaXk"]);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /^E_PD_EAR_ARGUMENTS\n$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema and receipt workflow remain closed, least-privilege contracts", () => {
  const schema = JSON.parse(readFileSync(new URL("../../contracts/release/production-deploy-effective-admission-receipt.schema.json", import.meta.url)));
  assert.deepEqual(Object.keys(schema.properties), ["schemaVersion", "artifactKind", "repository", "environment", "ref", "workflowSha", "runUrl", "observedAt", "approval", "branchPolicy"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.branchPolicy.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2");
  assert.equal(schema.properties.artifactKind.const, "production-deploy-effective-admission-receipt-v2");
  // approval은 닫힌 두 모드의 oneOf다. 모드 밖 구조는 스키마가 거부한다.
  assert.equal(schema.properties.approval.type, "object");
  assert.equal(schema.properties.approval.oneOf.length, 2);
  const [reviewer, actorGate] = schema.properties.approval.oneOf;
  assert.equal(reviewer.additionalProperties, false);
  assert.deepEqual(reviewer.required, ["mode", "canAdminsBypass", "preventSelfReview", "requiredReviewers"]);
  assert.equal(reviewer.properties.mode.const, "REVIEWER");
  assert.deepEqual(Object.keys(reviewer.properties.requiredReviewers.items.properties), ["type", "login"]);
  assert.equal(reviewer.properties.requiredReviewers.items.additionalProperties, false);
  assert.equal(actorGate.additionalProperties, false);
  assert.deepEqual(actorGate.required, ["mode", "canAdminsBypass", "requiredReviewers", "actorGate"]);
  assert.equal(actorGate.properties.mode.const, "ACTOR_GATE");
  assert.equal(actorGate.properties.canAdminsBypass.const, false);
  assert.equal(actorGate.properties.requiredReviewers.maxItems, 0);
  assert.equal(actorGate.properties.actorGate.additionalProperties, false);
  assert.deepEqual(actorGate.properties.actorGate.required, ["workflow", "allowedActors", "triggeringActor", "runAttempt"]);
  // 스키마의 열거는 허용 목록 모듈(단일 출처)에서 파생된 값과 같아야 한다(F2).
  assert.deepEqual(actorGate.properties.actorGate.properties.workflow.enum, Object.keys(DEPLOY_ACTORS_BY_WORKFLOW));
  assert.deepEqual(actorGate.properties.actorGate.properties.allowedActors.items.enum, [...new Set(Object.values(DEPLOY_ACTORS_BY_WORKFLOW).flat())]);
  assert.deepEqual(actorGate.properties.actorGate.properties.triggeringActor.enum, [...new Set(Object.values(DEPLOY_ACTORS_BY_WORKFLOW).flat())]);
  assert.equal(actorGate.properties.actorGate.properties.runAttempt.const, 1);
  assert.deepEqual(Object.keys(schema.properties.branchPolicy.properties), ["protectedBranches", "customBranchPolicies", "allowedRefs"]);
  assert.deepEqual(Object.keys(schema.properties.branchPolicy.properties.allowedRefs.items.properties), ["type", "name"]);
  assert.equal(schema.properties.branchPolicy.properties.allowedRefs.items.additionalProperties, false);
  const workflow = readFileSync(new URL("../../.github/workflows/production-deploy-effective-admission-receipt.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n  actions: read$/m);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1 && github\.triggering_actor == 'AquilaXk'\n    environment: production-deploy$/m);
  assert.match(workflow, /^    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:$/m);
  assert.match(workflow, /^      - name: Set up Node\.js\n        uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\n        with:\n          node-version: 24$/m);
  assert.match(workflow, /^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(workflow, /node tools\/platform\/verify-production-deploy-effective-admission-receipt\.mjs --repository "\$\{\{ github\.repository \}\}" --ref "\$\{\{ github\.ref \}\}" --workflow-sha "\$\{\{ github\.sha \}\}" --run-url/);
  assert.match(workflow, /receipt_path="\$\{RUNNER_TEMP\}\/production-deploy-effective-admission-receipt\.json"\n          node [^\n]+ > "\$\{receipt_path\}"\n          receipt_sha256="\$\(sha256sum "\$\{receipt_path\}" \| cut -d ' ' -f 1\)"\n          cat "\$\{receipt_path\}" >> "\$\{GITHUB_STEP_SUMMARY\}"/);
  assert.doesNotMatch(workflow, /inputs:|secrets:|permissions:\s*\{|docker compose|oci|publish|traffic|recovery/i);
});

function reviewers(reviewers_) {
  return { ...environment, protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: reviewers_ }, { type: "branch_policy" }] };
}

function stubFetch(overrides = {}, requests = []) {
  const values = { environment, policies, status: 200, ...overrides };
  return async (url, options) => {
    requests.push({ url, options });
    const isRun = url.includes("/actions/runs/");
    const status = isRun && values.runStatus !== undefined ? values.runStatus : values.status;
    return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (values.jsonError || (isRun && values.runJsonError)) throw new Error("raw-provider-body");
      if (values.jsonNeverSettles) return new Promise(() => {});
      if (isRun) return values.run;
      return url.endsWith("/deployment-branch-policies") ? values.policies : values.environment;
    },
  };
  };
}

function abortOnSignal(signal) {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
}
