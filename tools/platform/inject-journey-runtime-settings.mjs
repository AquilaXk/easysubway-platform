import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const searchTimeoutKey = "EASYSUBWAY_JOURNEY_SEARCH_TIMEOUT";
const maxSearchesKey = "EASYSUBWAY_JOURNEY_MAX_SEARCHES_PER_SESSION";
const sessionCertKey = "EASYSUBWAY_JOURNEY_SESSION_CERTIFICATE_SHA256";
const playIntegrityCertKey = "EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256";
const managedKeys = [searchTimeoutKey, maxSearchesKey, sessionCertKey];

const DEFAULT_SEARCH_TIMEOUT = "PT2S";
const DEFAULT_MAX_SEARCHES = "12";

function fail(message) {
  throw new Error(message);
}

function regularFileSnapshot(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("dotenv input must be a regular non-symlink dotenv file");
  }
  return metadata;
}

function deploymentEnvPath(environment) {
  const runnerTemp = environment.RUNNER_TEMP;
  if (typeof runnerTemp !== "string" || runnerTemp.length === 0
    || !isAbsolute(runnerTemp) || resolve(runnerTemp) !== runnerTemp) {
    fail("RUNNER_TEMP must be a nonempty absolute path resolving to itself");
  }
  let metadata;
  let resolved;
  try {
    metadata = lstatSync(runnerTemp, { bigint: true });
    resolved = realpathSync(runnerTemp);
  } catch {
    fail("RUNNER_TEMP must be an existing regular non-symlink directory");
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || resolved !== runnerTemp) {
    fail("RUNNER_TEMP must be an existing regular non-symlink directory resolving to itself");
  }
  return join(runnerTemp, "deployment.env");
}

function sameFileSnapshot(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function stableRead(path) {
  const before = regularFileSnapshot(path);
  const contents = readFileSync(path, "utf8");
  const after = regularFileSnapshot(path);
  if (!sameFileSnapshot(before, after)) fail("dotenv input changed while being read");
  return { contents, snapshot: after };
}

function parseDotenvValue(line, key) {
  if (!line.startsWith(`${key}=`)) return undefined;
  let raw = line.slice(key.length + 1).trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }
  return raw;
}

function findValueInEnv(contents, key) {
  for (const line of contents.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const parsed = parseDotenvValue(trimmed, key);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function withoutManagedDefinitions(contents) {
  return contents.split(/(?<=\n)/).filter((line) =>
    !managedKeys.some((key) => line.startsWith(`${key}=`)),
  ).join("");
}

function replacementContents(contents, values) {
  const preserved = withoutManagedDefinitions(contents);
  const separator = preserved.length > 0 && !preserved.endsWith("\n") ? "\n" : "";
  return `${preserved}${separator}`
    + `${searchTimeoutKey}=${values.searchTimeout}\n`
    + `${maxSearchesKey}=${values.maxSearches}\n`
    + `${sessionCertKey}=${values.sessionCert}\n`;
}

function atomicReplace(path, contents, expectedSnapshot) {
  const temporaryPath = join(dirname(path), `.journey-runtime-${randomBytes(16).toString("hex")}`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const current = regularFileSnapshot(path);
    if (!sameFileSnapshot(expectedSnapshot, current)) fail("dotenv input changed before replacement");
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export function inject(environment = process.env) {
  const path = deploymentEnvPath(environment);
  const source = stableRead(path);

  const existingTimeout = findValueInEnv(source.contents, searchTimeoutKey);
  const searchTimeout = environment[searchTimeoutKey] || existingTimeout || DEFAULT_SEARCH_TIMEOUT;
  if (/[\r\n\0]/.test(searchTimeout) || searchTimeout.length === 0) {
    fail(`${searchTimeoutKey} must be a nonempty single-line value`);
  }

  const existingMaxSearches = findValueInEnv(source.contents, maxSearchesKey);
  const maxSearches = environment[maxSearchesKey] || existingMaxSearches || DEFAULT_MAX_SEARCHES;
  if (!/^[1-9][0-9]*$/.test(maxSearches)) {
    fail(`${maxSearchesKey} must be a positive integer`);
  }

  const existingSessionCert = findValueInEnv(source.contents, sessionCertKey);
  const existingPlayIntegrityCert = findValueInEnv(source.contents, playIntegrityCertKey);
  const sessionCert = environment[sessionCertKey]
    || existingSessionCert
    || environment[playIntegrityCertKey]
    || existingPlayIntegrityCert;

  if (!sessionCert || typeof sessionCert !== "string" || sessionCert.length === 0) {
    fail(`${sessionCertKey} is required and could not be derived from ${playIntegrityCertKey}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionCert)) {
    fail(`invalid certificate SHA-256 for ${sessionCertKey}`);
  }

  const values = {
    searchTimeout,
    maxSearches,
    sessionCert,
  };

  atomicReplace(path, replacementContents(source.contents, values), source.snapshot);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    if (process.argv.length !== 2) fail("usage: inject-journey-runtime-settings.mjs");
    inject();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
