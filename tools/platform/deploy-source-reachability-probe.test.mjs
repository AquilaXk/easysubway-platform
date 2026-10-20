import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PROBE_TARGETS } from "../ops/source-reachability-probe.mjs";
import { DEPLOYER, NAMESPACE, OBJECT_NAMES, deploySourceReachabilityProbe, readProbeScript, renderSourceReachabilityProbe } from "./deploy-source-reachability-probe.mjs";

// hub easysubway#3036: PREVIEW는 렌더만, DEPLOY는 deployer 신원으로 고정 이름 객체를 apply·대조, COLLECT는 Job 파드 로그를 검증해 파일로, REMOVE는 측정 종료 정리.
// 모든 kubectl은 deployer 신원(--as)으로만 가고 secret은 어디에도 없다.
const expected = renderSourceReachabilityProbe({ scriptBytes: readProbeScript() });
const withDefaults = (object) => {
  const live = structuredClone(object);
  if (live.kind === "CronJob") live.spec.jobTemplate.spec.template.spec.dnsPolicy = "ClusterFirst";
  return live;
};
// ServiceAccount와 CronJob은 이름이 같아 종류와 이름을 함께 키로 쓴다.
const liveByName = {
  [`configmap/${OBJECT_NAMES.configMap}`]: expected.objects.configMap,
  [`serviceaccount/${OBJECT_NAMES.serviceAccount}`]: expected.objects.serviceAccount,
  [`networkpolicy/${OBJECT_NAMES.networkPolicy}`]: expected.objects.networkPolicy,
  [`networkpolicy/${OBJECT_NAMES.defaultDenyPolicy}`]: expected.objects.defaultDenyPolicy,
  [`cronjob/${OBJECT_NAMES.cronJob}`]: expected.objects.cronJob,
};

const COMMAND_OUTPUT_LIMIT = 1024 * 1024; // lib/process.mjs의 runCommand 출력 한도와 같다
const podOf = (name, phase = "Succeeded") => ({ metadata: { name }, status: { phase } });

