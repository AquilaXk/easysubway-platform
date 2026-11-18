#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const NAMESPACE = "easysubway-journey";
export const ACTIVE_SERVICE_NAME = "journey-active";
const CANDIDATE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CONFIG_NAME_PATTERN = /^journey-config-([a-z0-9][a-z0-9-]*)$/;
const SECRET_NAME_PATTERN = /^journey-secret-([a-z0-9][a-z0-9-]*)$/;
const DEPLOYMENT_NAME_PATTERN = /^journey-candidate-([a-z0-9][a-z0-9-]*)$/;
const KUBECTL_TARGET_PATTERN = /^(?:(configmap)\/(journey-config-([a-z0-9][a-z0-9-]*))|(secret)\/(journey-secret-([a-z0-9][a-z0-9-]*)))$/;
const BARE_TARGET_PATTERN = /^journey-(config|secret)-([a-z0-9][a-z0-9-]*)$/;
const SECRET_JSONPATH = String.raw`jsonpath={range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}`;

function compareStrings(left, right) {
  return left.localeCompare(right);
}

export class K3sCandidatePruneError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "K3sCandidatePruneError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new K3sCandidatePruneError(code, message);
}

async function defaultCommandRunner(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function extractActiveToken(activeService) {
  if (!activeService || typeof activeService !== "object") {
    fail("E_K3S_PRUNE_ACTIVE_MISSING", "journey-active Service does not exist or could not be read");
  }
  const selector = activeService?.spec?.selector;
  if (!selector || typeof selector !== "object") {
    fail("E_K3S_PRUNE_ACTIVE_MISSING", "journey-active Service has no spec.selector");
  }
  const byCandidateToken = selector["easysubway.io/candidate-token"];
  const byCandidate = selector["easysubway.io/candidate"];
  if (
    byCandidateToken !== undefined &&
    byCandidate !== undefined &&
    byCandidateToken !== byCandidate
  ) {
    fail(
      "E_K3S_PRUNE_ACTIVE_AMBIGUOUS",
      `journey-active selector keys disagree: candidate-token=${byCandidateToken} vs candidate=${byCandidate}`,
    );
  }
  const activeToken = byCandidateToken ?? byCandidate;
  if (typeof activeToken !== "string" || !CANDIDATE_TOKEN_PATTERN.test(activeToken)) {
    fail("E_K3S_PRUNE_ACTIVE_MISSING", `journey-active selector token is missing or invalid: ${String(activeToken)}`);
  }
  return activeToken;
}

function validateSingleDeployment(deployment, activeToken) {
  const name = deployment?.metadata?.name ?? "";
  const labels = deployment?.metadata?.labels ?? {};
  const byCandidateToken = labels["easysubway.io/candidate-token"];
  const byCandidate = labels["easysubway.io/candidate"];
  const hasCandidateLabel = byCandidateToken !== undefined || byCandidate !== undefined;
  if (!name.startsWith("journey-candidate-") && !hasCandidateLabel) return;

  if (
    byCandidateToken !== undefined &&
    byCandidate !== undefined &&
    byCandidateToken !== byCandidate
  ) {
    fail(
      "E_K3S_PRUNE_ACTIVE_DEPLOYMENT_MISMATCH",
      `candidate Deployment ${name} has conflicting candidate labels`,
    );
  }
  const match = DEPLOYMENT_NAME_PATTERN.exec(name);
  const labelToken = byCandidateToken ?? byCandidate;
  const deploymentToken = match?.[1];
  const tokenMismatch = !deploymentToken || deploymentToken !== activeToken;
  const labelMismatch = Boolean(labelToken && labelToken !== activeToken);
  if (tokenMismatch || labelMismatch) {
    fail(
      "E_K3S_PRUNE_ACTIVE_DEPLOYMENT_MISMATCH",
      `candidate Deployment ${name} (label=${String(labelToken)}) does not match active Service token ${activeToken}`,
    );
  }
}

function validateActiveDeployments(deployments, activeToken) {
  if (!Array.isArray(deployments)) return;
  for (const deployment of deployments) {
    validateSingleDeployment(deployment, activeToken);
  }
}

function parseIsoTimestamp(value, objectName) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("E_K3S_PRUNE_PREVIOUS_AMBIGUOUS", `${objectName} is missing metadata.creationTimestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("E_K3S_PRUNE_PREVIOUS_AMBIGUOUS", `${objectName} has unparseable metadata.creationTimestamp: ${value}`);
  }
  return parsed;
}

function collectCandidateObjects(items, prefix, pattern, kindLabel) {
  const byToken = new Map();
  for (const item of items ?? []) {
    const name = item?.metadata?.name;
    if (typeof name !== "string" || !name.startsWith(prefix)) continue;
    const match = pattern.exec(name);
    if (!match) {
      fail("E_K3S_PRUNE_CANDIDATE_INVALID_NAME", `${kindLabel} ${name} does not match expected candidate token pattern`);
    }
    const token = match[1];
    if (byToken.has(token)) {
      fail("E_K3S_PRUNE_CANDIDATE_DUPLICATE", `duplicate ${kindLabel} entry for token ${token}`);
    }
    byToken.set(token, {
      name,
      token,
      creationTimestamp: item?.metadata?.creationTimestamp ?? null,
    });
  }
  return byToken;
}

function buildProtectedTokenState(activeToken, previousToken) {
  if (typeof activeToken !== "string" || !CANDIDATE_TOKEN_PATTERN.test(activeToken)) {
    fail("E_K3S_PRUNE_TARGET_GUARD", "activeToken is required for target guard");
  }
  const protectedTokens = new Set([activeToken]);
  if (previousToken !== null && previousToken !== undefined) {
    if (typeof previousToken !== "string" || !CANDIDATE_TOKEN_PATTERN.test(previousToken)) {
      fail("E_K3S_PRUNE_TARGET_GUARD", "previousToken is invalid in target guard");
    }
    protectedTokens.add(previousToken);
  }
  const protectedNames = new Set(
    [...protectedTokens].flatMap((token) => [
      `journey-config-${token}`,
      `journey-secret-${token}`,
      `configmap/journey-config-${token}`,
      `secret/journey-secret-${token}`,
    ]),
  );
  return { protectedTokens, protectedNames };
}

function extractTargetToken(target) {
  const kubectlMatch = KUBECTL_TARGET_PATTERN.exec(target);
  if (kubectlMatch) {
    return kubectlMatch[3] ?? kubectlMatch[6];
  }
  const bareMatch = BARE_TARGET_PATTERN.exec(target);
  if (bareMatch) {
    return bareMatch[2];
  }
  fail("E_K3S_PRUNE_TARGET_GUARD", `non-candidate object in pruneTargets: ${target}`);
}

export function assertSafePruneTargets(targets, { activeToken, previousToken }) {
  if (!Array.isArray(targets)) {
    fail("E_K3S_PRUNE_TARGET_GUARD", "pruneTargets must be an array");
  }
  const { protectedTokens, protectedNames } = buildProtectedTokenState(activeToken, previousToken);
  const seen = new Set();
  for (const target of targets) {
    if (typeof target !== "string" || protectedNames.has(target)) {
      fail("E_K3S_PRUNE_TARGET_GUARD", `protected or invalid object in pruneTargets: ${String(target)}`);
    }
    if (seen.has(target)) {
      fail("E_K3S_PRUNE_TARGET_GUARD", `duplicate object in pruneTargets: ${target}`);
    }
    seen.add(target);
    const token = extractTargetToken(target);
    if (protectedTokens.has(token)) {
      fail("E_K3S_PRUNE_TARGET_GUARD", `protected token ${token} found in pruneTargets: ${target}`);
    }
  }
}

function validateExplicitPreviousToken(explicitPreviousToken, activeToken, configMapsByToken, secretsByToken) {
  const isValidFormat = typeof explicitPreviousToken === "string" && CANDIDATE_TOKEN_PATTERN.test(explicitPreviousToken);
  if (!isValidFormat || explicitPreviousToken === activeToken) {
    fail(
      "E_K3S_PRUNE_PREVIOUS_INVALID",
      `--previous-token must be a valid inactive candidate token (got ${String(explicitPreviousToken)})`,
    );
  }
  if (!configMapsByToken.has(explicitPreviousToken) || !secretsByToken.has(explicitPreviousToken)) {
    fail(
      "E_K3S_PRUNE_PREVIOUS_INCOMPLETE",
      `specified previous candidate ${explicitPreviousToken} is missing ConfigMap or Secret`,
    );
  }
  return explicitPreviousToken;
}

function selectNewestInactiveToken(inactiveTokens, configMapsByToken, secretsByToken) {
  const ranked = inactiveTokens.map((token) => {
    const cfg = configMapsByToken.get(token);
    const sec = secretsByToken.get(token);
    if (!cfg || !sec) {
      fail(
        "E_K3S_PRUNE_PREVIOUS_INCOMPLETE",
        `inactive candidate ${token} has an incomplete ConfigMap/Secret pair`,
      );
    }
    const cfgTs = parseIsoTimestamp(cfg.creationTimestamp, cfg.name);
    const secTs = parseIsoTimestamp(sec.creationTimestamp, sec.name);
    return {
      token,
      minTimestampMs: Math.min(cfgTs, secTs),
      maxTimestampMs: Math.max(cfgTs, secTs),
    };
  });
  ranked.sort((left, right) => right.maxTimestampMs - left.maxTimestampMs);
  if (ranked.length >= 2 && ranked[0].minTimestampMs <= ranked[1].maxTimestampMs) {
    fail(
      "E_K3S_PRUNE_PREVIOUS_AMBIGUOUS",
      `top inactive candidates ${ranked[0].token} and ${ranked[1].token} have overlapping or identical creationTimestamp; pass --previous-token explicitly`,
    );
  }
  return ranked[0].token;
}

function resolvePreviousToken({
  explicitPreviousToken,
  activeToken,
  inactiveTokens,
  configMapsByToken,
  secretsByToken,
}) {
  if (explicitPreviousToken !== undefined && explicitPreviousToken !== null) {
    return validateExplicitPreviousToken(explicitPreviousToken, activeToken, configMapsByToken, secretsByToken);
  }
  if (inactiveTokens.length === 0) {
    return null;
  }
  return selectNewestInactiveToken(inactiveTokens, configMapsByToken, secretsByToken);
}

export function planK3sCandidateConfigPrune(
  snapshot,
  { previousToken: explicitPreviousToken = undefined } = {},
) {
  if (!snapshot || typeof snapshot !== "object") {
    fail("E_K3S_PRUNE_USAGE", "cluster snapshot is required");
  }
  const activeToken = extractActiveToken(snapshot.activeService);
  validateActiveDeployments(snapshot.deployments, activeToken);

  const configMapsByToken = collectCandidateObjects(
    snapshot.configMaps,
    "journey-config-",
    CONFIG_NAME_PATTERN,
    "ConfigMap",
  );
  const secretsByToken = collectCandidateObjects(
    snapshot.secrets,
    "journey-secret-",
    SECRET_NAME_PATTERN,
    "Secret",
  );

  if (!configMapsByToken.has(activeToken) || !secretsByToken.has(activeToken)) {
    fail(
      "E_K3S_PRUNE_ACTIVE_INCOMPLETE",
      `active candidate ${activeToken} is missing journey-config-${activeToken} or journey-secret-${activeToken}`,
    );
  }

  const allTokens = [...new Set([...configMapsByToken.keys(), ...secretsByToken.keys()])].sort(compareStrings);
  const inactiveTokens = allTokens.filter((token) => token !== activeToken);
  const resolvedPreviousToken = resolvePreviousToken({
    explicitPreviousToken,
    activeToken,
    inactiveTokens,
    configMapsByToken,
    secretsByToken,
  });

  const retainedTokens = [
    activeToken,
    ...(resolvedPreviousToken ? [resolvedPreviousToken] : []),
  ];
  const retainedTokenSet = new Set(retainedTokens);

  const pruneConfigMaps = [];
  const pruneSecrets = [];
  for (const token of allTokens) {
    if (retainedTokenSet.has(token)) continue;
    const cfg = configMapsByToken.get(token);
    const sec = secretsByToken.get(token);
    if (cfg) pruneConfigMaps.push(cfg.name);
    if (sec) pruneSecrets.push(sec.name);
  }
  pruneConfigMaps.sort(compareStrings);
  pruneSecrets.sort(compareStrings);

  const kubectlResources = [
    ...pruneConfigMaps.map((name) => `configmap/${name}`),
    ...pruneSecrets.map((name) => `secret/${name}`),
  ];

  assertSafePruneTargets(preloadTargetCheck(pruneConfigMaps, pruneSecrets, kubectlResources), {
    activeToken,
    previousToken: resolvedPreviousToken,
  });

  return {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_CONFIG_PRUNE_V1",
    namespace: NAMESPACE,
    activeToken,
    previousToken: resolvedPreviousToken,
    retained: {
      tokens: retainedTokens,
      configMaps: retainedTokens.map((token) => `journey-config-${token}`),
      secrets: retainedTokens.map((token) => `journey-secret-${token}`),
    },
    pruneTargets: {
      configMaps: pruneConfigMaps,
      secrets: pruneSecrets,
      kubectlResources,
    },
    counts: {
      totalCandidates: allTokens.length,
      retainedConfigMaps: retainedTokens.length,
      retainedSecrets: retainedTokens.length,
      pruneConfigMaps: pruneConfigMaps.length,
      pruneSecrets: pruneSecrets.length,
      deletedResources: 0,
    },
  };
}

function preloadTargetCheck(pruneConfigMaps, pruneSecrets, kubectlResources) {
  return [...pruneConfigMaps, ...pruneSecrets, ...kubectlResources];
}

async function readClusterSnapshot(kubectlExec) {
  const [activeServiceRes, deploymentsRes, configMapsRes, secretsRes] = await Promise.all([
    kubectlExec(["get", "service", ACTIVE_SERVICE_NAME, "--namespace", NAMESPACE, "--ignore-not-found", "-o", "json"]),
    kubectlExec(["get", "deployments", "--namespace", NAMESPACE, "-o", "json"]),
    kubectlExec(["get", "configmaps", "--namespace", NAMESPACE, "-o", "json"]),
    kubectlExec(["get", "secrets", "--namespace", NAMESPACE, "-o", SECRET_JSONPATH]),
  ]);

  const activeServiceText = String(activeServiceRes?.stdout ?? "").trim();
  const activeService = activeServiceText ? JSON.parse(activeServiceText) : null;
  const deployments = JSON.parse(String(deploymentsRes?.stdout || '{"items":[]}')).items ?? [];
  const configMaps = JSON.parse(String(configMapsRes?.stdout || '{"items":[]}')).items ?? [];

  const secrets = String(secretsRes?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, creationTimestamp] = line.split("\t");
      return {
        metadata: {
          name,
          namespace: NAMESPACE,
          ...(creationTimestamp ? { creationTimestamp } : {}),
        },
      };
    });

  return { activeService, deployments, configMaps, secrets };
}

function listCandidateResourceNames(items, prefix) {
  return (items ?? [])
    .map((item) => item?.metadata?.name)
    .filter((name) => typeof name === "string" && name.startsWith(prefix))
    .sort(compareStrings);
}

function filterPostDeleteSnapshot(resolvedSnapshot, finalKubectlResources) {
  return {
    configMaps: resolvedSnapshot.configMaps.filter(
      (item) => !finalKubectlResources.includes(`configmap/${item?.metadata?.name}`),
    ),
    secrets: resolvedSnapshot.secrets.filter(
      (item) => !finalKubectlResources.includes(`secret/${item?.metadata?.name}`),
    ),
  };
}

function validateModeAndApproval(mode, qaApproval) {
  if (mode !== "DRY_RUN" && mode !== "EXECUTE") {
    fail("E_K3S_PRUNE_USAGE", `mode must be DRY_RUN or EXECUTE (got ${String(mode)})`);
  }
  if (mode === "EXECUTE" && (typeof qaApproval !== "string" || qaApproval.trim().length === 0)) {
    fail(
      "E_K3S_PRUNE_APPROVAL_REQUIRED",
      "EXECUTE mode requires explicit QA approval (--confirm-qa-approval <non-empty-string>)",
    );
  }
}

export async function pruneK3sCandidateConfigs({
  mode = "DRY_RUN",
  qaApproval = undefined,
  previousToken = undefined,
  snapshot = undefined,
  plan: providedPlan = undefined,
  commandRunner = defaultCommandRunner,
  kubectlPrefix = ["sudo", "--non-interactive", "k3s", "kubectl"],
} = {}) {
  validateModeAndApproval(mode, qaApproval);

  const [kubectlCmd, ...kubectlBaseArgs] = kubectlPrefix;
  const kubectlExec = (args) => commandRunner(kubectlCmd, [...kubectlBaseArgs, ...args]);

  const resolvedSnapshot = providedPlan && snapshot === undefined
    ? undefined
    : (snapshot ?? (await readClusterSnapshot(kubectlExec)));
  const plan = providedPlan ?? planK3sCandidateConfigPrune(resolvedSnapshot, { previousToken });

  const finalConfigMaps = plan?.pruneTargets?.configMaps ?? [];
  const finalSecrets = plan?.pruneTargets?.secrets ?? [];
  const finalKubectlResources = plan?.pruneTargets?.kubectlResources ?? [];

  assertSafePruneTargets(
    preloadTargetCheck(finalConfigMaps, finalSecrets, finalKubectlResources),
    {
      activeToken: plan?.activeToken,
      previousToken: plan?.previousToken,
    },
  );

  if (mode === "DRY_RUN") {
    return {
      ...plan,
      mode: "DRY_RUN",
    };
  }

  const shouldInvokeClusterDelete = snapshot === undefined || commandRunner !== defaultCommandRunner;
  if (shouldInvokeClusterDelete && finalKubectlResources.length > 0) {
    await kubectlExec([
      "delete",
      ...finalKubectlResources,
      "--namespace",
      NAMESPACE,
      "--wait=true",
    ]);
  }

  const postSnapshot = resolvedSnapshot
    ? filterPostDeleteSnapshot(resolvedSnapshot, finalKubectlResources)
    : await readClusterSnapshot(kubectlExec);

  const remainingConfigMaps = listCandidateResourceNames(postSnapshot.configMaps, "journey-config-");
  const remainingSecrets = listCandidateResourceNames(postSnapshot.secrets, "journey-secret-");
  const expectedRetainedConfigs = [...plan.retained.configMaps].sort(compareStrings);
  const expectedRetainedSecrets = [...plan.retained.secrets].sort(compareStrings);

  if (
    JSON.stringify(remainingConfigMaps) !== JSON.stringify(expectedRetainedConfigs) ||
    JSON.stringify(remainingSecrets) !== JSON.stringify(expectedRetainedSecrets)
  ) {
    fail(
      "E_K3S_PRUNE_POST_VERIFY_FAILED",
      `remaining candidate objects do not match retention policy: configMaps=${remainingConfigMaps.join(",")} secrets=${remainingSecrets.join(",")}`,
    );
  }

  return {
    ...plan,
    mode: "EXECUTE",
    qaApproval: qaApproval.trim(),
    remaining: {
      configMaps: remainingConfigMaps,
      secrets: remainingSecrets,
    },
    counts: {
      ...plan.counts,
      deletedResources: finalKubectlResources.length,
      remainingConfigMaps: remainingConfigMaps.length,
      remainingSecrets: remainingSecrets.length,
    },
  };
}

function readNextFlagValue(argv, index, errorMessage) {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    fail("E_K3S_PRUNE_USAGE", errorMessage);
  }
  return next;
}

function parseCliArgs(argv) {
  let mode = "DRY_RUN";
  let explicitDryRun = false;
  let explicitExecute = false;
  let qaApproval;
  let previousToken;
  let snapshotFile;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      explicitDryRun = true;
      mode = "DRY_RUN";
    } else if (arg === "--execute") {
      explicitExecute = true;
      mode = "EXECUTE";
    } else if (arg === "--confirm-qa-approval") {
      const next = argv[index + 1];
      const hasValue = next !== undefined && !next.startsWith("--");
      qaApproval = hasValue ? next : "";
      if (hasValue) index += 1;
    } else if (arg === "--previous-token") {
      previousToken = readNextFlagValue(argv, index, "--previous-token requires a value");
      index += 1;
    } else if (arg === "--snapshot-file") {
      snapshotFile = readNextFlagValue(argv, index, "--snapshot-file requires a file path");
      index += 1;
    } else {
      fail("E_K3S_PRUNE_USAGE", `unknown argument: ${arg}`);
    }
  }

  if (explicitDryRun && explicitExecute) {
    fail("E_K3S_PRUNE_USAGE", "cannot specify both --dry-run and --execute");
  }

  return { mode, qaApproval, previousToken, snapshotFile };
}

async function main() {
  try {
    const { mode, qaApproval, previousToken, snapshotFile } = parseCliArgs(process.argv.slice(2));
    const snapshot = snapshotFile ? JSON.parse(readFileSync(snapshotFile, "utf8")) : undefined;
    const result = await pruneK3sCandidateConfigs({
      mode,
      qaApproval,
      previousToken,
      snapshot,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
