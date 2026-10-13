import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertSafePruneTargets,
  planK3sCandidateConfigPrune,
  pruneK3sCandidateConfigs,
} from "./prune-k3s-candidate-configs.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;
const cliPath = join(repoRoot, "tools", "platform", "prune-k3s-candidate-configs.mjs");

// 2026-10-03 운영 클러스터 읽기 전용 실측 구조 반영:
// easysubway-journey namespace 내 journey-config-* 11개, journey-secret-* 11개, journey-candidate-* Deployment 1개(활성).
const ELEVEN_CANDIDATE_TOKENS = Object.freeze([
  { token: "a0100000000000000001", createdAt: "2026-09-23T01:00:00Z" },
  { token: "a0200000000000000002", createdAt: "2026-09-24T01:00:00Z" },
  { token: "a0300000000000000003", createdAt: "2026-09-25T01:00:00Z" },
  { token: "a0400000000000000004", createdAt: "2026-09-26T01:00:00Z" },
  { token: "a0500000000000000005", createdAt: "2026-09-27T01:00:00Z" },
  { token: "a0600000000000000006", createdAt: "2026-09-28T01:00:00Z" },
  { token: "a0700000000000000007", createdAt: "2026-09-29T01:00:00Z" },
  { token: "a0800000000000000008", createdAt: "2026-09-30T01:00:00Z" },
  { token: "a0900000000000000009", createdAt: "2026-10-01T01:00:00Z" },
  { token: "b10prev0000000000010", createdAt: "2026-10-02T11:30:00Z" },
  { token: "c11active00000000011", createdAt: "2026-10-03T14:20:00Z" },
]);

const ACTIVE_TOKEN = "c11active00000000011";
const PREVIOUS_TOKEN = "b10prev0000000000010";
const PAST_TOKENS = Object.freeze(ELEVEN_CANDIDATE_TOKENS.slice(0, 9).map((entry) => entry.token));

function buildClusterState({
  candidates = ELEVEN_CANDIDATE_TOKENS,
  activeSelector = { "easysubway.io/candidate-token": ACTIVE_TOKEN },
  deploymentTokens = [ACTIVE_TOKEN],
  extraConfigMaps = [{ metadata: { name: "kube-root-ca.crt", namespace: "easysubway-journey", creationTimestamp: "2026-09-01T00:00:00Z" } }],
  extraSecrets = [{ metadata: { name: "default-registry-cred", namespace: "easysubway-journey", creationTimestamp: "2026-09-01T00:00:00Z" } }],
} = {}) {
  const activeService = activeSelector === null
    ? null
    : {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "journey-active", namespace: "easysubway-journey" },
      spec: { selector: activeSelector },
    };
  const deployments = deploymentTokens.map((token) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: `journey-candidate-${token}`,
      namespace: "easysubway-journey",
      labels: { "easysubway.io/candidate-token": token },
    },
  }));
  const configMaps = [
    ...candidates.map(({ token, createdAt, configCreatedAt }) => ({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: `journey-config-${token}`,
        namespace: "easysubway-journey",
        ...(configCreatedAt !== undefined ? { creationTimestamp: configCreatedAt } : createdAt ? { creationTimestamp: createdAt } : {}),
      },
    })),
    ...extraConfigMaps,
  ];
  const secrets = [
    ...candidates.map(({ token, createdAt, secretCreatedAt }) => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: `journey-secret-${token}`,
        namespace: "easysubway-journey",
        ...(secretCreatedAt !== undefined ? { creationTimestamp: secretCreatedAt } : createdAt ? { creationTimestamp: createdAt } : {}),
      },
      data: { DATABASE_PASSWORD: Buffer.from(`super-secret-${token}`).toString("base64") },
    })),
    ...extraSecrets,
  ];
  return { activeService, deployments, configMaps, secrets };
}

