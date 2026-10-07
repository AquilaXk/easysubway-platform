import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createAppJwt, dueEntries, runScheduler, validateScheduleConfig, verifyAppAccess } from "./data-workflow-scheduler.mjs";

// AquilaXk/easysubway-platform#237: OCI k3s CronJob이 App easysubway-release-chain으로 data 레포 workflow를 dispatch한다.
// 이 테스트는 스크립트가 (1) 범위를 줄인 installation token만 쓰고 (2) 때가 된 workflow만 정해진 분에 dispatch하며
// (3) 어느 단계든 실패하면 숨기지 않고 실패하고 (4) 토큰·키를 로그와 오류에 남기지 않는지 고정한다.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const CLIENT_ID = "Iv23liTestClientId0001";
const INSTALLATION_TOKEN = "ghs_installationTokenValueThatMustNeverBeLogged";
const REPOSITORY = "AquilaXk/easysubway-data";

const config = {
  target: { repository: REPOSITORY, ref: "main", permissions: { actions: "write" } },
  workflows: [
    { id: "source-reverification", workflow: "source-reverification.yml", everyHours: 2, offsetHour: 0, minute: 23 },
    { id: "current-capital-topology-registration", workflow: "current-capital-topology-registration.yml", everyHours: 2, offsetHour: 0, minute: 5 },
    { id: "datapack-expiry-alert-datapack-expiry", workflow: "datapack-expiry-alert.yml", everyHours: 4, offsetHour: 0, minute: 23, inputs: { target: "datapack-expiry" } },
    { id: "source-derivative-rebinding", workflow: "source-derivative-rebinding.yml", everyHours: 6, offsetHour: 0, minute: 41 },
    { id: "itx-current-promotion", workflow: "itx-current-promotion.yml", everyHours: 24, offsetHour: 18, minute: 0 },
  ],
};
const at = (iso) => new Date(iso);

function fakeGitHub({ now, mint, installation, dispatchStatus = {}, revokeStatus = 204 } = {}) {
  const calls = [];
  const logs = [];
  let clock = now;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url: String(url), headers: options.headers ?? {}, body: options.body === undefined ? undefined : JSON.parse(options.body), at: clock.toISOString() });
    const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
    if (String(url) === `https://api.github.com/repos/${REPOSITORY}/installation`) return reply(200, installation ?? { id: 167775157, app_slug: "easysubway-release-chain" });
    if (String(url) === "https://api.github.com/app/installations/167775157/access_tokens") {
      return mint ? mint() : reply(201, {
        token: INSTALLATION_TOKEN,
        expires_at: "2026-10-07T05:00:00Z",
        permissions: { actions: "write", metadata: "read" },
        repository_selection: "selected",
        repositories: [{ full_name: REPOSITORY }],
      });
    }
    if (String(url) === "https://api.github.com/installation/token" && method === "DELETE") return reply(revokeStatus);
    const dispatch = /\/actions\/workflows\/([^/]+)\/dispatches$/u.exec(String(url));
    if (dispatch && method === "POST") {
      const status = dispatchStatus[dispatch[1]] ?? 204;
      return reply(status, status === 204 ? undefined : { message: "Workflow does not have 'workflow_dispatch' trigger", documentation_url: "https://docs.github.com" });
    }
    return reply(404, { message: "unexpected" });
  };
  const sleep = async (ms) => { clock = new Date(clock.getTime() + ms); };
  return { calls, logs, fetchImpl, sleep, now: () => clock, log: (line) => logs.push(line) };
}

const run = (github, extra = {}) => runScheduler({
  config, clientId: CLIENT_ID, privateKeyPem, now: github.now, fetchImpl: github.fetchImpl, sleep: github.sleep, log: github.log, ...extra,
});
const dispatches = (github) => github.calls.filter(({ url }) => url.endsWith("/dispatches"));

