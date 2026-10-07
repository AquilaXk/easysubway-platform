#!/usr/bin/env node
// AquilaXk/easysubway-platform#237: data workflow 스케줄러(CronJob)를 OCI k3s에 배포한다.
// PREVIEW는 렌더만 한다(클러스터·secret 접근 없음). DEPLOY는 self-hosted runner에서 별도 deployer 신원
// (system:serviceaccount:easysubway-journey:data-scheduler-deployer)으로 다음을 한다.
//   1) 현재 CronJob이 쓰는 secret·ConfigMap 이름 읽기  2) 내용 digest 이름의 immutable secret·ConfigMap create(같은 이름은 같은 내용이라 통과)
//   3) ServiceAccount·NetworkPolicy·CronJob apply  4) 적용한 CronJob을 읽어 대조  5) 직전 secret·ConfigMap 한 세트만 삭제.
// 실패는 숨기지 않는다: 자동 rollback도, 이전 값으로 대체도 없다. secret 값은 create의 stdin으로만 가고 출력·인자·로그에 남지 않는다.
import { createHash, createPrivateKey } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createAppJwt, verifyAppAccess } from "../ops/data-workflow-scheduler.mjs";
import { readSchedulerContract, readSchedulerScript, renderDataWorkflowScheduler } from "./render-data-workflow-scheduler.mjs";

const NAMESPACE = "easysubway-journey";
const DEPLOYER = "system:serviceaccount:easysubway-journey:data-scheduler-deployer";
const MODES = Object.freeze(["PREVIEW", "DEPLOY"]);
const PREVIEW_SECRET_IDENTITY = `sha256:${"0".repeat(64)}`;

class DeployError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const fail = (code, detail) => { throw new DeployError(code, detail); };

const MINIMUM_APP_KEY_BITS = 2048;

function readSecrets(env, minimumKeyBits) {
  const clientId = env.EASYSUBWAY_DISPATCH_APP_CLIENT_ID;
  const privateKeyPem = env.EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY;
  if (typeof clientId !== "string" || typeof privateKeyPem !== "string" || clientId === "" || privateKeyPem === "") fail("E_SCHEDULER_DEPLOY_SECRET", "app client id and private key are required");
  try {
    createAppJwt({ clientId, privateKeyPem, now: new Date() });
    const bits = createPrivateKey(privateKeyPem).asymmetricKeyDetails?.modulusLength;
    if (!Number.isInteger(bits) || bits < minimumKeyBits) throw new Error("small key");
  } catch {
    fail("E_SCHEDULER_DEPLOY_SECRET", `app client id or private key is invalid (RSA ${minimumKeyBits}+ PEM required)`);
  }
  return { clientId, privateKeyPem };
}

