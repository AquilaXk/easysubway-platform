#!/usr/bin/env node
// AquilaXk/easysubway-platform#237: data 레포 정기 workflow를 깨우는 CronJob 스케줄러의 k3s 객체를 결정적으로 렌더한다.
// 렌더는 이 저장소 안의 고정 파일(계약, 스크립트)만 읽고 외부 조회를 하지 않는다. secret 값은 다루지 않는다:
// secret 이름은 호출자가 넘기는 내용 digest(secretIdentity)에서만 나온다(journey-secret-<hash>와 같은 패턴).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CONTRACT_URL = new URL("../../contracts/release/platform-data-workflow-scheduler-contract.json", import.meta.url);
const SCRIPT_URL = new URL("../ops/data-workflow-scheduler.mjs", import.meta.url);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NAME = "data-workflow-scheduler";
const NAMESPACE = "easysubway-journey";
const SECRET_KEYS = Object.freeze(["client-id", "private-key.pem"]);
const PUBLIC_EGRESS_EXCEPT_CIDRS = Object.freeze(["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]);

class SchedulerRenderError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const fail = (message) => { throw new SchedulerRenderError("E_SCHEDULER_RENDER_INPUT", message); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const labels = () => ({ "app.kubernetes.io/name": NAME, "app.kubernetes.io/part-of": "easysubway" });

function scheduleText(contract) {
  const workflows = contract.workflows.map(({ id, workflow, everyHours, offsetHour, minute, inputs }) => ({
    id, workflow, everyHours, offsetHour, minute, ...(inputs ? { inputs } : {}),
  }));
  return `${JSON.stringify({ target: { repository: contract.target.repository, ref: contract.target.ref, permissions: contract.target.permissions }, workflows }, null, 2)}\n`;
}

export function renderDataWorkflowScheduler({ contract, scriptBytes, secretIdentity }) {
  if (!contract || typeof contract !== "object" || contract.schemaVersion !== "PLATFORM_DATA_WORKFLOW_SCHEDULER_CONTRACT_V1") fail("contract");
  if (!Buffer.isBuffer(scriptBytes) || scriptBytes.length === 0) fail("scriptBytes must be a non-empty Buffer");
  if (typeof secretIdentity !== "string" || !DIGEST.test(secretIdentity)) fail("secretIdentity must be a sha256 digest");
  const { cronJob: cron, runtime } = contract;
  if (cron.name !== NAME || cron.namespace !== NAMESPACE) fail("cronJob identity");

  const schedule = scheduleText(contract);
  const script = scriptBytes.toString("utf8");
  const configDigest = sha256([script, "---", schedule].join("\n")).slice(0, 20);
  const secretDigest = secretIdentity.slice("sha256:".length, "sha256:".length + 20);
  const names = {
    configMap: `${NAME}-config-${configDigest}`,
    secret: `${NAME}-secret-${secretDigest}`,
    cronJob: NAME,
    serviceAccount: NAME,
    networkPolicy: `${NAME}-boundary`,
  };
  const metadata = (name) => ({ name, namespace: NAMESPACE, labels: labels() });

  const serviceAccount = { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata(names.serviceAccount), automountServiceAccountToken: false };
  const configMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata(names.configMap),
    immutable: true,
    data: { "scheduler.mjs": script, "schedule.json": schedule },
  };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.networkPolicy, namespace: NAMESPACE },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": NAME } },
      policyTypes: ["Ingress", "Egress"],
      egress: [
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
        { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [...PUBLIC_EGRESS_EXCEPT_CIDRS] } }], ports: [{ protocol: "TCP", port: 443 }] },
      ],
    },
  };
  const cronJob = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: metadata(names.cronJob),
    spec: {
      schedule: cron.schedule,
      timeZone: cron.timeZone,
      concurrencyPolicy: cron.concurrencyPolicy,
      startingDeadlineSeconds: cron.startingDeadlineSeconds,
      successfulJobsHistoryLimit: cron.successfulJobsHistoryLimit,
      failedJobsHistoryLimit: cron.failedJobsHistoryLimit,
      suspend: false,
      jobTemplate: {
        metadata: { labels: labels() },
        spec: {
          backoffLimit: cron.backoffLimit,
          activeDeadlineSeconds: cron.activeDeadlineSeconds,
          template: {
            metadata: { labels: labels() },
            spec: {
              restartPolicy: "Never",
              serviceAccountName: names.serviceAccount,
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              nodeSelector: { "kubernetes.io/arch": "arm64" },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: runtime.runAsUser,
                runAsGroup: runtime.runAsGroup,
                fsGroup: runtime.runAsGroup,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [{
                name: "scheduler",
                image: runtime.image,
                imagePullPolicy: "IfNotPresent",
                command: ["node", "/opt/scheduler/scheduler.mjs"],
                env: [
                  { name: "SCHEDULER_CONFIG", value: "/opt/scheduler/schedule.json" },
                  { name: "SCHEDULER_SECRET_DIR", value: "/run/secrets/data-dispatch" },
                ],
                resources: structuredClone(runtime.resources),
                securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                volumeMounts: [
                  { name: "scheduler", mountPath: "/opt/scheduler", readOnly: true },
                  { name: "dispatch-app", mountPath: "/run/secrets/data-dispatch", readOnly: true },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              }],
              volumes: [
                { name: "scheduler", configMap: { name: names.configMap, defaultMode: 0o444 } },
                { name: "dispatch-app", secret: { secretName: names.secret, defaultMode: 0o440, items: SECRET_KEYS.map((key) => ({ key, path: key })) } },
                { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
              ],
            },
          },
        },
      },
    },
  };
  return {
    schemaVersion: "PLATFORM_DATA_WORKFLOW_SCHEDULER_RENDER_V1",
    names,
    secretPlan: { name: names.secret, namespace: NAMESPACE, keys: [...SECRET_KEYS], immutable: true, identity: secretIdentity },
    objects: { serviceAccount, networkPolicy, configMap, cronJob },
  };
}

export function readSchedulerContract() {
  return JSON.parse(readFileSync(CONTRACT_URL, "utf8"));
}

export function readSchedulerScript() {
  return readFileSync(SCRIPT_URL);
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--secret-identity") throw new SchedulerRenderError("E_SCHEDULER_RENDER_INPUT", "expected exactly --secret-identity <sha256:digest>");
  const rendered = renderDataWorkflowScheduler({ contract: readSchedulerContract(), scriptBytes: readSchedulerScript(), secretIdentity: argv[1] });
  process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof SchedulerRenderError ? error.message : "E_SCHEDULER_RENDER_FAILED"}\n`);
    process.exitCode = 1;
  }
}
