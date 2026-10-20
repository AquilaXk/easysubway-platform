#!/usr/bin/env node
// 공공 원천 호스트 도달성 측정(hub AquilaXk/easysubway#3036): 서울 k3s CronJob과 GitHub 호스티드 러너가 같은 이 파일을 쓴다.
// - 키·토큰·쿠키 없이 호스트 루트에 HEAD 한 번만 보낸다. 환경 변수를 읽지 않고 질의 문자열도 쓰지 않는다.
// - 응답이 왔으면(4xx·5xx 포함) 도달 성공이다. 실패는 성공으로 덮지 않고 실패 단계(dns·connect·tls·first-byte)와 오류 코드로 남긴다.
// - 단계 지연은 단계마다 따로 잰다: dnsMs(이름 조회) · connectMs(TCP 연결) · tlsMs(핸드셰이크) · firstByteMs(요청 전송부터 응답 첫 바이트).
// - 이름 조회는 c-ares Resolver.resolve4다: libuv 스레드풀 대기와 resolv.conf의 search·ndots 확장이 섞이지 않아 두 환경의 dnsMs가 같은 경로다.
// - 출력은 JSON Lines(한 줄 = 호스트 한 번의 측정). 호스트당 요청은 라운드당 1회이고 라운드 간격은 60초 이상이다.
// - --align이면 라운드를 실제 벽시계의 간격 경계(예: 10분 단위)에 맞춰 시작해, 늦게 시작한 실행도 같은 격자에 샘플이 놓인다.
//
// 사용:
//   node source-reachability-probe.mjs --vantage <label> [--rounds N] [--interval-seconds S] [--align] [--output file.jsonl]
//   node source-reachability-probe.mjs summarize <file.jsonl>...
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as sleepFor } from "node:timers/promises";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

export const RECORD_SCHEMA = "SOURCE_REACHABILITY_PROBE_V1";
const USER_AGENT = "easysubway-source-reachability-probe/1";
const DEFAULT_TIMEOUTS = Object.freeze({ dnsTimeoutMs: 10_000, connectTimeoutMs: 10_000, tlsTimeoutMs: 10_000, firstByteTimeoutMs: 15_000 });
const DEFAULT_INTERVAL_SECONDS = 600;
const MIN_INTERVAL_SECONDS = 60;
const MAX_ROUNDS = 12;
const VANTAGE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const HTTP_STATUS_LINE = /^HTTP\/1\.[01] ([1-5]\d\d)[ \r\n]/u;
const MAX_STATUS_LINE_BYTES = 256;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const ERROR_CODE = /^\w{1,64}$/u;
const STAGE_FIELDS = Object.freeze({ dns: "dnsMs", connect: "connectMs", tls: "tlsMs", "first-byte": "firstByteMs" });
const STAGE_KEYS = Object.freeze(Object.values(STAGE_FIELDS));
// 단계 이름이 없는 오류는 어느 단계의 것인지 알 수 없으므로 dns로 가장하지 않고 unknown으로 남긴다.
export const FAILED_STAGES = Object.freeze([...Object.keys(STAGE_FIELDS), "unknown"]);
const DNS_RESOLVER_OPTIONS = Object.freeze({ timeout: 5000, tries: 2 });
const KST_OFFSET_HOURS = 9;
const EVENING_FIRST_KST_HOUR = 17;

export const RECORD_KEYS = Object.freeze(["schema", "observedAt", "vantage", "round", "target", "host", "port", "ok", "httpStatus", ...STAGE_KEYS, "totalMs", "failedStage", "errorCode"]);

// 호스트는 data 레포 수집기가 실제로 부르는 공식 원천이다(source-reverification recipe의 humetro·kric·korail·data.go.kr·grtc,
// 서울 열린데이터 8088, 휴일 판정 KASI가 올라가는 apis.data.go.kr). control-github은 원천이 아니라 일반 외부 연결 대조군이다.
export const PROBE_TARGETS = Object.freeze([
  { id: "humetro-open-api", host: "data.humetro.busan.kr", port: 80, secure: false },
  { id: "humetro-www2", host: "www2.humetro.busan.kr", port: 443, secure: true },
  { id: "kric-open-api", host: "openapi.kric.go.kr", port: 443, secure: true },
  { id: "kric-data", host: "data.kric.go.kr", port: 443, secure: true },
  { id: "korail-www", host: "www.korail.com", port: 443, secure: true },
  { id: "data-go-kr-apis", host: "apis.data.go.kr", port: 443, secure: true },
  { id: "data-go-kr-portal", host: "www.data.go.kr", port: 443, secure: true },
  { id: "seoul-open-api", host: "openapi.seoul.go.kr", port: 8088, secure: false },
  { id: "grtc-www", host: "www.grtc.co.kr", port: 443, secure: true },
  { id: "control-github", host: "github.com", port: 443, secure: true },
].map((target) => Object.freeze(target)));

