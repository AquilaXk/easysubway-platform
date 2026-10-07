#!/usr/bin/env node
// AquilaXk/easysubway-platform#237: data 레포 정기 workflow를 GitHub `schedule` 대신 OCI k3s CronJob이 깨운다.
// 이 파일은 CronJob 안에서 도는 스크립트다(ConfigMap으로 마운트). 의존성 없이 node 내장 모듈만 쓴다.
//
// 흐름: 때가 된 항목 계산 -> App JWT(10분 이하) -> data 레포 설치 조회 -> 범위를 줄인 installation token 발급
//       (repositories:[easysubway-data], permissions:{actions:write}) -> 항목마다 정해진 분에 workflow_dispatch(main) -> token 폐기.
// 실패는 숨기지 않는다: 발급·범위 검증·dispatch 중 하나라도 실패하면 나머지 dispatch를 시도한 뒤 비0으로 끝난다.
// 이전 결과로 대신하거나 재시도로 덮지 않는다. GitHub `schedule`은 data 레포에 백업으로 남아 있다.
// token·JWT·private key는 로그와 오류에 남기지 않는다.
import { createPrivateKey, createSign } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "easysubway-data-workflow-scheduler";
const REQUEST_TIMEOUT_MS = 20_000;
const TARGET_REPOSITORY = "AquilaXk/easysubway-data";
const TARGET_REF = "main";
const HOUR_DIVISORS = Object.freeze([1, 2, 3, 4, 6, 8, 12, 24]);
// CronJob activeDeadlineSeconds(3300)보다 충분히 작아야 마지막 dispatch 뒤에 token 폐기까지 끝난다.
export const MAX_DISPATCH_MINUTE = 50;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const WORKFLOW_FILE = /^[a-z0-9][a-z0-9-]*\.yml$/u;
const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
const CLIENT_ID = /^[A-Za-z0-9]{10,64}$/u;

