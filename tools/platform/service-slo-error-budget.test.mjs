import assert from "node:assert/strict";
import test from "node:test";

import {
  BURN_RATE_THRESHOLDS,
  MAX_CATALOG_SERVICES,
  SERVICE_SLO_CATALOG,
  SLO_OBSERVATION_WINDOWS,
  ServiceSloError,
  evaluateServiceSloBurnRate,
  validateServiceSloCatalog,
} from "./service-slo-error-budget.mjs";

function buildHealthyWindows({
  p95LatencyMs = 24,
  freshnessAgeSeconds = 120,
} = {}) {
  return {
    "1h": { totalRequests: 10_000, failedRequests: 1, p95LatencyMs, freshnessAgeSeconds },
    "6h": { totalRequests: 60_000, failedRequests: 6, p95LatencyMs, freshnessAgeSeconds },
    "24h": { totalRequests: 240_000, failedRequests: 24, p95LatencyMs, freshnessAgeSeconds },
    "72h": { totalRequests: 720_000, failedRequests: 72, p95LatencyMs, freshnessAgeSeconds },
    "28d": { totalRequests: 6_000_000, failedRequests: 1_500, p95LatencyMs, freshnessAgeSeconds },
  };
}

test("SERVICE_SLO_CATALOG는 4대 핵심 운영 서비스와 28일 기준 SLO 목표·오류 예산을 불변 객체로 정의한다", () => {
  const validation = validateServiceSloCatalog(SERVICE_SLO_CATALOG);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.serviceIds, [
    "artifact-delivery-oci",
    "journey-routing-api",
    "observability-pipeline",
    "realtime-arrival-proxy",
  ]);
  assert.equal(Object.isFrozen(SERVICE_SLO_CATALOG), true);
  assert.deepEqual(SLO_OBSERVATION_WINDOWS, ["1h", "6h", "24h", "72h", "28d"]);
  assert.equal(BURN_RATE_THRESHOLDS.fastBurnMultiplier, 14.4);
  assert.equal(BURN_RATE_THRESHOLDS.slowBurnMultiplier, 6);
  assert.equal(BURN_RATE_THRESHOLDS.mediumBurnMultiplier, 3);
  assert.equal(BURN_RATE_THRESHOLDS.sustainedBurnMultiplier, 1);

  for (const serviceId of validation.serviceIds) {
    const entry = SERVICE_SLO_CATALOG[serviceId];
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(entry.windowDays, 28);
    assert.equal(
      Math.round((entry.sloTargets.availabilityRatio + entry.sloTargets.errorBudgetRatio) * 1_000_000),
      1_000_000,
    );
  }
});

test("validateServiceSloCatalog는 누락된 서비스·오류 예산 불일치·상한 초과 카탈로그를 Fail-Closed로 거부한다", () => {
  assert.throws(
    () => validateServiceSloCatalog({}),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_CATALOG_INVALID",
  );

  const tampered = structuredClone(SERVICE_SLO_CATALOG);
  tampered["journey-routing-api"].sloTargets.errorBudgetRatio = 0.05;
  assert.throws(
    () => validateServiceSloCatalog(tampered),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_CATALOG_INVALID",
  );

  const oversized = structuredClone(SERVICE_SLO_CATALOG);
  for (let i = 0; i <= MAX_CATALOG_SERVICES; i += 1) {
    const id = `extra-service-${i}`;
    oversized[id] = {
      ...structuredClone(SERVICE_SLO_CATALOG["journey-routing-api"]),
      serviceId: id,
    };
  }
  assert.throws(
    () => validateServiceSloCatalog(oversized),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_CATALOG_INVALID",
  );
});

test("evaluateServiceSloBurnRate는 정상 범위에서 부동소수 오차 없이 HEALTHY와 ALLOW를 판정한다", () => {
  const result = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows: buildHealthyWindows(),
  });

  assert.equal(result.serviceId, "journey-routing-api");
  assert.equal(result.status, "HEALTHY");
  assert.equal(result.releaseGateDecision, "ALLOW");
  assert.equal(result.errorBudgetRatio, 0.001);
  assert.equal(result.consumedBudgetRatio, 0.25);
  assert.equal(result.remainingBudgetRatio, 0.75);
  assert.equal(result.windowBurnRates["1h"], 0.1);
  assert.equal(result.windowBurnRates["6h"], 0.1);
  assert.equal(result.windowBurnRates["24h"], 0.1);
  assert.equal(result.windowBurnRates["72h"], 0.1);
  assert.equal(result.windowBurnRates["28d"], 0.25);
  assert.equal(result.latencySloBreached, false);
  assert.equal(result.freshnessSloBreached, false);
});

test("evaluateServiceSloBurnRate는 1h 및 6h 창이 14.4x 이상인 Fast Burn 시 PAGE_RELEASE_FREEZE와 BLOCK을 판정한다", () => {
  const windows = buildHealthyWindows();
  windows["1h"] = { totalRequests: 10_000, failedRequests: 144, p95LatencyMs: 30, freshnessAgeSeconds: 100 };
  windows["6h"] = { totalRequests: 100_000, failedRequests: 1_440, p95LatencyMs: 32, freshnessAgeSeconds: 100 };

  const result = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows,
  });

  assert.equal(result.windowBurnRates["1h"], 14.4);
  assert.equal(result.windowBurnRates["6h"], 14.4);
  assert.equal(result.status, "PAGE_RELEASE_FREEZE");
  assert.equal(result.releaseGateDecision, "BLOCK");
  assert.equal(result.triggers.includes("FAST_BURN_1H_6H"), true);
});

