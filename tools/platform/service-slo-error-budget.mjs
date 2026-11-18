import { codepointCompare } from "../lib/codepoint-compare.mjs";

const PPM_SCALE = 1_000_000;
const PPM_SCALE_BIGINT = 1_000_000n;
const TENTH_SCALE = 10;
const TENTH_SCALE_BIGINT = 10n;
const STANDARD_SLO_WINDOW_DAYS = 28;
const MAX_SAFE_REQUEST_COUNT = Number.MAX_SAFE_INTEGER;
export const MAX_CATALOG_SERVICES = 64;

const REQUIRED_SERVICE_IDS = Object.freeze([
  "artifact-delivery-oci",
  "journey-routing-api",
  "observability-pipeline",
  "realtime-arrival-proxy",
]);

const ALLOWED_OWNER_COMPONENTS = new Set(["backend", "data", "mobile", "platform"]);

export const SLO_OBSERVATION_WINDOWS = Object.freeze(["1h", "6h", "24h", "72h", "28d"]);

export const BURN_RATE_THRESHOLDS = Object.freeze({
  fastBurnMultiplier: 14.4,
  slowBurnMultiplier: 6,
  mediumBurnMultiplier: 3,
  sustainedBurnMultiplier: 1,
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

export class ServiceSloError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ServiceSloError";
    this.code = code;
    this.detail = detail;
  }
}

function failSlo(code, detail) {
  throw new ServiceSloError(code, detail);
}

function toPpmInt(ratio) {
  return Math.round(ratio * PPM_SCALE);
}

function roundPpm(value) {
  return Math.round(value * PPM_SCALE) / PPM_SCALE;
}

export const SERVICE_SLO_CATALOG = deepFreeze({
  "journey-routing-api": {
    serviceId: "journey-routing-api",
    ownerComponent: "backend",
    windowDays: STANDARD_SLO_WINDOW_DAYS,
    sliDefinitions: {
      availabilitySuccessRatio: "1 - (http_5xx_requests / total_requests)",
      warmLatencyP95Ms: "histogram_quantile(0.95, easysubway_journey_search_duration_seconds_bucket) * 1000",
      freshnessMaxAgeSeconds: "time() - easysubway_timetable_snapshot_published_timestamp_seconds",
    },
    sloTargets: {
      availabilityRatio: 0.999,
      errorBudgetRatio: 0.001,
      warmLatencyP95Ms: 50,
      maxFreshnessAgeSeconds: 86_400,
    },
  },
  "realtime-arrival-proxy": {
    serviceId: "realtime-arrival-proxy",
    ownerComponent: "backend",
    windowDays: STANDARD_SLO_WINDOW_DAYS,
    sliDefinitions: {
      availabilitySuccessRatio: "1 - (realtime_proxy_failures / realtime_proxy_requests)",
      warmLatencyP95Ms: "histogram_quantile(0.95, easysubway_realtime_arrival_duration_seconds_bucket) * 1000",
      freshnessMaxAgeSeconds: "time() - easysubway_realtime_feed_last_updated_timestamp_seconds",
    },
    sloTargets: {
      availabilityRatio: 0.995,
      errorBudgetRatio: 0.005,
      warmLatencyP95Ms: 150,
      maxFreshnessAgeSeconds: 120,
    },
  },
  "artifact-delivery-oci": {
    serviceId: "artifact-delivery-oci",
    ownerComponent: "data",
    windowDays: STANDARD_SLO_WINDOW_DAYS,
    sliDefinitions: {
      availabilitySuccessRatio: "1 - (oci_bundle_fetch_failures / oci_bundle_fetch_requests)",
      warmLatencyP95Ms: "histogram_quantile(0.95, easysubway_artifact_delivery_duration_seconds_bucket) * 1000",
      freshnessMaxAgeSeconds: "time() - easysubway_datapack_release_published_timestamp_seconds",
    },
    sloTargets: {
      availabilityRatio: 0.999,
      errorBudgetRatio: 0.001,
      warmLatencyP95Ms: 250,
      maxFreshnessAgeSeconds: 86_400,
    },
  },
  "observability-pipeline": {
    serviceId: "observability-pipeline",
    ownerComponent: "platform",
    windowDays: STANDARD_SLO_WINDOW_DAYS,
    sliDefinitions: {
      availabilitySuccessRatio: "avg_over_time(up[5m])",
      warmLatencyP95Ms: "histogram_quantile(0.95, prometheus_rule_group_duration_seconds_bucket) * 1000",
      freshnessMaxAgeSeconds: "time() - max(timestamp(up))",
    },
    sloTargets: {
      availabilityRatio: 0.999,
      errorBudgetRatio: 0.001,
      warmLatencyP95Ms: 200,
      maxFreshnessAgeSeconds: 300,
    },
  },
});

