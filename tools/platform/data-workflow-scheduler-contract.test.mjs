import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { MAX_DISPATCH_MINUTE, dueEntries, validateScheduleConfig } from "../ops/data-workflow-scheduler.mjs";
import { renderDataWorkflowScheduler } from "./render-data-workflow-scheduler.mjs";

// AquilaXk/easysubway-platform#237: data 레포 정기 workflow를 깨우는 OCI k3s CronJob 스케줄러의 계약.
const root = new URL("../..", import.meta.url);
const text = (path) => readFileSync(new URL(path, root), "utf8");
const json = (path) => JSON.parse(text(path));
const contract = json("contracts/release/platform-data-workflow-scheduler-contract.json");
const scriptBytes = readFileSync(new URL("tools/ops/data-workflow-scheduler.mjs", root));
const identity = (character) => `sha256:${character.repeat(64)}`;
const render = (overrides = {}) => renderDataWorkflowScheduler({ contract, scriptBytes, secretIdentity: identity("a"), ...overrides });
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("계약은 닫힌 형식이고 data 레포 main에 actions:write만 쓴다", () => {
  assert.deepEqual(Object.keys(contract), ["schemaVersion", "artifactKind", "issueRef", "target", "app", "cronJob", "runtime", "deployer", "workflows", "excluded", "failureVisibility", "postDeployVerification"]);
  assert.equal(contract.schemaVersion, "PLATFORM_DATA_WORKFLOW_SCHEDULER_CONTRACT_V1");
  assert.deepEqual(contract.target, { repository: "AquilaXk/easysubway-data", ref: "main", permissions: { actions: "write" }, githubScheduleRole: "BACKUP_PATH", tokenMaxLifetimeMinutes: 60 });
  assert.deepEqual(contract.app.secretReferences, ["EASYSUBWAY_DISPATCH_APP_CLIENT_ID", "EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY"]);
  assert.equal(contract.app.secretScope, "ENVIRONMENT:production-deploy");
});

test("CronJob은 매시 0분 UTC에 한 번, 겹치지 않고, 시간·이력 한도를 가진다", () => {
  assert.deepEqual(contract.cronJob, {
    name: "data-workflow-scheduler",
    namespace: "easysubway-journey",
    schedule: "0 * * * *",
    timeZone: "Etc/UTC",
    concurrencyPolicy: "Forbid",
    startingDeadlineSeconds: 600,
    activeDeadlineSeconds: 3300,
    backoffLimit: 0,
    successfulJobsHistoryLimit: 1,
    failedJobsHistoryLimit: 3,
  });
  // 마지막 dispatch 분 + 여유가 activeDeadlineSeconds 안에 들어가야 Job이 도중에 끊기지 않는다.
  const latest = Math.max(...contract.workflows.map(({ minute }) => minute));
  assert.ok(latest <= MAX_DISPATCH_MINUTE);
  assert.ok(latest * 60 + 300 < contract.cronJob.activeDeadlineSeconds);
});

test("이미지는 digest로 고정한 최소 node 이미지이고 리소스 한도가 있다", () => {
  assert.match(contract.runtime.image, /^docker\.io\/library\/node:24\.19\.0-alpine[0-9.]+@sha256:[a-f0-9]{64}$/u);
  assert.equal(text(".nvmrc").trim(), "24.19.0", "node 이미지 버전은 레포의 node 핀과 같다");
  assert.deepEqual(Object.keys(contract.runtime.resources.requests).sort(), ["cpu", "ephemeral-storage", "memory"]);
  assert.deepEqual(Object.keys(contract.runtime.resources.limits).sort(), ["cpu", "ephemeral-storage", "memory"]);
});

