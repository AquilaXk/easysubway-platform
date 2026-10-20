import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROBE_TARGETS } from "../ops/source-reachability-probe.mjs";
import { NAMESPACE, OBJECT_NAMES, POD_SELECTOR_LABELS, readProbeScript, renderSourceReachabilityProbe } from "./deploy-source-reachability-probe.mjs";

// hub easysubway#3036: 서울 k3s 도달성 측정 CronJob의 격리·최소 권한 계약. 별도 namespace, 토큰 미마운트, 고정 이름 객체 한정 RBAC, 공개 인터넷 egress 제한.
const root = new URL("../..", import.meta.url);
const text = (file) => readFileSync(new URL(file, root), "utf8");
const json = (file) => JSON.parse(text(file));
const { objects } = renderSourceReachabilityProbe({ scriptBytes: readProbeScript() });
const rbac = json("infra/k3s/source-reachability-probe-rbac.json");
const workflow = text(".github/workflows/source-reachability-probe-deploy.yml");

// 운영 서버(k3s, 읽기 전용 확인 2026-10-20): node podCIDR 10.42.0.0/24, 클러스터 pod 대역 10.42.0.0/16, `kubernetes` service clusterIP 10.43.0.1이라
// service 대역은 k3s 기본값 10.43.0.0/16이다. k3s config에 cidr 지정이 없어 기본값 그대로다. 두 대역이 egress 제외 목록에 들어 있어야 파드가 클러스터 내부로 나가지 못한다.
const K3S_POD_CIDR = "10.42.0.0/16";
const K3S_SERVICE_CIDR = "10.43.0.0/16";
const ipv4ToInt = (address) => address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
const cidrContains = (outer, inner) => {
  const [outerAddress, outerBits] = outer.split("/");
  const [innerAddress, innerBits] = inner.split("/");
  if (Number(outerBits) > Number(innerBits)) return false;
  const size = 2 ** (32 - Number(outerBits));
  return Math.floor(ipv4ToInt(innerAddress) / size) === Math.floor(ipv4ToInt(outerAddress) / size);
};
/** 쿠버네티스 matchLabels 선택: selector의 모든 label이 pod label에 같은 값으로 있어야 하고, 빈 selector는 모두 고른다. */
const selects = (selector, podLabels) => Object.entries(selector.matchLabels ?? {}).every(([key, value]) => podLabels?.[key] === value);

test("CronJob은 별도 namespace에서 토큰 없이 non-root·읽기 전용 rootfs·자원 한도로 돈다", () => {
  const { cronJob } = objects;
  assert.equal(NAMESPACE, "easysubway-probe");
  assert.equal(cronJob.metadata.namespace, NAMESPACE);
  assert.equal(cronJob.spec.concurrencyPolicy, "Forbid");
  assert.equal(cronJob.spec.suspend, false);
  const pod = cronJob.spec.jobTemplate.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(objects.serviceAccount.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } });
  const [container] = pod.containers;
  assert.deepEqual(container.securityContext, { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } });
  assert.match(container.image, /@sha256:[0-9a-f]{64}$/u);
  for (const kind of ["requests", "limits"]) for (const resource of ["cpu", "memory", "ephemeral-storage"]) assert.ok(container.resources[kind][resource], `${kind}.${resource}`);
  assert.deepEqual(pod.volumes.map(({ name }) => name), ["probe"], "secret·emptyDir·hostPath 볼륨이 없다");
  assert.equal(container.env, undefined, "환경 변수를 주지 않는다");
  assert.deepEqual(container.command, ["node", "/opt/probe/source-reachability-probe.mjs", "--vantage", "oci-seoul-k3s"]);
  assert.equal(cronJob.spec.jobTemplate.spec.activeDeadlineSeconds, 120);
  assert.equal(cronJob.spec.jobTemplate.spec.backoffLimit, 0);
});

test("측정은 10분에 한 번이고 48시간치 Job을 보존한다(호스트당 부하는 10분 1회)", () => {
  assert.equal(objects.cronJob.spec.schedule, "*/10 * * * *");
  assert.equal(objects.cronJob.spec.timeZone, "Etc/UTC");
  assert.ok(objects.cronJob.spec.successfulJobsHistoryLimit * 10 >= 48 * 60, "보존 Job이 48시간 이상이다");
});

test("ConfigMap은 저장소의 측정 스크립트 바이트 그대로다", () => {
  assert.deepEqual(Object.keys(objects.configMap.data), ["source-reachability-probe.mjs"]);
  assert.equal(objects.configMap.data["source-reachability-probe.mjs"], text("tools/ops/source-reachability-probe.mjs"));
});