test("evaluateServiceSloBurnRate는 28d 오류 예산이 고갈(remainingBudgetRatio <= 0)되면 PAGE_RELEASE_FREEZE와 BLOCK을 판정한다", () => {
  const windows = buildHealthyWindows();
  windows["28d"] = { totalRequests: 1_000_000, failedRequests: 1_200, p95LatencyMs: 25, freshnessAgeSeconds: 90 };

  const result = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows,
  });

  assert.equal(result.consumedBudgetRatio, 1.2);
  assert.equal(result.remainingBudgetRatio, -0.2);
  assert.equal(result.status, "PAGE_RELEASE_FREEZE");
  assert.equal(result.releaseGateDecision, "BLOCK");
  assert.equal(result.triggers.includes("ERROR_BUDGET_EXHAUSTED"), true);
});

test("evaluateServiceSloBurnRate는 6h 및 72h 창이 6x 이상이거나 24h 창이 3x 이상인 Slow Burn 시 TICKET_WARN과 WARN을 판정한다", () => {
  const slowBurnWindows = buildHealthyWindows();
  slowBurnWindows["6h"] = { totalRequests: 100_000, failedRequests: 600, p95LatencyMs: 25, freshnessAgeSeconds: 60 };
  slowBurnWindows["72h"] = { totalRequests: 1_000_000, failedRequests: 6_000, p95LatencyMs: 25, freshnessAgeSeconds: 60 };

  const result6h72h = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows: slowBurnWindows,
  });

  assert.equal(result6h72h.windowBurnRates["6h"], 6);
  assert.equal(result6h72h.windowBurnRates["72h"], 6);
  assert.equal(result6h72h.status, "TICKET_WARN");
  assert.equal(result6h72h.releaseGateDecision, "WARN");
  assert.equal(result6h72h.triggers.includes("SLOW_BURN_6H_72H"), true);

  const mediumBurnWindows = buildHealthyWindows();
  mediumBurnWindows["24h"] = { totalRequests: 100_000, failedRequests: 300, p95LatencyMs: 25, freshnessAgeSeconds: 60 };

  const result24h = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows: mediumBurnWindows,
  });

  assert.equal(result24h.windowBurnRates["24h"], 3);
  assert.equal(result24h.status, "TICKET_WARN");
  assert.equal(result24h.releaseGateDecision, "WARN");
  assert.equal(result24h.triggers.includes("SLOW_BURN_24H"), true);
});

test("evaluateServiceSloBurnRate는 신선도 만료 시 PAGE_RELEASE_FREEZE를, 지연시간 초과 시 TICKET_WARN을 판정한다", () => {
  const staleResult = evaluateServiceSloBurnRate({
    serviceId: "realtime-arrival-proxy",
    windows: buildHealthyWindows({ p95LatencyMs: 80, freshnessAgeSeconds: 300 }),
  });
  assert.equal(staleResult.freshnessSloBreached, true);
  assert.equal(staleResult.status, "PAGE_RELEASE_FREEZE");
  assert.equal(staleResult.releaseGateDecision, "BLOCK");

  const slowLatencyResult = evaluateServiceSloBurnRate({
    serviceId: "journey-routing-api",
    windows: buildHealthyWindows({ p95LatencyMs: 75, freshnessAgeSeconds: 120 }),
  });
  assert.equal(slowLatencyResult.latencySloBreached, true);
  assert.equal(slowLatencyResult.status, "TICKET_WARN");
  assert.equal(slowLatencyResult.releaseGateDecision, "WARN");
});

test("evaluateServiceSloBurnRate는 미등록 서비스·누락된 윈도우·음수·프로토타입 키·failedRequests > totalRequests를 Fail-Closed로 거부한다", () => {
  assert.throws(
    () =>
      evaluateServiceSloBurnRate({
        serviceId: "__proto__",
        windows: buildHealthyWindows(),
      }),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_UNKNOWN_SERVICE",
  );

  const missingWindow = buildHealthyWindows();
  delete missingWindow["72h"];
  assert.throws(
    () =>
      evaluateServiceSloBurnRate({
        serviceId: "journey-routing-api",
        windows: missingWindow,
      }),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_INVALID_WINDOW_METRICS",
  );

  const negativeRequests = buildHealthyWindows();
  negativeRequests["1h"].failedRequests = -1;
  assert.throws(
    () =>
      evaluateServiceSloBurnRate({
        serviceId: "journey-routing-api",
        windows: negativeRequests,
      }),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_INVALID_WINDOW_METRICS",
  );

  const impossibleFailures = buildHealthyWindows();
  impossibleFailures["6h"].failedRequests = impossibleFailures["6h"].totalRequests + 1;
  assert.throws(
    () =>
      evaluateServiceSloBurnRate({
        serviceId: "journey-routing-api",
        windows: impossibleFailures,
      }),
    (error) => error instanceof ServiceSloError && error.code === "E_SLO_INVALID_WINDOW_METRICS",
  );
});