const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
const resolver = new Resolver(DNS_RESOLVER_OPTIONS);

/** IPv4 주소 하나를 돌려준다. IPv4로 고정해 두 측정 환경(IPv4 전용 k3s 파드, GitHub 러너)의 조건을 같게 맞춘다. */
async function resolveIpv4(host) {
  const [address] = await resolver.resolve4(host);
  if (!address) throw Object.assign(new Error("no A record"), { code: "ENODATA" });
  return address;
}

const errorCodeOf = (error) => String(error?.code ?? error?.name ?? "ERROR");
const timeoutError = () => Object.assign(new Error("stage timed out"), { code: "ETIMEDOUT" });

/** 단계 하나를 실행해 걸린 시간을 돌려준다. 실패하면 단계 이름과 경과 시간을 붙여 던진다. */
async function timedStage(stage, run) {
  const started = performance.now();
  try {
    return { value: await run(), ms: performance.now() - started };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { stage, ms: performance.now() - started });
  }
}

/** 이름 조회에는 취소 수단이 없어 시간 안에 끝나지 않으면 기다리지 않고 ETIMEDOUT으로 처리한다. */
function withTimeout(promise, timeoutMs) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * 소켓이 `event`를 내면 그 값으로 resolve, `error`·시간 초과(소켓을 닫는다)·(failOnClose이면) close는 reject한다.
 * 어느 쪽이든 timer와 listener를 한 곳에서 정리한다.
 */
function awaitSocket(socket, { event, timeoutMs, failOnClose = false }) {
  return new Promise((resolve, reject) => {
    const handlers = { [event]: (value) => settle(resolve, value), error: (error) => settle(reject, error) };
    if (failOnClose) handlers.close = () => settle(reject, Object.assign(new Error("closed before a response"), { code: "CLOSED_BEFORE_RESPONSE" }));
    const timer = setTimeout(() => {
      socket.destroy();
      settle(reject, timeoutError());
    }, timeoutMs);
    function settle(callback, value) {
      clearTimeout(timer);
      for (const [name, handler] of Object.entries(handlers)) socket.off(name, handler);
      callback(value);
    }
    for (const [name, handler] of Object.entries(handlers)) socket.on(name, handler);
  });
}

const isStatusLineComplete = (head) => head.includes(0x0a) || head.length >= MAX_STATUS_LINE_BYTES;

/** 상태줄은 첫 조각에 다 오지 않을 수 있다. 줄 끝이 올 때까지(또는 상한까지) 이어 받는다. */
async function readStatusLine(socket, firstChunk, timeoutMs) {
  let head = firstChunk;
  while (!isStatusLineComplete(head)) head = Buffer.concat([head, await awaitSocket(socket, { event: "data", timeoutMs, failOnClose: true })]); // NOSONAR -- 조각은 순서대로 받아야 한다
  return head;
}

function requestHead({ host, port, secure }) {
  const defaultPort = secure ? 443 : 80;
  const authority = port === defaultPort ? host : `${host}:${port}`;
  return `HEAD / HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n\r\n`;
}

