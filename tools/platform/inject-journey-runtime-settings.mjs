import {
  atomicReplace,
  deploymentEnvPath,
  stableRead,
} from "./inject-datapack-callback-secrets.mjs";

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