test("UTC 시각이 주기와 offset에 맞는 항목만 때가 되고 분 순서로 정렬된다", () => {
  const ids = (iso) => dueEntries(config.workflows, at(iso)).map(({ id }) => id);
  assert.deepEqual(ids("2026-10-07T00:00:00Z"), ["current-capital-topology-registration", "datapack-expiry-alert-datapack-expiry", "source-reverification", "source-derivative-rebinding"]);
  assert.deepEqual(ids("2026-10-07T01:30:00Z"), []);
  assert.deepEqual(ids("2026-10-07T02:10:00Z"), ["current-capital-topology-registration", "source-reverification"]);
  assert.deepEqual(ids("2026-10-07T04:00:00Z"), ["current-capital-topology-registration", "datapack-expiry-alert-datapack-expiry", "source-reverification"]);
  assert.deepEqual(ids("2026-10-07T18:00:00Z"), ["itx-current-promotion", "current-capital-topology-registration", "source-reverification", "source-derivative-rebinding"]);
});

test("App JWT는 RS256이고 client id가 iss이며 10분을 넘지 않고 공개키로 검증된다", () => {
  const jwt = createAppJwt({ clientId: CLIENT_ID, privateKeyPem, now: at("2026-10-07T00:00:00Z") });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  const nowSeconds = Date.parse("2026-10-07T00:00:00Z") / 1000;
  assert.deepEqual(claims, { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: CLIENT_ID });
  assert.ok(claims.exp - claims.iat <= 600);
  assert.equal(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKeyPem, Buffer.from(signature, "base64url")), true);
  assert.throws(() => createAppJwt({ clientId: CLIENT_ID, privateKeyPem: "not a key", now: at("2026-10-07T00:00:00Z") }), /SCHEDULER_APP_KEY/u);
  assert.throws(() => createAppJwt({ clientId: "", privateKeyPem, now: at("2026-10-07T00:00:00Z") }), /SCHEDULER_APP_CLIENT_ID/u);
});

test("때가 되면 설치를 찾고 범위를 줄인 token을 받아 정해진 분에 순서대로 dispatch한 뒤 token을 폐기한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z") });
  const result = await run(github);
  assert.deepEqual(result.dispatched, ["current-capital-topology-registration", "datapack-expiry-alert-datapack-expiry", "source-reverification"]);
  assert.deepEqual(github.calls.map(({ method, url }) => `${method} ${url.replace("https://api.github.com", "")}`), [
    `GET /repos/${REPOSITORY}/installation`,
    "POST /app/installations/167775157/access_tokens",
    `POST /repos/${REPOSITORY}/actions/workflows/current-capital-topology-registration.yml/dispatches`,
    `POST /repos/${REPOSITORY}/actions/workflows/datapack-expiry-alert.yml/dispatches`,
    `POST /repos/${REPOSITORY}/actions/workflows/source-reverification.yml/dispatches`,
    "DELETE /installation/token",
  ]);
  const [installation, mint, registration, expiry, reverification, revoke] = github.calls;
  assert.match(installation.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
  assert.deepEqual(mint.body, { repositories: ["easysubway-data"], permissions: { actions: "write" } });
  assert.equal(mint.headers.authorization, installation.headers.authorization);
  for (const call of [registration, reverification, expiry, revoke]) assert.equal(call.headers.authorization, `Bearer ${INSTALLATION_TOKEN}`);
  assert.deepEqual(registration.body, { ref: "main" });
  assert.deepEqual(expiry.body, { ref: "main", inputs: { target: "datapack-expiry" } });
  // 정해진 분(5, 23, 23)까지 기다린 뒤에 dispatch한다: 시작 시각은 04:00이다.
  assert.deepEqual([registration.at, expiry.at, reverification.at], ["2026-10-07T04:05:00.000Z", "2026-10-07T04:23:00.000Z", "2026-10-07T04:23:00.000Z"]);
  for (const call of github.calls) {
    assert.equal(call.headers["x-github-api-version"], "2022-11-28");
    assert.equal(call.headers.accept, "application/vnd.github+json");
  }
});