/** podLogs는 파드 이름 → 그 파드의 로그다. 라벨 selector로 읽으면 kubectl처럼 모든 파드 로그를 이어 붙여 돌려준다. */
function fakeCluster({ bootstrapped = true, live = {}, pods = [], podLogs = {}, failOn = null } = {}) {
  const calls = [];
  const commandRunner = async (command, args, { input } = {}) => {
    calls.push({ command, args, input: input === undefined ? undefined : input.toString("utf8") });
    assert.equal(command, "sudo");
    assert.deepEqual(args.slice(0, 4), ["--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`], "모든 호출은 deployer 신원이다");
    const [verb, kind] = args.slice(4);
    if (failOn === verb || failOn === `${verb}:${verb === "logs" ? args[5] : args[6]}`) throw new Error(`host command failed (1): ${verb} refused`);
    if (verb === "get" && kind === "cronjob" && args.includes("--ignore-not-found")) return { stdout: bootstrapped ? "cronjob.batch/source-reachability-probe\n" : "", stderr: "" };
    if (verb === "get" && kind === "pods") return { stdout: JSON.stringify({ items: pods }), stderr: "" };
    if (verb === "get") return { stdout: JSON.stringify(live[`${kind}/${args[6]}`] ?? withDefaults(liveByName[`${kind}/${args[6]}`])), stderr: "" };
    if (verb === "logs") {
      const named = args[5].startsWith("-") ? null : args[5];
      const stdout = named === null ? Object.values(podLogs).join("") : (podLogs[named] ?? "");
      if (Buffer.byteLength(stdout) > COMMAND_OUTPUT_LIMIT) throw new Error("host command output exceeded the limit");
      return { stdout, stderr: "" };
    }
    if (verb === "apply" || verb === "delete") return { stdout: "", stderr: "" };
    return assert.fail(`unexpected kubectl verb ${verb}`);
  };
  return { calls, commandRunner };
}
const verbs = (cluster) => cluster.calls.map(({ args }) => (["get", "delete"].includes(args[4]) ? args.slice(4, 6) : args.slice(4, 5)).join(":"));
const recordObject = (observedAt, extra = {}) => ({ schema: "SOURCE_REACHABILITY_PROBE_V1", observedAt, vantage: "oci-seoul-k3s", round: 1, target: "kric-open-api", host: "openapi.kric.go.kr", port: 443, ok: true, httpStatus: 200, dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, totalMs: 10, failedStage: null, errorCode: null, ...extra });
const record = (observedAt, extra = {}) => JSON.stringify(recordObject(observedAt, extra));
const failedExtra = { ok: false, httpStatus: null, tlsMs: null, firstByteMs: null, failedStage: "connect", errorCode: "ETIMEDOUT" };

test("PREVIEW는 클러스터를 건드리지 않고 이름·측정 대상만 돌려준다", async () => {
  const cluster = fakeCluster();
  const result = await deploySourceReachabilityProbe({ mode: "PREVIEW", commandRunner: cluster.commandRunner });
  assert.equal(cluster.calls.length, 0);
  assert.equal(result.schemaVersion, "PLATFORM_SOURCE_REACHABILITY_PROBE_DEPLOY_RESULT_V1");
  assert.equal(result.kubernetesMutationCount, 0);
  assert.equal(result.namespace, NAMESPACE);
  assert.deepEqual(result.names, OBJECT_NAMES);
  assert.deepEqual(result.targets.map(({ host }) => host), ["data.humetro.busan.kr", "www2.humetro.busan.kr", "openapi.kric.go.kr", "data.kric.go.kr", "www.korail.com", "apis.data.go.kr", "www.data.go.kr", "openapi.seoul.go.kr", "www.grtc.co.kr", "github.com"]);
});

test("DEPLOY는 고정 이름 객체를 한 번 apply하고 네 객체를 읽어 렌더와 대조한다", async () => {
  const cluster = fakeCluster();
  const result = await deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner });
  assert.deepEqual(verbs(cluster), ["get:cronjob", "apply", "get:configmap", "get:serviceaccount", "get:networkpolicy", "get:networkpolicy", "get:cronjob"]);
  const applied = JSON.parse(cluster.calls[1].input);
  assert.deepEqual(applied.items, [expected.objects.configMap, expected.objects.serviceAccount, expected.objects.cronJob], "NetworkPolicy는 deployer가 바꾸지 않는다(관리자 bootstrap 전용)");
  assert.deepEqual(cluster.calls.filter(({ args }) => args[5] === "networkpolicy").map(({ args }) => args[6]), [OBJECT_NAMES.networkPolicy, OBJECT_NAMES.defaultDenyPolicy]);
  assert.equal(result.kubernetesMutationCount, 3);
  assert.equal(result.scriptSha256, createHash("sha256").update(readFileSync(new URL("../ops/source-reachability-probe.mjs", import.meta.url))).digest("hex"));
  assert.equal(JSON.stringify(cluster.calls).toLowerCase().includes("secret"), false);
});

test("DEPLOY는 관리자 bootstrap이 없으면 만들지 않고 멈춘다", async () => {
  const cluster = fakeCluster({ bootstrapped: false });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), { code: "E_PROBE_DEPLOY_NOT_BOOTSTRAPPED" });
  assert.deepEqual(verbs(cluster), ["get:cronjob"]);
});

test("DEPLOY는 적용한 객체가 렌더와 다르면 읽기 대조 실패로 끝낸다", async () => {
  const drifted = structuredClone(expected.objects.cronJob);
  drifted.spec.suspend = true;
  const cluster = fakeCluster({ live: { [`cronjob/${OBJECT_NAMES.cronJob}`]: drifted } });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), { code: "E_PROBE_DEPLOY_READBACK" });
});

test("DEPLOY는 관리자가 적용한 NetworkPolicy가 렌더와 다르면(허용 규칙이든 default-deny든) 읽기 대조 실패로 끝낸다", async () => {
  const widened = structuredClone(expected.objects.networkPolicy);
  widened.spec.egress[1].to[0].ipBlock.except = [];
  const opened = structuredClone(expected.objects.defaultDenyPolicy);
  opened.spec.podSelector = { matchLabels: { "app.kubernetes.io/name": "source-reachability-probe" } };
  for (const live of [{ [`networkpolicy/${OBJECT_NAMES.networkPolicy}`]: widened }, { [`networkpolicy/${OBJECT_NAMES.defaultDenyPolicy}`]: opened }]) {
    const cluster = fakeCluster({ live });
    await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), { code: "E_PROBE_DEPLOY_READBACK" });
  }
});

