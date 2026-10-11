#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const REPOSITORY = "AquilaXk/easysubway-platform";
const ENVIRONMENT = "production-deploy";
const REF = "refs/heads/main";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 5_000;
// 사람 승인을 없앤 환경(ACTOR_GATE, platform#247)에서 배포를 여는 행위자. 승인 대신 각 workflow의 job `if`와 첫 step이 같은 행위자 게이트를 건다
// (platform#244, production-deploy-actor-gates.test.mjs가 환경을 쓰는 모든 job을 고정한다). 여기 목록은 그 workflow별 허용 목록의 합집합이다.
const ACTOR_GATE_ALLOWED_ACTORS = Object.freeze(["AquilaXk", "easysubway-release-chain[bot]"]);

export async function verifyEffectiveAdmissionReceipt(context, request, timeoutMs = REQUEST_TIMEOUT_MS) {
  assertContext(context);
  if (typeof request !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("E_PD_EAR_REQUEST");

  const base = `https://api.github.com/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
  const environment = await getJson(request, base, timeoutMs);
  const policies = await getJson(request, `${base}/deployment-branch-policies`, timeoutMs);
  const approval = validateApproval(environment, context);
  const branchPolicy = validateBranchPolicy(environment, policies);

  return {
    schemaVersion: "PRODUCTION_DEPLOY_EFFECTIVE_ADMISSION_RECEIPT_V2",
    artifactKind: "production-deploy-effective-admission-receipt-v2",
    repository: REPOSITORY,
    environment: ENVIRONMENT,
    ref: REF,
    workflowSha: context.workflowSha,
    runUrl: context.runUrl,
    observedAt: new Date().toISOString(),
    approval,
    branchPolicy,
  };
}

async function main() {
  try {
    // 행위자 사실은 인자가 아니라 runner 환경에서만 읽는다(호출자가 값을 지어낼 수 없게 인자 집합은 닫혀 있다).
    const context = { ...parseArguments(process.argv.slice(2)), actor: process.env.GITHUB_ACTOR, runAttempt: process.env.GITHUB_RUN_ATTEMPT };
    const token = process.env.GITHUB_TOKEN;
    if (typeof token !== "string" || token.length === 0) fail("E_PD_EAR_TOKEN");
    const receipt = await verifyEffectiveAdmissionReceipt(context, (url, options) => fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
    }));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ReceiptError ? error.code : "E_PD_EAR_FAILURE"}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(arguments_) {
  const names = ["repository", "ref", "workflow-sha", "run-url"];
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!names.includes(key?.slice(2)) || typeof value !== "string" || value.length === 0 || value.startsWith("--") || values.has(key)) fail("E_PD_EAR_ARGUMENTS");
    values.set(key, value);
  }
  if (values.size !== names.length) fail("E_PD_EAR_ARGUMENTS");
  return {
    repository: values.get("--repository"),
    ref: values.get("--ref"),
    workflowSha: values.get("--workflow-sha"),
    runUrl: values.get("--run-url"),
  };
}

async function getJson(request, url, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  let timedOut = false;
  let response;
  let stage = "request";
  try {
    const requestTimeout = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ReceiptError("E_PD_EAR_TIMEOUT"));
      }, timeoutMs);
    });
    response = await Promise.race([request(url, { method: "GET", signal: controller.signal, headers: { "X-GitHub-Api-Version": API_VERSION } }), requestTimeout]);
    if (!response || response.ok !== true || response.status !== 200) fail("E_PD_EAR_HTTP");
    stage = "json";
    return await Promise.race([response.json(), requestTimeout]);
  } catch (error) {
    if (timedOut) fail("E_PD_EAR_TIMEOUT");
    if (error instanceof ReceiptError) throw error;
    fail(stage === "json" ? "E_PD_EAR_JSON" : "E_PD_EAR_HTTP");
  } finally {
    clearTimeout(timeout);
  }
}

function assertContext(context) {
  if (!isObject(context) || context.repository !== REPOSITORY || context.ref !== REF || !/^[a-f0-9]{40}$/.test(context.workflowSha) || !new RegExp(`^https://github\\.com/${REPOSITORY}/actions/runs/[1-9][0-9]*$`).test(context.runUrl)) fail("E_PD_EAR_CONTEXT");
}

// 환경의 관측 상태가 정확히 두 모드 중 하나일 때만 통과한다. 그 밖(규칙 추가·부분 제거·검토자 2명 등)은 모두 실패한다.
//   REVIEWER: 검토자 AquilaXk 1명 + 배포 브랜치 정책, 관리자 우회 불가
//   ACTOR_GATE: 배포 브랜치 정책 하나뿐(검토자 없음), 관리자 우회 불가, 이 run의 행위자가 허용 목록이고 재실행이 아님
function validateApproval(environment, context) {
  if (!isObject(environment) || environment.name !== ENVIRONMENT || environment.can_admins_bypass !== false || !Array.isArray(environment.protection_rules)) fail("E_PD_EAR_APPROVAL");
  const rules = environment.protection_rules;
  const requiredReviewerRules = rules.filter((rule) => isObject(rule) && rule.type === "required_reviewers");
  const branchPolicyRules = rules.filter((rule) => isObject(rule) && rule.type === "branch_policy");
  if (branchPolicyRules.length !== 1) fail("E_PD_EAR_APPROVAL");
  if (requiredReviewerRules.length === 0) {
    if (rules.length !== 1) fail("E_PD_EAR_APPROVAL");
    return validateActorGate(context);
  }
  if (rules.length !== 2 || requiredReviewerRules.length !== 1) fail("E_PD_EAR_APPROVAL");
  const rule = requiredReviewerRules[0];
  if (rule.prevent_self_review !== false || !Array.isArray(rule.reviewers) || rule.reviewers.length !== 1) fail("E_PD_EAR_APPROVAL");
  const reviewer = rule.reviewers[0];
  if (!isObject(reviewer) || reviewer.type !== "User" || !isObject(reviewer.reviewer) || reviewer.reviewer.login !== "AquilaXk") fail("E_PD_EAR_APPROVAL");
  return { mode: "REVIEWER", canAdminsBypass: false, preventSelfReview: false, requiredReviewers: [{ type: "User", login: "AquilaXk" }] };
}

function validateActorGate(context) {
  if (typeof context.actor !== "string" || !ACTOR_GATE_ALLOWED_ACTORS.includes(context.actor) || context.runAttempt !== "1") fail("E_PD_EAR_ACTOR_GATE");
  return {
    mode: "ACTOR_GATE",
    canAdminsBypass: false,
    requiredReviewers: [],
    actorGate: { allowedActors: [...ACTOR_GATE_ALLOWED_ACTORS], triggeringActor: context.actor, runAttempt: 1 },
  };
}

function validateBranchPolicy(environment, policies) {
  if (!isObject(environment.deployment_branch_policy) || environment.deployment_branch_policy.protected_branches !== false || environment.deployment_branch_policy.custom_branch_policies !== true || !isObject(policies) || policies.total_count !== 1 || !Array.isArray(policies.branch_policies) || policies.branch_policies.length !== 1) fail("E_PD_EAR_BRANCH_POLICY");
  const policy = policies.branch_policies[0];
  if (!isObject(policy) || policy.type !== "branch" || policy.name !== "main") fail("E_PD_EAR_BRANCH_POLICY");
  return { protectedBranches: false, customBranchPolicies: true, allowedRefs: [{ type: "branch", name: "main" }] };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code) {
  throw new ReceiptError(code);
}

class ReceiptError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
