import { codepointCompare } from "../lib/codepoint-compare.mjs";

const PPM_SCALE = 1_000_000;
const JOURNEY_UNIT_BATCH = 1_000;
const WARNING_THRESHOLD_RATIO = 0.7;
const CRITICAL_THRESHOLD_RATIO = 0.85;
const HARD_STOP_THRESHOLD_RATIO = 0.95;
export const MAX_RETENTION_EVALUATION_ITEMS = 50_000;
export const MAX_RELEASE_ID_SET_SIZE = 10_000;

const REQUIRED_STORAGE_CLASSES = Object.freeze([
  "container-and-audit-logs",
  "oci-object-storage",
  "postgresql-operational-db",
  "prometheus-tsdb",
]);

const ACTION_SEVERITY = Object.freeze({
  ALLOW_NORMAL: 0,
  THROTTLE_BACKGROUND_REFRESH: 1,
  BLOCK_NON_CRITICAL: 2,
  FAIL_CLOSED_QUOTA_EXCEEDED: 3,
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

export class FinopsBudgetError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "FinopsBudgetError";
    this.code = code;
    this.detail = detail;
  }
}

function failFinops(code, detail) {
  throw new FinopsBudgetError(code, detail);
}

function roundPpm(value) {
  return Math.round(value * PPM_SCALE) / PPM_SCALE;
}

