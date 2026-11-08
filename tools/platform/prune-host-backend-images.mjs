#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const NAMESPACE = "easysubway-journey";
export const ACTIVE_SERVICE_NAME = "journey-active";
export const DEFAULT_KEEP_COUNT = 3;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const EMBEDDED_DIGEST_PATTERN = /sha256:[a-f0-9]{64}/gi;
const BARE_HEX64_PATTERN = /^[a-f0-9]{64}$/i;
const CONFIG_NAME_PREFIX = "journey-config-";

export class HostBackendImagePruneError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "HostBackendImagePruneError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new HostBackendImagePruneError(
    code,
    message,
    cause !== undefined ? { cause } : undefined,
  );
}

async function defaultCommandRunner(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export function isBackendImageReference(image) {
  if (typeof image !== "string" || image.trim() === "") return false;
  const repository = image.trim().split("@")[0].replace(/:[^/]*$/, "");
  const lastSegment = repository.split("/").pop() ?? "";
  return lastSegment.startsWith("easysubway-backend");
}

function normalizeDigest(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (DIGEST_PATTERN.test(trimmed)) return trimmed;
  if (BARE_HEX64_PATTERN.test(trimmed)) return `sha256:${trimmed}`;
  return null;
}

function normalizeImageId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return null;
  if (DIGEST_PATTERN.test(trimmed)) return trimmed;
  if (BARE_HEX64_PATTERN.test(trimmed)) return `sha256:${trimmed}`;
  return trimmed;
}

function recordImageReference(rawValue, protectedDigests, protectedImageIds) {
  if (typeof rawValue !== "string" || rawValue.trim() === "") return;
  const trimmed = rawValue.trim();
  const normalizedId = normalizeImageId(trimmed);
  if (normalizedId) {
    protectedImageIds.add(normalizedId);
  }
  const matches = trimmed.match(EMBEDDED_DIGEST_PATTERN) ?? [];
  for (const match of matches) {
    const lower = match.toLowerCase();
    protectedDigests.add(lower);
    protectedImageIds.add(lower);
  }
}

function collectPodProtection(podsPayload, protectedDigests, protectedImageIds) {
  const pods = Array.isArray(podsPayload?.items) ? podsPayload.items : [];
  for (const pod of pods) {
    const phase = pod?.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") continue;

    const specContainers = [
      ...(pod?.spec?.containers ?? []),
      ...(pod?.spec?.initContainers ?? []),
      ...(pod?.spec?.ephemeralContainers ?? []),
    ];
    for (const container of specContainers) {
      recordImageReference(container?.image, protectedDigests, protectedImageIds);
    }

    const statusContainers = [
      ...(pod?.status?.containerStatuses ?? []),
      ...(pod?.status?.initContainerStatuses ?? []),
      ...(pod?.status?.ephemeralContainerStatuses ?? []),
    ];
    for (const status of statusContainers) {
      recordImageReference(status?.image, protectedDigests, protectedImageIds);
      recordImageReference(status?.imageID, protectedDigests, protectedImageIds);
    }
  }
}

