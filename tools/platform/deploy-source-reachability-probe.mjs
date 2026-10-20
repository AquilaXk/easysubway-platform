#!/usr/bin/env node
// hub AquilaXk/easysubway#3036: 공공 원천 도달성 측정 CronJob을 서울 k3s의 별도 namespace에 올리고, 결과를 꺼내고, 측정이 끝나면 걷어낸다.
// 측정 스크립트는 tools/ops/source-reachability-probe.mjs 하나이고 GitHub 호스티드 러너도 같은 파일을 쓴다. secret은 쓰지 않는다.
// 모드:
//   PREVIEW  렌더만 한다(클러스터 접근 없음).
//   DEPLOY   deployer 신원으로 고정 이름 객체(ConfigMap·ServiceAccount·CronJob)를 apply하고, NetworkPolicy 둘까지 읽어 렌더와 대조한다.
//   COLLECT  끝난 Job 파드의 로그(JSON Lines)를 파드별로 읽어 기록 형식을 하나씩 검증하고, 다시 직렬화한 줄만 --output 파일에 이어 쓴다.
//   REMOVE   측정 종료: CronJob과 ConfigMap을 지운다(Job·파드는 소유 관계로 함께 지워진다). 멱등이라 부분 실패 뒤 다시 돌릴 수 있다.
// namespace·deployer RBAC·NetworkPolicy·고정 이름 객체는 관리자가 infra/k3s/source-reachability-probe-rbac.json으로 한 번 만든다(data-workflow-scheduler와 같은 패턴).
// 격리 경계인 NetworkPolicy는 deployer가 바꿀 수 없다(get만): namespace 전체 default-deny가 깔려 있어 파드 라벨이 빠져도 파드는 고립된다.
// deployer에는 만들기 권한이 없고, 이름이 정해진 객체의 get·update·patch(CronJob·ConfigMap은 delete)와 파드 로그 읽기만 있다.
// REMOVE 뒤에는 CronJob 자리표시자가 없으므로 다시 DEPLOY하려면 관리자 bootstrap을 다시 적용해야 한다.
// 실패는 숨기지 않는다: 자동 rollback도 대체 값도 없다.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PROBE_TARGETS, parseRecordLines } from "../ops/source-reachability-probe.mjs";
import { runCommand } from "./lib/process.mjs";
import { isSubset } from "./lib/subset.mjs";

export const NAMESPACE = "easysubway-probe";
export const DEPLOYER = `system:serviceaccount:${NAMESPACE}:source-reachability-probe-deployer`;
const NAME = "source-reachability-probe";
const SCRIPT_URL = new URL("../ops/source-reachability-probe.mjs", import.meta.url);
const SCRIPT_KEY = "source-reachability-probe.mjs";
const MODES = Object.freeze(["PREVIEW", "DEPLOY", "COLLECT", "REMOVE"]);
const VANTAGE = "oci-seoul-k3s";
const RUN_AS = 10001;
const FINISHED_PHASES = Object.freeze(["Succeeded", "Failed"]);
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
  defaultDenyPolicy: `${NAME}-default-deny`,
  deployer: `${NAME}-deployer`,
});

class ProbeDeployError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const fail = (code, detail) => { throw new ProbeDeployError(code, detail); };
// NetworkPolicy 허용 규칙은 이 라벨을 가진 파드에만 적용된다. 라벨이 없는 파드는 default-deny에 막힌다.
export const POD_SELECTOR_LABELS = Object.freeze({ "app.kubernetes.io/name": NAME });
const labels = () => ({ ...POD_SELECTOR_LABELS, "app.kubernetes.io/part-of": "easysubway" });
const metadata = (name) => ({ name, namespace: NAMESPACE, labels: labels() });

export function readProbeScript() {
  return readFileSync(SCRIPT_URL);
}

/** 서울 ConfigMap에 실리는 스크립트의 SHA-256. data 레포 workflow가 받은 스크립트의 기대 해시와 같아야 두 측정이 같은 스크립트다. */
export const probeScriptSha256 = (scriptBytes) => createHash("sha256").update(scriptBytes).digest("hex");