function validateCatalogEntry(key, entry) {
  if (!entry || typeof entry !== "object") {
    failSlo("E_SLO_CATALOG_INVALID", `service entry ${key} must be an object`);
  }
  if (entry.serviceId !== key) {
    failSlo("E_SLO_CATALOG_INVALID", `serviceId ${String(entry.serviceId)} does not match key ${key}`);
  }
  if (!ALLOWED_OWNER_COMPONENTS.has(entry.ownerComponent)) {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} has invalid ownerComponent ${String(entry.ownerComponent)}`);
  }
  if (entry.windowDays !== STANDARD_SLO_WINDOW_DAYS) {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} must use ${STANDARD_SLO_WINDOW_DAYS}-day SLO window`);
  }
  const sli = entry.sliDefinitions;
  if (
    !sli ||
    typeof sli.availabilitySuccessRatio !== "string" ||
    sli.availabilitySuccessRatio.trim() === "" ||
    typeof sli.warmLatencyP95Ms !== "string" ||
    sli.warmLatencyP95Ms.trim() === "" ||
    typeof sli.freshnessMaxAgeSeconds !== "string" ||
    sli.freshnessMaxAgeSeconds.trim() === ""
  ) {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} is missing required SLI definitions`);
  }
  const targets = entry.sloTargets;
  if (!targets || typeof targets !== "object") {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} is missing sloTargets`);
  }
  const availabilityPpm = toPpmInt(targets.availabilityRatio);
  const budgetPpm = toPpmInt(targets.errorBudgetRatio);
  if (
    !Number.isFinite(targets.availabilityRatio) ||
    !Number.isFinite(targets.errorBudgetRatio) ||
    availabilityPpm <= 0 ||
    availabilityPpm >= PPM_SCALE ||
    budgetPpm <= 0 ||
    availabilityPpm + budgetPpm !== PPM_SCALE
  ) {
    failSlo(
      "E_SLO_CATALOG_INVALID",
      `service ${key} availabilityRatio and errorBudgetRatio must sum to 1.0 in ppm precision`,
    );
  }
  if (!Number.isFinite(targets.warmLatencyP95Ms) || targets.warmLatencyP95Ms <= 0) {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} warmLatencyP95Ms must be positive`);
  }
  if (!Number.isFinite(targets.maxFreshnessAgeSeconds) || targets.maxFreshnessAgeSeconds <= 0) {
    failSlo("E_SLO_CATALOG_INVALID", `service ${key} maxFreshnessAgeSeconds must be positive`);
  }
}

export function validateServiceSloCatalog(catalog = SERVICE_SLO_CATALOG) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    failSlo("E_SLO_CATALOG_INVALID", "catalog must be a non-null plain object");
  }
  const serviceIds = Object.keys(catalog).toSorted(codepointCompare);
  if (serviceIds.length > MAX_CATALOG_SERVICES) {
    failSlo(
      "E_SLO_CATALOG_INVALID",
      `catalog service count ${serviceIds.length} exceeds limit ${MAX_CATALOG_SERVICES}`,
    );
  }
  for (const requiredId of REQUIRED_SERVICE_IDS) {
    if (!Object.hasOwn(catalog, requiredId)) {
      failSlo("E_SLO_CATALOG_INVALID", `missing required service ${requiredId}`);
    }
  }
  for (const serviceId of serviceIds) {
    validateCatalogEntry(serviceId, catalog[serviceId]);
  }
  return {
    valid: true,
    serviceIds,
  };
}

function validateWindowObservation(windowKey, observation) {
  if (!observation || typeof observation !== "object") {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", `missing observation object for window ${windowKey}`);
  }
  const { totalRequests, failedRequests, p95LatencyMs, freshnessAgeSeconds } = observation;
  if (
    !Number.isInteger(totalRequests) ||
    totalRequests <= 0 ||
    totalRequests > MAX_SAFE_REQUEST_COUNT
  ) {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", `window ${windowKey} totalRequests must be a positive safe integer`);
  }
  if (
    !Number.isInteger(failedRequests) ||
    failedRequests < 0 ||
    failedRequests > totalRequests
  ) {
    failSlo(
      "E_SLO_INVALID_WINDOW_METRICS",
      `window ${windowKey} failedRequests must be an integer in [0, totalRequests]`,
    );
  }
  if (!Number.isFinite(p95LatencyMs) || p95LatencyMs < 0) {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", `window ${windowKey} p95LatencyMs must be a non-negative number`);
  }
  if (!Number.isFinite(freshnessAgeSeconds) || freshnessAgeSeconds < 0) {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", `window ${windowKey} freshnessAgeSeconds must be a non-negative number`);
  }
}

function computeExactBurnRate(failedRequests, totalRequests, budgetPpm) {
  const numerator = failedRequests * PPM_SCALE;
  const denominator = totalRequests * budgetPpm;
  return roundPpm(numerator / denominator);
}

function isBurnRateAtLeast(failedRequests, totalRequests, budgetPpm, thresholdMultiplier) {
  const scaledThreshold = BigInt(Math.round(thresholdMultiplier * TENTH_SCALE));
  const leftSide = BigInt(failedRequests) * PPM_SCALE_BIGINT * TENTH_SCALE_BIGINT;
  const rightSide = scaledThreshold * BigInt(totalRequests) * BigInt(budgetPpm);
  return leftSide >= rightSide;
}

export function evaluateServiceSloBurnRate(input, catalog = SERVICE_SLO_CATALOG) {
  validateServiceSloCatalog(catalog);
  if (!input || typeof input !== "object") {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", "evaluation input must be an object");
  }
  const { serviceId, windows } = input;
  if (typeof serviceId !== "string" || !Object.hasOwn(catalog, serviceId)) {
    failSlo("E_SLO_UNKNOWN_SERVICE", `unregistered serviceId: ${String(serviceId)}`);
  }
  if (!windows || typeof windows !== "object") {
    failSlo("E_SLO_INVALID_WINDOW_METRICS", "windows observation map is required");
  }

  const serviceSpec = catalog[serviceId];
  const budgetPpm = toPpmInt(serviceSpec.sloTargets.errorBudgetRatio);
  const windowBurnRates = {};
  const windowErrorRates = {};
  let latencySloBreached = false;
  let freshnessSloBreached = false;

  for (const windowKey of SLO_OBSERVATION_WINDOWS) {
    if (!Object.hasOwn(windows, windowKey)) {
      failSlo("E_SLO_INVALID_WINDOW_METRICS", `missing required observation window ${windowKey}`);
    }
    const observation = windows[windowKey];
    validateWindowObservation(windowKey, observation);

    windowErrorRates[windowKey] = roundPpm(observation.failedRequests / observation.totalRequests);
    windowBurnRates[windowKey] = computeExactBurnRate(
      observation.failedRequests,
      observation.totalRequests,
      budgetPpm,
    );

    if (observation.p95LatencyMs > serviceSpec.sloTargets.warmLatencyP95Ms) {
      latencySloBreached = true;
    }
    if (observation.freshnessAgeSeconds > serviceSpec.sloTargets.maxFreshnessAgeSeconds) {
      freshnessSloBreached = true;
    }
  }

  const consumedBudgetRatio = windowBurnRates["28d"];
  const consumedPpm = toPpmInt(consumedBudgetRatio);
  const remainingBudgetRatio = (PPM_SCALE - consumedPpm) / PPM_SCALE;

  const fastBurn1h = isBurnRateAtLeast(
    windows["1h"].failedRequests,
    windows["1h"].totalRequests,
    budgetPpm,
    BURN_RATE_THRESHOLDS.fastBurnMultiplier,
  );
  const fastBurn6h = isBurnRateAtLeast(
    windows["6h"].failedRequests,
    windows["6h"].totalRequests,
    budgetPpm,
    BURN_RATE_THRESHOLDS.fastBurnMultiplier,
  );
  const slowBurn6h = isBurnRateAtLeast(
    windows["6h"].failedRequests,
    windows["6h"].totalRequests,
    budgetPpm,
    BURN_RATE_THRESHOLDS.slowBurnMultiplier,
  );
  const slowBurn72h = isBurnRateAtLeast(
    windows["72h"].failedRequests,
    windows["72h"].totalRequests,
    budgetPpm,
    BURN_RATE_THRESHOLDS.slowBurnMultiplier,
  );
  const slowBurn24h = isBurnRateAtLeast(
    windows["24h"].failedRequests,
    windows["24h"].totalRequests,
    budgetPpm,
    BURN_RATE_THRESHOLDS.mediumBurnMultiplier,
  );

  const triggers = [];
  if (fastBurn1h && fastBurn6h) {
    triggers.push("FAST_BURN_1H_6H");
  }
  if (remainingBudgetRatio <= 0) {
    triggers.push("ERROR_BUDGET_EXHAUSTED");
  }
  if (slowBurn6h && slowBurn72h) {
    triggers.push("SLOW_BURN_6H_72H");
  }
  if (slowBurn24h) {
    triggers.push("SLOW_BURN_24H");
  }
  if (freshnessSloBreached) {
    triggers.push("FRESHNESS_SLO_BREACHED");
  }
  if (latencySloBreached) {
    triggers.push("LATENCY_P95_SLO_BREACHED");
  }

  let status = "HEALTHY";
  let releaseGateDecision = "ALLOW";

  if ((fastBurn1h && fastBurn6h) || remainingBudgetRatio <= 0 || freshnessSloBreached) {
    status = "PAGE_RELEASE_FREEZE";
    releaseGateDecision = "BLOCK";
  } else if ((slowBurn6h && slowBurn72h) || slowBurn24h || latencySloBreached) {
    status = "TICKET_WARN";
    releaseGateDecision = "WARN";
  }

  return {
    serviceId,
    ownerComponent: serviceSpec.ownerComponent,
    status,
    releaseGateDecision,
    errorBudgetRatio: serviceSpec.sloTargets.errorBudgetRatio,
    consumedBudgetRatio,
    remainingBudgetRatio,
    windowErrorRates,
    windowBurnRates,
    latencySloBreached,
    freshnessSloBreached,
    triggers,
  };
}