test("kubectl 실패는 코드와 함께 그대로 드러나고 이후 호출을 하지 않는다", async () => {
  const cluster = fakeCluster({ failOn: "apply" });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), (error) => error.code === "E_PROBE_DEPLOY_KUBECTL" && /apply refused/u.test(error.message));
  assert.deepEqual(verbs(cluster), ["get:cronjob", "apply"]);
});

test("COLLECT는 Job 파드 로그의 JSONL을 검증해 다시 직렬화한 줄만 파일로 쓰고 파드 단계와 기간을 보고한다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(recordObject("2026-10-21T08:10:00.000Z")).reverse()));
    const podLogs = { "pod-a": `${shuffled}\n`, "pod-b": `${record("2026-10-21T08:00:00.000Z", failedExtra)}\n`, "pod-c": "" };
    const pods = [podOf("pod-a"), podOf("pod-b"), podOf("pod-c", "Failed"), podOf("pod-d", "Running")];
    const cluster = fakeCluster({ pods, podLogs });
    const result = await deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner });
    assert.equal(readFileSync(output, "utf8"), `${record("2026-10-21T08:10:00.000Z")}\n${record("2026-10-21T08:00:00.000Z", failedExtra)}\n`, "원문이 아니라 RECORD_KEYS 순서로 다시 만든 줄이다");
    assert.deepEqual(result.collected, { pods: 4, podsRead: 3, podPhases: { Succeeded: 2, Failed: 1, Running: 1 }, records: 2, firstObservedAt: "2026-10-21T08:00:00.000Z", lastObservedAt: "2026-10-21T08:10:00.000Z" });
    assert.equal(result.kubernetesMutationCount, 0);
    assert.deepEqual(verbs(cluster), ["get:pods", "logs", "logs", "logs"], "끝난 파드(Succeeded·Failed)만 파드별로 읽고 실행 중인 파드는 다음 수집으로 미룬다");
    assert.deepEqual(cluster.calls.slice(1).map(({ args }) => args[5]), ["pod-a", "pod-b", "pod-c"]);
    assert.ok(cluster.calls.slice(1).every(({ args }) => args.includes("--tail=-1") && !args.includes("-l")), "파드마다 전체 로그를 읽고 selector로 한꺼번에 읽지 않는다");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("COLLECT는 형식이 다른 줄(JSON 아님·키 추가·타입 오류·값 범위 오류·알 수 없는 대상)을 버리지 않고 실패하며 파일을 쓰지 않는다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    const at = "2026-10-21T08:00:00.000Z";
    const bad = [
      "not json\n",
      `${JSON.stringify({ schema: "OTHER", observedAt: at })}\n`,
      `${record(at)}\n${JSON.stringify({ ...recordObject(at), note: "any extra key leaks into a public artifact" })}\n`,
      `${record(at, { httpStatus: "200" })}\n`,
      `${record(at, { dnsMs: -5 })}\n`,
      `${record(at, { host: "internal.example", target: "kric-open-api" })}\n`,
      `${record(at, { errorCode: "secret token value" , ok: false, failedStage: "dns", httpStatus: null })}\n`,
    ];
    for (const logs of bad) {
      const cluster = fakeCluster({ pods: [podOf("pod-a")], podLogs: { "pod-a": logs } });
      await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner }), { code: "E_PROBE_COLLECT_FORMAT" }, logs);
      assert.equal(existsSync(output), false);
    }
    await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", commandRunner: fakeCluster().commandRunner }), { code: "E_PROBE_DEPLOY_USAGE" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 실제 측정 기록처럼 소수점 이하 자릿수가 긴 값으로 파드 하나(10개 대상 한 라운드)의 로그를 만든다.
const realisticPodLog = (podIndex) => `${PROBE_TARGETS.map((target, index) => JSON.stringify({
  ...recordObject(new Date(Date.UTC(2026, 9, 21, 0, 0, 0) + podIndex * 600_000).toISOString(), { target: target.id, host: target.host, port: target.port, round: 1 }),
  dnsMs: 12.345678901234 + index, connectMs: 31.2345678901234, tlsMs: 45.678901234567, firstByteMs: 123.456789012345, totalMs: 212.3456789012345,
})).join("\n")}\n`;

