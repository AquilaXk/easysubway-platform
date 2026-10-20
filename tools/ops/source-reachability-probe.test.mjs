import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

import {
  PROBE_TARGETS,
  RECORD_KEYS,
  main,
  parseArguments,
  probeTarget,
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
const FAST = { connectTimeoutMs: 500, tlsTimeoutMs: 500, firstByteTimeoutMs: 300 };

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
  const lookup = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); };
  const record = await probeTarget(localTarget(80), { vantage: "test", round: 1, ...FAST, lookup, netConnect: () => { connects += 1; } });
  assert.equal(record.failedStage, "dns");
  assert.equal(record.errorCode, "ENOTFOUND");
  assert.equal(record.connectMs, null);
  assert.equal(connects, 0);
});

test("이름 조회가 시간 안에 끝나지 않으면 dns 단계 ETIMEDOUT이다", async () => {
  const record = await probeTarget(localTarget(80), { vantage: "test", round: 1, ...FAST, dnsTimeoutMs: 60, lookup: () => new Promise(() => {}) });
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
  const garbage = httpServer((socket) => socket.end("not http at all"));
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

test("인자는 vantage 필수·라운드와 간격 상한·하한을 지키고 알 수 없는 인자는 거부한다", () => {
  assert.deepEqual(parseArguments(["--vantage", "oci-seoul-k3s"]), { vantage: "oci-seoul-k3s", rounds: 1, intervalSeconds: 600, output: null });
  assert.deepEqual(parseArguments(["--vantage", "gha-us", "--rounds", "6", "--interval-seconds", "600", "--output", "/tmp/x.jsonl"]), { vantage: "gha-us", rounds: 6, intervalSeconds: 600, output: "/tmp/x.jsonl" });
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

test("summarize 하위 명령은 JSONL 파일을 읽어 표를 출력한다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-summary-"));
  try {
    const file = path.join(directory, "a.jsonl");
    const line = { observedAt: "2026-10-21T09:00:00.000Z", vantage: "gha-us", round: 1, target: "korail-www", host: "www.korail.com", port: 443, ok: true, httpStatus: 200, dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, totalMs: 10, failedStage: null, errorCode: null };
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    const result = spawnSync(process.execPath, [new URL("./source-reachability-probe.mjs", import.meta.url).pathname, "summarize", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| gha-us \| korail-www \| 1 \| 0 \| 100\.0% \|/u);
    const empty = spawnSync(process.execPath, [new URL("./source-reachability-probe.mjs", import.meta.url).pathname, "summarize"], { encoding: "utf8" });
    assert.notEqual(empty.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