/** 대상 하나를 한 번 잰다. 어떤 실패도 던지지 않고 기록으로 돌려준다. */
export async function probeTarget(target, {
  vantage, round, resolveHost = resolveIpv4, netConnect = net.connect, tlsOptions = {}, now = () => new Date(),
  dnsTimeoutMs = DEFAULT_TIMEOUTS.dnsTimeoutMs, connectTimeoutMs = DEFAULT_TIMEOUTS.connectTimeoutMs, tlsTimeoutMs = DEFAULT_TIMEOUTS.tlsTimeoutMs, firstByteTimeoutMs = DEFAULT_TIMEOUTS.firstByteTimeoutMs,
}) {
  const observedAt = now().toISOString();
  const started = performance.now();
  const stages = { dnsMs: null, connectMs: null, tlsMs: null, firstByteMs: null };
  let socket = null;
  let httpStatus = null;
  let failure = null;
  try {
    const resolved = await timedStage("dns", () => withTimeout(resolveHost(target.host), dnsTimeoutMs));
    stages.dnsMs = resolved.ms;
    const connected = await timedStage("connect", () => {
      const raw = netConnect({ host: resolved.value, port: target.port });
      raw.on("error", () => {}); // 단계가 끝난 뒤 늦게 오는 오류가 프로세스를 죽이지 않게 한다. 단계 안의 오류는 awaitSocket이 받는다.
      socket = raw;
      return awaitSocket(raw, { event: "connect", timeoutMs: connectTimeoutMs }).then(() => raw);
    });
    stages.connectMs = connected.ms;
    if (target.secure) {
      const secured = await timedStage("tls", () => {
        const wrapped = tls.connect({ socket: connected.value, servername: target.host, ...tlsOptions });
        wrapped.on("error", () => {});
        socket = wrapped;
        return awaitSocket(wrapped, { event: "secureConnect", timeoutMs: tlsTimeoutMs }).then(() => wrapped);
      });
      stages.tlsMs = secured.ms;
      socket = secured.value;
    }
    const answered = await timedStage("first-byte", () => {
      const reading = awaitSocket(socket, { event: "data", timeoutMs: firstByteTimeoutMs, failOnClose: true });
      socket.write(requestHead(target));
      return reading;
    });
    stages.firstByteMs = answered.ms;
    const head = await timedStage("first-byte", () => readStatusLine(socket, answered.value, firstByteTimeoutMs));
    const match = HTTP_STATUS_LINE.exec(head.value.toString("latin1", 0, 32));
    if (!match) throw Object.assign(new Error("not an HTTP response"), { stage: "first-byte", ms: answered.ms, code: "BAD_RESPONSE" });
    httpStatus = Number(match[1]);
  } catch (error) {
    failure = { stage: error.stage ?? "unknown", code: errorCodeOf(error), ms: error.ms };
    // 실패한 단계도 걸린 시간을 남긴다(연결 timeout은 timeout 값만큼 걸린 기록이 곧 증거다). 이미 잰 단계 값은 덮지 않고 이후 단계는 null로 남는다.
    const field = STAGE_FIELDS[failure.stage];
    if (field && stages[field] === null) stages[field] = failure.ms ?? null;
  } finally {
    socket?.destroy();
  }
  return {
    schema: RECORD_SCHEMA,
    observedAt,
    vantage,
    round,
    target: target.id,
    host: target.host,
    port: target.port,
    ok: failure === null,
    httpStatus,
    ...stages,
    totalMs: performance.now() - started,
    failedStage: failure?.stage ?? null,
    errorCode: failure?.code ?? null,
  };
}

/** 다음 간격 경계까지 남은 ms. 첫 라운드는 지금이 경계면 바로 시작하고, 라운드 사이에는 항상 다음 경계를 기다린다. */
const untilSlot = (nowMs, intervalMs, { startNow }) => (startNow ? (intervalMs - (nowMs % intervalMs)) % intervalMs : intervalMs - (nowMs % intervalMs));

/** 라운드마다 모든 대상을 측정해 기록한다. 대상은 서로 다른 호스트라 함께 재고, 기록은 대상 순서로 내보낸다. */
export async function runRounds({ targets, rounds, intervalMs, vantage, align = false, clock = Date.now, probe = probeTarget, probeOptions = {}, sleep = (ms) => sleepFor(ms), emit }) {
  if (align) await sleep(untilSlot(clock(), intervalMs, { startNow: true }));
  let recorded = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const records = await Promise.all(targets.map((target) => probe(target, { vantage, round, ...probeOptions }))); // NOSONAR -- 라운드는 호스트 부하를 줄이려고 의도적으로 순차다
    for (const record of records.filter(Boolean)) {
      emit(record);
      recorded += 1;
    }
    if (round < rounds) await sleep(align ? untilSlot(clock(), intervalMs, { startNow: false }) : intervalMs); // NOSONAR -- 라운드 간격 대기다
  }
  // 대상별 연결 실패도 기록이 남으므로 정상이다. 대상 수 x 라운드 수보다 기록이 적으면 측정이 일부만 돈 것이라 실패시킨다.
  if (recorded !== targets.length * rounds) fail("PROBE_INCOMPLETE_ROUND", `recorded ${recorded} of ${targets.length * rounds} expected measurements`);
}