test("이미 지난 분은 기다리지 않고 바로 dispatch한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:30:00Z") });
  await run(github);
  assert.deepEqual(dispatches(github).map(({ at: when }) => when), ["2026-10-07T04:30:00.000Z", "2026-10-07T04:30:00.000Z", "2026-10-07T04:30:00.000Z"]);
});

test("때가 된 항목이 없으면 GitHub를 부르지 않는다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T03:00:00Z") });
  const result = await run(github);
  assert.deepEqual(result.dispatched, []);
  assert.equal(github.calls.length, 0);
});

test("한 workflow의 dispatch가 실패해도 나머지를 모두 시도한 뒤 실패로 끝내고 token을 폐기한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), dispatchStatus: { "source-reverification.yml": 422 } });
  await assert.rejects(run(github), (error) => {
    assert.match(error.message, /^SCHEDULER_DISPATCH_FAILED: source-reverification \(HTTP 422 Workflow does not have 'workflow_dispatch' trigger\)$/u);
    return true;
  });
  assert.equal(dispatches(github).length, 3);
  assert.equal(github.calls.at(-1).method, "DELETE");
});

test("installation 발급이 실패하면 dispatch 없이 실패한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), mint: () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) });
  await assert.rejects(run(github), /^Error: SCHEDULER_TOKEN_MINT_FAILED: HTTP 401 Bad credentials$/u);
  assert.equal(dispatches(github).length, 0);
  assert.equal(github.calls.some(({ method }) => method === "DELETE"), false);
});

test("요청보다 넓은 권한이나 다른 저장소가 섞인 token은 쓰지 않고 폐기한다", async () => {
  const mintWith = (patch) => () => new Response(JSON.stringify({
    token: INSTALLATION_TOKEN,
    permissions: { actions: "write", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ full_name: REPOSITORY }],
    ...patch,
  }), { status: 201 });
  for (const patch of [
    { permissions: { actions: "write", contents: "write" } },
    { permissions: { actions: "read", metadata: "read" } },
    { repository_selection: "all" },
    { repositories: [{ full_name: REPOSITORY }, { full_name: "AquilaXk/other" }] },
    { repositories: [{ full_name: "AquilaXk/other" }] },
    { token: "" },
  ]) {
    const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), mint: mintWith(patch) });
    await assert.rejects(run(github), /SCHEDULER_TOKEN_SCOPE|SCHEDULER_TOKEN_MINT_FAILED/u, JSON.stringify(patch));
    assert.equal(dispatches(github).length, 0, JSON.stringify(patch));
    // 발급은 됐지만 범위가 틀린 token은 쓰지 않고 바로 폐기한다.
    if (patch.token !== "") assert.equal(github.calls.at(-1).method, "DELETE", JSON.stringify(patch));
  }
});

test("설치 조회가 깨진 응답이면 실패한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), installation: { id: "x" } });
  await assert.rejects(run(github), /SCHEDULER_INSTALLATION_LOOKUP_FAILED/u);
  assert.equal(github.calls.length, 1);
});

test("token 폐기가 실패하면 dispatch가 끝났어도 비0으로 끝나고 dispatch 실패와 함께 보고한다", async () => {
  const revokeFails = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), revokeStatus: 500 });
  await assert.rejects(run(revokeFails), /^Error: SCHEDULER_TOKEN_REVOKE_FAILED: HTTP 500 \(the installation token stays valid until it expires, at most 1 hour\)$/u);
  assert.equal(dispatches(revokeFails).length, 3);
  assert.ok(revokeFails.logs.some((line) => JSON.parse(line).event === "token_revoke_failed"));
  const both = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), revokeStatus: 500, dispatchStatus: { "source-reverification.yml": 422 } });
  await assert.rejects(run(both), /SCHEDULER_DISPATCH_FAILED: source-reverification .*; SCHEDULER_TOKEN_REVOKE_FAILED: HTTP 500/u);
  const verify = fakeGitHub({ now: at("2026-10-07T03:00:00Z"), revokeStatus: 500 });
  await assert.rejects(verifyAppAccess({ config, clientId: CLIENT_ID, privateKeyPem, now: verify.now, fetchImpl: verify.fetchImpl, log: verify.log }), /SCHEDULER_TOKEN_REVOKE_FAILED/u);
});

