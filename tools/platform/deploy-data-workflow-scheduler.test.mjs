import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { deployDataWorkflowScheduler } from "./deploy-data-workflow-scheduler.mjs";
import { readSchedulerContract, readSchedulerScript, renderDataWorkflowScheduler } from "./render-data-workflow-scheduler.mjs";

// AquilaXk/easysubway-platform#237: PREVIEW는 렌더만 하고, DEPLOY는 별도 deployer 신원으로 secret(내용 digest 이름)·ConfigMap을 만들고
// CronJob을 적용한 뒤 읽어서 대조하고 직전 객체 한 세트만 지운다. 실패는 숨기지 않는다.
const NAMESPACE = "easysubway-journey";
const DEPLOYER = "system:serviceaccount:easysubway-journey:data-scheduler-deployer";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const CLIENT_ID = "Iv23liTestClientId0001";
const env = { EASYSUBWAY_DISPATCH_APP_CLIENT_ID: CLIENT_ID, EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY: PEM };
const contract = readSchedulerContract();
const scriptBytes = readSchedulerScript();
const canonicalSecret = ["client-id", CLIENT_ID, "private-key.pem", PEM, ""].join("\n");
const secretIdentity = `sha256:${createHash("sha256").update(canonicalSecret).digest("hex")}`;
const expected = renderDataWorkflowScheduler({ contract, scriptBytes, secretIdentity });

function fakeCluster({ previous = null, createError = {}, liveOverride } = {}) {
  const calls = [];
  const commandRunner = async (command, args, { input } = {}) => {
    calls.push({ command, args, input: input === undefined ? undefined : input.toString("utf8") });
    const kubectl = args.slice(args.indexOf("kubectl") + 1);
    assert.equal(command, "sudo");
    assert.deepEqual(args.slice(0, 3), ["--non-interactive", "k3s", "kubectl"]);
    assert.equal(kubectl[0], `--as=${DEPLOYER}`);
    const [verb, ...rest] = kubectl.slice(1);
    if (verb === "get") {
      const live = calls.some((call) => call.args.includes("apply")) ? (liveOverride ?? expected.objects.cronJob) : previous;
      return { stdout: live ? JSON.stringify(live) : "", stderr: "" };
    }
    if (verb === "create") {
      const kind = JSON.parse(input).kind;
      if (createError[kind]) throw new Error(createError[kind]);
      return { stdout: "", stderr: "" };
    }
    if (verb === "apply" || verb === "delete") return { stdout: "", stderr: "" };
    assert.fail(`unexpected kubectl verb ${verb} ${rest.join(" ")}`);
    return null;
  };
  return { calls, commandRunner };
}

const previousCronJob = (secretName, configName) => {
  const cronJob = structuredClone(expected.objects.cronJob);
  const volumes = cronJob.spec.jobTemplate.spec.template.spec.volumes;
  volumes[0].configMap.name = configName;
  volumes[1].secret.secretName = secretName;
  return cronJob;
};
const accessChecks = [];
const verifyAccess = async (options) => { accessChecks.push(options); };
const deploy = (options) => deployDataWorkflowScheduler({ verifyAccess, ...options });
const verbs = (cluster) => cluster.calls.map(({ args }) => args.slice(args.indexOf("kubectl") + 2).filter((value) => !value.startsWith("--"))[0]);

test("PREVIEW는 secret도 클러스터도 없이 객체 이름만 렌더하고 0 digest를 쓴다", async () => {
  const cluster = fakeCluster();
  const result = await deployDataWorkflowScheduler({ mode: "PREVIEW", env: {}, commandRunner: cluster.commandRunner });
  assert.equal(cluster.calls.length, 0);
  assert.equal(result.mode, "PREVIEW");
  assert.equal(result.names.secret, `data-workflow-scheduler-secret-${"0".repeat(20)}`);
  assert.equal(result.names.configMap, expected.names.configMap);
  assert.equal(result.secretValueSerializedCount, 0);
  assert.equal(result.kubernetesMutationCount, 0);
});