export function parseArguments(argv) {
  const options = { vantage: null, rounds: 1, intervalSeconds: DEFAULT_INTERVAL_SECONDS, align: false, output: null };
  const integer = (name, value, min, max) => {
    if (!/^\d+$/u.test(value ?? "") || Number(value) < min || Number(value) > max) fail("PROBE_ARGUMENTS", `${name} must be an integer in ${min}..${max}`);
    return Number(value);
  };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === "--align") {
      options.align = true;
      index -= 1; // 값이 없는 플래그다
    } else if (name === "--vantage") options.vantage = value;
    else if (name === "--rounds") options.rounds = integer(name, value, 1, MAX_ROUNDS);
    else if (name === "--interval-seconds") options.intervalSeconds = integer(name, value, MIN_INTERVAL_SECONDS, 3600);
    else if (name === "--output" && typeof value === "string" && value !== "") options.output = value;
    else fail("PROBE_ARGUMENTS", `unexpected argument ${String(name)}`);
  }
  if (!VANTAGE.test(options.vantage ?? "")) fail("PROBE_ARGUMENTS", "--vantage must be a lowercase label such as oci-seoul-k3s");
  return options;
}

export async function main(argv, { targets = PROBE_TARGETS, write = (text) => process.stdout.write(text), sleep, clock, probeOptions = {} } = {}) {
  const options = parseArguments(argv);
  if (options.output) writeFileSync(options.output, "");
  await runRounds({
    targets,
    rounds: options.rounds,
    intervalMs: options.intervalSeconds * 1000,
    vantage: options.vantage,
    align: options.align,
    probeOptions,
    ...(sleep ? { sleep } : {}),
    ...(clock ? { clock } : {}),
    emit: (record) => {
      const line = `${JSON.stringify(record)}\n`;
      write(line);
      if (options.output) appendFileSync(options.output, line);
    },
  });
}

// ---- 기록 검증: 수집(COLLECT)과 요약이 같은 검증을 쓴다. 형식이 다른 기록은 버리지 않고 오류로 드러낸다.

const isNullableMs = (value) => value === null || (Number.isFinite(value) && value >= 0);

/** 기록이 RECORD_KEYS와 정확히 같은 키·타입·값 범위이고 ok와 실패 필드가 서로 맞으면 빈 배열, 아니면 어긋난 항목 이름 목록(항상 배열)을 돌려준다. */
export function findInvalidFields(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return ["record"];
  const keys = Object.keys(record);
  if (keys.length !== RECORD_KEYS.length || !RECORD_KEYS.every((key) => Object.hasOwn(record, key))) return ["keys"];
  const target = PROBE_TARGETS.find(({ id }) => id === record.target);
  const failed = record.failedStage !== null || record.errorCode !== null;
  const checks = [
    ["schema", record.schema === RECORD_SCHEMA],
    ["observedAt", typeof record.observedAt === "string" && ISO_UTC.test(record.observedAt)],
    ["vantage", typeof record.vantage === "string" && VANTAGE.test(record.vantage)],
    ["round", Number.isInteger(record.round) && record.round >= 1 && record.round <= MAX_ROUNDS],
    ["target", target !== undefined && record.host === target.host && record.port === target.port],
    ["ok", typeof record.ok === "boolean"],
    ["httpStatus", record.httpStatus === null || (Number.isInteger(record.httpStatus) && record.httpStatus >= 100 && record.httpStatus <= 599)],
    ...STAGE_KEYS.map((key) => [key, isNullableMs(record[key])]),
    ["totalMs", Number.isFinite(record.totalMs) && record.totalMs >= 0],
    ["failedStage", record.failedStage === null || FAILED_STAGES.includes(record.failedStage)],
    ["errorCode", record.errorCode === null || (typeof record.errorCode === "string" && ERROR_CODE.test(record.errorCode))],
    ["ok-consistency", record.ok ? !failed && record.httpStatus !== null : record.failedStage !== null && record.errorCode !== null && record.httpStatus === null],
  ];
  return checks.filter(([, valid]) => !valid).map(([name]) => name);
}

