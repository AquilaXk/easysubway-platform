#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIR, "../..");

const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1_000;
const MS_PER_DAY = SECONDS_PER_DAY * MS_PER_SECOND;
export const MIN_TLS_VALIDITY_DAYS = 7;
const MIN_TLS_VALIDITY_MS = MIN_TLS_VALIDITY_DAYS * MS_PER_DAY;

export const MAX_CONFIG_FILE_BYTES = 1_048_576;
export const MAX_BACKUP_DUMP_BYTES = 536_870_912;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const BACKUP_DUMP_FILENAME_PATTERN =
  /^(easysubway-)?postgres-(\d{8}T\d{6}Z)(\.[A-Za-z0-9]+)?\.dump$/;
const DOTENV_LINE_PATTERN = /^([A-Z0-9_]+)=(.*)$/;
const ACTIVE_RUNNER_UNIT_PATTERN =
  /^(actions\.runner\.[A-Za-z0-9._@-]+\.service)\s+\S+\s+active\b/;

export const EXPECTED_STAGE_ORDER = Object.freeze([
  "DATA_VOLUME_AND_DOCKER",
  "ORIGIN_TLS_AND_HOST_NGINX",
  "ENV_AND_BACKUP_RESTORE_INPUTS",
  "SINGLE_NODE_K3S_BOOTSTRAP",
  "BACKUP_ALERT_SUBSCRIPTION_AND_OBSERVABILITY",
  "SELF_HOSTED_RUNNER_SERVICE",
]);

export const REQUIRED_NGINX_CONFIG_RELATIVE_PATHS = Object.freeze([
  "nginx.conf",
  "conf.d/easysubway.conf",
  "conf.d/default-proxy.conf",
  "conf.d/real-ip.conf",
]);

export const REQUIRED_K3S_RBAC_RELATIVE_PATHS = Object.freeze([
  "infra/k3s/deployer-rbac.json",
  "infra/k3s/data-workflow-scheduler-rbac.json",
  "infra/k3s/source-reachability-probe-rbac.json",
]);

export const DEFAULT_REQUIRED_ENV_KEYS = Object.freeze([
  "EASYSUBWAY_POSTGRES_DB",
  "EASYSUBWAY_POSTGRES_USER",
  "EASYSUBWAY_POSTGRES_PASSWORD",
  "EASYSUBWAY_DATASOURCE_URL",
  "EASYSUBWAY_DATASOURCE_USERNAME",
  "EASYSUBWAY_DATASOURCE_PASSWORD",
  "EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY",
  "EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY",
  "EASYSUBWAY_REPORT_UPLOAD_BUCKET",
  "EASYSUBWAY_REPORT_RECEIPT_PEPPER",
  "EASYSUBWAY_REPORT_UPLOAD_INTENT_SIGNING_KEY",
  "EASYSUBWAY_ADMIN_USERNAME",
  "EASYSUBWAY_ADMIN_PASSWORD",
  "EASYSUBWAY_TAGO_TRAIN_SERVICE_KEY",
  "EASYSUBWAY_SEOUL_METRO_ELEVATOR_SERVICE_KEY",
  "EASYSUBWAY_ROUTE_V2_ORIGIN_SECRET",
  "EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256",
  "EASYSUBWAY_PLAY_INTEGRITY_CREDENTIALS_BASE64",
  "EASYSUBWAY_JOURNEY_SEARCH_TIMEOUT",
  "EASYSUBWAY_JOURNEY_MAX_SEARCHES_PER_SESSION",
  "EASYSUBWAY_JOURNEY_SESSION_CERTIFICATE_SHA256",
]);

const DEFAULT_MARKER_SUBDIRS = Object.freeze([
  "",
  "postgres",
  "object-storage",
  "minio",
]);

export class CleanRoomBootstrapError extends Error {
  constructor(code, stage, detail) {
    super(`${code} [${stage}]: ${detail}`);
    this.name = "CleanRoomBootstrapError";
    this.code = code;
    this.stage = stage;
  }
}

function fail(code, stage, detail) {
  throw new CleanRoomBootstrapError(code, stage, detail);
}

function hasPathTraversal(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
    return true;
  }
  const segments = rawPath.split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === "..") return true;
  }
  return false;
}