test("COLLECT는 파드 300개(약 50시간) 규모도 파드별로 읽어 출력 한도에 걸리지 않고 파일에 이어 쓴다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    const names = Array.from({ length: 300 }, (_, index) => `source-reachability-probe-${index}`);
    const podLogs = Object.fromEntries(names.map((name, index) => [name, realisticPodLog(index)]));
    assert.ok(Buffer.byteLength(Object.values(podLogs).join("")) > COMMAND_OUTPUT_LIMIT, "전제: 모든 로그를 한 번에 읽으면 출력 한도를 넘는 규모다");
    const cluster = fakeCluster({ pods: names.map((name) => podOf(name)), podLogs });
    const result = await deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner });
    assert.equal(result.collected.records, 3000);
    assert.equal(result.collected.podsRead, 300);
    assert.equal(cluster.calls.filter(({ args }) => args[4] === "logs").length, 300);
    const lines = readFileSync(output, "utf8").trim().split("\n");
    assert.equal(lines.length, 3000);
    assert.equal(result.collected.firstObservedAt, "2026-10-21T00:00:00.000Z");
    assert.equal(result.collected.lastObservedAt, new Date(Date.UTC(2026, 9, 21, 0, 0, 0) + 299 * 600_000).toISOString());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("COLLECT는 중간 파드의 로그가 어긋나면 이미 쓴 내용을 지우고 실패한다(공개 artifact에 부분 결과를 남기지 않는다)", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    const cluster = fakeCluster({ pods: [podOf("pod-a"), podOf("pod-b")], podLogs: { "pod-a": `${record("2026-10-21T08:00:00.000Z")}\n`, "pod-b": "not json\n" } });
    await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner }), { code: "E_PROBE_COLLECT_FORMAT" });
    assert.equal(existsSync(output), false);
    const failing = fakeCluster({ pods: [podOf("pod-a"), podOf("pod-b")], podLogs: { "pod-a": `${record("2026-10-21T08:00:00.000Z")}\n` }, failOn: "logs:pod-b" });
    await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: failing.commandRunner }), { code: "E_PROBE_DEPLOY_KUBECTL" });
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("REMOVE는 CronJob과 ConfigMap만 지우고, 이미 없는 객체는 오류로 보지 않는다(멱등)", async () => {
  const cluster = fakeCluster();
  const result = await deploySourceReachabilityProbe({ mode: "REMOVE", commandRunner: cluster.commandRunner });
  assert.deepEqual(verbs(cluster), ["delete:cronjob", "delete:configmap"]);
  assert.deepEqual(cluster.calls.map(({ args }) => args[6]), [OBJECT_NAMES.cronJob, OBJECT_NAMES.configMap]);
  assert.ok(cluster.calls.every(({ args }) => args.includes("--ignore-not-found=true") && !args.includes("--ignore-not-found=false")));
  assert.equal(result.kubernetesMutationCount, 2);
});

test("REMOVE는 ConfigMap 삭제가 실패해 중단된 뒤에도 다시 실행해 끝낼 수 있다", async () => {
  const partial = fakeCluster({ failOn: `delete:${OBJECT_NAMES.configMap}` });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "REMOVE", commandRunner: partial.commandRunner }), { code: "E_PROBE_DEPLOY_KUBECTL" });
  assert.deepEqual(verbs(partial), ["delete:cronjob", "delete:configmap"]);
  // 두 번째 실행: CronJob은 이미 없다. kubectl이 --ignore-not-found=true로 통과시키므로 ConfigMap 삭제까지 도달한다.
  const rerun = fakeCluster();
  const result = await deploySourceReachabilityProbe({ mode: "REMOVE", commandRunner: rerun.commandRunner });
  assert.equal(result.kubernetesMutationCount, 2);
  assert.deepEqual(rerun.calls[0].args.slice(4), ["delete", "cronjob", OBJECT_NAMES.cronJob, "--namespace", NAMESPACE, "--ignore-not-found=true"]);
});

test("알 수 없는 모드는 거부한다", async () => {
  await assert.rejects(deploySourceReachabilityProbe({ mode: "APPLY", commandRunner: fakeCluster().commandRunner }), { code: "E_PROBE_DEPLOY_USAGE" });
  await assert.rejects(deploySourceReachabilityProbe({ mode: undefined }), { code: "E_PROBE_DEPLOY_USAGE" });
});