test("DEPLOY는 secret과 ConfigMap을 만든 뒤 나머지를 apply하고 읽어서 대조한다", async () => {
  const cluster = fakeCluster();
  const result = await deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner });
  assert.deepEqual(verbs(cluster), ["get", "create", "create", "apply", "get"]);
  const [, createSecret, createConfig, apply] = cluster.calls;
  const secret = JSON.parse(createSecret.input);
  assert.deepEqual({ ...secret, stringData: Object.keys(secret.stringData) }, {
    apiVersion: "v1", kind: "Secret", metadata: { name: expected.names.secret, namespace: NAMESPACE, labels: { "app.kubernetes.io/name": "data-workflow-scheduler", "app.kubernetes.io/part-of": "easysubway" } },
    immutable: true, type: "Opaque", stringData: ["client-id", "private-key.pem"],
  });
  assert.equal(secret.stringData["client-id"], CLIENT_ID);
  assert.equal(secret.stringData["private-key.pem"], PEM);
  assert.deepEqual(JSON.parse(createConfig.input), expected.objects.configMap);
  const applied = JSON.parse(apply.input);
  assert.equal(applied.kind, "List");
  assert.deepEqual(applied.items, [expected.objects.serviceAccount, expected.objects.networkPolicy, expected.objects.cronJob]);
  assert.equal(result.names.secret, expected.names.secret);
  assert.equal(result.secretValueSerializedCount, 0);
  assert.equal(result.kubernetesMutationCount, 5);
  assert.deepEqual(result.pruned, []);
});

test("secret 값은 명령행 인자·apply 입력·결과 어디에도 나오지 않고 secret create의 stdin에만 있다", async () => {
  const cluster = fakeCluster();
  const result = await deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner });
  const keyBody = PEM.split("\n")[1];
  for (const call of cluster.calls) {
    assert.equal(call.args.join(" ").includes(keyBody), false);
    assert.equal(call.args.join(" ").includes(CLIENT_ID), false);
  }
  const holders = cluster.calls.filter(({ input }) => input?.includes(keyBody));
  assert.equal(holders.length, 1);
  assert.equal(JSON.parse(holders[0].input).kind, "Secret");
  assert.equal(JSON.stringify(result).includes(keyBody), false);
  assert.equal(JSON.stringify(result).includes(CLIENT_ID), false);
});

test("이전 CronJob이 다른 secret·ConfigMap을 쓰면 새 CronJob을 확인한 뒤 그 한 세트만 지운다", async () => {
  const oldSecret = `data-workflow-scheduler-secret-${"1".repeat(20)}`;
  const oldConfig = `data-workflow-scheduler-config-${"2".repeat(20)}`;
  const cluster = fakeCluster({ previous: previousCronJob(oldSecret, oldConfig) });
  const result = await deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner });
  assert.deepEqual(verbs(cluster), ["get", "create", "create", "apply", "get", "delete", "delete"]);
  const deletes = cluster.calls.slice(-2).map(({ args }) => args.slice(args.indexOf("kubectl") + 2));
  assert.deepEqual(deletes, [
    ["delete", "secret", oldSecret, "--namespace", NAMESPACE, "--ignore-not-found=true"],
    ["delete", "configmap", oldConfig, "--namespace", NAMESPACE, "--ignore-not-found=true"],
  ]);
  assert.deepEqual(result.pruned, [`secret/${oldSecret}`, `configmap/${oldConfig}`]);
});

test("같은 secret·ConfigMap이면 아무것도 지우지 않고 AlreadyExists는 같은 내용이라 통과한다", async () => {
  const cluster = fakeCluster({
    previous: previousCronJob(expected.names.secret, expected.names.configMap),
    createError: { Secret: 'Error from server (AlreadyExists): secrets "x" already exists', ConfigMap: 'Error from server (AlreadyExists): configmaps "x" already exists' },
  });
  const result = await deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner });
  assert.equal(verbs(cluster).includes("delete"), false);
  assert.deepEqual(result.pruned, []);
  assert.equal(result.kubernetesMutationCount, 3);
});

test("create가 AlreadyExists 말고 실패하면 apply 없이 실패한다", async () => {
  const cluster = fakeCluster({ createError: { Secret: "Error from server (Forbidden): secrets is forbidden" } });
  await assert.rejects(deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner }), /E_SCHEDULER_DEPLOY_KUBECTL/u);
  assert.equal(verbs(cluster).includes("apply"), false);
});

