import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { k3sCandidateInputFixture } from "./k3s-candidate-input-fixture.mjs";
import { PRODUCTION_DB_COMPOSE_BACKEND_SERVICES } from "./run-k3s-journey-activation.mjs";

// Issue #221: K3s 활성화는 compose backend를 drain하고 트래픽을 journey-active Service로 옮긴다.
// Prometheus backend 수집 대상은 그 활성 Service를 따라가야 하며, drain되는 compose DNS를 가리키면 안 된다.
const root = new URL("../..", import.meta.url);
const renderer = new URL("tools/platform/render-journey-kubernetes-candidate.mjs", root);
const digest = (character) => `sha256:${character.repeat(64)}`;

function readText(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function observabilityContract() {
  return readJson("contracts/release/platform-k3s-observability-contract.json");
}

// prometheus.yml의 scrape_configs에서 job별 static target 문자열을 뽑는다(YAML 의존성 없이 고정 형식만 해석).
function scrapeTargetsByJob(text) {
  const jobs = new Map();
  let current;
  let inTargets = false;
  for (const line of text.split("\n")) {
    const job = line.match(/^  - job_name: "([^"]+)"\s*$/);
    if (job) {
      current = job[1];
      jobs.set(current, []);
      inTargets = false;
      continue;
    }
    if (!current) continue;
    if (/^\s+- targets:\s*$/.test(line)) {
      inTargets = true;
      continue;
    }
    const inline = line.match(/^\s+- targets: \[(.*)\]\s*$/);
    if (inline) {
      jobs.get(current).push(...inline[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")));
      inTargets = false;
      continue;
    }
    const item = line.match(/^\s+- "([^"]+)"\s*$/);
    if (inTargets && item) {
      jobs.get(current).push(item[1]);
      continue;
    }
    if (inTargets && line.trim() !== "") inTargets = false;
  }
  return jobs;
}

function targetHost(target) {
  const withoutScheme = target.replace(/^[a-z]+:\/\//, "");
  return withoutScheme.split("/")[0].split(":")[0];
}

function validInput() {
  return k3sCandidateInputFixture();
}

function render() {
  const temporary = mkdtempSync(join(tmpdir(), "platform-k3s-observability-"));
  const input = join(temporary, "input.json");
  try {
    writeFileSync(input, `${JSON.stringify(validInput())}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, [renderer.pathname, "--input", input], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("observability contract pins the compose network subnet and the active Service ClusterIP", () => {
  const contract = observabilityContract();
  assert.equal(contract.schemaVersion, "PLATFORM_K3S_OBSERVABILITY_CONTRACT_V1");
  assert.equal(contract.artifactKind, "platform-k3s-observability-contract");
  assert.equal(contract.issueRef.repository, "AquilaXk/easysubway-platform");
  assert.equal(contract.issueRef.issueNumber, 221);
  assert.match(contract.composeNetwork.name, /^[a-z0-9][a-z0-9_-]*_default$/);
  assert.match(contract.composeNetwork.subnet, /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[1-9]|[12]\d|3[0-2])$/);
  assert.equal(contract.activeService.name, "journey-active");
  assert.equal(contract.activeService.namespace, "easysubway-journey");
  assert.match(contract.activeService.clusterIP, /^(?:\d{1,3}\.){3}\d{1,3}$/);
  assert.equal(contract.activeService.port, 8080);
});

test("rendered active Service pins the contract ClusterIP and NetworkPolicy admits only the compose subnet on 8080", () => {
  const contract = observabilityContract();
  const rendered = render();
  const active = rendered.activationPlan.activeServiceTemplate;
  assert.equal(active.metadata.name, contract.activeService.name);
  assert.equal(active.metadata.namespace, contract.activeService.namespace);
  assert.equal(active.spec.clusterIP, contract.activeService.clusterIP);
  assert.equal(active.spec.ports[0].port, contract.activeService.port);

  // 보안 경계(F1): ingress 출처는 정확히 [namespace, 노드 /32, 계약 subnet]이고 포트는 TCP 8080 하나뿐이다.
  // egress는 Issue #221 이전 규칙과 정확히 같아야 한다(관측 경로 추가가 egress를 넓히지 않는다).
  const policy = rendered.candidateObjects.find(({ kind }) => kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress, [{
    from: [
      { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "easysubway-journey" } } },
      { ipBlock: { cidr: `${validInput().nodeInternalIp}/32` } },
      { ipBlock: { cidr: contract.composeNetwork.subnet } },
    ],
    ports: [{ protocol: "TCP", port: 8080 }],
  }]);
  assert.ok(policy.spec.ingress.every((rule) =>
    JSON.stringify(rule.ports) === JSON.stringify([{ protocol: "TCP", port: 8080 }])));
  assert.deepEqual(policy.spec.egress, [
    {
      to: [{ ipBlock: { cidr: `${validInput().nodeInternalIp}/32` } }],
      ports: [{ protocol: "TCP", port: 15432 }, { protocol: "TCP", port: 9000 }],
    },
    {
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
      ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
    },
    {
      to: [{
        ipBlock: {
          cidr: "0.0.0.0/0",
          except: ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"],
        },
      }],
      ports: [{ protocol: "TCP", port: 443 }, { protocol: "TCP", port: 80 }],
    },
  ]);
});

test("Prometheus backend probe and app metrics scrape target the rendered active Service", () => {
  const contract = observabilityContract();
  const active = render().activationPlan.activeServiceTemplate;
  const address = `${active.spec.clusterIP}:${active.spec.ports[0].port}`;
  const jobs = scrapeTargetsByJob(readText("infra/prometheus/prometheus.yml"));

  assert.deepEqual(jobs.get("easysubway-backend"), [`http://${address}/actuator/health/readiness`]);
  assert.deepEqual(jobs.get("backend_app_metrics"), [address]);
  assert.equal(contract.activeService.clusterIP, active.spec.clusterIP);
});

test("no Prometheus scrape target points at a compose backend that K3s activation drains", () => {
  const jobs = scrapeTargetsByJob(readText("infra/prometheus/prometheus.yml"));
  assert.ok(jobs.size > 0);
  const drained = new Set(PRODUCTION_DB_COMPOSE_BACKEND_SERVICES);
  for (const [job, targets] of jobs) {
    for (const target of targets) {
      assert.equal(drained.has(targetHost(target)), false, `${job} targets drained compose service ${target}`);
    }
  }
});

test("backend scrape down alerts still fire and no longer describe the drained compose backend", () => {
  const alerts = readText("infra/prometheus/alerts.yml");
  const alertTests = readText("infra/prometheus/alerts.test.yml");
  assert.match(alerts, /expr: min\(up\{job="backend_app_metrics"\}\) < 1/);
  assert.doesNotMatch(alerts, /backend:8080/);
  assert.doesNotMatch(alertTests, /backend:8080/);
  assert.match(alertTests, /name: backend app metrics scrape down fires dead-mans switch/);
  // F4: probe 경로 실패는 dead-man 경보와 별개의 probe_success 경보로 드러난다.
  assert.match(alerts, /- alert: AquilaBackendReadinessProbeFailed\n\s+expr: min\(probe_success\{job="easysubway-backend"\}\) < 1\n\s+for: 5m/);
  assert.match(alertTests, /alertname: AquilaBackendReadinessProbeFailed\n\s+exp_alerts:\n\s+- exp_labels:/);
});

test("CI runs this contract exactly once", () => {
  const ci = readText(".github/workflows/ci.yml");
  assert.equal(ci.split("node --test tools/platform/prometheus-k3s-backend-target.test.mjs").length - 1, 1);
});