function assertNonSymlinkDirectory(dirPath, code, stage, label) {
  if (hasPathTraversal(dirPath)) {
    fail(code, stage, `${label} path contains invalid or traversal segments`);
  }
  let stat;
  try {
    stat = lstatSync(dirPath);
  } catch {
    fail(code, stage, `${label} directory does not exist: ${dirPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(code, stage, `${label} must be a regular non-symlink directory: ${dirPath}`);
  }
}

function readVerifiedRegularFile(
  filePath,
  { code, stage, label, maxBytes = MAX_CONFIG_FILE_BYTES, allowEmpty = false },
) {
  if (hasPathTraversal(filePath)) {
    fail(code, stage, `${label} path contains invalid or traversal segments`);
  }
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    fail(code, stage, `${label} file does not exist: ${filePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(code, stage, `${label} must be a regular non-symlink file: ${filePath}`);
  }
  if (!allowEmpty && stat.size === 0) {
    fail(code, stage, `${label} file must not be empty: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    fail(code, stage, `${label} file exceeds maximum allowed size (${maxBytes} bytes)`);
  }
  return readFileSync(filePath);
}

function defaultCommandRunner(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_CONFIG_FILE_BYTES,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function defaultReadCertificateNotAfter(certPath) {
  const pemBytes = readFileSync(certPath);
  const x509 = new X509Certificate(pemBytes);
  return new Date(x509.validTo);
}

function loadBackupContract(repoRoot) {
  const stage = "DATA_VOLUME_AND_DOCKER";
  const contractPath = path.join(
    repoRoot,
    "contracts/release/platform-data-volume-backup-contract.json",
  );
  const raw = readVerifiedRegularFile(contractPath, {
    code: "E_CLEAN_ROOM_CONTRACT_INVALID",
    stage,
    label: "platform-data-volume-backup-contract.json",
  });
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    fail(
      "E_CLEAN_ROOM_CONTRACT_INVALID",
      stage,
      "failed to parse platform-data-volume-backup-contract.json",
    );
  }
}

function verifyStage1DataVolumeAndDocker({
  dataVolumeMountPath,
  dockerDataRoot,
  dockerDaemonConfigPath,
  commandRunner,
}) {
  const stage = "DATA_VOLUME_AND_DOCKER";
  assertNonSymlinkDirectory(
    dataVolumeMountPath,
    "E_CLEAN_ROOM_DATA_VOLUME_DIR_MISSING",
    stage,
    "data volume mount",
  );
  assertNonSymlinkDirectory(
    dockerDataRoot,
    "E_CLEAN_ROOM_DOCKER_DATA_DIR_MISSING",
    stage,
    "docker data-root",
  );

  const mountRes = commandRunner("mountpoint", ["-q", dataVolumeMountPath]);
  if (mountRes.status !== 0) {
    fail(
      "E_CLEAN_ROOM_DATA_VOLUME_UNMOUNTED",
      stage,
      `mountpoint check failed for ${dataVolumeMountPath}`,
    );
  }

  const serviceRes = commandRunner("systemctl", [
    "is-active",
    "easysubway-data-volume-setup.service",
  ]);
  if (serviceRes.status !== 0 || serviceRes.stdout.trim() !== "active") {
    fail(
      "E_CLEAN_ROOM_DATA_VOLUME_SERVICE_INACTIVE",
      stage,
      "easysubway-data-volume-setup.service is not active",
    );
  }

  const daemonBytes = readVerifiedRegularFile(dockerDaemonConfigPath, {
    code: "E_CLEAN_ROOM_DOCKER_CONFIG_INVALID",
    stage,
    label: "docker daemon.json",
  });

  let daemonJson;
  try {
    daemonJson = JSON.parse(daemonBytes.toString("utf8"));
  } catch {
    fail(
      "E_CLEAN_ROOM_DOCKER_CONFIG_INVALID",
      stage,
      "docker daemon.json is not valid JSON",
    );
  }

  if (daemonJson?.["data-root"] !== dockerDataRoot) {
    fail(
      "E_CLEAN_ROOM_DOCKER_DATA_ROOT_MISMATCH",
      stage,
      `docker daemon.json data-root must equal ${dockerDataRoot}`,
    );
  }

  return {
    id: stage,
    status: "VERIFIED",
    mountPath: dataVolumeMountPath,
    dockerDataRoot,
    setupService: "easysubway-data-volume-setup.service",
  };
}

function verifyStage2OriginTlsAndHostNginx({
  tlsCertPath,
  tlsKeyPath,
  nginxConfigRoot,
  commandRunner,
  now,
  readCertificateNotAfter,
}) {
  const stage = "ORIGIN_TLS_AND_HOST_NGINX";
  readVerifiedRegularFile(tlsCertPath, {
    code: "E_CLEAN_ROOM_TLS_FILE_INVALID",
    stage,
    label: "origin TLS certificate",
  });
  readVerifiedRegularFile(tlsKeyPath, {
    code: "E_CLEAN_ROOM_TLS_FILE_INVALID",
    stage,
    label: "origin TLS private key",
  });

  let notAfterDate;
  try {
    notAfterDate = readCertificateNotAfter(tlsCertPath);
  } catch {
    fail(
      "E_CLEAN_ROOM_TLS_CERT_PARSE_FAILED",
      stage,
      "unable to parse origin TLS certificate expiry",
    );
  }

  const notAfterMs = notAfterDate instanceof Date ? notAfterDate.getTime() : NaN;
  const nowMs = now().getTime();
  if (!Number.isFinite(notAfterMs) || notAfterMs - nowMs < MIN_TLS_VALIDITY_MS) {
    fail(
      "E_CLEAN_ROOM_TLS_CERT_EXPIRING",
      stage,
      `origin TLS certificate expires in less than ${MIN_TLS_VALIDITY_DAYS} days`,
    );
  }

  assertNonSymlinkDirectory(
    nginxConfigRoot,
    "E_CLEAN_ROOM_NGINX_CONFIG_INVALID",
    stage,
    "nginx config root",
  );
  assertNonSymlinkDirectory(
    path.join(nginxConfigRoot, "conf.d"),
    "E_CLEAN_ROOM_NGINX_CONFIG_INVALID",
    stage,
    "nginx conf.d",
  );

  for (const relPath of REQUIRED_NGINX_CONFIG_RELATIVE_PATHS) {
    const fullPath = path.join(nginxConfigRoot, relPath);
    readVerifiedRegularFile(fullPath, {
      code: "E_CLEAN_ROOM_NGINX_CONFIG_INVALID",
      stage,
      label: `nginx config ${relPath}`,
    });
  }

  const nginxTest = commandRunner("nginx", ["-t"]);
  if (nginxTest.status !== 0) {
    fail("E_CLEAN_ROOM_NGINX_TEST_FAILED", stage, "nginx -t validation failed");
  }

  const remainingDays = Math.floor((notAfterMs - nowMs) / MS_PER_DAY);
  return {
    id: stage,
    status: "VERIFIED",
    certificateRemainingDays: remainingDays,
    verifiedNginxConfigCount: REQUIRED_NGINX_CONFIG_RELATIVE_PATHS.length,
  };
}

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function verifyDotenvFile(envFilePath, requiredKeySet, stage) {
  const envBytes = readVerifiedRegularFile(envFilePath, {
    code: "E_CLEAN_ROOM_ENV_INVALID",
    stage,
    label: "deployment .env",
  });
  const lines = envBytes.toString("utf8").split(/\r?\n/);
  const parsedKeys = new Map();

  for (const rawLine of lines) {
    if (rawLine.length === 0 || rawLine.startsWith("#")) continue;
    const match = DOTENV_LINE_PATTERN.exec(rawLine);
    if (!match) {
      fail("E_CLEAN_ROOM_ENV_INVALID", stage, "malformed dotenv line in .env");
    }
    const [, key, rawValue] = match;
    if (parsedKeys.has(key)) {
      fail("E_CLEAN_ROOM_ENV_INVALID", stage, `duplicate dotenv key: ${key}`);
    }
    if (rawValue.includes("$") && !rawValue.startsWith("'")) {
      fail(
        "E_CLEAN_ROOM_ENV_INVALID",
        stage,
        `cross-key interpolation is forbidden for key: ${key}`,
      );
    }
    parsedKeys.set(key, stripWrappingQuotes(rawValue).trim());
  }

  for (const requiredKey of requiredKeySet) {
    const val = parsedKeys.get(requiredKey);
    if (typeof val !== "string" || val.length === 0) {
      fail(
        "E_CLEAN_ROOM_ENV_INVALID",
        stage,
        `required deployment env key is missing or empty: ${requiredKey}`,
      );
    }
  }

  return parsedKeys.size;
}

function selectAndVerifyBackupDump(backupDir, explicitBackupFile, stage) {
  assertNonSymlinkDirectory(
    backupDir,
    "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
    stage,
    "backup directory",
  );
  const resolvedBackupDir = realpathSync(backupDir);

  let selectedDumpPath = "";
  let selectedDumpName = "";

  if (explicitBackupFile) {
    if (hasPathTraversal(explicitBackupFile)) {
      fail(
        "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
        stage,
        "backup file path traversal rejected",
      );
    }
    selectedDumpPath = path.isAbsolute(explicitBackupFile)
      ? explicitBackupFile
      : path.join(backupDir, explicitBackupFile);
    selectedDumpName = path.basename(selectedDumpPath);
  } else {
    const entries = readdirSync(backupDir, { withFileTypes: true });
    let latestSortKey = "";
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const match = BACKUP_DUMP_FILENAME_PATTERN.exec(entry.name);
      if (!match) continue;
      const prefixRank = match[1] ? "1" : "0";
      const sortKey = `${match[2]}:${prefixRank}:${entry.name}`;
      if (sortKey > latestSortKey) {
        latestSortKey = sortKey;
        selectedDumpName = entry.name;
        selectedDumpPath = path.join(backupDir, entry.name);
      }
    }
    if (!selectedDumpPath) {
      fail(
        "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
        stage,
        "no matching PostgreSQL backup dump found",
      );
    }
  }

  if (!BACKUP_DUMP_FILENAME_PATTERN.test(selectedDumpName)) {
    fail(
      "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
      stage,
      `invalid backup dump filename pattern: ${selectedDumpName}`,
    );
  }

  let resolvedParentDir;
  try {
    resolvedParentDir = realpathSync(path.dirname(selectedDumpPath));
  } catch {
    fail("E_CLEAN_ROOM_BACKUP_FILE_INVALID", stage, "invalid backup parent directory");
  }
  if (resolvedParentDir !== resolvedBackupDir) {
    fail(
      "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
      stage,
      "backup dump must reside directly inside backupDir",
    );
  }

  const dumpBytes = readVerifiedRegularFile(selectedDumpPath, {
    code: "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
    stage,
    label: "PostgreSQL backup dump",
    maxBytes: MAX_BACKUP_DUMP_BYTES,
  });

  const checksumPath = `${selectedDumpPath}.sha256`;
  const checksumBytes = readVerifiedRegularFile(checksumPath, {
    code: "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
    stage,
    label: "companion .sha256 file",
  });

  const firstToken = checksumBytes
    .toString("utf8")
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  if (!firstToken || !SHA256_HEX_PATTERN.test(firstToken)) {
    fail(
      "E_CLEAN_ROOM_BACKUP_FILE_INVALID",
      stage,
      "malformed SHA-256 digest in companion .sha256 file",
    );
  }

  const actualSha256 = createHash("sha256")
    .update(dumpBytes)
    .digest("hex")
    .toLowerCase();
  if (actualSha256 !== firstToken) {
    fail(
      "E_CLEAN_ROOM_BACKUP_CHECKSUM_MISMATCH",
      stage,
      `SHA-256 mismatch for backup dump ${selectedDumpName}`,
    );
  }

  return { backupFileName: selectedDumpName, backupSha256: actualSha256 };
}

function verifyRestoreMarkers(markerRoot, requiredMarkers, stage) {
  assertNonSymlinkDirectory(
    markerRoot,
    "E_CLEAN_ROOM_RESTORE_MARKER_MISSING",
    stage,
    "restore marker root",
  );

  const requiredSet = new Set(requiredMarkers);
  const foundMarkers = new Set();

  for (const subDir of DEFAULT_MARKER_SUBDIRS) {
    const candidateDir = subDir ? path.join(markerRoot, subDir) : markerRoot;
    let dirStat;
    try {
      dirStat = lstatSync(candidateDir);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;

    const dirents = readdirSync(candidateDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!requiredSet.has(dirent.name)) continue;
      if (dirent.isSymbolicLink()) {
        fail(
          "E_CLEAN_ROOM_RESTORE_MARKER_MISSING",
          stage,
          `restore marker must not be a symlink: ${dirent.name}`,
        );
      }
      if (dirent.isFile() || dirent.isDirectory()) {
        foundMarkers.add(dirent.name);
      }
    }
    if (foundMarkers.size === requiredSet.size) break;
  }

  for (const marker of requiredSet) {
    if (!foundMarkers.has(marker)) {
      fail(
        "E_CLEAN_ROOM_RESTORE_MARKER_MISSING",
        stage,
        `required restore marker is missing: ${marker}`,
      );
    }
  }

  return [...requiredSet];
}

function verifyStage3EnvAndBackupRestoreInputs({
  deployRoot,
  backupDir,
  backupFile,
  restoreMarkerRoot,
  requiredEnvKeys,
  requiredMarkers,
}) {
  const stage = "ENV_AND_BACKUP_RESTORE_INPUTS";
  assertNonSymlinkDirectory(
    deployRoot,
    "E_CLEAN_ROOM_ENV_INVALID",
    stage,
    "deploy root",
  );

  const envPath = path.join(deployRoot, ".env");
  const requiredKeySet = new Set(requiredEnvKeys);
  const verifiedEnvKeyCount = verifyDotenvFile(envPath, requiredKeySet, stage);

  const { backupFileName, backupSha256 } = selectAndVerifyBackupDump(
    backupDir,
    backupFile,
    stage,
  );
  const verifiedMarkers = verifyRestoreMarkers(
    restoreMarkerRoot,
    requiredMarkers,
    stage,
  );

  return {
    id: stage,
    status: "VERIFIED",
    verifiedEnvKeyCount,
    requiredEnvKeyCount: requiredKeySet.size,
    backupFileName,
    backupSha256,
    verifiedMarkers,
  };
}

function verifyStage4SingleNodeK3sBootstrap({ repoRoot, commandRunner }) {
  const stage = "SINGLE_NODE_K3S_BOOTSTRAP";
  for (const relPath of REQUIRED_K3S_RBAC_RELATIVE_PATHS) {
    const manifestPath = path.join(repoRoot, relPath);
    readVerifiedRegularFile(manifestPath, {
      code: "E_CLEAN_ROOM_K3S_RBAC_MISSING",
      stage,
      label: relPath,
    });
  }

  const bootstrapScript = path.join(
    repoRoot,
    "tools/platform/bootstrap-single-node-k3s.sh",
  );
  const verifyRes = commandRunner("bash", [bootstrapScript, "--mode", "VERIFY"]);
  if (verifyRes.status !== 0) {
    fail(
      "E_CLEAN_ROOM_K3S_VERIFY_FAILED",
      stage,
      "bootstrap-single-node-k3s.sh --mode VERIFY failed",
    );
  }

  return {
    id: stage,
    status: "VERIFIED",
    verifiedRbacManifests: [...REQUIRED_K3S_RBAC_RELATIVE_PATHS],
  };
}

function unwrapTerraformOutputValue(outputs, key) {
  if (!outputs || typeof outputs !== "object" || !Object.hasOwn(outputs, key)) {
    return undefined;
  }
  const entry = outputs[key];
  if (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "value")) {
    return entry.value;
  }
  return entry;
}

function resolveBackupControlOutputs({
  repoRoot,
  controlRoot,
  backupControlOutputs,
  backupControlOutputsPath,
  commandRunner,
  stage,
}) {
  if (backupControlOutputs && typeof backupControlOutputs === "object") {
    return backupControlOutputs;
  }
  if (backupControlOutputsPath) {
    const raw = readVerifiedRegularFile(backupControlOutputsPath, {
      code: "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
      stage,
      label: "backup control outputs JSON",
    });
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      fail(
        "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
        stage,
        "failed to parse backup control outputs JSON file",
      );
    }
  }

  const tfDir = path.join(repoRoot, controlRoot);
  const tfRes = commandRunner("terraform", [`-chdir=${tfDir}`, "output", "-json"]);
  if (tfRes.status !== 0) {
    fail(
      "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
      stage,
      "failed to read terraform output from data-volume-backup-control",
    );
  }
  try {
    return JSON.parse(tfRes.stdout);
  } catch {
    fail(
      "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
      stage,
      "terraform output -json produced invalid JSON",
    );
  }
}

function verifyStage5BackupAlertSubscription({
  repoRoot,
  backupContract,
  backupControlOutputs,
  backupControlOutputsPath,
  commandRunner,
}) {
  const stage = "BACKUP_ALERT_SUBSCRIPTION_AND_OBSERVABILITY";
  const controlRoot =
    backupContract?.target?.controlRoot ??
    "infra/terraform/oci/data-volume-backup-control";
  const requiredSubscriptionState =
    backupContract?.alert?.requiredSubscriptionState ?? "ACTIVE";

  const outputs = resolveBackupControlOutputs({
    repoRoot,
    controlRoot,
    backupControlOutputs,
    backupControlOutputsPath,
    commandRunner,
    stage,
  });

  const subscriptionState = unwrapTerraformOutputValue(outputs, "subscription_state");
  const eventRuleEnabled = unwrapTerraformOutputValue(outputs, "event_rule_enabled");
  const assignmentId = unwrapTerraformOutputValue(
    outputs,
    "backup_policy_assignment_id",
  );

  if (
    subscriptionState !== requiredSubscriptionState ||
    eventRuleEnabled !== true ||
    typeof assignmentId !== "string" ||
    assignmentId.trim().length === 0
  ) {
    fail(
      "E_CLEAN_ROOM_BACKUP_ALERT_INACTIVE",
      stage,
      `backup alert subscription must be ${requiredSubscriptionState}, event_rule_enabled must be true, and backup_policy_assignment_id must be non-empty`,
    );
  }

  return {
    id: stage,
    status: "VERIFIED",
    controlRoot,
    subscriptionState: requiredSubscriptionState,
    eventRuleEnabled: true,
    backupPolicyAssigned: true,
  };
}

function verifyStage6SelfHostedRunnerService({ runnerServiceName, commandRunner }) {
  const stage = "SELF_HOSTED_RUNNER_SERVICE";

  if (runnerServiceName) {
    if (
      typeof runnerServiceName !== "string" ||
      !runnerServiceName.startsWith("actions.runner.")
    ) {
      fail(
        "E_CLEAN_ROOM_RUNNER_INACTIVE",
        stage,
        "runnerServiceName must start with actions.runner.",
      );
    }
    const res = commandRunner("systemctl", ["is-active", runnerServiceName]);
    if (res.status !== 0 || res.stdout.trim() !== "active") {
      fail(
        "E_CLEAN_ROOM_RUNNER_INACTIVE",
        stage,
        `self-hosted runner service is not active: ${runnerServiceName}`,
      );
    }
    return {
      id: stage,
      status: "VERIFIED",
      activeRunnerUnitCount: 1,
    };
  }

  const listRes = commandRunner("systemctl", [
    "list-units",
    "--type=service",
    "--state=active",
    "--no-legend",
    "--plain",
    "actions.runner.*",
  ]);
  if (listRes.status !== 0) {
    fail(
      "E_CLEAN_ROOM_RUNNER_INACTIVE",
      stage,
      "failed to query active actions.runner.* systemd services",
    );
  }

  const activeUnits = [];
  for (const rawLine of listRes.stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = ACTIVE_RUNNER_UNIT_PATTERN.exec(trimmed);
    if (match) {
      activeUnits.push(match[1]);
    }
  }

  if (activeUnits.length === 0) {
    fail(
      "E_CLEAN_ROOM_RUNNER_INACTIVE",
      stage,
      "no active actions.runner.* systemd service found",
    );
  }

  return {
    id: stage,
    status: "VERIFIED",
    activeRunnerUnitCount: activeUnits.length,
  };
}

export function verifyCleanRoomHostBootstrap(options = {}, effects = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const commandRunner = effects.commandRunner ?? defaultCommandRunner;
  const now = effects.now ?? (() => new Date());
  const readCertificateNotAfter =
    effects.readCertificateNotAfter ?? defaultReadCertificateNotAfter;

  const backupContract = loadBackupContract(repoRoot);
  const dataVolumeMountPath =
    options.dataVolumeMountPath ??
    backupContract?.target?.mountPath ??
    "/var/lib/easysubway-data";
  const dockerDataRoot =
    options.dockerDataRoot ??
    backupContract?.target?.dockerDataRoot ??
    path.join(dataVolumeMountPath, "docker");
  const dockerDaemonConfigPath =
    options.dockerDaemonConfigPath ?? "/etc/docker/daemon.json";

  const certName = options.certName ?? "easysubway-api.aquilaxk.site";
  const tlsCertPath =
    options.tlsCertPath ?? `/etc/letsencrypt/live/${certName}/fullchain.pem`;
  const tlsKeyPath =
    options.tlsKeyPath ?? `/etc/letsencrypt/live/${certName}/privkey.pem`;
  const nginxConfigRoot = options.nginxConfigRoot ?? "/etc/nginx";

  const deployRoot = options.deployRoot ?? "/opt/easysubway";
  const backupDir = options.backupDir ?? path.join(deployRoot, "backups");
  const restoreMarkerRoot = options.restoreMarkerRoot ?? dataVolumeMountPath;
  const requiredEnvKeys = options.requiredEnvKeys ?? DEFAULT_REQUIRED_ENV_KEYS;
  const requiredMarkers =
    options.requiredMarkers ??
    backupContract?.restore?.requiredMarkers ??
    ["PG_VERSION", ".minio.sys"];

  const stages = [
    verifyStage1DataVolumeAndDocker({
      dataVolumeMountPath,
      dockerDataRoot,
      dockerDaemonConfigPath,
      commandRunner,
    }),
    verifyStage2OriginTlsAndHostNginx({
      tlsCertPath,
      tlsKeyPath,
      nginxConfigRoot,
      commandRunner,
      now,
      readCertificateNotAfter,
    }),
    verifyStage3EnvAndBackupRestoreInputs({
      deployRoot,
      backupDir,
      backupFile: options.backupFile,
      restoreMarkerRoot,
      requiredEnvKeys,
      requiredMarkers,
    }),
    verifyStage4SingleNodeK3sBootstrap({
      repoRoot,
      commandRunner,
    }),
    verifyStage5BackupAlertSubscription({
      repoRoot,
      backupContract,
      backupControlOutputs: options.backupControlOutputs,
      backupControlOutputsPath: options.backupControlOutputsPath,
      commandRunner,
    }),
    verifyStage6SelfHostedRunnerService({
      runnerServiceName: options.runnerServiceName,
      commandRunner,
    }),
  ];

  return {
    schemaVersion: 1,
    artifactKind: "platform-clean-room-host-bootstrap-receipt-v1",
    status: "READY",
    stages,
    verifiedAt: now().toISOString(),
  };
}

function readNextArg(argv, index, flag) {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    fail("E_CLEAN_ROOM_USAGE", "CLI", `${flag} requires a value`);
  }
  return next;
}

export function parseCliArgs(argv) {
  const options = {};
  const flagHandlers = new Map([
    ["--repo-root", (val) => { options.repoRoot = val; }],
    ["--data-volume-mount", (val) => { options.dataVolumeMountPath = val; }],
    ["--docker-data-root", (val) => { options.dockerDataRoot = val; }],
    ["--docker-daemon-config", (val) => { options.dockerDaemonConfigPath = val; }],
    ["--tls-cert", (val) => { options.tlsCertPath = val; }],
    ["--tls-key", (val) => { options.tlsKeyPath = val; }],
    ["--nginx-config-root", (val) => { options.nginxConfigRoot = val; }],
    ["--deploy-root", (val) => { options.deployRoot = val; }],
    ["--backup-dir", (val) => { options.backupDir = val; }],
    ["--backup-file", (val) => { options.backupFile = val; }],
    ["--restore-marker-root", (val) => { options.restoreMarkerRoot = val; }],
    ["--backup-control-outputs-json", (val) => { options.backupControlOutputsPath = val; }],
    ["--runner-service", (val) => { options.runnerServiceName = val; }],
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    const handler = flagHandlers.get(arg);
    if (!handler) {
      fail("E_CLEAN_ROOM_USAGE", "CLI", `unknown argument: ${arg}`);
    }
    handler(readNextArg(argv, i, arg));
    i += 1;
  }

  return { help: false, options };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

function main() {
  try {
    const { help, options } = parseCliArgs(process.argv.slice(2));
    if (help) {
      process.stdout.write(
        "usage: verify-clean-room-host-bootstrap.mjs [--deploy-root <path>] [--backup-control-outputs-json <path>]\n",
      );
      return;
    }
    const receipt = verifyCleanRoomHostBootstrap(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  main();
}
