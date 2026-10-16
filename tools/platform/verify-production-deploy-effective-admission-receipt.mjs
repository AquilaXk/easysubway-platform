#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { allowedActorsFor } from "./production-deploy-actor-allowlist.mjs";

const REPOSITORY = "AquilaXk/easysubway-platform";
const ENVIRONMENT = "production-deploy";
const REF = "refs/heads/main";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 5_000;
// run 기록이 아직 시작 상태로 반영되지 않은 동안 같은 run을 다시 읽는 횟수와 간격이다(platform#256). 끝내 시작되지 않으면 실패한다.
const RUN_START_MAX_READS = 12;
const RUN_START_READ_INTERVAL_MS = 5_000;
const NOT_STARTED_RUN_STATUSES = new Set(["queued", "requested", "waiting", "pending"]);
const OBSERVED_VALUE_MAX_LENGTH = 48;

export async function verifyEffectiveAdmissionReceipt(context, request, timeoutMs = REQUEST_TIMEOUT_MS, pause = sleep) {
  assertContext(context);
  if (typeof request !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail("E_PD_EAR_REQUEST");

  const base = `https://api.github.com/repos/${REPOSITORY}/environments/${ENVIRONMENT}`;
  const environment = await getJson(request, base, timeoutMs);
  const policies = await getJson(request, `${base}/deployment-branch-policies`, timeoutMs);
  const classified = validateApproval(environment);
  const branchPolicy = validateBranchPolicy(environment, policies);
  // 사람 승인이 없는 환경은 승인 대신 이 run의 행위자를 Actions API 기록으로 확인한다(환경 변수는 쓰지 않는다).
  const approval = classified.mode === "ACTOR_GATE" ? await readActorGate(request, context, timeoutMs, pause) : classified;

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
    const context = parseArguments(process.argv.slice(2));
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
    process.stderr.write(error instanceof ReceiptError ? `${error.code}\n${error.detail === undefined ? "" : `${error.detail}\n`}` : "E_PD_EAR_FAILURE\n");
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
//   ACTOR_GATE: 배포 브랜치 정책 하나뿐(검토자 없음), 관리자 우회 불가. 행위자는 readActorGate가 run 기록으로 확인한다.
function validateApproval(environment) {
  if (!isObject(environment) || environment.name !== ENVIRONMENT || environment.can_admins_bypass !== false || !Array.isArray(environment.protection_rules)) fail("E_PD_EAR_APPROVAL");
  const rules = environment.protection_rules;
  const requiredReviewerRules = rules.filter((rule) => isObject(rule) && rule.type === "required_reviewers");
  const branchPolicyRules = rules.filter((rule) => isObject(rule) && rule.type === "branch_policy");
  if (branchPolicyRules.length !== 1) fail("E_PD_EAR_APPROVAL");
  if (requiredReviewerRules.length === 0) {
    if (rules.length !== 1) fail("E_PD_EAR_APPROVAL");
    return { mode: "ACTOR_GATE" };
  }
  if (rules.length !== 2 || requiredReviewerRules.length !== 1) fail("E_PD_EAR_APPROVAL");
  const rule = requiredReviewerRules[0];
  if (rule.prevent_self_review !== false || !Array.isArray(rule.reviewers) || rule.reviewers.length !== 1) fail("E_PD_EAR_APPROVAL");
  const reviewer = rule.reviewers[0];
  if (!isObject(reviewer) || reviewer.type !== "User" || !isObject(reviewer.reviewer) || reviewer.reviewer.login !== "AquilaXk") fail("E_PD_EAR_APPROVAL");
  return { mode: "REVIEWER", canAdminsBypass: false, preventSelfReview: false, requiredReviewers: [{ type: "User", login: "AquilaXk" }] };
}

// 현재 run의 기록(Actions API)으로 호출 workflow(path)와 시작 행위자(triggering_actor)·실행 시도를 확인한다.
// 환경 변수(GITHUB_ACTOR 등)는 step `env:`로 바뀔 수 있어 근거로 쓰지 않는다. 기록을 읽지 못하거나 어긋나면 실패한다.
async function readActorGate(request, context, timeoutMs, pause) {
  const runId = /\/actions\/runs\/([1-9][0-9]*)$/.exec(context.runUrl)?.[1];
  if (runId === undefined) fail("E_PD_EAR_CONTEXT");
  const run = await readStartedRun(request, runId, timeoutMs, pause);
  const checks = isObject(run) ? runRecordChecks(run, runId, context.workflowSha) : undefined;
  if (checks === undefined) fail("E_PD_EAR_ACTOR_GATE", "run record is not an object");
  const mismatches = checks.filter(({ matches }) => !matches);
  if (mismatches.length > 0) fail("E_PD_EAR_ACTOR_GATE", mismatches.map(({ field, observed }) => `${field}=${observe(observed)}`).join(" "));
  return {
    mode: "ACTOR_GATE",
    canAdminsBypass: false,
    requiredReviewers: [],
    actorGate: { workflow: run.path, allowedActors: allowedActorsFor(run.path), triggeringActor: run.triggering_actor.login, runAttempt: 1 },
  };
}

// 이 run의 기록이 아직 시작 전 상태이면 정해진 횟수까지 다시 읽어 확정한다. 확정된 기록만 판정하고, 그 밖의 기록은 그대로 판정으로 넘긴다.
async function readStartedRun(request, runId, timeoutMs, pause) {
  const url = `https://api.github.com/repos/${REPOSITORY}/actions/runs/${runId}`;
  for (let reads = 1; ; reads += 1) {
    const run = await getJson(request, url, timeoutMs);
    if (!isObject(run) || String(run.id) !== runId || !NOT_STARTED_RUN_STATUSES.has(run.status)) return run;
    if (reads === RUN_START_MAX_READS) fail("E_PD_EAR_RUN_NOT_STARTED", `status=${observe(run.status)} reads=${reads}`);
    await pause(RUN_START_READ_INTERVAL_MS);
  }
}

function runRecordChecks(run, runId, workflowSha) {
  const allowedActors = allowedActorsFor(run.path);
  const triggeringActor = isObject(run.triggering_actor) ? run.triggering_actor.login : undefined;
  return [
    { field: "id", observed: String(run.id), matches: String(run.id) === runId },
    { field: "status", observed: run.status, matches: run.status === "in_progress" },
    { field: "event", observed: run.event, matches: run.event === "workflow_dispatch" },
    { field: "head_branch", observed: run.head_branch, matches: run.head_branch === "main" },
    { field: "head_sha", observed: run.head_sha, matches: run.head_sha === workflowSha },
    { field: "run_attempt", observed: run.run_attempt, matches: run.run_attempt === 1 },
    { field: "path", observed: run.path, matches: allowedActors !== undefined },
    { field: "triggering_actor", observed: triggeringActor, matches: typeof triggeringActor === "string" && allowedActors?.includes(triggeringActor) === true },
  ];
}

// 로그에 남기는 관측값은 JSON 한 줄로 만들어 길이를 제한한다.
function observe(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > OBSERVED_VALUE_MAX_LENGTH ? `${text.slice(0, OBSERVED_VALUE_MAX_LENGTH)}...` : text;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function fail(code, detail) {
  throw new ReceiptError(code, detail);
}

class ReceiptError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
