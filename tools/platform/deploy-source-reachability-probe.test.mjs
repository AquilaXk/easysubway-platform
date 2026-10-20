import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEPLOYER, NAMESPACE, OBJECT_NAMES, deploySourceReachabilityProbe, readProbeScript, renderSourceReachabilityProbe } from "./deploy-source-reachability-probe.mjs";

// hub easysubway#3036: PREVIEW는 렌더만, DEPLOY는 deployer 신원으로 고정 이름 객체를 apply·대조, COLLECT는 Job 파드 로그를 검증해 파일로, REMOVE는 측정 종료 정리.
// 모든 kubectl은 deployer 신원(--as)으로만 가고 secret은 어디에도 없다.
const expected = renderSourceReachabilityProbe({ scriptBytes: readProbeScript() });
const withDefaults = (object) => {
  const live = structuredClone(object);
  if (live.kind === "CronJob") live.spec.jobTemplate.spec.template.spec.dnsPolicy = "ClusterFirst";
  return live;
};
const liveByResource = { configmap: expected.objects.configMap, serviceaccount: expected.objects.serviceAccount, networkpolicy: expected.objects.networkPolicy, cronjob: expected.objects.cronJob };

function fakeCluster({ bootstrapped = true, live = {}, pods = [], logs = "", failOn = null } = {}) {
  const calls = [];
  const commandRunner = async (command, args, { input } = {}) => {
    calls.push({ command, args, input: input === undefined ? undefined : input.toString("utf8") });
    assert.equal(command, "sudo");
    assert.deepEqual(args.slice(0, 4), ["--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`], "모든 호출은 deployer 신원이다");
    const [verb, kind] = args.slice(4);
    if (failOn === verb) throw new Error(`host command failed (1): ${verb} refused`);
    if (verb === "get" && kind === "cronjob" && args.includes("--ignore-not-found")) return { stdout: bootstrapped ? "cronjob.batch/source-reachability-probe\n" : "", stderr: "" };
    if (verb === "get" && kind === "pods") return { stdout: JSON.stringify({ items: pods }), stderr: "" };
    if (verb === "get") return { stdout: JSON.stringify(live[kind] ?? withDefaults(liveByResource[kind])), stderr: "" };
    if (verb === "logs") return { stdout: logs, stderr: "" };
    if (verb === "apply" || verb === "delete") return { stdout: "", stderr: "" };
    return assert.fail(`unexpected kubectl verb ${verb}`);
  };
  return { calls, commandRunner };
}
const verbs = (cluster) => cluster.calls.map(({ args }) => (["get", "delete"].includes(args[4]) ? args.slice(4, 6) : args.slice(4, 5)).join(":"));
const record = (observedAt, extra = {}) => JSON.stringify({ schema: "SOURCE_REACHABILITY_PROBE_V1", observedAt, vantage: "oci-seoul-k3s", target: "kric-open-api", ok: true, ...extra });

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
  assert.deepEqual(verbs(cluster), ["get:cronjob", "apply", "get:configmap", "get:serviceaccount", "get:networkpolicy", "get:cronjob"]);
  const applied = JSON.parse(cluster.calls[1].input);
  assert.deepEqual(applied.items, [expected.objects.configMap, expected.objects.serviceAccount, expected.objects.networkPolicy, expected.objects.cronJob]);
  assert.equal(result.kubernetesMutationCount, 4);
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
  const cluster = fakeCluster({ live: { cronjob: drifted } });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), { code: "E_PROBE_DEPLOY_READBACK" });
});

test("kubectl 실패는 코드와 함께 그대로 드러나고 이후 호출을 하지 않는다", async () => {
  const cluster = fakeCluster({ failOn: "apply" });
  await assert.rejects(deploySourceReachabilityProbe({ mode: "DEPLOY", commandRunner: cluster.commandRunner }), (error) => error.code === "E_PROBE_DEPLOY_KUBECTL" && /apply refused/u.test(error.message));
  assert.deepEqual(verbs(cluster), ["get:cronjob", "apply"]);
});

test("COLLECT는 Job 파드 로그의 JSONL을 검증해 파일로 쓰고 파드 단계와 기간을 보고한다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    const logs = `${record("2026-10-21T08:10:00.000Z")}\n${record("2026-10-21T08:00:00.000Z", { ok: false })}\n`;
    const pods = [{ status: { phase: "Succeeded" } }, { status: { phase: "Succeeded" } }, { status: { phase: "Failed" } }];
    const cluster = fakeCluster({ pods, logs });
    const result = await deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner });
    assert.equal(readFileSync(output, "utf8"), logs);
    assert.deepEqual(result.collected, { pods: 3, podPhases: { Succeeded: 2, Failed: 1 }, records: 2, firstObservedAt: "2026-10-21T08:00:00.000Z", lastObservedAt: "2026-10-21T08:10:00.000Z" });
    assert.equal(result.kubernetesMutationCount, 0);
    assert.deepEqual(verbs(cluster), ["get:pods", "logs"]);
    assert.ok(cluster.calls[1].args.includes("--tail=-1"), "selector 로그는 기본 10줄로 잘리므로 전체를 읽는다");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("COLLECT는 형식이 다른 줄을 버리지 않고 실패하며 파일을 쓰지 않는다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "probe-collect-"));
  try {
    const output = path.join(directory, "seoul.jsonl");
    for (const logs of ["not json\n", `${JSON.stringify({ schema: "OTHER", observedAt: "2026-10-21T08:00:00.000Z" })}\n`]) {
      const cluster = fakeCluster({ logs });
      await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", output, commandRunner: cluster.commandRunner }), { code: "E_PROBE_COLLECT_FORMAT" });
      assert.equal(existsSync(output), false);
    }
    await assert.rejects(deploySourceReachabilityProbe({ mode: "COLLECT", commandRunner: fakeCluster().commandRunner }), { code: "E_PROBE_DEPLOY_USAGE" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("REMOVE는 CronJob과 ConfigMap만 지운다", async () => {
  const cluster = fakeCluster();
  const result = await deploySourceReachabilityProbe({ mode: "REMOVE", commandRunner: cluster.commandRunner });
  assert.deepEqual(verbs(cluster), ["delete:cronjob", "delete:configmap"]);
  assert.deepEqual(cluster.calls.map(({ args }) => args[6]), [OBJECT_NAMES.cronJob, OBJECT_NAMES.configMap]);
  assert.equal(result.kubernetesMutationCount, 2);
});

test("알 수 없는 모드는 거부한다", async () => {
  await assert.rejects(deploySourceReachabilityProbe({ mode: "APPLY", commandRunner: fakeCluster().commandRunner }), { code: "E_PROBE_DEPLOY_USAGE" });
  await assert.rejects(deploySourceReachabilityProbe({ mode: undefined }), { code: "E_PROBE_DEPLOY_USAGE" });
});