test("NetworkPolicy는 ingress 전부 차단, kube-system DNS와 측정 대상 포트의 공개 인터넷만 허용한다", () => {
  const { spec } = objects.networkPolicy;
  assert.deepEqual(spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal(spec.ingress, undefined);
  assert.equal(spec.podSelector.matchLabels["app.kubernetes.io/name"], "source-reachability-probe");
  assert.deepEqual(spec.egress[0], { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] });
  assert.deepEqual(spec.egress[1].to, [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"] } }]);
  assert.deepEqual(spec.egress[1].ports, [80, 443, 8088].map((port) => ({ protocol: "TCP", port })));
  assert.deepEqual([...new Set(PROBE_TARGETS.map(({ port }) => port))].sort((a, b) => a - b), [80, 443, 8088], "허용 포트는 측정 대상 포트와 같다");
  assert.equal(spec.egress.length, 2);
});

test("파드 라벨이 허용 NetworkPolicy의 podSelector를 만족한다(라벨이 빠지거나 바뀌면 이 시험이 깨진다)", () => {
  const template = objects.cronJob.spec.jobTemplate.spec.template;
  assert.deepEqual(POD_SELECTOR_LABELS, { "app.kubernetes.io/name": "source-reachability-probe" });
  assert.equal(selects(objects.networkPolicy.spec.podSelector, template.metadata.labels), true, "허용 정책이 파드를 고른다");
  assert.deepEqual(objects.networkPolicy.spec.podSelector.matchLabels, POD_SELECTOR_LABELS);
  assert.notEqual(Object.keys(objects.networkPolicy.spec.podSelector.matchLabels ?? {}).length, 0, "허용 정책의 selector가 비어 있으면 안 된다");
  // 시험 도구 자체 점검: 라벨이 빠지거나 값이 바뀐 파드는 선택되지 않는다.
  assert.equal(selects(objects.networkPolicy.spec.podSelector, {}), false);
  assert.equal(selects(objects.networkPolicy.spec.podSelector, { "app.kubernetes.io/name": "other" }), false);
});

test("namespace 전체 default-deny가 허용 정책과 별개로 있어, 라벨이 없는 파드는 ingress·egress가 모두 막힌다(fail-closed)", () => {
  const { defaultDenyPolicy, networkPolicy } = objects;
  assert.equal(defaultDenyPolicy.kind, "NetworkPolicy");
  assert.equal(defaultDenyPolicy.metadata.namespace, NAMESPACE);
  assert.notEqual(defaultDenyPolicy.metadata.name, networkPolicy.metadata.name);
  assert.deepEqual(defaultDenyPolicy.spec, { podSelector: {}, policyTypes: ["Ingress", "Egress"] }, "규칙이 없고 selector가 비어 모든 파드를 고른다");
  assert.equal(selects(defaultDenyPolicy.spec.podSelector, {}), true, "라벨이 없는 파드도 default-deny가 고른다");
  assert.equal(selects(defaultDenyPolicy.spec.podSelector, objects.cronJob.spec.jobTemplate.spec.template.metadata.labels), true);
  assert.equal(defaultDenyPolicy.spec.ingress, undefined);
  assert.equal(defaultDenyPolicy.spec.egress, undefined);
  // 관리자 bootstrap에도 같은 객체가 들어 있어야 실제로 깔린다.
  assert.deepEqual(rbac.items.find(({ metadata }) => metadata?.name === OBJECT_NAMES.defaultDenyPolicy), defaultDenyPolicy);
});

test("egress 제외 목록은 운영 클러스터의 pod 대역과 service 대역(k3s 기본값 10.42.0.0/16, 10.43.0.0/16)을 덮는다", () => {
  const except = objects.networkPolicy.spec.egress[1].to[0].ipBlock.except;
  for (const cidr of [K3S_POD_CIDR, K3S_SERVICE_CIDR]) assert.ok(except.some((excluded) => cidrContains(excluded, cidr)), `${cidr}이 제외 목록에 덮이지 않는다`);
  assert.ok(except.includes("10.0.0.0/8"));
  // 시험 도구 자체 점검: 덮이지 않는 대역은 거짓이다.
  assert.equal(cidrContains("10.0.0.0/8", "11.0.0.0/16"), false);
  assert.equal(cidrContains("10.42.0.0/24", K3S_POD_CIDR), false);
});

test("Pod의 dnsConfig는 ndots를 1로 둔다", () => {
  assert.deepEqual(objects.cronJob.spec.jobTemplate.spec.template.spec.dnsConfig, { options: [{ name: "ndots", value: "1" }] });
});

test("관리자 bootstrap RBAC는 별도 namespace의 고정 이름 객체 한정 권한이고 만들기·secret·전역 권한이 없다", () => {
  assert.deepEqual(rbac.items.map(({ kind }) => kind), ["Namespace", "ServiceAccount", "Role", "RoleBinding", "ServiceAccount", "NetworkPolicy", "NetworkPolicy", "ConfigMap", "CronJob"]);
  const [namespace, deployer, role, binding, workloadAccount, defaultDeny, networkPolicy, configMap, cronJob] = rbac.items;
  assert.deepEqual(defaultDeny, objects.defaultDenyPolicy);
  assert.equal(namespace.metadata.name, NAMESPACE);
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  assert.deepEqual([deployer.metadata.name, deployer.metadata.namespace, deployer.automountServiceAccountToken], [OBJECT_NAMES.deployer, NAMESPACE, false]);
  assert.equal(JSON.stringify(rbac).includes("ClusterRole"), false);
  assert.equal(JSON.stringify(rbac).includes("easysubway-journey"), false);
  assert.equal(JSON.stringify(role.rules).includes("*"), false);
  assert.equal(JSON.stringify(role.rules).includes("secrets"), false);
  assert.equal(JSON.stringify(role.rules).includes('"create"'), false);
  assert.deepEqual(role.rules, [
    { apiGroups: ["batch"], resources: ["cronjobs"], resourceNames: [OBJECT_NAMES.cronJob], verbs: ["get", "update", "patch", "delete"] },
    { apiGroups: [""], resources: ["configmaps"], resourceNames: [OBJECT_NAMES.configMap], verbs: ["get", "update", "patch", "delete"] },
    { apiGroups: [""], resources: ["serviceaccounts"], resourceNames: [OBJECT_NAMES.serviceAccount], verbs: ["get", "update", "patch"] },
    { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], resourceNames: [OBJECT_NAMES.networkPolicy, OBJECT_NAMES.defaultDenyPolicy], verbs: ["get"] },
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
  ]);
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: OBJECT_NAMES.deployer, namespace: NAMESPACE }]);
  assert.deepEqual(binding.roleRef, { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role.metadata.name });
  // 관리자가 미리 만드는 객체는 렌더러가 만드는 객체와 이름·내용이 같고 CronJob은 중지된 자리표시자다.
  assert.deepEqual(workloadAccount, objects.serviceAccount);
  assert.deepEqual(networkPolicy, objects.networkPolicy);
  // 격리 경계(NetworkPolicy)는 관리자 bootstrap 전용이다: deployer는 어떤 NetworkPolicy도 바꾸거나 지울 수 없다.
  const policyRules = role.rules.filter(({ resources }) => resources.includes("networkpolicies"));
  assert.deepEqual(policyRules.flatMap(({ verbs }) => verbs), ["get"]);
  assert.deepEqual(configMap.metadata, objects.configMap.metadata);
  assert.deepEqual(configMap.data, {});
  assert.deepEqual(cronJob.metadata, objects.cronJob.metadata);
  assert.equal(cronJob.spec.suspend, true);
  assert.deepEqual(cronJob.spec.jobTemplate.spec.template.spec.containers[0].command, ["node", "--version"]);
});

