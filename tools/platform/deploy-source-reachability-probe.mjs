#!/usr/bin/env node
// hub AquilaXk/easysubway#3036: 공공 원천 도달성 측정 CronJob을 서울 k3s의 별도 namespace에 올리고, 결과를 꺼내고, 측정이 끝나면 걷어낸다.
// 측정 스크립트는 tools/ops/source-reachability-probe.mjs 하나이고 GitHub 호스티드 러너도 같은 파일을 쓴다. secret은 쓰지 않는다.
// 모드:
//   PREVIEW  렌더만 한다(클러스터 접근 없음).
//   DEPLOY   deployer 신원으로 고정 이름 객체(ConfigMap·ServiceAccount·NetworkPolicy·CronJob)를 apply하고 읽어 렌더와 대조한다.
//   COLLECT  보존된 Job 파드의 로그(JSON Lines)를 읽어 검증하고 --output 파일에 쓴다.
//   REMOVE   측정 종료: CronJob과 ConfigMap을 지운다(Job·파드는 소유 관계로 함께 지워진다).
// namespace·deployer RBAC·고정 이름 객체는 관리자가 infra/k3s/source-reachability-probe-rbac.json으로 한 번 만든다(data-workflow-scheduler와 같은 패턴).
// deployer에는 만들기 권한이 없고, 이름이 정해진 객체의 get·update·patch(CronJob·ConfigMap은 delete)와 파드 로그 읽기만 있다.
// 실패는 숨기지 않는다: 자동 rollback도 대체 값도 없다.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PROBE_TARGETS, RECORD_SCHEMA } from "../ops/source-reachability-probe.mjs";
import { isSubset, runCommand } from "./deploy-data-workflow-scheduler.mjs";

export const NAMESPACE = "easysubway-probe";
export const DEPLOYER = `system:serviceaccount:${NAMESPACE}:source-reachability-probe-deployer`;
const NAME = "source-reachability-probe";
const SCRIPT_URL = new URL("../ops/source-reachability-probe.mjs", import.meta.url);
const SCRIPT_KEY = "source-reachability-probe.mjs";
const MODES = Object.freeze(["PREVIEW", "DEPLOY", "COLLECT", "REMOVE"]);
const VANTAGE = "oci-seoul-k3s";
const RUN_AS = 10001;
// 측정 한 번은 Job 하나다. 10분 주기로 50시간(2일 + 여유)치 Job을 보존해 COLLECT가 로그를 읽을 수 있게 한다.
const SCHEDULE = Object.freeze({
  cron: "*/10 * * * *",
  timeZone: "Etc/UTC",
  startingDeadlineSeconds: 300,
  activeDeadlineSeconds: 120,
  successfulJobsHistoryLimit: 300,
  failedJobsHistoryLimit: 20,
});
const RUNTIME = Object.freeze({
  image: "docker.io/library/node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43",
  resources: { requests: { cpu: "20m", memory: "48Mi", "ephemeral-storage": "16Mi" }, limits: { cpu: "200m", memory: "128Mi", "ephemeral-storage": "64Mi" } },
});
// 공개 인터넷 egress에서 빼는 사설·링크로컬 대역이다(허용 목록이 아니라 차단 목록).
const PRIVATE_CIDRS = Object.freeze(["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]); // NOSONAR

export const OBJECT_NAMES = Object.freeze({
  cronJob: NAME,
  serviceAccount: NAME,
  configMap: `${NAME}-script`,
  networkPolicy: `${NAME}-boundary`,
  deployer: `${NAME}-deployer`,
});

class ProbeDeployError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const fail = (code, detail) => { throw new ProbeDeployError(code, detail); };
const labels = () => ({ "app.kubernetes.io/name": NAME, "app.kubernetes.io/part-of": "easysubway" });
const metadata = (name) => ({ name, namespace: NAMESPACE, labels: labels() });

export function readProbeScript() {
  return readFileSync(SCRIPT_URL);
}

/** 측정 대상이 쓰는 포트만 공개 인터넷으로 열고(DNS 제외) 사설 대역과 ingress는 모두 막는다. */
function egressRules() {
  const ports = [...new Set(PROBE_TARGETS.map(({ port }) => port))].sort((a, b) => a - b).map((port) => ({ protocol: "TCP", port }));
  return [
    { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
    { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [...PRIVATE_CIDRS] } }], ports },
  ];
}

