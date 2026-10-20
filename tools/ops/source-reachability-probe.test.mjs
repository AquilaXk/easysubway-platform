import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

import {
  FAILED_STAGES,
  PROBE_TARGETS,
  RECORD_KEYS,
  findInvalidField,
  main,
  parseArguments,
  parseRecordLines,
  probeTarget,
  renderSummary,
  runRounds,
  summarizeRecords,
} from "./source-reachability-probe.mjs";

// 서울 k3s와 GitHub 호스티드 러너가 같은 스크립트로 공공 원천 호스트의 연결 성공률·단계별 지연을 재는 도구다(hub easysubway#3036).
// 키·토큰·쿠키 없이 루트 HEAD만 보내고, 실패는 성공으로 덮지 않고 단계(dns·connect·tls·first-byte)와 오류 코드로 남긴다.
const SOURCE = readFileSync(new URL("./source-reachability-probe.mjs", import.meta.url), "utf8");
const STAGES = ["dnsMs", "connectMs", "tlsMs", "firstByteMs"];
const OK_RESPONSE = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

// close가 남은 연결을 기다리며 멈추지 않도록 서버가 받은 소켓을 기록해 둔다.
const openSockets = new WeakMap();
const listen = (server) => new Promise((resolve) => {
  const sockets = new Set();
  openSockets.set(server, sockets);
  server.on(server instanceof tls.Server ? "secureConnection" : "connection", (socket) => sockets.add(socket));
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => { server.close(resolve); openSockets.get(server).forEach((socket) => socket.destroy()); });
const localTarget = (port, extra = {}) => ({ id: "local", host: "localhost", port, secure: false, ...extra });
// 이름 조회는 c-ares 실제 조회라 로컬 서버 시험에서는 주소를 고정해 넣는다(조회 경로 자체는 아래 DNS 시험이 다룬다).
const FAST = { connectTimeoutMs: 500, tlsTimeoutMs: 500, firstByteTimeoutMs: 300, resolveHost: async () => "127.0.0.1" };

function httpServer(reply) {
  return net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (chunk) => reply(socket, chunk.toString("latin1")));
  });
}

test("응답이 오면 단계별 지연을 모두 채우고 HTTP 상태만 기록한다", async () => {
  const seen = [];
  const server = httpServer((socket, request) => { seen.push(request); socket.end(OK_RESPONSE); });
  const port = await listen(server);
  try {
    const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST });
    assert.deepEqual(Object.keys(record), RECORD_KEYS);
    assert.equal(record.ok, true);
    assert.equal(record.httpStatus, 200);
    assert.equal(record.failedStage, null);
    assert.equal(record.errorCode, null);
    assert.equal(record.tlsMs, null, "평문 대상은 TLS 단계가 없다");
    for (const stage of ["dnsMs", "connectMs", "firstByteMs", "totalMs"]) assert.ok(Number.isFinite(record[stage]) && record[stage] >= 0, stage);
    assert.match(record.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
    assert.equal(record.vantage, "test");
    assert.equal(seen.length, 1);
    assert.match(seen[0], new RegExp(`^HEAD / HTTP/1\\.1\\r\\nHost: localhost:${port}\\r\\n`, "u"));
    assert.doesNotMatch(seen[0], /authorization|cookie|api[-_]?key|token|\?/iu);
  } finally {
    await close(server);
  }
});

test("4xx·5xx도 응답이 온 것이라 도달 성공으로 기록하고 상태 코드를 남긴다", async () => {
  const server = httpServer((socket) => socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"));
  const port = await listen(server);
  try {
    const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST });
    assert.equal(record.ok, true);
    assert.equal(record.httpStatus, 500);
  } finally {
    await close(server);
  }
});

test("연결 거부는 connect 단계 실패로 오류 코드와 함께 남고 이후 단계는 비어 있다", async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST });
  assert.equal(record.ok, false);
  assert.equal(record.failedStage, "connect");
  assert.equal(record.errorCode, "ECONNREFUSED");
  assert.equal(record.httpStatus, null);
  assert.equal(record.tlsMs, null);
  assert.equal(record.firstByteMs, null);
  assert.ok(Number.isFinite(record.dnsMs));
});

test("연결이 시간 안에 끝나지 않으면 connect 단계 ETIMEDOUT이다", async () => {
  const record = await probeTarget(localTarget(9), { vantage: "test", round: 1, ...FAST, connectTimeoutMs: 80, netConnect: () => new net.Socket() });
  assert.equal(record.failedStage, "connect");
  assert.equal(record.errorCode, "ETIMEDOUT");
  assert.ok(record.connectMs >= 70 && record.connectMs < 400, String(record.connectMs));
});

