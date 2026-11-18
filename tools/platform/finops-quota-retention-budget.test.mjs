import assert from "node:assert/strict";
import test from "node:test";

import {
  FINOPS_QUOTA_RETENTION_POLICY,
  FinopsBudgetError,
  classifyRetentionCandidatesDryRun,
  evaluateFinopsAndQuotaStatus,
  validateFinopsQuotaRetentionPolicy,
} from "./finops-quota-retention-budget.mjs";

function buildNormalEvaluationInput() {
  return {
    monthlyJourneyCount: 500_000,
    monthlyFixedCostKrw: 45_000,
    monthlyVariableCostKrw: 15_000,
    providerUsage: {
      "data-go-kr-subway": { hourlyCallsUsed: 200, dailyCallsUsed: 3_000 },
      "kric-rail-portal": { hourlyCallsUsed: 150, dailyCallsUsed: 2_000 },
      "seoul-topis-realtime": { hourlyCallsUsed: 500, dailyCallsUsed: 8_000 },
    },
    storageUsageGiB: {
      "oci-object-storage": 12,
      "postgresql-operational-db": 6,
      "prometheus-tsdb": 1.5,
      "container-and-audit-logs": 3,
    },
  };
}

test("FINOPS_QUOTA_RETENTION_POLICY는 여정 단가·제공자 쿼터(70/85/95%)·스토리지 보존 정책을 불변 객체로 정의한다", () => {
  const validation = validateFinopsQuotaRetentionPolicy(FINOPS_QUOTA_RETENTION_POLICY);
  assert.equal(validation.valid, true);
  assert.equal(Object.isFrozen(FINOPS_QUOTA_RETENTION_POLICY), true);
  assert.deepEqual(validation.storageClasses, [
    "container-and-audit-logs",
    "oci-object-storage",
    "postgresql-operational-db",
    "prometheus-tsdb",
  ]);

  for (const provider of Object.values(FINOPS_QUOTA_RETENTION_POLICY.providerQuotaBudgets)) {
    assert.equal(provider.warningRatio, 0.7);
    assert.equal(provider.criticalRatio, 0.85);
    assert.equal(provider.hardStopRatio, 0.95);
  }
});

test("validateFinopsQuotaRetentionPolicy는 역전된 임계치나 잘못된 보존 기간을 Fail-Closed로 거부한다", () => {
  const broken = structuredClone(FINOPS_QUOTA_RETENTION_POLICY);
  broken.storageAndLogRetentionBudgets["prometheus-tsdb"].minRetentionDays = 40;
  broken.storageAndLogRetentionBudgets["prometheus-tsdb"].maxRetentionDays = 30;

  assert.throws(
    () => validateFinopsQuotaRetentionPolicy(broken),
    (error) => error instanceof FinopsBudgetError && error.code === "E_FINOPS_POLICY_INVALID",
  );
});

test("evaluateFinopsAndQuotaStatus는 1,000여정당 비용과 쿼터·스토리지 소진율을 정밀 계산하고 임계치별 조치를 반환한다", () => {
  const normal = evaluateFinopsAndQuotaStatus(buildNormalEvaluationInput());
  assert.equal(normal.costPerThousandJourneysKrw, 120);
  assert.equal(normal.recommendedAction, "ALLOW_NORMAL");

  const warningInput = buildNormalEvaluationInput();
  warningInput.providerUsage["data-go-kr-subway"] = {
    hourlyCallsUsed: 720,
    dailyCallsUsed: 5_000,
  };
  const warningStatus = evaluateFinopsAndQuotaStatus(warningInput);
  assert.equal(warningStatus.providerStatuses["data-go-kr-subway"].action, "THROTTLE_BACKGROUND_REFRESH");
  assert.equal(warningStatus.recommendedAction, "THROTTLE_BACKGROUND_REFRESH");

  const criticalInput = buildNormalEvaluationInput();
  criticalInput.providerUsage["seoul-topis-realtime"] = {
    hourlyCallsUsed: 1_750,
    dailyCallsUsed: 15_000,
  };
  const criticalStatus = evaluateFinopsAndQuotaStatus(criticalInput);
  assert.equal(criticalStatus.providerStatuses["seoul-topis-realtime"].action, "BLOCK_NON_CRITICAL");
  assert.equal(criticalStatus.recommendedAction, "BLOCK_NON_CRITICAL");

  const hardStopInput = buildNormalEvaluationInput();
  hardStopInput.providerUsage["kric-rail-portal"] = {
    hourlyCallsUsed: 960,
    dailyCallsUsed: 9_600,
  };
  const hardStopStatus = evaluateFinopsAndQuotaStatus(hardStopInput);
  assert.equal(hardStopStatus.providerStatuses["kric-rail-portal"].action, "FAIL_CLOSED_QUOTA_EXCEEDED");
  assert.equal(hardStopStatus.recommendedAction, "FAIL_CLOSED_QUOTA_EXCEEDED");
});

test("evaluateFinopsAndQuotaStatus는 음수·누락·미등록 제공자 입력을 Fail-Closed로 거부한다", () => {
  const badInput = buildNormalEvaluationInput();
  badInput.monthlyJourneyCount = 0;
  assert.throws(
    () => evaluateFinopsAndQuotaStatus(badInput),
    (error) => error instanceof FinopsBudgetError && error.code === "E_FINOPS_INVALID_INPUT",
  );

  const unknownProvider = buildNormalEvaluationInput();
  unknownProvider.providerUsage["unknown-provider"] = { hourlyCallsUsed: 10, dailyCallsUsed: 10 };
  assert.throws(
    () => evaluateFinopsAndQuotaStatus(unknownProvider),
    (error) => error instanceof FinopsBudgetError && error.code === "E_FINOPS_INVALID_INPUT",
  );
});