export function renderSourceReachabilityProbe({ scriptBytes }) {
  if (!Buffer.isBuffer(scriptBytes) || scriptBytes.length === 0) fail("E_PROBE_RENDER_INPUT", "scriptBytes must be a non-empty Buffer");
  const serviceAccount = { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata(OBJECT_NAMES.serviceAccount), automountServiceAccountToken: false };
  const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: metadata(OBJECT_NAMES.configMap), data: { [SCRIPT_KEY]: scriptBytes.toString("utf8") } };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: OBJECT_NAMES.networkPolicy, namespace: NAMESPACE },
    spec: { podSelector: { matchLabels: { "app.kubernetes.io/name": NAME } }, policyTypes: ["Ingress", "Egress"], egress: egressRules() },
  };
  const cronJob = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: metadata(OBJECT_NAMES.cronJob),
    spec: {
      schedule: SCHEDULE.cron,
      timeZone: SCHEDULE.timeZone,
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: SCHEDULE.startingDeadlineSeconds,
      successfulJobsHistoryLimit: SCHEDULE.successfulJobsHistoryLimit,
      failedJobsHistoryLimit: SCHEDULE.failedJobsHistoryLimit,
      suspend: false,
      jobTemplate: {
        metadata: { labels: labels() },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: SCHEDULE.activeDeadlineSeconds,
          template: {
            metadata: { labels: labels() },
            spec: {
              restartPolicy: "Never",
              serviceAccountName: OBJECT_NAMES.serviceAccount,
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              nodeSelector: { "kubernetes.io/arch": "arm64" },
              securityContext: { runAsNonRoot: true, runAsUser: RUN_AS, runAsGroup: RUN_AS, seccompProfile: { type: "RuntimeDefault" } },
              containers: [{
                name: "probe",
                image: RUNTIME.image,
                imagePullPolicy: "IfNotPresent",
                command: ["node", `/opt/probe/${SCRIPT_KEY}`, "--vantage", VANTAGE],
                resources: structuredClone(RUNTIME.resources),
                securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                volumeMounts: [{ name: "probe", mountPath: "/opt/probe", readOnly: true }],
              }],
              volumes: [{ name: "probe", configMap: { name: OBJECT_NAMES.configMap, defaultMode: 0o444 } }],
            },
          },
        },
      },
    },
  };
  return {
    schemaVersion: "PLATFORM_SOURCE_REACHABILITY_PROBE_RENDER_V1",
    names: { ...OBJECT_NAMES },
    objects: { serviceAccount, configMap, networkPolicy, cronJob },
  };
}

const parseJson = (text, what) => {
  try {
    return JSON.parse(text);
  } catch {
    return fail("E_PROBE_DEPLOY_READBACK", `${what} is not readable JSON`);
  }
};

function makeKubectl(commandRunner) {
  return async (args, input) => {
    try {
      return await commandRunner("sudo", ["--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`, ...args], input === undefined ? {} : { input: Buffer.from(input) });
    } catch (error) {
      return fail("E_PROBE_DEPLOY_KUBECTL", String(error?.message ?? "kubectl failed").slice(0, 400));
    }
  };
}

async function deploy({ kubectl, rendered }) {
  // 관리자가 만든 고정 이름 객체가 없으면 만들어 주지 않고 멈춘다(deployer에는 만들기 권한이 없다).
  const existing = await kubectl(["get", "cronjob", OBJECT_NAMES.cronJob, "--namespace", NAMESPACE, "--ignore-not-found", "-o", "name"]);
  if (existing.stdout.trim() === "") fail("E_PROBE_DEPLOY_NOT_BOOTSTRAPPED", "apply infra/k3s/source-reachability-probe-rbac.json as the host administrator first");
  const applied = [rendered.objects.configMap, rendered.objects.serviceAccount, rendered.objects.networkPolicy, rendered.objects.cronJob];
  await kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: applied }));
  for (const [resource, name, wanted] of [
    ["configmap", OBJECT_NAMES.configMap, rendered.objects.configMap],
    ["serviceaccount", OBJECT_NAMES.serviceAccount, rendered.objects.serviceAccount],
    ["networkpolicy", OBJECT_NAMES.networkPolicy, rendered.objects.networkPolicy],
    ["cronjob", OBJECT_NAMES.cronJob, rendered.objects.cronJob],
  ]) {
    // 읽기 대조는 객체마다 순서대로 한다(첫 불일치에서 멈춘다).
    const live = parseJson((await kubectl(["get", resource, name, "--namespace", NAMESPACE, "-o", "json"])).stdout, `live ${resource}`); // NOSONAR
    if (!isSubset(wanted, live)) fail("E_PROBE_DEPLOY_READBACK", `live ${resource} differs from the rendered ${resource}`);
  }
  return { kubernetesMutationCount: applied.length };
}