function secretIdentity({ clientId, privateKeyPem }) {
  const canonical = ["client-id", clientId, "private-key.pem", privateKeyPem, ""].join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function summarize(cronJob) {
  const pod = cronJob?.spec?.jobTemplate?.spec?.template?.spec;
  const volume = (name) => pod?.volumes?.find((item) => item.name === name);
  return {
    schedule: cronJob?.spec?.schedule,
    timeZone: cronJob?.spec?.timeZone,
    concurrencyPolicy: cronJob?.spec?.concurrencyPolicy,
    suspend: cronJob?.spec?.suspend,
    startingDeadlineSeconds: cronJob?.spec?.startingDeadlineSeconds,
    successfulJobsHistoryLimit: cronJob?.spec?.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: cronJob?.spec?.failedJobsHistoryLimit,
    backoffLimit: cronJob?.spec?.jobTemplate?.spec?.backoffLimit,
    activeDeadlineSeconds: cronJob?.spec?.jobTemplate?.spec?.activeDeadlineSeconds,
    serviceAccountName: pod?.serviceAccountName,
    image: pod?.containers?.[0]?.image,
    configMap: volume("scheduler")?.configMap?.name,
    secret: volume("dispatch-app")?.secret?.secretName,
  };
}

export async function deployDataWorkflowScheduler({
  mode, env = process.env, commandRunner = runCommand, verifyAccess = verifyAppAccess, minimumKeyBits = MINIMUM_APP_KEY_BITS,
} = {}) {
  if (!MODES.includes(mode) || typeof commandRunner !== "function") fail("E_SCHEDULER_DEPLOY_USAGE", "mode must be PREVIEW or DEPLOY");
  const contract = readSchedulerContract();
  const scriptBytes = readSchedulerScript();
  const result = (rendered, extra) => ({
    schemaVersion: "PLATFORM_DATA_WORKFLOW_SCHEDULER_DEPLOY_RESULT_V1",
    mode,
    names: rendered.names,
    image: contract.runtime.image,
    schedule: contract.cronJob.schedule,
    workflowIds: contract.workflows.map(({ id }) => id),
    excludedWorkflows: contract.excluded.map(({ workflow }) => workflow),
    secretValueSerializedCount: 0,
    ...extra,
  });
  if (mode === "PREVIEW") {
    const rendered = renderDataWorkflowScheduler({ contract, scriptBytes, secretIdentity: PREVIEW_SECRET_IDENTITY });
    return result(rendered, { kubernetesMutationCount: 0, pruned: [] });
  }

  const secrets = readSecrets(env, minimumKeyBits);
  const rendered = renderDataWorkflowScheduler({ contract, scriptBytes, secretIdentity: secretIdentity(secrets) });
  // 클러스터를 건드리기 전에 App 자격이 실제로 동작하는지 확인한다(범위를 줄인 token 발급·검증·폐기, dispatch 없음).
  try {
    await verifyAccess({ config: JSON.parse(rendered.objects.configMap.data["schedule.json"]), clientId: secrets.clientId, privateKeyPem: secrets.privateKeyPem, log: () => {} });
  } catch (error) {
    fail("E_SCHEDULER_DEPLOY_APP_ACCESS", String(error?.message ?? "app access check failed").slice(0, 300));
  }
  const redact = (text) => [secrets.clientId, secrets.privateKeyPem, ...secrets.privateKeyPem.split("\n").filter((line) => line.length >= 16)]
    .reduce((current, value) => current.split(value).join("[redacted]"), String(text));
  const kubectl = async (args, input) => {
    try {
      return await commandRunner("sudo", ["--non-interactive", "k3s", "kubectl", `--as=${DEPLOYER}`, ...args], input === undefined ? {} : { input: Buffer.from(input) });
    } catch (error) {
      return fail("E_SCHEDULER_DEPLOY_KUBECTL", redact(String(error?.message ?? "kubectl failed")).slice(0, 400));
    }
  };
  const json = (value) => JSON.stringify(value);
  let mutations = 0;

  const current = await kubectl(["get", "cronjob", rendered.names.cronJob, "--namespace", NAMESPACE, "--ignore-not-found", "-o", "json"]);
  let previous = null;
  try {
    previous = current.stdout.trim() === "" ? null : summarize(JSON.parse(current.stdout));
  } catch {
    fail("E_SCHEDULER_DEPLOY_KUBECTL", "current CronJob is not readable JSON");
  }

  const createImmutable = async (object) => {
    try {
      await kubectl(["create", "-f", "-"], json(object));
      mutations += 1;
    } catch (error) {
      // 이름이 내용 digest라 같은 이름은 같은 내용이다. 다른 실패는 그대로 드러낸다.
      if (!String(error.message).includes("AlreadyExists")) throw error;
    }
  };
  await createImmutable({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: rendered.names.secret, namespace: NAMESPACE, labels: rendered.objects.configMap.metadata.labels },
    immutable: true,
    type: "Opaque",
    stringData: { "client-id": secrets.clientId, "private-key.pem": secrets.privateKeyPem },
  });
  await createImmutable(rendered.objects.configMap);
  const applied = [rendered.objects.serviceAccount, rendered.objects.networkPolicy, rendered.objects.cronJob];
  await kubectl(["apply", "-f", "-"], json({ apiVersion: "v1", kind: "List", items: applied }));
  mutations += applied.length;

  const live = await kubectl(["get", "cronjob", rendered.names.cronJob, "--namespace", NAMESPACE, "-o", "json"]);
  let liveSummary;
  try {
    liveSummary = summarize(JSON.parse(live.stdout));
  } catch {
    fail("E_SCHEDULER_DEPLOY_READBACK", "live CronJob is not readable JSON");
  }
  const wanted = summarize(rendered.objects.cronJob);
  if (JSON.stringify(liveSummary) !== JSON.stringify(wanted)) fail("E_SCHEDULER_DEPLOY_READBACK", "live CronJob differs from the rendered CronJob");

  const pruned = [];
  for (const [kind, resource, oldName, newName] of [
    ["secret", "secret", previous?.secret, rendered.names.secret],
    ["configmap", "configmap", previous?.configMap, rendered.names.configMap],
  ]) {
    if (typeof oldName !== "string" || oldName === newName) continue;
    await kubectl(["delete", resource, oldName, "--namespace", NAMESPACE, "--ignore-not-found=true"]);
    mutations += 1;
    pruned.push(`${kind}/${oldName}`);
  }
  return result(rendered, { kubernetesMutationCount: mutations, pruned });
}

class HostCommandError extends Error {}

function runCommand(command, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => reject(new HostCommandError("host command output exceeded the limit")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new HostCommandError(`host command failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new HostCommandError("host command timed out")));
    }, timeoutMs);
    if (input) child.stdin.end(input);
  });
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--mode") fail("E_SCHEDULER_DEPLOY_USAGE", "expected exactly --mode PREVIEW|DEPLOY");
  process.stdout.write(`${JSON.stringify(await deployDataWorkflowScheduler({ mode: argv[1] }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof DeployError ? error.message : "E_SCHEDULER_DEPLOY_FAILED"}\n`);
    process.exitCode = 1;
  }
}