function extractConfigMapBackendDigest(configMap) {
  const candidates = [
    configMap?.data?.EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST,
    configMap?.data?.["backend-image-digest"],
    configMap?.metadata?.annotations?.["easysubway.io/backend-image-digest"],
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDigest(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function collectJourneyResourceProtection(journeyPayload, protectedDigests, protectedImageIds) {
  const items = Array.isArray(journeyPayload?.items) ? journeyPayload.items : [];
  let activeToken = null;

  for (const item of items) {
    const kind = item?.kind ?? "";
    const name = item?.metadata?.name ?? "";
    if (kind === "Service" || name === ACTIVE_SERVICE_NAME) {
      if (name === ACTIVE_SERVICE_NAME) {
        const selector = item?.spec?.selector ?? {};
        activeToken =
          selector["easysubway.io/candidate-token"] ??
          selector["easysubway.io/candidate"] ??
          activeToken;
      }
      recordImageReference(
        item?.metadata?.annotations?.["easysubway.io/backend-image-digest"],
        protectedDigests,
        protectedImageIds,
      );
      recordImageReference(
        item?.metadata?.annotations?.["easysubway.io/previous-backend-image-digest"],
        protectedDigests,
        protectedImageIds,
      );
    } else if (kind === "Deployment" || name.startsWith("journey-candidate-")) {
      recordImageReference(
        item?.metadata?.annotations?.["easysubway.io/backend-image-digest"],
        protectedDigests,
        protectedImageIds,
      );
      recordImageReference(
        item?.spec?.template?.metadata?.annotations?.["easysubway.io/backend-image-digest"],
        protectedDigests,
        protectedImageIds,
      );
      const containers = [
        ...(item?.spec?.template?.spec?.containers ?? []),
        ...(item?.spec?.template?.spec?.initContainers ?? []),
      ];
      for (const container of containers) {
        recordImageReference(container?.image, protectedDigests, protectedImageIds);
      }
    }
  }

  const candidateConfigMaps = items.filter((item) => {
    const name = item?.metadata?.name ?? "";
    return (item?.kind === "ConfigMap" || name.startsWith(CONFIG_NAME_PREFIX)) &&
      name.startsWith(CONFIG_NAME_PREFIX);
  });

  const inactiveWithDigest = [];
  for (let index = 0; index < candidateConfigMaps.length; index += 1) {
    const cm = candidateConfigMaps[index];
    const name = cm.metadata.name;
    const token = name.slice(CONFIG_NAME_PREFIX.length);
    const digest = extractConfigMapBackendDigest(cm);
    if (!digest) continue;

    if (activeToken && token === activeToken) {
      protectedDigests.add(digest);
      protectedImageIds.add(digest);
    } else {
      const parsedTs = Date.parse(cm?.metadata?.creationTimestamp ?? "");
      inactiveWithDigest.push({
        token,
        digest,
        timestampMs: Number.isFinite(parsedTs) ? parsedTs : -Infinity,
        index,
      });
    }
  }

  inactiveWithDigest.sort((left, right) => {
    if (right.timestampMs !== left.timestampMs) {
      return right.timestampMs - left.timestampMs;
    }
    return right.index - left.index;
  });

  const protectFromInactiveCount = activeToken ? 1 : 2;
  for (const entry of inactiveWithDigest.slice(0, protectFromInactiveCount)) {
    protectedDigests.add(entry.digest);
    protectedImageIds.add(entry.digest);
  }
}

export function assertSafeImagePruneTargets(
  targets,
  { protectedDigests = new Set(), protectedImageIds = new Set() } = {},
) {
  if (!Array.isArray(targets)) {
    fail("E_IMAGE_PRUNE_PROTECTED_TARGET", "prune targets must be an array");
  }
  const normalizedProtectedDigests = new Set(
    [...protectedDigests].map((d) => normalizeDigest(d) ?? String(d).toLowerCase()),
  );
  const normalizedProtectedIds = new Set(
    [...protectedImageIds].map((id) => normalizeImageId(id) ?? String(id).toLowerCase()),
  );

  for (const target of targets) {
    const rawId = typeof target === "string" ? target : target?.id;
    const normalizedId = normalizeImageId(rawId);
    if (
      !rawId ||
      normalizedProtectedIds.has(normalizedId) ||
      normalizedProtectedIds.has(String(rawId).toLowerCase()) ||
      normalizedProtectedDigests.has(normalizedId)
    ) {
      fail(
        "E_IMAGE_PRUNE_PROTECTED_TARGET",
        `refusing to prune protected image ID: ${String(rawId)}`,
      );
    }
    const digests = Array.isArray(target?.digests) ? target.digests : [];
    for (const digestValue of digests) {
      const normalizedDigest = normalizeDigest(digestValue) ?? String(digestValue).toLowerCase();
      if (
        normalizedProtectedDigests.has(normalizedDigest) ||
        normalizedProtectedIds.has(normalizedDigest)
      ) {
        fail(
          "E_IMAGE_PRUNE_PROTECTED_TARGET",
          `refusing to prune image ${rawId} with protected digest ${digestValue}`,
        );
      }
    }
  }
}

function isImageProtected(entry, protectedDigests, protectedImageIds) {
  if (entry.pinned === true) return true;
  const normalizedId = normalizeImageId(entry.id);
  if (
    normalizedId &&
    (protectedImageIds.has(normalizedId) || protectedDigests.has(normalizedId))
  ) {
    return true;
  }
  if (protectedImageIds.has(entry.id) || protectedDigests.has(entry.id)) {
    return true;
  }
  for (const digestValue of entry.digests) {
    const normalizedDigest = normalizeDigest(digestValue) ?? digestValue.toLowerCase();
    if (
      protectedDigests.has(normalizedDigest) ||
      protectedImageIds.has(normalizedDigest)
    ) {
      return true;
    }
  }
  return false;
}

function planCrictlBackendImagePrune(
  crictlPayload,
  { keepCount, protectedDigests, protectedImageIds },
) {
  const rawImages = Array.isArray(crictlPayload?.images) ? crictlPayload.images : [];
  const byId = new Map();

  for (const img of rawImages) {
    const id = typeof img?.id === "string" ? img.id.trim() : "";
    if (!id) continue;
    const repoTags = Array.isArray(img?.repoTags) ? img.repoTags : [];
    const repoDigests = Array.isArray(img?.repoDigests) ? img.repoDigests : [];
    const refs = [...repoTags, ...repoDigests];
    if (!refs.some(isBackendImageReference)) continue;

    const extractedDigests = new Set();
    for (const ref of repoDigests) {
      const matches = String(ref).match(EMBEDDED_DIGEST_PATTERN) ?? [];
      for (const match of matches) {
        extractedDigests.add(match.toLowerCase());
      }
    }

    const existing = byId.get(id);
    if (existing) {
      for (const d of extractedDigests) existing.digests.add(d);
      if (img?.pinned === true) existing.pinned = true;
    } else {
      byId.set(id, {
        id,
        pinned: img?.pinned === true,
        digests: extractedDigests,
      });
    }
  }

  const backendImages = [...byId.values()].map((entry) => ({
    id: entry.id,
    pinned: entry.pinned,
    digests: [...entry.digests],
  }));

  const keptImageIds = [];
  const pruneTargets = [];

  for (let index = 0; index < backendImages.length; index += 1) {
    const entry = backendImages[index];
    const withinKeepCount = index < keepCount;
    const protectedEntry = isImageProtected(entry, protectedDigests, protectedImageIds);
    if (withinKeepCount || protectedEntry) {
      keptImageIds.push(entry.id);
    } else {
      pruneTargets.push(entry);
    }
  }

  assertSafeImagePruneTargets(pruneTargets, { protectedDigests, protectedImageIds });

  return {
    totalBackendImages: backendImages.length,
    keptImageIds,
    pruneTargets,
    pruneTargetIds: pruneTargets.map((entry) => entry.id),
  };
}

function planDockerBackendImagePrune(
  dockerImagesStdout,
  { keepCount, protectedDigests, protectedImageIds },
) {
  const lines = String(dockerImagesStdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const byId = new Map();
  for (const line of lines) {
    const [repository = "", id = "", rawDigest = ""] = line.split("\t");
    const trimmedRepo = repository.trim();
    const trimmedId = id.trim();
    if (!trimmedId || !isBackendImageReference(trimmedRepo)) continue;

    const normalizedDigest = normalizeDigest(rawDigest);
    const existing = byId.get(trimmedId);
    if (existing) {
      if (normalizedDigest) existing.digests.add(normalizedDigest);
    } else {
      const digests = new Set();
      if (normalizedDigest) digests.add(normalizedDigest);
      byId.set(trimmedId, {
        id: trimmedId,
        digests,
      });
    }
  }

  const backendImages = [...byId.values()].map((entry) => ({
    id: entry.id,
    pinned: false,
    digests: [...entry.digests],
  }));

  const keptImageIds = [];
  const pruneTargets = [];

  for (let index = 0; index < backendImages.length; index += 1) {
    const entry = backendImages[index];
    const withinKeepCount = index < keepCount;
    const protectedEntry = isImageProtected(entry, protectedDigests, protectedImageIds);
    if (withinKeepCount || protectedEntry) {
      keptImageIds.push(entry.id);
    } else {
      pruneTargets.push(entry);
    }
  }

  assertSafeImagePruneTargets(pruneTargets, { protectedDigests, protectedImageIds });

  return {
    totalBackendImages: backendImages.length,
    keptImageIds,
    pruneTargets,
    pruneTargetIds: pruneTargets.map((entry) => entry.id),
  };
}

function validateOptions({ mode, keepCount, activeDigest, previousDigest }) {
  if (mode !== "DRY_RUN" && mode !== "EXECUTE") {
    fail("E_IMAGE_PRUNE_USAGE", `mode must be DRY_RUN or EXECUTE (got ${String(mode)})`);
  }
  if (!Number.isSafeInteger(keepCount) || keepCount < 1) {
    fail("E_IMAGE_PRUNE_USAGE", `keepCount must be a positive integer (got ${String(keepCount)})`);
  }
  if (activeDigest !== undefined && activeDigest !== null && !normalizeDigest(activeDigest)) {
    fail("E_IMAGE_PRUNE_USAGE", `activeDigest must be sha256:<64hex> (got ${String(activeDigest)})`);
  }
  if (previousDigest !== undefined && previousDigest !== null && !normalizeDigest(previousDigest)) {
    fail(
      "E_IMAGE_PRUNE_USAGE",
      `previousDigest must be sha256:<64hex> (got ${String(previousDigest)})`,
    );
  }
}

export async function pruneHostBackendImages({
  mode = "DRY_RUN",
  keepCount = DEFAULT_KEEP_COUNT,
  activeDigest = undefined,
  previousDigest = undefined,
  bestEffort = false,
  commandRunner = defaultCommandRunner,
  kubectlPrefix = ["sudo", "--non-interactive", "k3s", "kubectl"],
  crictlPrefix = ["sudo", "--non-interactive", "k3s", "crictl"],
  dockerPrefix = ["docker"],
} = {}) {
  validateOptions({ mode, keepCount, activeDigest, previousDigest });

  const protectedDigests = new Set();
  const protectedImageIds = new Set();
  const warnings = [];

  if (activeDigest) {
    const normalized = normalizeDigest(activeDigest);
    protectedDigests.add(normalized);
    protectedImageIds.add(normalized);
  }
  if (previousDigest) {
    const normalized = normalizeDigest(previousDigest);
    protectedDigests.add(normalized);
    protectedImageIds.add(normalized);
  }

  const [kubectlCmd, ...kubectlBaseArgs] = kubectlPrefix;
  const [crictlCmd, ...crictlBaseArgs] = crictlPrefix;
  const [dockerCmd, ...dockerBaseArgs] = dockerPrefix;

  const kubectlExec = (args) => commandRunner(kubectlCmd, [...kubectlBaseArgs, ...args]);
  const crictlExec = (args) => commandRunner(crictlCmd, [...crictlBaseArgs, ...args]);
  const dockerExec = (args) => commandRunner(dockerCmd, [...dockerBaseArgs, ...args]);

  let k3sPlan = {
    totalBackendImages: 0,
    keptImageIds: [],
    pruneTargets: [],
    pruneTargetIds: [],
  };
  const k3sRemovedImageIds = [];

  try {
    const [podsRes, journeyRes] = await Promise.all([
      kubectlExec(["get", "pods", "-A", "-o", "json"]),
      kubectlExec(["-n", NAMESPACE, "get", "deployment,service,configmap", "-o", "json"]),
    ]);
    const podsPayload = JSON.parse(String(podsRes?.stdout || '{"items":[]}'));
    const journeyPayload = JSON.parse(String(journeyRes?.stdout || '{"items":[]}'));
    collectPodProtection(podsPayload, protectedDigests, protectedImageIds);
    collectJourneyResourceProtection(journeyPayload, protectedDigests, protectedImageIds);

    const crictlRes = await crictlExec(["images", "-o", "json"]);
    const crictlPayload = JSON.parse(String(crictlRes?.stdout || '{"images":[]}'));
    k3sPlan = planCrictlBackendImagePrune(crictlPayload, {
      keepCount,
      protectedDigests,
      protectedImageIds,
    });

    if (mode === "EXECUTE") {
      for (const target of k3sPlan.pruneTargets) {
        try {
          await crictlExec(["rmi", target.id]);
          k3sRemovedImageIds.push(target.id);
        } catch (rmiError) {
          if (!bestEffort) {
            fail(
              "E_IMAGE_PRUNE_K3S_RMI_FAILED",
              `failed to remove K3s image ${target.id}: ${rmiError?.message ?? String(rmiError)}`,
              rmiError,
            );
          }
          warnings.push(
            `k3s crictl rmi failed for ${target.id}: ${rmiError?.message ?? String(rmiError)}`,
          );
        }
      }
    }
  } catch (k3sError) {
    if (k3sError instanceof HostBackendImagePruneError && k3sError.code === "E_IMAGE_PRUNE_PROTECTED_TARGET") {
      throw k3sError;
    }
    if (!bestEffort) {
      if (k3sError instanceof HostBackendImagePruneError) throw k3sError;
      fail(
        "E_IMAGE_PRUNE_K3S_FAILED",
        `K3s image prune failed: ${k3sError?.message ?? String(k3sError)}`,
        k3sError,
      );
    }
    warnings.push(`K3s image inspection/prune skipped: ${k3sError?.message ?? String(k3sError)}`);
  }

  let dockerPlan = {
    totalBackendImages: 0,
    keptImageIds: [],
    pruneTargets: [],
    pruneTargetIds: [],
  };
  const dockerRemovedImageIds = [];
  let dockerDanglingPruned = false;

  try {
    const psRes = await dockerExec(["ps", "-q"]);
    const runningContainerIds = String(psRes?.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (runningContainerIds.length > 0) {
      const inspectRes = await dockerExec([
        "inspect",
        "--format",
        "{{.Image}}",
        ...runningContainerIds,
      ]);
      const runningImageIds = String(inspectRes?.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const runningImageId of runningImageIds) {
        recordImageReference(runningImageId, protectedDigests, protectedImageIds);
      }
    }

    const imagesRes = await dockerExec([
      "images",
      "--no-trunc",
      "--format",
      "{{.Repository}}\t{{.ID}}\t{{.Digest}}",
    ]);
    dockerPlan = planDockerBackendImagePrune(imagesRes?.stdout ?? "", {
      keepCount,
      protectedDigests,
      protectedImageIds,
    });

    if (mode === "EXECUTE") {
      for (const target of dockerPlan.pruneTargets) {
        try {
          await dockerExec(["rmi", "-f", target.id]);
          dockerRemovedImageIds.push(target.id);
        } catch (rmiError) {
          if (!bestEffort) {
            fail(
              "E_IMAGE_PRUNE_DOCKER_RMI_FAILED",
              `failed to remove Docker image ${target.id}: ${rmiError?.message ?? String(rmiError)}`,
              rmiError,
            );
          }
          warnings.push(
            `docker rmi -f failed for ${target.id}: ${rmiError?.message ?? String(rmiError)}`,
          );
        }
      }

      try {
        await dockerExec(["image", "prune", "-f"]);
        dockerDanglingPruned = true;
      } catch (pruneError) {
        if (!bestEffort) {
          fail(
            "E_IMAGE_PRUNE_DOCKER_PRUNE_FAILED",
            `docker image prune -f failed: ${pruneError?.message ?? String(pruneError)}`,
            pruneError,
          );
        }
        warnings.push(`docker image prune -f failed: ${pruneError?.message ?? String(pruneError)}`);
      }
    }
  } catch (dockerError) {
    if (
      dockerError instanceof HostBackendImagePruneError &&
      dockerError.code === "E_IMAGE_PRUNE_PROTECTED_TARGET"
    ) {
      throw dockerError;
    }
    if (!bestEffort) {
      if (dockerError instanceof HostBackendImagePruneError) throw dockerError;
      fail(
        "E_IMAGE_PRUNE_DOCKER_FAILED",
        `Docker image prune failed: ${dockerError?.message ?? String(dockerError)}`,
        dockerError,
      );
    }
    warnings.push(
      `Docker image inspection/prune skipped: ${dockerError?.message ?? String(dockerError)}`,
    );
  }

  return {
    schemaVersion: "PLATFORM_HOST_BACKEND_IMAGE_PRUNE_V1",
    status: warnings.length > 0 ? "DEGRADED" : "OK",
    mode,
    keepCount,
    bestEffort,
    k3sRemovedCount: k3sRemovedImageIds.length,
    dockerRemovedCount: dockerRemovedImageIds.length,
    protectedDigests: [...protectedDigests].sort((a, b) => a.localeCompare(b)),
    protectedImageIds: [...protectedImageIds].sort((a, b) => a.localeCompare(b)),
    k3s: {
      totalBackendImages: k3sPlan.totalBackendImages,
      keptImageIds: k3sPlan.keptImageIds,
      pruneTargetIds: k3sPlan.pruneTargetIds,
      removedImageIds: k3sRemovedImageIds,
    },
    docker: {
      totalBackendImages: dockerPlan.totalBackendImages,
      keptImageIds: dockerPlan.keptImageIds,
      pruneTargetIds: dockerPlan.pruneTargetIds,
      removedImageIds: dockerRemovedImageIds,
      danglingPruned: dockerDanglingPruned,
    },
    warnings,
  };
}

function readNextFlagValue(argv, index, flagName) {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    fail("E_IMAGE_PRUNE_USAGE", `${flagName} requires a value`);
  }
  return next;
}

export function parseCliArgs(argv) {
  let mode = "DRY_RUN";
  let keepCount = DEFAULT_KEEP_COUNT;
  let activeDigest;
  let previousDigest;
  let bestEffort = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      mode = readNextFlagValue(argv, index, "--mode");
      index += 1;
    } else if (arg === "--dry-run") {
      mode = "DRY_RUN";
    } else if (arg === "--execute") {
      mode = "EXECUTE";
    } else if (arg === "--keep-count") {
      const rawCount = readNextFlagValue(argv, index, "--keep-count");
      if (!/^[1-9]\d*$/.test(rawCount)) {
        fail("E_IMAGE_PRUNE_USAGE", `--keep-count must be a positive integer (got ${rawCount})`);
      }
      keepCount = Number(rawCount);
      index += 1;
    } else if (arg === "--active-digest") {
      activeDigest = readNextFlagValue(argv, index, "--active-digest");
      index += 1;
    } else if (arg === "--previous-digest") {
      previousDigest = readNextFlagValue(argv, index, "--previous-digest");
      index += 1;
    } else if (arg === "--best-effort") {
      bestEffort = true;
    } else {
      fail("E_IMAGE_PRUNE_USAGE", `unknown argument: ${arg}`);
    }
  }

  validateOptions({ mode, keepCount, activeDigest, previousDigest });
  return { mode, keepCount, activeDigest, previousDigest, bestEffort };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const bestEffortRequested = rawArgs.includes("--best-effort");
  try {
    const options = parseCliArgs(rawArgs);
    const result = await pruneHostBackendImages(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (bestEffortRequested && !(error instanceof HostBackendImagePruneError && error.code === "E_IMAGE_PRUNE_USAGE")) {
      const fallbackSummary = {
        schemaVersion: "PLATFORM_HOST_BACKEND_IMAGE_PRUNE_V1",
        status: "DEGRADED",
        k3sRemovedCount: 0,
        dockerRemovedCount: 0,
        protectedDigests: [],
        warnings: [message],
      };
      process.stdout.write(`${JSON.stringify(fallbackSummary, null, 2)}\n`);
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
