import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const actorContext = { ...context, actor: "easysubway-release-chain[bot]", runAttempt: "1" };

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

test("emits an ACTOR_GATE receipt when the environment has no human reviewer and the run was started by an allowed actor (platform#247)", async () => {
  for (const actor of ["AquilaXk", "easysubway-release-chain[bot]"]) {
    const receipt = await verifyEffectiveAdmissionReceipt({ ...actorContext, actor }, stubFetch({ environment: unattendedEnvironment }));
    assert.equal(receipt.schemaVersion, "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2");
    assert.deepEqual(receipt.approval, {
      mode: "ACTOR_GATE",
      canAdminsBypass: false,
      requiredReviewers: [],
      actorGate: { allowedActors: ["AquilaXk", "easysubway-release-chain[bot]"], triggeringActor: actor, runAttempt: 1 },
    });
    assert.deepEqual(receipt.branchPolicy, { protectedBranches: false, customBranchPolicies: true, allowedRefs: [{ type: "branch", name: "main" }] });
  }
  // 검토자가 있는 환경은 행위자 정보가 없어도(수동 receipt 실행 포함) 기존 REVIEWER 모드로 통과한다.
  const reviewerReceipt = await verifyEffectiveAdmissionReceipt(actorContext, stubFetch({}));
  assert.equal(reviewerReceipt.approval.mode, "REVIEWER");
  // 내보낸 두 모드의 키 집합과 순서는 스키마의 required와 같다(소비자 assembler가 순서까지 검사한다).
  const schema = JSON.parse(readFileSync(new URL("../../contracts/release/production-deploy-effective-admission-receipt.schema.json", import.meta.url)));
  const gated = await verifyEffectiveAdmissionReceipt(actorContext, stubFetch({ environment: unattendedEnvironment }));
  assert.deepEqual(Object.keys(reviewerReceipt.approval), schema.properties.approval.oneOf[0].required);
  assert.deepEqual(Object.keys(gated.approval), schema.properties.approval.oneOf[1].required);
  assert.deepEqual(Object.keys(gated.approval.actorGate), schema.properties.approval.oneOf[1].properties.actorGate.required);
  assert.deepEqual(Object.keys(gated), Object.keys(schema.properties));
});

test("ACTOR_GATE rejects an actor outside the allow-list, a rerun and missing actor facts", async () => {
  const stub = () => stubFetch({ environment: unattendedEnvironment });
  for (const actor of ["write-collaborator", "AquilaXk-evil", "aquilaxk", "AQUILAXK", "AquilaXk[bot]", "github-actions[bot]", "easysubway-release-chain", "", undefined, null, 7]) {
    await assert.rejects(verifyEffectiveAdmissionReceipt({ ...actorContext, actor }, stub()), { code: "E_PD_EAR_ACTOR_GATE" }, String(actor));
  }
  for (const runAttempt of ["2", "0", "", "01", "1 ", undefined, 1]) {
    await assert.rejects(verifyEffectiveAdmissionReceipt({ ...actorContext, runAttempt }, stub()), { code: "E_PD_EAR_ACTOR_GATE" }, String(runAttempt));
  }
  await assert.rejects(verifyEffectiveAdmissionReceipt(context, stub()), { code: "E_PD_EAR_ACTOR_GATE" });
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
  for (const values of cases) await assert.rejects(verifyEffectiveAdmissionReceipt(actorContext, stubFetch(values)), { code: /^E_PD_EAR_(APPROVAL|BRANCH_POLICY)$/ });
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

test("CLI reads the actor facts from the runner environment, never from arguments", () => {
  const script = fileURLToPath(new URL("./verify-production-deploy-effective-admission-receipt.mjs", import.meta.url));
  const args = ["--repository", context.repository, "--ref", context.ref, "--workflow-sha", context.workflowSha, "--run-url", context.runUrl];
  const respond = encodeURIComponent(`globalThis.fetch=async(url)=>({ok:true,status:200,json:async()=>String(url).endsWith("/deployment-branch-policies")?${JSON.stringify(policies)}:${JSON.stringify(unattendedEnvironment)}});`);
  const run = (extra, env) => spawnSync(process.execPath, ["--import", `data:text/javascript,${respond}`, script, ...args, ...extra], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_TOKEN: "t", ...env } });
  const ok = run([], { GITHUB_ACTOR: "easysubway-release-chain[bot]", GITHUB_RUN_ATTEMPT: "1" });
  assert.equal(ok.status, 0, ok.stderr);
  const receipt = JSON.parse(ok.stdout);
  assert.equal(receipt.approval.mode, "ACTOR_GATE");
  assert.equal(receipt.approval.actorGate.triggeringActor, "easysubway-release-chain[bot]");
  for (const env of [{ GITHUB_ACTOR: "other", GITHUB_RUN_ATTEMPT: "1" }, { GITHUB_ACTOR: "AquilaXk", GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_ACTOR: "AquilaXk" }, {}]) {
    const denied = run([], env);
    assert.notEqual(denied.status, 0, JSON.stringify(env));
    assert.equal(denied.stdout, "");
    assert.match(denied.stderr, /^E_PD_EAR_ACTOR_GATE\n$/);
  }
  // 행위자는 인자로 줄 수 없다: 인자 집합은 그대로 닫혀 있다.
  const extra = run(["--actor", "AquilaXk"], { GITHUB_ACTOR: "AquilaXk", GITHUB_RUN_ATTEMPT: "1" });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /^E_PD_EAR_ARGUMENTS\n$/);
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
  assert.deepEqual(actorGate.properties.actorGate.required, ["allowedActors", "triggeringActor", "runAttempt"]);
  assert.deepEqual(actorGate.properties.actorGate.properties.allowedActors.const, ["AquilaXk", "easysubway-release-chain[bot]"]);
  assert.deepEqual(actorGate.properties.actorGate.properties.triggeringActor.enum, ["AquilaXk", "easysubway-release-chain[bot]"]);
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
    return {
    ok: values.status >= 200 && values.status < 300,
    status: values.status,
    json: async () => {
      if (values.jsonError) throw new Error("raw-provider-body");
      if (values.jsonNeverSettles) return new Promise(() => {});
      return url.endsWith("/deployment-branch-policies") ? values.policies : values.environment;
    },
  };
  };
}

function abortOnSignal(signal) {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
}