test("적용한 CronJob을 읽어 대조해 다르면 실패하고 이전 객체를 지우지 않는다", async () => {
  const drifted = structuredClone(expected.objects.cronJob);
  drifted.spec.suspend = true;
  const oldSecret = `data-workflow-scheduler-secret-${"1".repeat(20)}`;
  const cluster = fakeCluster({ previous: previousCronJob(oldSecret, expected.names.configMap), liveOverride: drifted });
  await assert.rejects(deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner }), /E_SCHEDULER_DEPLOY_READBACK/u);
  assert.equal(verbs(cluster).includes("delete"), false);
  const wrongImage = structuredClone(expected.objects.cronJob);
  wrongImage.spec.jobTemplate.spec.template.spec.containers[0].image = "docker.io/library/node:latest";
  await assert.rejects(deploy({ mode: "DEPLOY", env, commandRunner: fakeCluster({ liveOverride: wrongImage }).commandRunner }), /E_SCHEDULER_DEPLOY_READBACK/u);
});

test("secret이 없거나 RSA가 아니거나 PEM이 아니면 클러스터를 부르기 전에 실패한다", async () => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  for (const bad of [
    {},
    { ...env, EASYSUBWAY_DISPATCH_APP_CLIENT_ID: "" },
    { ...env, EASYSUBWAY_DISPATCH_APP_CLIENT_ID: "not valid!" },
    { ...env, EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY: "" },
    { ...env, EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY: "garbage" },
    { ...env, EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY: ec },
  ]) {
    const cluster = fakeCluster();
    await assert.rejects(deploy({ mode: "DEPLOY", env: bad, commandRunner: cluster.commandRunner }), /E_SCHEDULER_DEPLOY_SECRET/u);
    assert.equal(cluster.calls.length, 0);
  }
});

test("키 길이가 최소값에 못 미치면 클러스터를 부르기 전에 실패한다", async () => {
  const cluster = fakeCluster();
  await assert.rejects(deploy({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner, minimumKeyBits: 4096 }), /E_SCHEDULER_DEPLOY_SECRET: app client id or private key is invalid \(RSA 4096\+ PEM required\)/u);
  assert.equal(cluster.calls.length, 0);
});

test("DEPLOY는 클러스터를 건드리기 전에 App 자격을 확인하고 실패하면 아무것도 만들지 않는다", async () => {
  accessChecks.length = 0;
  const cluster = fakeCluster();
  await deployDataWorkflowScheduler({ mode: "DEPLOY", env, commandRunner: cluster.commandRunner, verifyAccess: async (options) => { accessChecks.push(options); assert.equal(cluster.calls.length, 0); } });
  assert.equal(accessChecks.length, 1);
  assert.equal(accessChecks[0].clientId, CLIENT_ID);
  assert.equal(accessChecks[0].privateKeyPem, PEM);
  assert.equal(accessChecks[0].config.target.repository, "AquilaXk/easysubway-data");
  assert.deepEqual(accessChecks[0].config.workflows.map(({ id }) => id), contract.workflows.map(({ id }) => id));
  const failing = fakeCluster();
  await assert.rejects(deployDataWorkflowScheduler({ mode: "DEPLOY", env, commandRunner: failing.commandRunner, verifyAccess: async () => { throw new Error("SCHEDULER_TOKEN_MINT_FAILED: HTTP 401 Bad credentials"); } }), /E_SCHEDULER_DEPLOY_APP_ACCESS: SCHEDULER_TOKEN_MINT_FAILED/u);
  assert.equal(failing.calls.length, 0);
  accessChecks.length = 0;
  await deployDataWorkflowScheduler({ mode: "PREVIEW", env: {}, commandRunner: fakeCluster().commandRunner, verifyAccess });
  assert.equal(accessChecks.length, 0, "PREVIEW는 GitHub를 부르지 않는다");
});

test("mode는 PREVIEW와 DEPLOY만 받는다", async () => {
  await assert.rejects(deployDataWorkflowScheduler({ mode: "APPLY", env, commandRunner: fakeCluster().commandRunner }), /E_SCHEDULER_DEPLOY_USAGE/u);
});