/** 보존된 Job 파드의 로그를 모아 검증한다. 형식이 다른 줄은 버리지 않고 실패로 드러낸다. */
async function collect({ kubectl, output }) {
  if (typeof output !== "string" || output === "") fail("E_PROBE_DEPLOY_USAGE", "COLLECT needs --output <file.jsonl>");
  const selector = `app.kubernetes.io/name=${NAME}`;
  const pods = parseJson((await kubectl(["get", "pods", "--namespace", NAMESPACE, "-l", selector, "-o", "json"])).stdout, "pod list").items ?? [];
  const phases = {};
  for (const { status } of pods) {
    const phase = status?.phase ?? "Unknown";
    phases[phase] = (phases[phase] ?? 0) + 1;
  }
  const logs = (await kubectl(["logs", "--namespace", NAMESPACE, "-l", selector, "--tail=-1", "--prefix=false"])).stdout;
  const lines = logs.split("\n").filter((line) => line !== "");
  const observed = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail("E_PROBE_COLLECT_FORMAT", "a pod log line is not JSON");
    }
    if (record?.schema !== RECORD_SCHEMA || typeof record.observedAt !== "string") fail("E_PROBE_COLLECT_FORMAT", `a pod log line is not a ${RECORD_SCHEMA} record`);
    observed.push(record.observedAt);
  }
  writeFileSync(output, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  observed.sort((left, right) => left.localeCompare(right));
  return { kubernetesMutationCount: 0, collected: { pods: pods.length, podPhases: phases, records: lines.length, firstObservedAt: observed[0] ?? null, lastObservedAt: observed.at(-1) ?? null } };
}

async function remove({ kubectl }) {
  await kubectl(["delete", "cronjob", OBJECT_NAMES.cronJob, "--namespace", NAMESPACE, "--ignore-not-found=false"]);
  await kubectl(["delete", "configmap", OBJECT_NAMES.configMap, "--namespace", NAMESPACE, "--ignore-not-found=false"]);
  return { kubernetesMutationCount: 2 };
}

export async function deploySourceReachabilityProbe({ mode, output = null, commandRunner = runCommand } = {}) {
  if (!MODES.includes(mode) || typeof commandRunner !== "function") fail("E_PROBE_DEPLOY_USAGE", `mode must be one of ${MODES.join(", ")}`);
  const rendered = renderSourceReachabilityProbe({ scriptBytes: readProbeScript() });
  const kubectl = makeKubectl(commandRunner);
  const outcome = {
    PREVIEW: async () => ({ kubernetesMutationCount: 0 }),
    DEPLOY: () => deploy({ kubectl, rendered }),
    COLLECT: () => collect({ kubectl, output }),
    REMOVE: () => remove({ kubectl }),
  }[mode];
  return {
    schemaVersion: "PLATFORM_SOURCE_REACHABILITY_PROBE_DEPLOY_RESULT_V1",
    mode,
    namespace: NAMESPACE,
    names: rendered.names,
    image: RUNTIME.image,
    schedule: SCHEDULE.cron,
    targets: PROBE_TARGETS.map(({ id, host, port }) => ({ id, host, port })),
    ...(await outcome()),
  };
}

function parseCli(argv) {
  const options = { mode: null, output: null };
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === "--mode" && argv[index + 1] !== undefined) options.mode = argv[index + 1];
    else if (argv[index] === "--output" && argv[index + 1] !== undefined) options.output = argv[index + 1];
    else fail("E_PROBE_DEPLOY_USAGE", "expected --mode PREVIEW|DEPLOY|COLLECT|REMOVE [--output <file>]");
  }
  return options;
}

async function main(argv) {
  process.stdout.write(`${JSON.stringify(await deploySourceReachabilityProbe(parseCli(argv)), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof ProbeDeployError ? error.message : "E_PROBE_DEPLOY_FAILED"}\n`);
    process.exitCode = 1;
  }
}