/** 측정 대상이 쓰는 포트만 공개 인터넷으로 열고(DNS 제외) 사설 대역과 ingress는 모두 막는다. */
function egressRules() {
  const ports = [...new Set(PROBE_TARGETS.map(({ port }) => port))].sort((a, b) => a - b).map((port) => ({ protocol: "TCP", port }));
  return [
    // DNS는 kube-system 안의 CoreDNS 파드(k3s 기본 라벨 k8s-app=kube-dns)로만 간다. 같은 to 항목의 두 selector는 AND다.
    { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
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
    spec: { podSelector: { matchLabels: { ...POD_SELECTOR_LABELS } }, policyTypes: ["Ingress", "Egress"], egress: egressRules() },
  };
  // namespace의 모든 파드를 ingress·egress 모두 막는다. 허용 규칙(networkPolicy)이 라벨로 고른 파드만 그 위에서 열린다.
  const defaultDenyPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: OBJECT_NAMES.defaultDenyPolicy, namespace: NAMESPACE },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
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
              // 측정은 c-ares로 완전한 이름을 직접 조회하지만, 파드의 다른 이름 조회도 search 확장이 섞이지 않게 ndots를 1로 둔다.
              dnsConfig: { options: [{ name: "ndots", value: "1" }] },
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
    objects: { serviceAccount, configMap, networkPolicy, defaultDenyPolicy, cronJob },
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
  // NetworkPolicy는 관리자 bootstrap 전용이라 apply하지 않고 읽어서 렌더와 같은지만 확인한다(다르면 bootstrap을 다시 적용해야 한다).
  const applied = [rendered.objects.configMap, rendered.objects.serviceAccount, rendered.objects.cronJob];
  await kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: applied }));
  for (const [resource, name, wanted] of [
    ["configmap", OBJECT_NAMES.configMap, rendered.objects.configMap],
    ["serviceaccount", OBJECT_NAMES.serviceAccount, rendered.objects.serviceAccount],
    ["networkpolicy", OBJECT_NAMES.networkPolicy, rendered.objects.networkPolicy],
    ["networkpolicy", OBJECT_NAMES.defaultDenyPolicy, rendered.objects.defaultDenyPolicy],
    ["cronjob", OBJECT_NAMES.cronJob, rendered.objects.cronJob],
  ]) {
    // 읽기 대조는 객체마다 순서대로 한다(첫 불일치에서 멈춘다).
    const live = parseJson((await kubectl(["get", resource, name, "--namespace", NAMESPACE, "-o", "json"])).stdout, `live ${resource}`); // NOSONAR
    // NetworkPolicy는 격리 경계라 부분 일치로는 부족하다: 빈 podSelector({})는 어떤 selector의 부분 집합이기도 하므로 spec은 양방향으로 대조한다.
    const matches = isSubset(wanted, live) && (resource !== "networkpolicy" || isSubset(live.spec, wanted.spec));
    if (!matches) fail("E_PROBE_DEPLOY_READBACK", `live ${resource} ${name} differs from the rendered ${resource}`);
  }
  return { kubernetesMutationCount: applied.length };
}

/**
 * 보존된 Job 파드의 로그를 파드별로 읽어 검증하고 --output 파일에 이어 쓴다. 한 번에 읽는 양이 파드 하나 분량이라 보존 파드가 늘어도
 * 명령 출력 한도(lib/process.mjs, 1 MiB)에 걸리지 않는다. 형식이 다른 줄이 하나라도 있거나 읽기가 실패하면 이미 쓴 내용까지 지우고 실패한다.
 */
async function collect({ kubectl, output }) {
  if (typeof output !== "string" || output === "") fail("E_PROBE_DEPLOY_USAGE", "COLLECT needs --output <file.jsonl>");
  const pods = parseJson((await kubectl(["get", "pods", "--namespace", NAMESPACE, "-l", `app.kubernetes.io/name=${NAME}`, "-o", "json"])).stdout, "pod list").items ?? [];
  const phases = {};
  for (const { status } of pods) {
    const phase = status?.phase ?? "Unknown";
    phases[phase] = (phases[phase] ?? 0) + 1;
  }
  // 실행 중인 파드는 로그가 아직 끝나지 않았으므로 다음 수집으로 미룬다.
  const finished = pods.filter(({ status }) => FINISHED_PHASES.includes(status?.phase)).map(({ metadata }) => metadata.name).sort();
  const collected = { pods: pods.length, podsRead: finished.length, podPhases: phases, records: 0, firstObservedAt: null, lastObservedAt: null };
  writeFileSync(output, "");
  try {
    for (const name of finished) {
      const logs = (await kubectl(["logs", name, "--namespace", NAMESPACE, "--tail=-1"])).stdout; // NOSONAR -- 파드별로 순서대로 읽어 한 번에 읽는 양을 제한한다
      let records;
      try {
        // 공개 저장소 artifact로 나가므로 모든 줄을 RECORD_KEYS 기준으로 검증하고, 원문이 아니라 다시 직렬화한 줄만 쓴다.
        records = parseRecordLines(logs);
      } catch (error) {
        fail("E_PROBE_COLLECT_FORMAT", `pod ${name}: ${String(error.message).replace(/^PROBE_RECORD_INVALID: /u, "")}`);
      }
      appendFileSync(output, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      for (const { observedAt } of records) {
        collected.records += 1;
        if (collected.firstObservedAt === null || observedAt < collected.firstObservedAt) collected.firstObservedAt = observedAt;
        if (collected.lastObservedAt === null || observedAt > collected.lastObservedAt) collected.lastObservedAt = observedAt;
      }
    }
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  }
  return { kubernetesMutationCount: 0, collected };
}

async function remove({ kubectl }) {
  await kubectl(["delete", "cronjob", OBJECT_NAMES.cronJob, "--namespace", NAMESPACE, "--ignore-not-found=true"]);
  await kubectl(["delete", "configmap", OBJECT_NAMES.configMap, "--namespace", NAMESPACE, "--ignore-not-found=true"]);
  return { kubernetesMutationCount: 2 };
}

export async function deploySourceReachabilityProbe({ mode, output = null, commandRunner = runCommand } = {}) {
  if (!MODES.includes(mode) || typeof commandRunner !== "function") fail("E_PROBE_DEPLOY_USAGE", `mode must be one of ${MODES.join(", ")}`);
  const scriptBytes = readProbeScript();
  const rendered = renderSourceReachabilityProbe({ scriptBytes });
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
    scriptSha256: probeScriptSha256(scriptBytes),
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