test("classifyRetentionCandidatesDryRun은 활성·롤백·불변 원장·최소 보존일 이내 항목을 절대 삭제 후보로 분류하지 않고 만료된 비활성 항목만 분류한다", () => {
  const result = classifyRetentionCandidatesDryRun({
    activeReleaseIds: ["rel-20261109-active"],
    knownGoodReleaseIds: ["rel-20261101-rollback"],
    items: [
      {
        itemId: "oci://bundles/rel-20261109-active.tar.zst",
        storageClass: "oci-object-storage",
        releaseId: "rel-20261109-active",
        immutableLedger: false,
        ageDays: 400,
        sizeBytes: 104_857_600,
      },
      {
        itemId: "oci://bundles/rel-20261101-rollback.tar.zst",
        storageClass: "oci-object-storage",
        releaseId: "rel-20261101-rollback",
        immutableLedger: false,
        ageDays: 400,
        sizeBytes: 104_857_600,
      },
      {
        itemId: "oci://ledger/activation-receipt-20250101.json",
        storageClass: "oci-object-storage",
        releaseId: "rel-20250101-old",
        immutableLedger: true,
        ageDays: 500,
        sizeBytes: 4_096,
      },
      {
        itemId: "oci://bundles/rel-20261105-recent-inactive.tar.zst",
        storageClass: "oci-object-storage",
        releaseId: "rel-20261105-recent-inactive",
        immutableLedger: false,
        ageDays: 15,
        sizeBytes: 104_857_600,
      },
      {
        itemId: "oci://bundles/rel-20250901-expired-inactive.tar.zst",
        storageClass: "oci-object-storage",
        releaseId: "rel-20250901-expired-inactive",
        immutableLedger: false,
        ageDays: 380,
        sizeBytes: 104_857_600,
      },
      {
        itemId: "logs://audit/2026-01-01.log.zst",
        storageClass: "container-and-audit-logs",
        releaseId: null,
        immutableLedger: false,
        ageDays: 200,
        sizeBytes: 52_428_800,
      },
    ],
  });

  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.protectedItems.length, 4);
  assert.equal(result.pruneCandidates.length, 2);
  assert.deepEqual(
    result.protectedItems.map((item) => ({ itemId: item.itemId, disposition: item.disposition, reason: item.reason })),
    [
      {
        itemId: "oci://bundles/rel-20261109-active.tar.zst",
        disposition: "PROTECTED",
        reason: "ACTIVE_RELEASE",
      },
      {
        itemId: "oci://bundles/rel-20261101-rollback.tar.zst",
        disposition: "PROTECTED",
        reason: "KNOWN_GOOD_ROLLBACK_RELEASE",
      },
      {
        itemId: "oci://ledger/activation-receipt-20250101.json",
        storageClass: "oci-object-storage",
        releaseId: "rel-20250101-old",
        ageDays: 500,
        sizeBytes: 4_096,
        disposition: "PROTECTED",
        reason: "IMMUTABLE_AUDIT_LEDGER",
      },
      {
        itemId: "oci://bundles/rel-20261105-recent-inactive.tar.zst",
        disposition: "PROTECTED",
        reason: "WITHIN_MIN_RETENTION_WINDOW",
      },
    ].map(({ itemId, disposition, reason }) => ({ itemId, disposition, reason })),
  );
  assert.deepEqual(
    result.pruneCandidates.map((item) => ({ itemId: item.itemId, disposition: item.disposition })),
    [
      {
        itemId: "oci://bundles/rel-20250901-expired-inactive.tar.zst",
        disposition: "DRY_RUN_PRUNE_CANDIDATE",
      },
      {
        itemId: "logs://audit/2026-01-01.log.zst",
        disposition: "DRY_RUN_PRUNE_CANDIDATE",
      },
    ],
  );
  assert.equal(result.reclaimableBytes, 157_286_400);
});

test("classifyRetentionCandidatesDryRun은 배치 상한(maxItems)을 초과하는 악의적 입력이나 잘못된 스토리지 클래스를 Fail-Closed로 거부한다", () => {
  const items = Array.from({ length: 6 }, (_, index) => ({
    itemId: `oci://bundles/item-${index}.tar.zst`,
    storageClass: "oci-object-storage",
    releaseId: null,
    immutableLedger: false,
    ageDays: 400,
    sizeBytes: 1_024,
  }));

  assert.throws(
    () =>
      classifyRetentionCandidatesDryRun({
        activeReleaseIds: ["rel-active"],
        knownGoodReleaseIds: [],
        maxItems: 5,
        items,
      }),
    (error) => error instanceof FinopsBudgetError && error.code === "E_FINOPS_BATCH_LIMIT_EXCEEDED",
  );

  assert.throws(
    () =>
      classifyRetentionCandidatesDryRun({
        activeReleaseIds: ["rel-active"],
        knownGoodReleaseIds: [],
        items: [
          {
            itemId: "bad://item",
            storageClass: "unregistered-storage",
            releaseId: null,
            immutableLedger: false,
            ageDays: 100,
            sizeBytes: 512,
          },
        ],
      }),
    (error) => error instanceof FinopsBudgetError && error.code === "E_FINOPS_INVALID_INPUT",
  );
});