test("SIGTERM(activeDeadlineSeconds 초과, 노드 종료)을 받으면 대기 중에도 token을 폐기하고 143으로 끝난다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z") });
  const signals = new EventEmitter();
  const exits = [];
  const pending = run(github, { sleep: () => new Promise(() => {}), signals, exit: (code) => exits.push(code) });
  for (let attempt = 0; attempt < 50 && github.calls.length < 2; attempt += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  signals.emit("SIGTERM");
  for (let attempt = 0; attempt < 50 && exits.length === 0; attempt += 1) await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(exits, [143]);
  assert.equal(github.calls.at(-1).method, "DELETE");
  assert.equal(github.calls.at(-1).headers.authorization, `Bearer ${INSTALLATION_TOKEN}`);
  assert.ok(github.logs.some((line) => JSON.parse(line).event === "terminated"));
  void pending;
});

test("정상 종료 뒤에는 SIGTERM 처리기를 남기지 않는다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z") });
  const signals = new EventEmitter();
  await run(github, { signals, exit: () => assert.fail("exit must not be called") });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("로그와 오류 어디에도 token·JWT·private key가 남지 않는다", async () => {
  const ok = fakeGitHub({ now: at("2026-10-07T04:00:00Z") });
  await run(ok);
  const failing = fakeGitHub({ now: at("2026-10-07T04:00:00Z"), dispatchStatus: { "source-reverification.yml": 500 } });
  let message = "";
  await run(failing).catch((error) => { message = error.message; });
  const jwts = [...ok.calls, ...failing.calls].map(({ headers }) => headers.authorization?.replace("Bearer ", "")).filter((value) => value && value !== INSTALLATION_TOKEN);
  const secrets = [INSTALLATION_TOKEN, ...jwts, privateKeyPem, privateKeyPem.split("\n")[1]];
  for (const text of [...ok.logs, ...failing.logs, message]) for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.ok(ok.logs.length > 0);
  for (const line of ok.logs) assert.doesNotThrow(() => JSON.parse(line));
});

test("배포 전 자격 확인은 token을 범위 검증까지 발급하고 dispatch 없이 폐기한다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T03:00:00Z") });
  const result = await verifyAppAccess({ config, clientId: CLIENT_ID, privateKeyPem, now: github.now, fetchImpl: github.fetchImpl, log: github.log });
  assert.deepEqual(result, { verified: true });
  assert.deepEqual(github.calls.map(({ method, url }) => `${method} ${url.replace("https://api.github.com", "")}`), [
    `GET /repos/${REPOSITORY}/installation`,
    "POST /app/installations/167775157/access_tokens",
    "DELETE /installation/token",
  ]);
  assert.ok(github.logs.some((line) => JSON.parse(line).event === "app_access_verified"));
  const broad = fakeGitHub({ now: at("2026-10-07T03:00:00Z"), mint: () => new Response(JSON.stringify({ token: INSTALLATION_TOKEN, permissions: { actions: "write", contents: "write" }, repository_selection: "selected", repositories: [{ full_name: REPOSITORY }] }), { status: 201 }) });
  await assert.rejects(verifyAppAccess({ config, clientId: CLIENT_ID, privateKeyPem, now: broad.now, fetchImpl: broad.fetchImpl, log: broad.log }), /SCHEDULER_TOKEN_SCOPE/u);
  const denied = fakeGitHub({ now: at("2026-10-07T03:00:00Z"), mint: () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) });
  await assert.rejects(verifyAppAccess({ config, clientId: CLIENT_ID, privateKeyPem, now: denied.now, fetchImpl: denied.fetchImpl, log: denied.log }), /SCHEDULER_TOKEN_MINT_FAILED: HTTP 401/u);
});