/** JSON Lines 텍스트를 검증해 RECORD_KEYS 순서로 다시 만든 기록 목록을 돌려준다(원문 줄을 그대로 믿지 않는다). */
export function parseRecordLines(text) {
  return text.split("\n").filter((line) => line !== "").map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return fail("PROBE_RECORD_INVALID", `line ${index + 1} is not JSON`);
    }
    const [invalid] = findInvalidFields(record);
    if (invalid !== undefined) fail("PROBE_RECORD_INVALID", `line ${index + 1}: invalid ${invalid}`);
    return Object.fromEntries(RECORD_KEYS.map((key) => [key, record[key]]));
  });
}

// ---- 요약: 두 측정 환경의 JSONL을 합쳐 성공률·지연·실패 사유를 비교한다.

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  return sortedValues[Math.min(sortedValues.length, Math.ceil(fraction * sortedValues.length)) - 1];
}

const STATUS_CLASSES = Object.freeze(["2xx", "3xx", "4xx", "5xx"]);
const isEvening = (observedAt) => new Date(Date.parse(observedAt) + KST_OFFSET_HOURS * 3_600_000).getUTCHours() >= EVENING_FIRST_KST_HOUR;
const tally = (records) => ({ samples: records.length, failures: records.filter(({ ok }) => !ok).length });

/** vantage·대상별 요약. 지연 분위수는 성공한 측정만으로 계산하고 실패는 실패 사유로 센다. */
export function summarizeRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.vantage}\u0000${record.target}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => {
    const succeeded = group.filter(({ ok }) => ok);
    const stages = Object.fromEntries(STAGE_KEYS.map((stage) => {
      const values = succeeded.map((record) => record[stage]).filter(Number.isFinite).sort((a, b) => a - b);
      return [stage, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
    }));
    const failureReasons = {};
    for (const { failedStage, errorCode } of group.filter(({ ok }) => !ok)) {
      const reason = `${failedStage}/${errorCode}`;
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
    const { samples, failures } = tally(group);
    const statusClasses = Object.fromEntries(STATUS_CLASSES.map((statusClass) => [statusClass, group.filter(({ httpStatus }) => httpStatus !== null && `${Math.floor(httpStatus / 100)}xx` === statusClass).length]));
    return {
      vantage: group[0].vantage,
      target: group[0].target,
      host: group[0].host,
      samples,
      failures,
      successRate: (samples - failures) / samples,
      failureReasons,
      statusClasses,
      stages,
      evening: tally(group.filter(({ observedAt }) => isEvening(observedAt))),
      other: tally(group.filter(({ observedAt }) => !isEvening(observedAt))),
    };
  });
}

const cell = (value) => (value === null ? "-" : value.toFixed(0));

export function renderSummary(summary) {
  const lines = [
    "| vantage | target | samples | failures | success | HTTP 2xx/3xx/4xx/5xx | KST 17-23 fail/n | other fail/n | dns p95 | connect p95 | tls p95 | first-byte p95 | failure reasons |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const entry of summary) {
    const reasons = Object.entries(entry.failureReasons).map(([reason, count]) => `${reason}=${count}`).join(", ") || "-";
    lines.push(`| ${entry.vantage} | ${entry.target} | ${entry.samples} | ${entry.failures} | ${(entry.successRate * 100).toFixed(1)}% | ${STATUS_CLASSES.map((statusClass) => entry.statusClasses[statusClass]).join("/")} | ${entry.evening.failures}/${entry.evening.samples} | ${entry.other.failures}/${entry.other.samples} | ${cell(entry.stages.dnsMs.p95)} | ${cell(entry.stages.connectMs.p95)} | ${cell(entry.stages.tlsMs.p95)} | ${cell(entry.stages.firstByteMs.p95)} | ${reasons} |`);
  }
  return `${lines.join("\n")}\n`;
}

function summarizeFiles(files) {
  if (files.length === 0) fail("PROBE_ARGUMENTS", "summarize needs at least one JSONL file");
  const records = files.flatMap((file) => parseRecordLines(readFileSync(file, "utf8")));
  return renderSummary(summarizeRecords(records));
}

/** 이 모듈이 직접 실행된 진입점인지 본다. ConfigMap 볼륨 symlink는 realpath로 풀고, 실재하지 않는 경로(`node -e` 등)는 진입점이 아니다. */
function isEntryPoint(scriptPath) {
  if (!scriptPath) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(scriptPath)).href;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    if (process.argv[2] === "summarize") process.stdout.write(summarizeFiles(process.argv.slice(3)));
    else await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