test("대상 workflow는 기존 정기 cron의 주기·분을 그대로 옮기고 제외 workflow와 겹치지 않는다", () => {
  const cronOf = ({ everyHours, offsetHour, minute }) => {
    const hours = everyHours === 24 ? String(offsetHour) : everyHours === 1 ? "*" : offsetHour === 0 ? `*/${everyHours}` : `${offsetHour}/${everyHours}`;
    return `${minute} ${hours} * * *`;
  };
  for (const entry of contract.workflows) assert.equal(entry.githubCron, cronOf(entry), entry.id);
  assert.equal(new Set(contract.workflows.map(({ id }) => id)).size, contract.workflows.length);
  const excluded = contract.excluded.map(({ workflow }) => workflow);
  assert.deepEqual(excluded, ["datapack-release.yml", "osv-scheduled.yml"]);
  for (const { workflow } of contract.workflows) assert.equal(excluded.includes(workflow), false);
  for (const { reason } of contract.excluded) assert.ok(reason.length > 20);
  assert.deepEqual(
    contract.workflows.map(({ minute, id }) => [minute, id]),
    contract.workflows.map(({ minute, id }) => [minute, id]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)),
    "분 순서(같으면 id 순서)로 적는다",
  );
  const config = JSON.parse(render().objects.configMap.data["schedule.json"]);
  validateScheduleConfig(config);
});

test("전국 후보 갱신은 data workflow의 정기 cron(29 */2 * * *)과 같은 주기·분으로 깨운다(#240)", () => {
  const entry = contract.workflows.find(({ workflow }) => workflow === "nationwide-candidate-refresh.yml");
  assert.deepEqual(entry, { id: "nationwide-candidate-refresh", workflow: "nationwide-candidate-refresh.yml", everyHours: 2, offsetHour: 0, minute: 29, githubCron: "29 */2 * * *" });
  assert.equal(entry.inputs, undefined, "정기 역할은 입력 없는 dispatch로만 인정된다. 2인 역할 입력을 보내면 사람 dispatch 경로가 된다");
  assert.equal(contract.excluded.some(({ workflow }) => workflow === "nationwide-candidate-refresh.yml"), false);
});