test("원격 오류 메시지는 로그에 싣지 않고 오류 메시지에는 한 줄로 정제해 싣는다", async () => {
  const github = fakeGitHub({ now: at("2026-10-07T04:00:00Z") });
  const forged = async (url, options = {}) => (String(url).endsWith("/source-reverification.yml/dispatches")
    ? new Response(JSON.stringify({ message: "boom\n{\"event\":\"dispatched\",\"id\":\"forged\"}\u0007" }), { status: 500 })
    : github.fetchImpl(url, options));
  const error = await run(github, { fetchImpl: forged }).then(() => null, (caught) => caught);
  assert.match(error.message, /^SCHEDULER_DISPATCH_FAILED: source-reverification \(HTTP 500 boom\?/u);
  assert.equal(/[\u0000-\u001f\u007f]/u.test(error.message), false);
  assert.equal(github.logs.some((line) => line.includes("boom") || line.includes("forged")), false);
  assert.equal(github.logs.every((line) => !line.includes("\n")), true);
});

test("설정은 닫힌 형식이고 main의 data 레포·actions write만 허용한다", () => {
  assert.doesNotThrow(() => validateScheduleConfig(config));
  const bad = [
    { ...config, extra: 1 },
    { ...config, target: { ...config.target, ref: "feature" } },
    { ...config, target: { ...config.target, repository: "AquilaXk/other" } },
    { ...config, target: { ...config.target, permissions: { actions: "write", contents: "write" } } },
    { ...config, workflows: [] },
    { ...config, workflows: [config.workflows[0], config.workflows[0]] },
    { ...config, workflows: [{ ...config.workflows[0], workflow: "../x.yml" }] },
    { ...config, workflows: [{ ...config.workflows[0], minute: 60 }] },
    { ...config, workflows: [{ ...config.workflows[0], minute: 55 }] },
    { ...config, workflows: [{ ...config.workflows[0], everyHours: 3, offsetHour: 3 }] },
    { ...config, workflows: [{ ...config.workflows[0], inputs: { target: 1 } }] },
    { ...config, workflows: [{ ...config.workflows[0], unknown: true }] },
  ];
  for (const value of bad) assert.throws(() => validateScheduleConfig(value), /SCHEDULER_CONFIG/u, JSON.stringify(value).slice(0, 120));
});

test("ConfigMap 볼륨처럼 심볼릭 링크로 마운트돼도 진입점이 main을 실행하고 실패하면 비0으로 끝난다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scheduler-mount-"));
  try {
    // kubelet 레이아웃: <mount>/..data -> <mount>/..<timestamp>, <mount>/scheduler.mjs -> ..data/scheduler.mjs
    const timestamp = path.join(directory, "..2026_10_07_00_00_00.000000000");
    mkdirSync(timestamp);
    writeFileSync(path.join(timestamp, "scheduler.mjs"), readFileSync(new URL("./data-workflow-scheduler.mjs", import.meta.url)));
    symlinkSync(path.basename(timestamp), path.join(directory, "..data"));
    symlinkSync(path.join("..data", "scheduler.mjs"), path.join(directory, "scheduler.mjs"));
    const result = spawnSync(process.execPath, [path.join(directory, "scheduler.mjs")], {
      env: { PATH: process.env.PATH, SCHEDULER_CONFIG: path.join(directory, "missing-schedule.json"), SCHEDULER_SECRET_DIR: path.join(directory, "missing-secrets") },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `main이 실행되지 않았다: ${result.stderr}`);
    assert.match(result.stderr, /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