test("DNS 실패는 dns 단계 실패이고 연결을 시도하지 않는다", async () => {
  let connects = 0;
  const resolveHost = async () => { throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }); };
  const record = await probeTarget(localTarget(80), { vantage: "test", round: 1, ...FAST, resolveHost, netConnect: () => { connects += 1; } });
  assert.equal(record.failedStage, "dns");
  assert.equal(record.errorCode, "ENOTFOUND");
  assert.equal(record.connectMs, null);
  assert.equal(connects, 0);
});

test("이름 조회가 시간 안에 끝나지 않으면 dns 단계 ETIMEDOUT이다", async () => {
  const record = await probeTarget(localTarget(80), { vantage: "test", round: 1, ...FAST, dnsTimeoutMs: 60, resolveHost: () => new Promise(() => {}) });
  assert.deepEqual([record.failedStage, record.errorCode], ["dns", "ETIMEDOUT"]);
});

test("연결 뒤 응답이 없으면 first-byte 단계 ETIMEDOUT이다", async () => {
  const server = httpServer(() => {});
  const port = await listen(server);
  try {
    const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST, firstByteTimeoutMs: 120 });
    assert.equal(record.failedStage, "first-byte");
    assert.equal(record.errorCode, "ETIMEDOUT");
    assert.ok(Number.isFinite(record.connectMs));
    assert.ok(record.firstByteMs >= 100, String(record.firstByteMs));
  } finally {
    await close(server);
  }
});

test("응답 전에 연결이 끊기면 first-byte 단계 실패이고 HTTP가 아닌 바이트는 BAD_RESPONSE다", async () => {
  const reset = httpServer((socket) => socket.destroy());
  const resetPort = await listen(reset);
  const garbage = httpServer((socket) => socket.end("not http at all\r\n"));
  const garbagePort = await listen(garbage);
  try {
    const closed = await probeTarget(localTarget(resetPort), { vantage: "test", round: 1, ...FAST });
    assert.deepEqual([closed.ok, closed.failedStage], [false, "first-byte"]);
    assert.match(closed.errorCode, /^(ECONNRESET|CLOSED_BEFORE_RESPONSE)$/u);
    const bad = await probeTarget(localTarget(garbagePort), { vantage: "test", round: 1, ...FAST });
    assert.deepEqual([bad.ok, bad.failedStage, bad.errorCode, bad.httpStatus], [false, "first-byte", "BAD_RESPONSE", null]);
  } finally {
    await close(reset);
    await close(garbage);
  }
});

test("상태줄이 여러 조각으로 오면 줄 끝까지 이어 받아 판정한다(짧은 첫 조각이 BAD_RESPONSE가 아니다)", async () => {
  const server = httpServer((socket) => {
    socket.write("HTT");
    setTimeout(() => socket.end("P/1.1 204 No Content\r\n\r\n"), 40);
  });
  const port = await listen(server);
  try {
    const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST });
    assert.deepEqual([record.ok, record.httpStatus, record.failedStage], [true, 204, null]);
    assert.ok(record.firstByteMs < 40, "firstByteMs는 첫 조각까지의 시간이다");
  } finally {
    await close(server);
  }
});

test("상태줄이 끝나기 전에 연결이 끊기면 first-byte 단계 실패이고 이미 잰 firstByteMs는 유지된다", async () => {
  const server = httpServer((socket) => socket.end("HTTP/1.1 2"));
  const port = await listen(server);
  try {
    const record = await probeTarget(localTarget(port), { vantage: "test", round: 1, ...FAST });
    assert.deepEqual([record.ok, record.failedStage, record.errorCode], [false, "first-byte", "CLOSED_BEFORE_RESPONSE"]);
    assert.ok(Number.isFinite(record.firstByteMs));
  } finally {
    await close(server);
  }
});