test("정기 대상은 하루 동안 원래 주기대로 때가 된다", () => {
  const counts = new Map();
  for (let hour = 0; hour < 24; hour += 1) {
    for (const { id } of dueEntries(contract.workflows, new Date(Date.UTC(2026, 9, 7, hour)))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  assert.equal(counts.get("source-reverification"), 12);
  assert.equal(counts.get("kric-current-facility-refresh"), 12);
  assert.equal(counts.get("datapack-expiry-alert-datapack-expiry"), 6);
  assert.equal(counts.get("source-derivative-rebinding"), 4);
  // #240: data#1035가 스케줄러 App의 입력 없는 dispatch를 정기 역할로 인정한 뒤 후보 갱신도 원래 2시간 주기로 깨운다.
  assert.equal(counts.get("nationwide-candidate-refresh"), 12);
  assert.equal(counts.get("datapack-expiry-alert-provider-approval"), 1);
  assert.equal(counts.get("itx-current-promotion"), 1);
  assert.deepEqual(dueEntries(contract.workflows, new Date(Date.UTC(2026, 9, 7, 18))).map(({ id }) => id).slice(0, 1), ["itx-current-promotion"]);
  assert.deepEqual(dueEntries(contract.workflows, new Date(Date.UTC(2026, 9, 7, 1))), []);
});

test("렌더는 결정적이고 이름이 내용 digest에서 나오며 secret 값을 담지 않는다", () => {
  const first = render();
  const second = render();
  assert.deepEqual(first, second);
  assert.match(first.names.configMap, /^data-workflow-scheduler-config-[0-9a-f]{20}$/u);
  assert.match(first.names.secret, /^data-workflow-scheduler-secret-[0-9a-f]{20}$/u);
  assert.equal(first.names.secret, `data-workflow-scheduler-secret-${"a".repeat(20)}`);
  assert.equal(render({ secretIdentity: identity("b") }).names.secret, `data-workflow-scheduler-secret-${"b".repeat(20)}`);
  assert.equal(render({ secretIdentity: identity("b") }).names.configMap, first.names.configMap);
  assert.notEqual(render({ scriptBytes: Buffer.concat([scriptBytes, Buffer.from("\n")]) }).names.configMap, first.names.configMap);
  assert.deepEqual(first.secretPlan, { name: first.names.secret, namespace: "easysubway-journey", keys: ["client-id", "private-key.pem"], immutable: true, identity: identity("a") });
  assert.equal(JSON.stringify(first).includes("BEGIN"), false);
  assert.throws(() => render({ secretIdentity: "sha256:short" }), /E_SCHEDULER_RENDER_INPUT/u);
  assert.throws(() => render({ scriptBytes: "string" }), /E_SCHEDULER_RENDER_INPUT/u);
});

test("ConfigMap은 immutable이고 스크립트와 일정만 담는다", () => {
  const { objects, names } = render();
  const configMap = objects.configMap;
  assert.equal(configMap.kind, "ConfigMap");
  assert.equal(configMap.immutable, true);
  assert.deepEqual(configMap.metadata, { name: names.configMap, namespace: "easysubway-journey", labels: { "app.kubernetes.io/name": "data-workflow-scheduler", "app.kubernetes.io/part-of": "easysubway" } });
  assert.deepEqual(Object.keys(configMap.data), ["scheduler.mjs", "schedule.json"]);
  assert.equal(configMap.data["scheduler.mjs"], scriptBytes.toString("utf8"));
  const expectedDigest = sha(`${scriptBytes.toString("utf8")}\n---\n${configMap.data["schedule.json"]}`).slice(0, 20);
  assert.equal(names.configMap, `data-workflow-scheduler-config-${expectedDigest}`);
});

test("CronJob은 비루트·읽기 전용 루트·capability 제거·토큰 미마운트로 이 Job에만 key를 마운트한다", () => {
  const { objects, names } = render();
  const cronJob = objects.cronJob;
  assert.equal(cronJob.apiVersion, "batch/v1");
  assert.equal(cronJob.kind, "CronJob");
  assert.equal(cronJob.metadata.name, "data-workflow-scheduler");
  const { spec } = cronJob;
  assert.equal(spec.schedule, "0 * * * *");
  assert.equal(spec.timeZone, "Etc/UTC");
  assert.equal(spec.concurrencyPolicy, "Forbid");
  assert.equal(spec.startingDeadlineSeconds, 600);
  assert.equal(spec.successfulJobsHistoryLimit, 1);
  assert.equal(spec.failedJobsHistoryLimit, 3);
  assert.equal(spec.suspend, false);
  assert.equal(spec.jobTemplate.spec.backoffLimit, 0);
  assert.equal(spec.jobTemplate.spec.activeDeadlineSeconds, 3300);
  const pod = spec.jobTemplate.spec.template.spec;
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.serviceAccountName, "data-workflow-scheduler");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.deepEqual(pod.nodeSelector, { "kubernetes.io/arch": "arm64" });
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } });
  assert.equal(pod.containers.length, 1);
  const [container] = pod.containers;
  assert.equal(container.image, contract.runtime.image);
  assert.equal(container.imagePullPolicy, "IfNotPresent");
  assert.deepEqual(container.command, ["node", "/opt/scheduler/scheduler.mjs"]);
  assert.deepEqual(container.securityContext, { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  assert.deepEqual(container.resources, contract.runtime.resources);
  assert.deepEqual(container.env, [
    { name: "SCHEDULER_CONFIG", value: "/opt/scheduler/schedule.json" },
    { name: "SCHEDULER_SECRET_DIR", value: "/run/secrets/data-dispatch" },
  ]);
  assert.equal(container.envFrom, undefined, "key는 환경 변수로 주입하지 않고 파일로만 읽는다");
  assert.deepEqual(container.volumeMounts, [
    { name: "scheduler", mountPath: "/opt/scheduler", readOnly: true },
    { name: "dispatch-app", mountPath: "/run/secrets/data-dispatch", readOnly: true },
    { name: "tmp", mountPath: "/tmp" },
  ]);
  assert.deepEqual(pod.volumes, [
    { name: "scheduler", configMap: { name: names.configMap, defaultMode: 0o444 } },
    { name: "dispatch-app", secret: { secretName: names.secret, defaultMode: 0o440, items: [{ key: "client-id", path: "client-id" }, { key: "private-key.pem", path: "private-key.pem" }] } },
    { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
  ]);
});

test("ServiceAccount는 권한이 없고 NetworkPolicy는 ingress 전부 차단, DNS와 공개 443만 허용한다", () => {
  const { objects } = render();
  assert.deepEqual(objects.serviceAccount, {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: { name: "data-workflow-scheduler", namespace: "easysubway-journey", labels: { "app.kubernetes.io/name": "data-workflow-scheduler", "app.kubernetes.io/part-of": "easysubway" } },
    automountServiceAccountToken: false,
  });
  const policy = objects.networkPolicy;
  assert.equal(policy.spec.podSelector.matchLabels["app.kubernetes.io/name"], "data-workflow-scheduler");
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal(policy.spec.ingress, undefined, "ingress 규칙이 없으면 모두 차단이다");
  assert.deepEqual(policy.spec.egress, [
    { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
    { to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"] } }], ports: [{ protocol: "TCP", port: 443 }] },
  ]);
  const podLabels = objects.cronJob.spec.jobTemplate.spec.template.metadata.labels;
  assert.equal(podLabels["app.kubernetes.io/name"], "data-workflow-scheduler");
});

test("CLI는 계약과 스크립트를 읽어 같은 렌더를 JSON으로 출력한다", () => {
  const result = spawnSync(process.execPath, ["tools/platform/render-data-workflow-scheduler.mjs", "--secret-identity", identity("c")], { cwd: new URL(".", root), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(render({ secretIdentity: identity("c") }))));
  const bad = spawnSync(process.execPath, ["tools/platform/render-data-workflow-scheduler.mjs"], { cwd: new URL(".", root), encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
});

test("배포 RBAC는 이 namespace의 별도 신원이고 전역 권한·와일드카드가 없으며 create는 secret·ConfigMap에만 있다", () => {
  const rbac = json("infra/k3s/data-workflow-scheduler-rbac.json");
  assert.deepEqual(rbac.items.map(({ kind }) => kind), ["ServiceAccount", "Role", "RoleBinding", "ServiceAccount", "NetworkPolicy", "CronJob"]);
  const [account, role, binding, workloadAccount, networkPolicy, cronJob] = rbac.items;
  assert.deepEqual([account.metadata.name, account.metadata.namespace, account.automountServiceAccountToken], ["data-scheduler-deployer", "easysubway-journey", false]);
  assert.equal(contract.deployer.serviceAccount, account.metadata.name);
  assert.equal(contract.deployer.bootstrap, "ADMIN_APPLIED_FIXED_NAME_OBJECTS");
  assert.equal(role.metadata.namespace, "easysubway-journey");
  assert.equal(JSON.stringify(role.rules).includes("*"), false);
  assert.equal(JSON.stringify(role.rules).includes("nodes"), false);
  assert.equal(JSON.stringify(rbac).includes("ClusterRole"), false);
  // 규칙 전체를 고정한다: 이 밖의 자원·verb는 없다.
  assert.deepEqual(role.rules, [
    { apiGroups: ["batch"], resources: ["cronjobs"], resourceNames: ["data-workflow-scheduler"], verbs: ["get", "update", "patch"] },
    { apiGroups: [""], resources: ["serviceaccounts"], resourceNames: ["data-workflow-scheduler"], verbs: ["get", "update", "patch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], resourceNames: ["data-workflow-scheduler-boundary"], verbs: ["get", "update", "patch"] },
    { apiGroups: [""], resources: ["configmaps"], verbs: ["create"] },
    { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
  ]);
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "data-scheduler-deployer", namespace: "easysubway-journey" }]);
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name });
  // 관리자가 미리 만드는 고정 이름 객체는 렌더러가 만드는 객체와 같고(ServiceAccount·NetworkPolicy), CronJob은 중지된 자리표시자다.
  const { objects } = render();
  assert.deepEqual(workloadAccount, objects.serviceAccount);
  assert.deepEqual(networkPolicy, objects.networkPolicy);
  assert.equal(cronJob.metadata.name, objects.cronJob.metadata.name);
  assert.equal(cronJob.spec.suspend, true);
  assert.equal(cronJob.spec.jobTemplate.spec.template.spec.containers[0].image, contract.runtime.image);
  assert.deepEqual(cronJob.spec.jobTemplate.spec.template.spec.containers[0].command, ["node", "--version"]);
  // hub 번들에 핀된 journey-deployer 계약과 RBAC는 건드리지 않는다.
  assert.equal(JSON.stringify(json("infra/k3s/deployer-rbac.json")).includes("batch"), false);
});

test("App 시크릿은 production-deploy 환경 범위에서만 읽고 환경 밖 job·다른 workflow는 참조하지 않는다", () => {
  const directory = new URL(".github/workflows/", root);
  const offenders = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const yml = readFileSync(new URL(file, directory), "utf8");
    if (!/EASYSUBWAY_DISPATCH_APP_/u.test(yml)) continue;
    // job 블록 단위로 본다: 2칸 들여쓰기 job 이름으로 나눈다.
    const jobsIndex = yml.indexOf("\njobs:\n");
    const jobs = yml.slice(jobsIndex).split(/\n  (?=[A-Za-z0-9_-]+:\n)/u).slice(1);
    for (const job of jobs) {
      if (/EASYSUBWAY_DISPATCH_APP_/u.test(job) && !/\n    environment: production-deploy\n/u.test(job)) offenders.push(`${file}: ${job.split("\n")[0]}`);
    }
    if (file !== "data-workflow-scheduler-deploy.yml") offenders.push(`${file}: unexpected reference`);
  }
  assert.deepEqual(offenders, []);
  assert.equal(contract.app.secretScope, "ENVIRONMENT:production-deploy");
});

test("배포 후 확인 절차에 NetworkPolicy 실제 적용 시험(차단 대상 접속)이 있다", () => {
  assert.deepEqual(contract.postDeployVerification.map(({ id }) => id), [
    "NETWORK_POLICY_ENFORCED_PUBLIC_HTTP_BLOCKED",
    "NETWORK_POLICY_NODE_SERVICES_BLOCKED",
    "NETWORK_POLICY_GITHUB_API_ALLOWED",
    "NETWORK_POLICY_LIMIT_ANY_PUBLIC_443",
  ]);
  for (const { description } of contract.postDeployVerification) assert.ok(description.length > 20);
});

test("배포 workflow는 main·승인 환경에서만, DEPLOY만 self-hosted runner에서 돌고 secret은 DEPLOY 단계 env로만 받는다", () => {
  const workflow = text(".github/workflows/data-workflow-scheduler-deploy.yml");
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n(?:        .*\n)*?        options:\n          - PREVIEW\n          - DEPLOY\n/mu);
  assert.doesNotMatch(workflow, /\n  push:|\n  schedule:|\n  pull_request/u);
  assert.match(workflow, /\npermissions:\n  contents: read\n  actions: read\n/u);
  assert.match(workflow, /\n    concurrency:\n      group: data-workflow-scheduler-production\n      cancel-in-progress: false\n/u);
  assert.match(workflow, /\n    if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1 && github\.triggering_actor == 'AquilaXk'\n/u);
  assert.match(workflow, /\n    environment: production-deploy\n/u);
  assert.match(workflow, /\n    runs-on: \$\{\{ fromJSON\(inputs\.mode == 'DEPLOY' && '\["self-hosted","Linux","ARM64","easysubway-production"\]' \|\| '\["ubuntu-latest"\]'\) \}\}\n/u);
  assert.match(workflow, /EASYSUBWAY_DISPATCH_APP_CLIENT_ID: \$\{\{ inputs\.mode == 'DEPLOY' && secrets\.EASYSUBWAY_DISPATCH_APP_CLIENT_ID \|\| '' \}\}/u);
  assert.match(workflow, /EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY: \$\{\{ inputs\.mode == 'DEPLOY' && secrets\.EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY \|\| '' \}\}/u);
  assert.equal((workflow.match(/secrets\.EASYSUBWAY_DISPATCH_APP/gu) ?? []).length, 2);
  assert.ok(workflow.indexOf("verify-production-deploy-effective-admission-receipt.mjs") < workflow.indexOf("deploy-data-workflow-scheduler.mjs"));
  assert.match(workflow, /node tools\/platform\/deploy-data-workflow-scheduler\.mjs --mode "\$\{MODE\}"/u);
  assert.doesNotMatch(workflow, /docker |kubectl|\$\{\{ inputs\.mode \}\}[^\n]*run:/u);
  for (const [, ref] of workflow.matchAll(/uses: [^@\s]+@(\S+)/gu)) assert.match(ref, /^[a-f0-9]{40}$/u);
  const scriptBlocks = workflow.split("\n        run: ").slice(1);
  for (const block of scriptBlocks) assert.doesNotMatch(block.split("\n      - ")[0], /\$\{\{/u, "run 스크립트에 표현식을 직접 넣지 않는다");
});

test("CI가 새 테스트를 실행한다", () => {
  const ci = text(".github/workflows/ci.yml");
  for (const file of ["tools/ops/data-workflow-scheduler.test.mjs", "tools/platform/data-workflow-scheduler-contract.test.mjs", "tools/platform/deploy-data-workflow-scheduler.test.mjs"]) {
    assert.match(ci, new RegExp(`node --test ${file.replaceAll(".", "\\.")}\\n`, "u"), file);
  }
});