test("배포 workflow는 main·소유자 dispatch·승인 환경에서만 돌고 PREVIEW만 hosted runner이며 secret을 쓰지 않는다", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      mode:\n(?:        .*\n)*?        options:\n          - PREVIEW\n          - DEPLOY\n          - COLLECT\n          - REMOVE\n/mu);
  assert.doesNotMatch(workflow, /\n  push:|\n  schedule:|\n  pull_request/u);
  assert.match(workflow, /\npermissions:\n  contents: read\n  actions: read\n/u);
  assert.match(workflow, /\n    environment: production-deploy\n/u);
  assert.match(workflow, /\n    runs-on: \$\{\{ fromJSON\(inputs\.mode != 'PREVIEW' && '\["self-hosted","Linux","ARM64","easysubway-production"\]' \|\| '\["ubuntu-latest"\]'\) \}\}\n/u);
  assert.equal(/secrets\./u.test(workflow), false, "이 workflow는 secret을 참조하지 않는다");
  assert.equal(/EASYSUBWAY_DISPATCH_APP_/u.test(workflow), false);
  assert.match(workflow, /- name: Upload the collected measurements\n        if: inputs\.mode == 'COLLECT'\n/u);
});

test("Platform CI가 측정 스크립트·계약·배포 도구 테스트를 실행한다", () => {
  const ci = text(".github/workflows/ci.yml");
  for (const file of ["tools/ops/source-reachability-probe.test.mjs", "tools/platform/source-reachability-probe-contract.test.mjs", "tools/platform/deploy-source-reachability-probe.test.mjs"]) {
    assert.ok(ci.includes(`          node --test ${file}\n`), file);
  }
});