function createFakeClusterRunner(initialState = buildClusterState()) {
  const state = structuredClone(initialState);
  const calls = [];
  const deleteCalls = [];

  const runner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("delete")) {
      deleteCalls.push({ command, args });
      const deletedTargets = args.filter((arg) => /^(configmap|secret)\//.test(arg));
      for (const target of deletedTargets) {
        const [kind, name] = target.split("/");
        if (kind === "configmap") {
          state.configMaps = state.configMaps.filter((item) => item.metadata.name !== name);
        } else if (kind === "secret") {
          state.secrets = state.secrets.filter((item) => item.metadata.name !== name);
        }
      }
      return { stdout: deletedTargets.map((item) => `${item} deleted`).join("\n") + "\n", stderr: "" };
    }
    if (args.includes("get")) {
      if (args.includes("service") && args.includes("journey-active")) {
        if (!state.activeService) {
          return { stdout: "", stderr: "" };
        }
        return { stdout: JSON.stringify(state.activeService), stderr: "" };
      }
      if (args.includes("deployments")) {
        return { stdout: JSON.stringify({ apiVersion: "v1", kind: "List", items: state.deployments }), stderr: "" };
      }
      if (args.includes("configmaps")) {
        return { stdout: JSON.stringify({ apiVersion: "v1", kind: "List", items: state.configMaps }), stderr: "" };
      }
      if (args.includes("secrets")) {
        const stdout = state.secrets
          .map((item) => `${item?.metadata?.name ?? ""}\t${item?.metadata?.creationTimestamp ?? ""}`)
          .join("\n") + "\n";
        return { stdout, stderr: "" };
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  return { state, calls, deleteCalls, runner };
}

test("11개 candidate(활성 1 + 직전 1 + 과거 9)에서 --dry-run은 활성+직전 2개만 보존하고 과거 9개만 정리 대상으로 산출하며 삭제 호출은 0건이다", async () => {
  const cluster = createFakeClusterRunner();
  const result = await pruneK3sCandidateConfigs({
    commandRunner: cluster.runner,
  });

  assert.equal(result.schemaVersion, "PLATFORM_K3S_CANDIDATE_CONFIG_PRUNE_V1");
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.namespace, "easysubway-journey");
  assert.equal(result.activeToken, ACTIVE_TOKEN);
  assert.equal(result.previousToken, PREVIOUS_TOKEN);
  assert.deepEqual(result.retained, {
    tokens: [ACTIVE_TOKEN, PREVIOUS_TOKEN],
    configMaps: [`journey-config-${ACTIVE_TOKEN}`, `journey-config-${PREVIOUS_TOKEN}`],
    secrets: [`journey-secret-${ACTIVE_TOKEN}`, `journey-secret-${PREVIOUS_TOKEN}`],
  });
  assert.deepEqual(
    result.pruneTargets.configMaps,
    PAST_TOKENS.map((token) => `journey-config-${token}`),
  );
  assert.deepEqual(
    result.pruneTargets.secrets,
    PAST_TOKENS.map((token) => `journey-secret-${token}`),
  );
  assert.equal(result.pruneTargets.configMaps.length, 9);
  assert.equal(result.pruneTargets.secrets.length, 9);
  assert.equal(result.pruneTargets.kubectlResources.length, 18);
  assert.deepEqual(result.counts, {
    totalCandidates: 11,
    retainedConfigMaps: 2,
    retainedSecrets: 2,
    pruneConfigMaps: 9,
    pruneSecrets: 9,
    deletedResources: 0,
  });
  assert.equal(cluster.deleteCalls.length, 0, "dry-run must never invoke kubectl delete");
  assert.doesNotMatch(JSON.stringify(result), /super-secret-|DATABASE_PASSWORD/u);
});

test("journey-active selector가 easysubway.io/candidate 키를 사용하는 경우에도 활성 토큰을 정상 판정한다", async () => {
  const cluster = createFakeClusterRunner(buildClusterState({
    activeSelector: { "easysubway.io/candidate": ACTIVE_TOKEN },
  }));
  const result = await pruneK3sCandidateConfigs({
    mode: "DRY_RUN",
    commandRunner: cluster.runner,
  });
  assert.equal(result.activeToken, ACTIVE_TOKEN);
  assert.equal(result.previousToken, PREVIOUS_TOKEN);
  assert.equal(cluster.deleteCalls.length, 0);
});

test("--execute를 --confirm-qa-approval 없이 호출하면 삭제 0건으로 즉시 실패한다", async () => {
  for (const invalidApproval of [undefined, null, "", "   "]) {
    const cluster = createFakeClusterRunner();
    await assert.rejects(
      pruneK3sCandidateConfigs({
        mode: "EXECUTE",
        qaApproval: invalidApproval,
        commandRunner: cluster.runner,
      }),
      /E_K3S_PRUNE_APPROVAL_REQUIRED/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
    assert.equal(cluster.calls.length, 0, "승인 누락 시 클러스터 조회조차 하지 않고 즉시 거부한다");
  }
});

test("--execute --confirm-qa-approval 호출 시 과거 9개 ConfigMap·Secret만 삭제하고 남은 개수가 각각 2개(활성+직전 1개)와 일치한다", async () => {
  const cluster = createFakeClusterRunner();
  const result = await pruneK3sCandidateConfigs({
    mode: "EXECUTE",
    qaApproval: "QA-APPROVED",
    commandRunner: cluster.runner,
  });

  assert.equal(result.mode, "EXECUTE");
  assert.equal(result.qaApproval, "QA-APPROVED");
  assert.equal(cluster.deleteCalls.length, 1);
  assert.equal(result.counts.deletedResources, 18);
  assert.equal(result.counts.remainingConfigMaps, 2);
  assert.equal(result.counts.remainingSecrets, 2);
  assert.deepEqual(result.remaining, {
    configMaps: [`journey-config-${ PREVIOUS_TOKEN }`, `journey-config-${ ACTIVE_TOKEN }`].sort(),
    secrets: [`journey-secret-${ PREVIOUS_TOKEN }`, `journey-secret-${ ACTIVE_TOKEN }`].sort(),
  });

  const remainingCandidateConfigs = cluster.state.configMaps
    .map((item) => item.metadata.name)
    .filter((name) => name.startsWith("journey-config-"));
  const remainingCandidateSecrets = cluster.state.secrets
    .map((item) => item.metadata.name)
    .filter((name) => name.startsWith("journey-secret-"));
  assert.equal(remainingCandidateConfigs.length, 2);
  assert.equal(remainingCandidateSecrets.length, 2);
  assert.ok(cluster.state.configMaps.some((item) => item.metadata.name === "kube-root-ca.crt"));
  assert.ok(cluster.state.secrets.some((item) => item.metadata.name === "default-registry-cred"));
});

test("판정 불가·모호성·대상 오염 시나리오에서는 모두 삭제 0건으로 fail-closed 된다", async () => {
  // 1) journey-active Service 누락 또는 selector 토큰 없음
  for (const activeSelector of [null, {}, { "easysubway.io/candidate-token": "" }, { "easysubway.io/candidate-token": "INVALID_UPPER" }]) {
    const cluster = createFakeClusterRunner(buildClusterState({ activeSelector }));
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_ACTIVE/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 2) journey-active selector의 두 키(candidate-token vs candidate)가 서로 충돌할 때
  {
    const cluster = createFakeClusterRunner(buildClusterState({
      activeSelector: {
        "easysubway.io/candidate-token": ACTIVE_TOKEN,
        "easysubway.io/candidate": PREVIOUS_TOKEN,
      },
    }));
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_ACTIVE_AMBIGUOUS/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 3) 활성 Deployment 토큰이 journey-active Service selector 토큰과 불일치할 때
  {
    const cluster = createFakeClusterRunner(buildClusterState({
      deploymentTokens: [PREVIOUS_TOKEN],
    }));
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_ACTIVE_DEPLOYMENT_MISMATCH/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 4) 활성 토큰의 ConfigMap 또는 Secret이 존재하지 않을 때
  {
    const missingActiveSecretState = buildClusterState();
    missingActiveSecretState.secrets = missingActiveSecretState.secrets.filter(
      (item) => item.metadata.name !== `journey-secret-${ACTIVE_TOKEN}`,
    );
    const cluster = createFakeClusterRunner(missingActiveSecretState);
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_ACTIVE_INCOMPLETE/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 5) 직전(previous) 토큰 판정 모호: 최신 비활성 2개의 creationTimestamp 동률
  {
    const tiedCandidates = ELEVEN_CANDIDATE_TOKENS.map((entry, idx) =>
      idx === 8 ? { ...entry, createdAt: "2026-10-02T11:30:00Z" } : entry,
    );
    const cluster = createFakeClusterRunner(buildClusterState({ candidates: tiedCandidates }));
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_PREVIOUS_AMBIGUOUS/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 6) 직전(previous) 토큰 판정 모호: 비활성 candidate에 creationTimestamp 누락
  {
    const missingTsCandidates = ELEVEN_CANDIDATE_TOKENS.map((entry, idx) =>
      idx === 9 ? { token: entry.token, configCreatedAt: null, secretCreatedAt: null } : entry,
    );
    const cluster = createFakeClusterRunner(buildClusterState({ candidates: missingTsCandidates }));
    await assert.rejects(
      pruneK3sCandidateConfigs({ mode: "EXECUTE", qaApproval: "QA-APPROVED", commandRunner: cluster.runner }),
      /E_K3S_PRUNE_PREVIOUS_AMBIGUOUS/u,
    );
    assert.equal(cluster.deleteCalls.length, 0);
  }

  // 7) 명시적 --previous-token의 ConfigMap/Secret 쌍이 불완전하거나 활성 토큰과 같을 때
  {
    const clusterSameAsActive = createFakeClusterRunner();
    await assert.rejects(
      pruneK3sCandidateConfigs({
        mode: "EXECUTE",
        qaApproval: "QA-APPROVED",
        previousToken: ACTIVE_TOKEN,
        commandRunner: clusterSameAsActive.runner,
      }),
      /E_K3S_PRUNE_PREVIOUS_INVALID/u,
    );
    assert.equal(clusterSameAsActive.deleteCalls.length, 0);

    const incompletePrevState = buildClusterState();
    incompletePrevState.configMaps = incompletePrevState.configMaps.filter(
      (item) => item.metadata.name !== `journey-config-${PREVIOUS_TOKEN}`,
    );
    const clusterIncompletePrev = createFakeClusterRunner(incompletePrevState);
    await assert.rejects(
      pruneK3sCandidateConfigs({
        mode: "EXECUTE",
        qaApproval: "QA-APPROVED",
        previousToken: PREVIOUS_TOKEN,
        commandRunner: clusterIncompletePrev.runner,
      }),
      /E_K3S_PRUNE_PREVIOUS_INCOMPLETE/u,
    );
    assert.equal(clusterIncompletePrev.deleteCalls.length, 0);
  }

  // 8) 정리 대상(pruneTargets)에 활성 객체·직전 객체·비정규 객체가 섞이는 변이 시 삭제 0건으로 실패
  const basePlan = planK3sCandidateConfigPrune(buildClusterState());
  for (const injectedTarget of [
    `configmap/journey-config-${ACTIVE_TOKEN}`,
    `secret/journey-secret-${ACTIVE_TOKEN}`,
    `configmap/journey-config-${PREVIOUS_TOKEN}`,
    `secret/journey-secret-${PREVIOUS_TOKEN}`,
    "configmap/kube-root-ca.crt",
    "deployment/journey-candidate-a0100000000000000001",
  ]) {
    const cluster = createFakeClusterRunner();
    const tamperedPlan = structuredClone(basePlan);
    tamperedPlan.pruneTargets.kubectlResources.push(injectedTarget);
    await assert.rejects(
      pruneK3sCandidateConfigs({
        mode: "EXECUTE",
        qaApproval: "QA-APPROVED",
        plan: tamperedPlan,
        commandRunner: cluster.runner,
      }),
      /E_K3S_PRUNE_TARGET_GUARD/u,
      injectedTarget,
    );
    assert.equal(cluster.deleteCalls.length, 0, `삭제 0건 보장 실패: ${injectedTarget}`);
    assert.throws(
      () => assertSafePruneTargets([injectedTarget], { activeToken: ACTIVE_TOKEN, previousToken: PREVIOUS_TOKEN }),
      /E_K3S_PRUNE_TARGET_GUARD/u,
    );
  }
});

test("CLI는 기본 --dry-run으로 동작하고 --execute 시 --confirm-qa-approval을 강제한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "k3s-prune-cli-"));
  try {
    const snapshotPath = join(dir, "snapshot.json");
    writeFileSync(snapshotPath, JSON.stringify(buildClusterState(), null, 2));

    const dryRun = spawnSync(process.execPath, [cliPath, "--snapshot-file", snapshotPath], { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const parsedDryRun = JSON.parse(dryRun.stdout);
    assert.equal(parsedDryRun.mode, "DRY_RUN");
    assert.equal(parsedDryRun.counts.retainedConfigMaps, 2);
    assert.equal(parsedDryRun.counts.retainedSecrets, 2);
    assert.equal(parsedDryRun.counts.pruneConfigMaps, 9);
    assert.equal(parsedDryRun.counts.pruneSecrets, 9);

    const noApproval = spawnSync(process.execPath, [cliPath, "--execute", "--snapshot-file", snapshotPath], { encoding: "utf8" });
    assert.equal(noApproval.status, 1);
    assert.match(noApproval.stderr, /E_K3S_PRUNE_APPROVAL_REQUIRED/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planK3sCandidateConfigPrune는 순수 함수로 입력 상태를 변경하지 않는다", () => {
  const state = buildClusterState();
  const cloned = structuredClone(state);
  const plan = planK3sCandidateConfigPrune(state);
  assert.deepEqual(state, cloned);
  assert.equal(plan.activeToken, ACTIVE_TOKEN);
  assert.equal(plan.previousToken, PREVIOUS_TOKEN);
  assert.equal(plan.pruneTargets.configMaps.length, 9);
  assert.equal(plan.pruneTargets.secrets.length, 9);
});

test("CI가 이 계약 테스트를 정확히 1회 실행한다", () => {
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.equal(ci.split("node --test tools/platform/prune-k3s-candidate-configs.test.mjs").length - 1, 1);
});