class SchedulerError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const fail = (code, detail) => { throw new SchedulerError(code, detail); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => isObject(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

export function validateScheduleConfig(config) {
  const bad = (detail) => fail("SCHEDULER_CONFIG", detail);
  if (!exactKeys(config, ["target", "workflows"]) || Object.keys(config).length !== 2) bad("shape");
  const { target, workflows } = config;
  if (!exactKeys(target, ["repository", "ref", "permissions"]) || target.repository !== TARGET_REPOSITORY || target.ref !== TARGET_REF
    || !isObject(target.permissions) || Object.keys(target.permissions).length !== 1 || target.permissions.actions !== "write") {
    bad(`target must be ${TARGET_REPOSITORY}@${TARGET_REF} with actions:write only`);
  }
  if (!Array.isArray(workflows) || workflows.length === 0) bad("workflows");
  const ids = new Set();
  for (const entry of workflows) {
    if (!exactKeys(entry, ["id", "workflow", "everyHours", "offsetHour", "minute"], ["inputs"])) bad("workflow entry shape");
    if (typeof entry.id !== "string" || !ID.test(entry.id) || ids.has(entry.id)) bad(`id ${JSON.stringify(entry.id)}`);
    ids.add(entry.id);
    if (typeof entry.workflow !== "string" || !WORKFLOW_FILE.test(entry.workflow)) bad(`workflow ${JSON.stringify(entry.workflow)}`);
    if (!HOUR_DIVISORS.includes(entry.everyHours)) bad(`${entry.id} everyHours`);
    if (!Number.isInteger(entry.offsetHour) || entry.offsetHour < 0 || entry.offsetHour >= entry.everyHours) bad(`${entry.id} offsetHour`);
    if (!Number.isInteger(entry.minute) || entry.minute < 0 || entry.minute > MAX_DISPATCH_MINUTE) bad(`${entry.id} minute`);
    if (entry.inputs !== undefined) {
      const names = isObject(entry.inputs) ? Object.keys(entry.inputs) : null;
      if (!names || names.length > 10 || names.some((name) => !INPUT_NAME.test(name) || typeof entry.inputs[name] !== "string")) bad(`${entry.id} inputs`);
    }
  }
  return config;
}

/** UTC 시각이 주기·offset에 맞는 항목을 분 순서(같으면 id 순서)로 돌려준다. */
export function dueEntries(workflows, date) {
  const hour = date.getUTCHours();
  return workflows
    .filter(({ everyHours, offsetHour }) => (((hour - offsetHour) % everyHours) + everyHours) % everyHours === 0)
    .sort((left, right) => left.minute - right.minute || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function createAppJwt({ clientId, privateKeyPem, now }) {
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) fail("SCHEDULER_APP_CLIENT_ID");
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    fail("SCHEDULER_APP_KEY", "private key is not a parsable PEM");
  }
  if (key.asymmetricKeyType !== "rsa") fail("SCHEDULER_APP_KEY", "private key must be RSA");
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: clientId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
}

function redactor(secrets) {
  return (text) => secrets.filter((secret) => typeof secret === "string" && secret.length >= 8)
    .reduce((current, secret) => current.split(secret).join("[redacted]"), String(text));
}

async function call(fetchImpl, redact, method, path, { bearer, body } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "x-github-api-version": API_VERSION,
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let json = null;
  if (response.status !== 204) {
    try {
      json = await response.json();
    } catch {
      json = null;
    }
  }
  const message = typeof json?.message === "string" ? redact(json.message).replace(/[^\x20-\x7e]/gu, "?").slice(0, 160) : "";
  return { status: response.status, json, message };
}

/**
 * App JWT -> 설치 조회 -> 범위를 줄인 installation token 발급·검증 -> useToken 실행 -> token 폐기.
 * 요청보다 넓게 발급된 token은 쓰지 않고 바로 폐기한다.
 */
async function withScopedInstallationToken({ config, clientId, privateKeyPem, now, fetchImpl, emit }, useToken) {
  const jwt = createAppJwt({ clientId, privateKeyPem, now: now() });
  const secrets = [jwt];
  const redact = redactor(secrets);
  const repositoryName = TARGET_REPOSITORY.split("/")[1];

  const installation = await call(fetchImpl, redact, "GET", `/repos/${TARGET_REPOSITORY}/installation`, { bearer: jwt });
  if (installation.status !== 200 || !Number.isSafeInteger(installation.json?.id) || installation.json.id < 1) {
    fail("SCHEDULER_INSTALLATION_LOOKUP_FAILED", `HTTP ${installation.status} ${installation.message}`.trim());
  }
  emit("installation_resolved", { installationId: installation.json.id });

  const minted = await call(fetchImpl, redact, "POST", `/app/installations/${installation.json.id}/access_tokens`, {
    bearer: jwt,
    body: { repositories: [repositoryName], permissions: config.target.permissions },
  });
  const token = minted.json?.token;
  if (minted.status !== 201 || typeof token !== "string" || token === "") {
    fail("SCHEDULER_TOKEN_MINT_FAILED", `HTTP ${minted.status} ${minted.message}`.trim());
  }
  secrets.push(token);

  try {
    const granted = minted.json.permissions;
    const names = isObject(granted) ? Object.keys(granted) : [];
    const repositories = Array.isArray(minted.json.repositories) ? minted.json.repositories.map((item) => item?.full_name) : [];
    if (granted?.actions !== "write" || names.some((name) => !["actions", "metadata"].includes(name))
      || (granted.metadata !== undefined && granted.metadata !== "read")
      || minted.json.repository_selection !== "selected" || repositories.length !== 1 || repositories[0] !== TARGET_REPOSITORY) {
      fail("SCHEDULER_TOKEN_SCOPE", "installation token is broader than actions:write on the data repository only");
    }
    emit("token_minted", { expiresAt: typeof minted.json.expires_at === "string" ? minted.json.expires_at : null });
    return await useToken({ token, redact });
  } finally {
    const revoked = await call(fetchImpl, redact, "DELETE", "/installation/token", { bearer: token }).catch(() => ({ status: 0 }));
    if (revoked.status === 204) emit("token_revoked");
    else emit("token_revoke_failed", { status: revoked.status });
  }
}

/** 배포 전에 App 자격이 실제로 동작하는지 확인한다: token을 범위 검증까지 발급하고 dispatch 없이 폐기한다. */
export async function verifyAppAccess({ config, clientId, privateKeyPem, now = () => new Date(), fetchImpl = fetch, log = console.log }) {
  validateScheduleConfig(config);
  const emit = (event, fields = {}) => log(JSON.stringify({ event, at: now().toISOString(), ...fields }));
  await withScopedInstallationToken({ config, clientId, privateKeyPem, now, fetchImpl, emit }, async () => {});
  emit("app_access_verified");
  return { verified: true };
}

export async function runScheduler({
  config, clientId, privateKeyPem, now = () => new Date(), fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), log = console.log,
}) {
  validateScheduleConfig(config);
  const emit = (event, fields = {}) => log(JSON.stringify({ event, at: now().toISOString(), ...fields }));
  const started = now();
  const due = dueEntries(config.workflows, started);
  if (due.length === 0) {
    emit("nothing_due", { hourUtc: started.getUTCHours() });
    return { dispatched: [] };
  }
  emit("schedule_start", { hourUtc: started.getUTCHours(), due: due.map(({ id }) => id) });

  const failures = [];
  const dispatched = [];
  await withScopedInstallationToken({ config, clientId, privateKeyPem, now: () => started, fetchImpl, emit }, async ({ token, redact }) => {
    const hourStart = Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate(), started.getUTCHours());
    for (const entry of due) {
      const wait = hourStart + entry.minute * 60_000 - now().getTime();
      if (wait > 0) await sleep(wait);
      const result = await call(fetchImpl, redact, "POST", `/repos/${TARGET_REPOSITORY}/actions/workflows/${entry.workflow}/dispatches`, {
        bearer: token,
        body: { ref: config.target.ref, ...(entry.inputs ? { inputs: entry.inputs } : {}) },
      });
      if (result.status === 204) {
        dispatched.push(entry.id);
        emit("dispatched", { id: entry.id, workflow: entry.workflow });
      } else {
        failures.push(`${entry.id} (HTTP ${result.status})`);
        emit("dispatch_failed", { id: entry.id, workflow: entry.workflow, status: result.status, message: result.message });
      }
    }
  });
  if (failures.length > 0) fail("SCHEDULER_DISPATCH_FAILED", failures.join(", "));
  emit("done", { dispatched });
  return { dispatched };
}

export async function main(env = process.env) {
  const configPath = env.SCHEDULER_CONFIG ?? "/opt/scheduler/schedule.json";
  const secretDirectory = env.SCHEDULER_SECRET_DIR ?? "/run/secrets/data-dispatch";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const clientId = (await readFile(`${secretDirectory}/client-id`, "utf8")).trim();
  const privateKeyPem = await readFile(`${secretDirectory}/private-key.pem`, "utf8");
  return runScheduler({ config, clientId, privateKeyPem });
}

// ConfigMap 볼륨은 심볼릭 링크라 node가 모듈 URL을 실제 경로로 푼다. argv[1]도 실제 경로로 풀어 비교하지 않으면
// 진입 조건이 거짓이 되어 main이 돌지 않고 Job이 아무것도 하지 않은 채 성공한다.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "SCHEDULER_FAILED"}\n`);
    process.exitCode = 1;
  }
}