test("단계를 알 수 없는 오류는 dns로 가장하지 않고 unknown 단계로 기록한다", async () => {
  const server = httpServer(() => {});
  const port = await listen(server);
  try {
    // TLS 여부를 읽는 자리(연결 직후, 어느 단계 안도 아님)에서 내부 오류가 난 경우다.
    const target = { id: "local", host: "localhost", port, get secure() { throw new Error("internal bug"); } };
    const record = await probeTarget(target, { vantage: "test", round: 1, ...FAST });
    assert.deepEqual([record.ok, record.failedStage, record.errorCode], [false, "unknown", "Error"]);
    assert.deepEqual([Number.isFinite(record.dnsMs), Number.isFinite(record.connectMs), record.tlsMs, record.firstByteMs], [true, true, null, null], "이미 잰 앞 단계 값은 남는다");
    assert.ok(FAILED_STAGES.includes("unknown"));
    assert.equal(findInvalidField({ ...record, target: "kric-open-api", host: "openapi.kric.go.kr", port: 443 }), null, "unknown도 유효한 기록이다");
  } finally {
    await close(server);
  }
});

const opensslAvailable = spawnSync("openssl", ["version"]).status === 0;

test("TLS 대상은 핸드셰이크 시간을 따로 재고, 핸드셰이크가 멈추면 tls 단계 실패다", { skip: !opensslAvailable }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-tls-"));
  let silent;
  try {
    const keyFile = path.join(directory, "key.pem");
    const certFile = path.join(directory, "cert.pem");
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const cert = readFileSync(certFile);
    const key = readFileSync(keyFile);
    const secureServer = tls.createServer({ key, cert }, (socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end(OK_RESPONSE));
    });
    const port = await listen(secureServer);
    const record = await probeTarget({ id: "tls", host: "localhost", port, secure: true }, { vantage: "test", round: 1, ...FAST, tlsOptions: { ca: cert } });
    await close(secureServer);
    assert.equal(record.ok, true, JSON.stringify(record));
    assert.equal(record.httpStatus, 200);
    for (const stage of STAGES) assert.ok(Number.isFinite(record[stage]), stage);

    silent = net.createServer((socket) => socket.on("error", () => {}));
    const silentPort = await listen(silent);
    const stalled = await probeTarget({ id: "tls", host: "localhost", port: silentPort, secure: true }, { vantage: "test", round: 1, ...FAST, tlsTimeoutMs: 120, tlsOptions: { ca: cert } });
    assert.deepEqual([stalled.ok, stalled.failedStage, stalled.errorCode], [false, "tls", "ETIMEDOUT"]);
    assert.equal(stalled.firstByteMs, null);
    await close(silent);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("라운드 사이에만 간격만큼 쉬고 라운드마다 모든 대상을 순서대로 기록한다", async () => {
  const targets = [{ id: "a", host: "a.example", port: 443, secure: true }, { id: "b", host: "b.example", port: 80, secure: false }];
  const sleeps = [];
  const emitted = [];
  const probe = async (target, { round, vantage }) => ({ target: target.id, round, vantage });
  await runRounds({ targets, rounds: 3, intervalMs: 600_000, vantage: "oci", probe, sleep: async (ms) => { sleeps.push(ms); }, emit: (record) => emitted.push(record) });
  assert.deepEqual(sleeps, [600_000, 600_000]);
  assert.deepEqual(emitted.map(({ round, target }) => `${round}${target}`), ["1a", "1b", "2a", "2b", "3a", "3b"]);
  assert.ok(emitted.every(({ vantage }) => vantage === "oci"));
});

test("--align이면 첫 라운드와 라운드 사이를 실제 벽시계 간격 경계까지 기다린다", async () => {
  const MINUTE = 60_000;
  const sleeps = [];
  const emitted = [];
  const times = [7 * MINUTE, 10 * MINUTE + 5_000, 20 * MINUTE + 9_000];
  const targets = [{ id: "a", host: "a.example", port: 443, secure: true }];
  const probe = async (target, { round }) => ({ target: target.id, round });
  const run = (extra) => runRounds({ targets, rounds: 3, intervalMs: 10 * MINUTE, vantage: "gha", probe, sleep: async (ms) => { sleeps.push(ms); }, emit: (record) => emitted.push(record), ...extra });
  await run({ align: true, clock: () => times.shift() });
  assert.deepEqual(sleeps, [3 * MINUTE, 10 * MINUTE - 5_000, 10 * MINUTE - 9_000], ":07 시작 → :10, 이어 다음 :20, :30 경계");
  assert.equal(emitted.length, 3);
  // 이미 경계에 있으면 첫 라운드는 바로 시작하고, 라운드 사이에는 반드시 다음 경계를 기다린다(0ms 대기가 없다).
  sleeps.length = 0;
  const onBoundary = [20 * MINUTE, 20 * MINUTE];
  await run({ align: true, rounds: 2, clock: () => onBoundary.shift() });
  assert.deepEqual(sleeps, [0, 10 * MINUTE]);
  sleeps.length = 0;
  await run({ align: false });
  assert.deepEqual(sleeps, [10 * MINUTE, 10 * MINUTE], "--align이 없으면 고정 간격이다");
});

test("인자는 vantage 필수·라운드와 간격 상한·하한을 지키고 알 수 없는 인자는 거부한다", () => {
  assert.deepEqual(parseArguments(["--vantage", "oci-seoul-k3s"]), { vantage: "oci-seoul-k3s", rounds: 1, intervalSeconds: 600, align: false, output: null });
  assert.deepEqual(parseArguments(["--vantage", "gha-us", "--rounds", "6", "--interval-seconds", "600", "--output", "/tmp/x.jsonl"]), { vantage: "gha-us", rounds: 6, intervalSeconds: 600, align: false, output: "/tmp/x.jsonl" });
  assert.deepEqual(parseArguments(["--align", "--vantage", "gha-us", "--rounds", "2", "--align"]), { vantage: "gha-us", rounds: 2, intervalSeconds: 600, align: true, output: null }, "--align은 값이 없는 플래그다");
  for (const bad of [[], ["--vantage", "Bad Label"], ["--vantage", "ok", "--rounds", "0"], ["--vantage", "ok", "--rounds", "13"], ["--vantage", "ok", "--rounds", "2", "--interval-seconds", "59"], ["--vantage", "ok", "--extra", "1"], ["--vantage"], ["--vantage", "ok", "--rounds", "x"]]) {
    assert.throws(() => parseArguments(bad), /PROBE_ARGUMENTS/u, JSON.stringify(bad));
  }
});

test("기본 대상은 공식 호스트의 루트만 가리키고 고유 id를 갖고 질의·자격 정보가 없다", () => {
  assert.equal(new Set(PROBE_TARGETS.map(({ id }) => id)).size, PROBE_TARGETS.length);
  const hosts = PROBE_TARGETS.map(({ host }) => host);
  for (const host of ["data.humetro.busan.kr", "openapi.kric.go.kr", "www.korail.com", "apis.data.go.kr", "openapi.seoul.go.kr"]) assert.ok(hosts.includes(host), host);
  for (const target of PROBE_TARGETS) {
    assert.deepEqual(Object.keys(target).sort(), ["host", "id", "port", "secure"]);
    assert.match(target.host, /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u);
    assert.ok([80, 443, 8088].includes(target.port), target.host);
    assert.equal(target.secure, target.port === 443);
  }
});

test("비밀 미포함: 스크립트는 환경 변수·자격 헤더·질의 문자열을 쓰지 않는다", () => {
  assert.doesNotMatch(SOURCE, /process\.env|import\.meta\.env/u);
  assert.doesNotMatch(SOURCE, /authorization|cookie|api[-_]?key|service[-_]?key|secret/iu);
  assert.match(SOURCE, /HEAD \/ HTTP\/1\.1/u);
  const imports = [...SOURCE.matchAll(/^import .* from "([^"]+)";$/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["node:dns/promises", "node:fs", "node:net", "node:perf_hooks", "node:timers/promises", "node:tls", "node:url"]);
});

test("이름 조회는 c-ares Resolver.resolve4 한 경로다(스레드풀 getaddrinfo·search 확장을 쓰지 않는다)", () => {
  assert.match(SOURCE, /new Resolver\(/u);
  assert.match(SOURCE, /resolver\.resolve4\(/u);
  assert.doesNotMatch(SOURCE, /\blookup\b|getaddrinfo/u);
});

test("CLI는 JSON Lines를 stdout과 파일에 같은 내용으로 쓰고 실패 기록이 있어도 0으로 끝난다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-cli-"));
  try {
    const output = path.join(directory, "result.jsonl");
    const lines = [];
    const refused = net.createServer();
    const port = await listen(refused);
    await close(refused);
    await main(["--vantage", "cli-test", "--output", output], { targets: [localTarget(port)], write: (text) => lines.push(text), probeOptions: FAST });
    const stdout = lines.join("");
    assert.equal(readFileSync(output, "utf8"), stdout);
    const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]), RECORD_KEYS);
    assert.deepEqual([records[0].vantage, records[0].ok, records[0].failedStage], ["cli-test", false, "connect"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("요약은 vantage·대상별 성공률, 단계 지연 분위수, 실패 단계·코드, KST 17~23시 구간을 낸다", () => {
  const record = (overrides) => ({ observedAt: "2026-10-21T00:00:00.000Z", vantage: "oci-seoul-k3s", round: 1, target: "kric-open-api", host: "openapi.kric.go.kr", port: 443, ok: true, httpStatus: 200, dnsMs: 5, connectMs: 10, tlsMs: 20, firstByteMs: 30, totalMs: 65, failedStage: null, errorCode: null, ...overrides });
  const records = [
    record({}),
    record({ observedAt: "2026-10-21T09:00:00.000Z", firstByteMs: 90, totalMs: 125 }),
    record({ observedAt: "2026-10-21T09:10:00.000Z", ok: false, httpStatus: null, connectMs: 10000, tlsMs: null, firstByteMs: null, totalMs: 10005, failedStage: "connect", errorCode: "ETIMEDOUT" }),
    record({ vantage: "gha-us", observedAt: "2026-10-21T09:00:00.000Z" }),
  ];
  const summary = summarizeRecords(records);
  assert.deepEqual(summary.map(({ vantage, target }) => `${vantage}/${target}`), ["gha-us/kric-open-api", "oci-seoul-k3s/kric-open-api"]);
  const seoul = summary[1];
  assert.deepEqual([seoul.samples, seoul.failures, seoul.successRate], [3, 1, 2 / 3]);
  assert.deepEqual(seoul.failureReasons, { "connect/ETIMEDOUT": 1 });
  assert.deepEqual([seoul.evening.samples, seoul.evening.failures, seoul.other.samples, seoul.other.failures], [2, 1, 1, 0], "UTC 09시는 KST 18시다");
  assert.equal(seoul.stages.firstByteMs.p50, 30);
  assert.equal(seoul.stages.firstByteMs.p95, 90);
  assert.equal(seoul.stages.connectMs.p95, 10);
  assert.equal(summary[0].failures, 0);
});

const summaryRecord = (observedAt, overrides = {}) => ({ schema: "SOURCE_REACHABILITY_PROBE_V1", observedAt, vantage: "oci-seoul-k3s", round: 1, target: "kric-open-api", host: "openapi.kric.go.kr", port: 443, ok: true, httpStatus: 200, dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, totalMs: 10, failedStage: null, errorCode: null, ...overrides });
const failedRecord = (observedAt) => summaryRecord(observedAt, { ok: false, httpStatus: null, tlsMs: null, firstByteMs: null, failedStage: "connect", errorCode: "ETIMEDOUT" });

// KST 17~23시는 17:00:00.000~23:59:59.999이다. 경계 양쪽과 UTC 날짜 경계를 실패 기록으로 각각 놓아 어느 열에 들어가는지 고정한다.
const KST_WINDOW_EDGES = [
  ["2026-10-21T07:59:59.999Z", "KST 16:59:59.999", "other"],
  ["2026-10-21T08:00:00.000Z", "KST 17:00:00.000", "evening"],
  ["2026-10-21T13:59:59.999Z", "KST 22:59:59.999", "evening"],
  ["2026-10-21T14:00:00.000Z", "KST 23:00:00.000", "evening"],
  ["2026-10-21T14:59:59.999Z", "KST 23:59:59.999", "evening"],
  ["2026-10-21T15:00:00.000Z", "KST 00:00 다음 날(UTC 날짜 경계 전)", "other"],
  ["2026-10-21T23:59:59.999Z", "KST 08:59 다음 날", "other"],
  ["2026-10-22T00:00:00.000Z", "KST 09:00(UTC 날짜 경계)", "other"],
];

for (const [observedAt, label, bucket] of KST_WINDOW_EDGES) {
  test(`요약의 KST 17~23시 구간: ${observedAt} (${label})는 ${bucket} 열에 들어간다`, () => {
    const [entry] = summarizeRecords([failedRecord(observedAt)]);
    const other = bucket === "evening" ? "other" : "evening";
    assert.deepEqual([entry[bucket].samples, entry[bucket].failures, entry[other].samples], [1, 1, 0]);
  });
}

test("요약은 상태 코드 분포(2xx/3xx/4xx/5xx)를 보여 주고 실패 기록은 세지 않는다", () => {
  const at = "2026-10-21T00:00:00.000Z";
  const records = [200, 204, 301, 403, 403, 403, 503].map((httpStatus) => summaryRecord(at, { httpStatus })).concat(failedRecord(at), summaryRecord(at, { vantage: "gha-us-hosted", httpStatus: 200 }));
  const [us, seoul] = summarizeRecords(records);
  assert.deepEqual(seoul.statusClasses, { "2xx": 2, "3xx": 1, "4xx": 3, "5xx": 1 });
  assert.deepEqual(us.statusClasses, { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0 });
  const table = renderSummary([seoul]);
  assert.match(table, /\| HTTP 2xx\/3xx\/4xx\/5xx \|/u);
  assert.match(table, /\| 87\.5% \| 2\/1\/3\/1 \|/u, "403 거절이 100% 성공 뒤에 가려지지 않는다");
});

test("기록 검증은 키·타입·범위·대상 일치·ok와 실패 필드의 일관성을 확인하고 재직렬화한다", () => {
  const good = summaryRecord("2026-10-21T00:00:00.000Z");
  assert.equal(findInvalidField(good), null);
  assert.equal(findInvalidField(failedRecord("2026-10-21T00:00:00.000Z")), null);
  const mutants = [
    ["keys", { extra: "x" }], ["schema", { schema: "OTHER" }], ["observedAt", { observedAt: "2026-10-21 00:00:00" }], ["vantage", { vantage: "Bad Label" }],
    ["round", { round: 0 }], ["round", { round: "1" }], ["target", { host: "evil.example" }], ["target", { port: 80 }], ["target", { target: "unknown" }], ["ok", { ok: "yes" }],
    ["httpStatus", { httpStatus: 99 }], ["httpStatus", { httpStatus: "200" }], ["dnsMs", { dnsMs: -1 }], ["tlsMs", { tlsMs: "3" }], ["totalMs", { totalMs: null }],
    ["failedStage", { failedStage: "other", ok: false, errorCode: "X", httpStatus: null }], ["errorCode", { errorCode: "has space", ok: false, failedStage: "dns", httpStatus: null }],
    ["errorCode", { errorCode: "x".repeat(65), ok: false, failedStage: "dns", httpStatus: null }],
    ["ok-consistency", { ok: false }], ["ok-consistency", { failedStage: "dns" }], ["ok-consistency", { httpStatus: null }],
  ];
  for (const [field, overrides] of mutants) assert.equal(findInvalidField({ ...good, ...overrides }), field, JSON.stringify(overrides));
  const { schema: _omitted, ...withoutSchema } = good;
  assert.equal(findInvalidField(withoutSchema), "keys");
  for (const notRecord of [null, [], "text", 7]) assert.equal(findInvalidField(notRecord), "record");
  const shuffled = Object.fromEntries(Object.entries(good).reverse());
  const [parsed] = parseRecordLines(`${JSON.stringify(shuffled)}\n\n`);
  assert.deepEqual(Object.keys(parsed), RECORD_KEYS, "RECORD_KEYS 순서로 다시 만든다");
  assert.throws(() => parseRecordLines("not json\n"), /PROBE_RECORD_INVALID: line 1 is not JSON/u);
  assert.throws(() => parseRecordLines(`${JSON.stringify(good)}\n${JSON.stringify({ ...good, httpStatus: "x" })}\n`), /PROBE_RECORD_INVALID: line 2: invalid httpStatus/u);
});

test("summarize 하위 명령은 JSONL 파일을 읽어 표를 출력한다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-summary-"));
  try {
    const file = path.join(directory, "a.jsonl");
    const line = summaryRecord("2026-10-21T09:00:00.000Z", { vantage: "gha-us", target: "korail-www", host: "www.korail.com" });
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    const result = spawnSync(process.execPath, [new URL("./source-reachability-probe.mjs", import.meta.url).pathname, "summarize", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| gha-us \| korail-www \| 1 \| 0 \| 100\.0% \| 1\/0\/0\/0 \|/u);
    writeFileSync(file, `${JSON.stringify({ ...line, httpStatus: "200" })}\n`);
    const invalid = spawnSync(process.execPath, [new URL("./source-reachability-probe.mjs", import.meta.url).pathname, "summarize", file], { encoding: "utf8" });
    assert.notEqual(invalid.status, 0, "형식이 다른 기록은 요약하지 않고 실패한다");
    assert.match(invalid.stderr, /PROBE_RECORD_INVALID/u);
    const empty = spawnSync(process.execPath, [new URL("./source-reachability-probe.mjs", import.meta.url).pathname, "summarize"], { encoding: "utf8" });
    assert.notEqual(empty.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