export const FINOPS_QUOTA_RETENTION_POLICY = deepFreeze({
  costPerJourneyBudget: {
    currency: "KRW",
    unitBatchJourneys: JOURNEY_UNIT_BATCH,
    targetCostPerThousandJourneysKrw: 150,
    maxCostPerThousandJourneysKrw: 300,
    monthlyFixedInfraCeilingKrw: 150_000,
    monthlyVariableCeilingKrw: 100_000,
    monthlyTotalCeilingKrw: 250_000,
  },
  providerQuotaBudgets: {
    "data-go-kr-subway": {
      providerId: "data-go-kr-subway",
      hourlyCallLimit: 1_000,
      dailyCallLimit: 10_000,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
    "kric-rail-portal": {
      providerId: "kric-rail-portal",
      hourlyCallLimit: 1_000,
      dailyCallLimit: 10_000,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
    "seoul-topis-realtime": {
      providerId: "seoul-topis-realtime",
      hourlyCallLimit: 2_000,
      dailyCallLimit: 25_000,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
  },
  storageAndLogRetentionBudgets: {
    "oci-object-storage": {
      storageClass: "oci-object-storage",
      minRetentionDays: 30,
      maxRetentionDays: 365,
      maxCapacityGiB: 50,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
    "postgresql-operational-db": {
      storageClass: "postgresql-operational-db",
      minRetentionDays: 14,
      maxRetentionDays: 90,
      maxCapacityGiB: 20,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
    "prometheus-tsdb": {
      storageClass: "prometheus-tsdb",
      minRetentionDays: 28,
      maxRetentionDays: 30,
      maxCapacityGiB: 3,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
    "container-and-audit-logs": {
      storageClass: "container-and-audit-logs",
      minRetentionDays: 30,
      maxRetentionDays: 180,
      maxCapacityGiB: 10,
      warningRatio: WARNING_THRESHOLD_RATIO,
      criticalRatio: CRITICAL_THRESHOLD_RATIO,
      hardStopRatio: HARD_STOP_THRESHOLD_RATIO,
    },
  },
});

function validateThresholds(label, entry) {
  if (
    !Number.isFinite(entry.warningRatio) ||
    !Number.isFinite(entry.criticalRatio) ||
    !Number.isFinite(entry.hardStopRatio) ||
    entry.warningRatio <= 0 ||
    entry.warningRatio >= entry.criticalRatio ||
    entry.criticalRatio >= entry.hardStopRatio ||
    entry.hardStopRatio > 1
  ) {
    failFinops("E_FINOPS_POLICY_INVALID", `${label} threshold ratios must satisfy 0 < warning < critical < hardStop <= 1`);
  }
}

export function validateFinopsQuotaRetentionPolicy(policy = FINOPS_QUOTA_RETENTION_POLICY) {
  if (!policy || typeof policy !== "object") {
    failFinops("E_FINOPS_POLICY_INVALID", "policy must be a non-null object");
  }
  const cost = policy.costPerJourneyBudget;
  if (
    !cost ||
    cost.currency !== "KRW" ||
    cost.unitBatchJourneys !== JOURNEY_UNIT_BATCH ||
    !Number.isFinite(cost.targetCostPerThousandJourneysKrw) ||
    !Number.isFinite(cost.maxCostPerThousandJourneysKrw) ||
    cost.targetCostPerThousandJourneysKrw <= 0 ||
    cost.targetCostPerThousandJourneysKrw > cost.maxCostPerThousandJourneysKrw ||
    !Number.isFinite(cost.monthlyFixedInfraCeilingKrw) ||
    !Number.isFinite(cost.monthlyVariableCeilingKrw) ||
    !Number.isFinite(cost.monthlyTotalCeilingKrw) ||
    cost.monthlyFixedInfraCeilingKrw < 0 ||
    cost.monthlyVariableCeilingKrw < 0 ||
    cost.monthlyFixedInfraCeilingKrw + cost.monthlyVariableCeilingKrw !== cost.monthlyTotalCeilingKrw
  ) {
    failFinops("E_FINOPS_POLICY_INVALID", "invalid costPerJourneyBudget configuration");
  }

  const providers = policy.providerQuotaBudgets;
  if (!providers || typeof providers !== "object" || Object.keys(providers).length === 0) {
    failFinops("E_FINOPS_POLICY_INVALID", "providerQuotaBudgets must be a non-empty map");
  }
  const providerIds = Object.keys(providers).toSorted(codepointCompare);
  for (const providerId of providerIds) {
    const provider = providers[providerId];
    if (
      !provider ||
      provider.providerId !== providerId ||
      !Number.isInteger(provider.hourlyCallLimit) ||
      provider.hourlyCallLimit <= 0 ||
      !Number.isInteger(provider.dailyCallLimit) ||
      provider.dailyCallLimit < provider.hourlyCallLimit
    ) {
      failFinops("E_FINOPS_POLICY_INVALID", `invalid providerQuotaBudgets entry for ${providerId}`);
    }
    validateThresholds(`provider:${providerId}`, provider);
  }

  const storageBudgets = policy.storageAndLogRetentionBudgets;
  if (!storageBudgets || typeof storageBudgets !== "object") {
    failFinops("E_FINOPS_POLICY_INVALID", "storageAndLogRetentionBudgets must be an object");
  }
  for (const requiredClass of REQUIRED_STORAGE_CLASSES) {
    if (!Object.hasOwn(storageBudgets, requiredClass)) {
      failFinops("E_FINOPS_POLICY_INVALID", `missing required storageClass ${requiredClass}`);
    }
  }
  const storageClasses = Object.keys(storageBudgets).toSorted(codepointCompare);
  for (const storageClass of storageClasses) {
    const budget = storageBudgets[storageClass];
    if (
      !budget ||
      budget.storageClass !== storageClass ||
      !Number.isInteger(budget.minRetentionDays) ||
      budget.minRetentionDays <= 0 ||
      !Number.isInteger(budget.maxRetentionDays) ||
      budget.maxRetentionDays < budget.minRetentionDays ||
      !Number.isFinite(budget.maxCapacityGiB) ||
      budget.maxCapacityGiB <= 0
    ) {
      failFinops("E_FINOPS_POLICY_INVALID", `invalid storageAndLogRetentionBudgets entry for ${storageClass}`);
    }
    validateThresholds(`storage:${storageClass}`, budget);
  }

  return {
    valid: true,
    providerIds,
    storageClasses,
  };
}

function classifyUtilizationAction(ratio, thresholds) {
  if (ratio >= thresholds.hardStopRatio) {
    return "FAIL_CLOSED_QUOTA_EXCEEDED";
  }
  if (ratio >= thresholds.criticalRatio) {
    return "BLOCK_NON_CRITICAL";
  }
  if (ratio >= thresholds.warningRatio) {
    return "THROTTLE_BACKGROUND_REFRESH";
  }
  return "ALLOW_NORMAL";
}

function escalateAction(currentAction, candidateAction) {
  return ACTION_SEVERITY[candidateAction] > ACTION_SEVERITY[currentAction]
    ? candidateAction
    : currentAction;
}

export function evaluateFinopsAndQuotaStatus(input, policy = FINOPS_QUOTA_RETENTION_POLICY) {
  const { providerIds, storageClasses } = validateFinopsQuotaRetentionPolicy(policy);
  if (!input || typeof input !== "object") {
    failFinops("E_FINOPS_INVALID_INPUT", "evaluation input must be an object");
  }

  const {
    monthlyJourneyCount,
    monthlyFixedCostKrw,
    monthlyVariableCostKrw,
    providerUsage,
    storageUsageGiB,
  } = input;

  if (!Number.isInteger(monthlyJourneyCount) || monthlyJourneyCount <= 0) {
    failFinops("E_FINOPS_INVALID_INPUT", "monthlyJourneyCount must be a positive integer");
  }
  if (
    !Number.isFinite(monthlyFixedCostKrw) ||
    monthlyFixedCostKrw < 0 ||
    !Number.isFinite(monthlyVariableCostKrw) ||
    monthlyVariableCostKrw < 0
  ) {
    failFinops("E_FINOPS_INVALID_INPUT", "monthlyFixedCostKrw and monthlyVariableCostKrw must be non-negative numbers");
  }
  if (!providerUsage || typeof providerUsage !== "object") {
    failFinops("E_FINOPS_INVALID_INPUT", "providerUsage must be an object");
  }
  if (!storageUsageGiB || typeof storageUsageGiB !== "object") {
    failFinops("E_FINOPS_INVALID_INPUT", "storageUsageGiB must be an object");
  }

  for (const key of Object.keys(providerUsage)) {
    if (!Object.hasOwn(policy.providerQuotaBudgets, key)) {
      failFinops("E_FINOPS_INVALID_INPUT", `unregistered providerId in providerUsage: ${key}`);
    }
  }
  for (const key of Object.keys(storageUsageGiB)) {
    if (!Object.hasOwn(policy.storageAndLogRetentionBudgets, key)) {
      failFinops("E_FINOPS_INVALID_INPUT", `unregistered storageClass in storageUsageGiB: ${key}`);
    }
  }

  const monthlyTotalCostKrw = roundPpm(monthlyFixedCostKrw + monthlyVariableCostKrw);
  const costPerThousandJourneysKrw = roundPpm(
    (monthlyTotalCostKrw * policy.costPerJourneyBudget.unitBatchJourneys) / monthlyJourneyCount,
  );
  const costCeilingRatio = roundPpm(
    monthlyTotalCostKrw / policy.costPerJourneyBudget.monthlyTotalCeilingKrw,
  );

  let recommendedAction = "ALLOW_NORMAL";
  let costAction = "ALLOW_NORMAL";
  if (
    monthlyTotalCostKrw >= policy.costPerJourneyBudget.monthlyTotalCeilingKrw ||
    monthlyFixedCostKrw > policy.costPerJourneyBudget.monthlyFixedInfraCeilingKrw ||
    monthlyVariableCostKrw > policy.costPerJourneyBudget.monthlyVariableCeilingKrw
  ) {
    costAction = "FAIL_CLOSED_QUOTA_EXCEEDED";
  } else if (costPerThousandJourneysKrw > policy.costPerJourneyBudget.maxCostPerThousandJourneysKrw) {
    costAction = "BLOCK_NON_CRITICAL";
  } else if (costPerThousandJourneysKrw > policy.costPerJourneyBudget.targetCostPerThousandJourneysKrw) {
    costAction = "THROTTLE_BACKGROUND_REFRESH";
  }
  recommendedAction = escalateAction(recommendedAction, costAction);

  const providerStatuses = {};
  for (const providerId of providerIds) {
    const spec = policy.providerQuotaBudgets[providerId];
    const usage = providerUsage[providerId];
    if (
      !usage ||
      typeof usage !== "object" ||
      !Number.isInteger(usage.hourlyCallsUsed) ||
      usage.hourlyCallsUsed < 0 ||
      !Number.isInteger(usage.dailyCallsUsed) ||
      usage.dailyCallsUsed < 0
    ) {
      failFinops("E_FINOPS_INVALID_INPUT", `invalid or missing providerUsage for ${providerId}`);
    }
    const hourlyUtilizationRatio = roundPpm(usage.hourlyCallsUsed / spec.hourlyCallLimit);
    const dailyUtilizationRatio = roundPpm(usage.dailyCallsUsed / spec.dailyCallLimit);
    const peakUtilizationRatio = Math.max(hourlyUtilizationRatio, dailyUtilizationRatio);
    const action = classifyUtilizationAction(peakUtilizationRatio, spec);
    recommendedAction = escalateAction(recommendedAction, action);
    providerStatuses[providerId] = {
      providerId,
      hourlyUtilizationRatio,
      dailyUtilizationRatio,
      peakUtilizationRatio,
      action,
    };
  }

  const storageStatuses = {};
  for (const storageClass of storageClasses) {
    const spec = policy.storageAndLogRetentionBudgets[storageClass];
    const usedGiB = storageUsageGiB[storageClass];
    if (!Number.isFinite(usedGiB) || usedGiB < 0) {
      failFinops("E_FINOPS_INVALID_INPUT", `invalid or missing storageUsageGiB for ${storageClass}`);
    }
    const utilizationRatio = roundPpm(usedGiB / spec.maxCapacityGiB);
    const action = classifyUtilizationAction(utilizationRatio, spec);
    recommendedAction = escalateAction(recommendedAction, action);
    storageStatuses[storageClass] = {
      storageClass,
      usedGiB,
      maxCapacityGiB: spec.maxCapacityGiB,
      utilizationRatio,
      action,
    };
  }

  return {
    monthlyTotalCostKrw,
    costPerThousandJourneysKrw,
    costCeilingRatio,
    costAction,
    providerStatuses,
    storageStatuses,
    recommendedAction,
  };
}

function validateReleaseIdList(label, list) {
  if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && id.trim() !== "")) {
    failFinops("E_FINOPS_INVALID_INPUT", `${label} must be an array of non-empty release IDs`);
  }
  if (list.length > MAX_RELEASE_ID_SET_SIZE) {
    failFinops(
      "E_FINOPS_BATCH_LIMIT_EXCEEDED",
      `${label} count ${list.length} exceeds limit ${MAX_RELEASE_ID_SET_SIZE}`,
    );
  }
}

function classifySingleRetentionItem(item, activeReleaseSet, knownGoodReleaseSet, storageBudgets) {
  if (!item || typeof item !== "object") {
    failFinops("E_FINOPS_INVALID_INPUT", "retention item must be an object");
  }
  const { itemId, storageClass, releaseId = null, immutableLedger = false, ageDays, sizeBytes } = item;
  if (typeof itemId !== "string" || itemId.trim() === "") {
    failFinops("E_FINOPS_INVALID_INPUT", "retention item is missing a valid itemId");
  }
  if (typeof storageClass !== "string" || !Object.hasOwn(storageBudgets, storageClass)) {
    failFinops("E_FINOPS_INVALID_INPUT", `item ${itemId} has unregistered storageClass ${String(storageClass)}`);
  }
  if (typeof immutableLedger !== "boolean") {
    failFinops("E_FINOPS_INVALID_INPUT", `item ${itemId} immutableLedger must be boolean`);
  }
  if (releaseId !== null && (typeof releaseId !== "string" || releaseId.trim() === "")) {
    failFinops("E_FINOPS_INVALID_INPUT", `item ${itemId} releaseId must be null or a non-empty string`);
  }
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    failFinops("E_FINOPS_INVALID_INPUT", `item ${itemId} ageDays must be a non-negative number`);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    failFinops("E_FINOPS_INVALID_INPUT", `item ${itemId} sizeBytes must be a non-negative integer`);
  }

  const budget = storageBudgets[storageClass];

  if (immutableLedger) {
    return {
      itemId,
      storageClass,
      releaseId,
      ageDays,
      sizeBytes,
      disposition: "PROTECTED",
      reason: "IMMUTABLE_AUDIT_LEDGER",
    };
  }
  if (releaseId !== null && activeReleaseSet.has(releaseId)) {
    return {
      itemId,
      storageClass,
      releaseId,
      ageDays,
      sizeBytes,
      disposition: "PROTECTED",
      reason: "ACTIVE_RELEASE",
    };
  }
  if (releaseId !== null && knownGoodReleaseSet.has(releaseId)) {
    return {
      itemId,
      storageClass,
      releaseId,
      ageDays,
      sizeBytes,
      disposition: "PROTECTED",
      reason: "KNOWN_GOOD_ROLLBACK_RELEASE",
    };
  }
  if (ageDays <= budget.minRetentionDays) {
    return {
      itemId,
      storageClass,
      releaseId,
      ageDays,
      sizeBytes,
      disposition: "PROTECTED",
      reason: "WITHIN_MIN_RETENTION_WINDOW",
    };
  }
  if (ageDays <= budget.maxRetentionDays) {
    return {
      itemId,
      storageClass,
      releaseId,
      ageDays,
      sizeBytes,
      disposition: "PROTECTED",
      reason: "WITHIN_MAX_RETENTION_WINDOW",
    };
  }

  return {
    itemId,
    storageClass,
    releaseId,
    ageDays,
    sizeBytes,
    disposition: "DRY_RUN_PRUNE_CANDIDATE",
    reason: "RETENTION_WINDOW_EXPIRED",
  };
}

export function classifyRetentionCandidatesDryRun(input, policy = FINOPS_QUOTA_RETENTION_POLICY) {
  validateFinopsQuotaRetentionPolicy(policy);
  if (!input || typeof input !== "object") {
    failFinops("E_FINOPS_INVALID_INPUT", "retention classification input must be an object");
  }
  const {
    activeReleaseIds,
    knownGoodReleaseIds,
    items,
    maxItems = MAX_RETENTION_EVALUATION_ITEMS,
  } = input;
  validateReleaseIdList("activeReleaseIds", activeReleaseIds);
  validateReleaseIdList("knownGoodReleaseIds", knownGoodReleaseIds);

  if (!Array.isArray(items)) {
    failFinops("E_FINOPS_INVALID_INPUT", "items must be an array");
  }
  const effectiveMaxItems = Math.min(maxItems, MAX_RETENTION_EVALUATION_ITEMS);
  if (!Number.isInteger(effectiveMaxItems) || effectiveMaxItems <= 0 || items.length > effectiveMaxItems) {
    failFinops(
      "E_FINOPS_BATCH_LIMIT_EXCEEDED",
      `items count ${items.length} exceeds maximum allowed ${effectiveMaxItems}`,
    );
  }

  const activeReleaseSet = new Set(activeReleaseIds);
  const knownGoodReleaseSet = new Set(knownGoodReleaseIds);
  const storageBudgets = policy.storageAndLogRetentionBudgets;

  const protectedItems = [];
  const pruneCandidates = [];
  let reclaimableBytes = 0;

  for (let i = 0; i < items.length; i += 1) {
    const classified = classifySingleRetentionItem(
      items[i],
      activeReleaseSet,
      knownGoodReleaseSet,
      storageBudgets,
    );
    if (classified.disposition === "PROTECTED") {
      protectedItems.push(classified);
    } else {
      pruneCandidates.push(classified);
      reclaimableBytes += classified.sizeBytes;
    }
  }

  return {
    mode: "DRY_RUN",
    protectedItems,
    pruneCandidates,
    reclaimableBytes,
  };
}
