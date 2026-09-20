import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const searchTimeoutKey = "EASYSUBWAY_JOURNEY_SEARCH_TIMEOUT";
const maxSearchesKey = "EASYSUBWAY_JOURNEY_MAX_SEARCHES_PER_SESSION";
const sessionCertKey = "EASYSUBWAY_JOURNEY_SESSION_CERTIFICATE_SHA256";
const playIntegrityCertKey = "EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256";
const timetableSeedEnabledKey = "EASYSUBWAY_TIMETABLE_SEED_ENABLED";
const timetableSeedIncludesItxKey = "EASYSUBWAY_TIMETABLE_SEED_INCLUDES_ITX";

const DEFAULT_SEARCH_TIMEOUT = "PT2S";
const DEFAULT_MAX_SEARCHES = "12";

function unquote(val) {
  if (typeof val !== "string") return "";
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function inject(environment = process.env) {
  const runnerTemp = environment.RUNNER_TEMP;
  if (!runnerTemp || typeof runnerTemp !== "string") {
    throw new Error("RUNNER_TEMP must be a nonempty string");
  }
  const path = join(runnerTemp, "deployment.env");
  const raw = readFileSync(path, "utf8");

  const lines = raw.split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx !== -1) {
      values.set(line.slice(0, idx).trim(), unquote(line.slice(idx + 1)));
    }
  }

  const existingTimeout = values.get(searchTimeoutKey);
  const searchTimeout = environment[searchTimeoutKey] || (existingTimeout && existingTimeout.length > 0 ? existingTimeout : DEFAULT_SEARCH_TIMEOUT);
  if (/[\r\n\0]/.test(searchTimeout) || searchTimeout.length === 0) {
    throw new Error(`${searchTimeoutKey} must be a nonempty single-line value`);
  }

  const existingMax = values.get(maxSearchesKey);
  const maxSearches = environment[maxSearchesKey] || (existingMax && existingMax.length > 0 ? existingMax : DEFAULT_MAX_SEARCHES);
  if (!/^[1-9]\d*$/.test(maxSearches)) {
    throw new Error(`${maxSearchesKey} must be a positive integer`);
  }

  const existingSessionCert = values.get(sessionCertKey);
  const existingPlayIntegrityCert = values.get(playIntegrityCertKey);
  const sessionCert = environment[sessionCertKey]
    || (existingSessionCert && existingSessionCert.length > 0 ? existingSessionCert : undefined)
    || environment[playIntegrityCertKey]
    || (existingPlayIntegrityCert && existingPlayIntegrityCert.length > 0 ? existingPlayIntegrityCert : undefined);

  if (!sessionCert || typeof sessionCert !== "string" || sessionCert.length === 0) {
    throw new Error(`${sessionCertKey} is required and could not be derived from ${playIntegrityCertKey}`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionCert)) {
    throw new Error(`invalid certificate SHA-256 for ${sessionCertKey}`);
  }

const DEPRECATED_ADMIN_KEYS = [
  "EASYSUBWAY_ADMIN_PLATFORM_TRANSITION_STAGE",
  "EASYSUBWAY_ADMIN_IDENTITY_STORE_ENABLED",
  "EASYSUBWAY_ADMIN_RBAC_SHADOW_ENABLED",
  "EASYSUBWAY_ADMIN_RBAC_ENFORCEMENT_ENABLED",
  "EASYSUBWAY_ADMIN_AUDIT_SHADOW_ENABLED",
  "EASYSUBWAY_ADMIN_AUDIT_ENFORCEMENT_ENABLED",
  "EASYSUBWAY_ADMIN_LEGACY_ENV_FALLBACK_ENABLED",
  "EASYSUBWAY_ADMIN_BREAK_GLASS_BOOTSTRAP_ENABLED",
  "EASYSUBWAY_ADMIN_ROLE_SEED_REQUIRED",
  "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_RBAC_ENFORCEMENT",
  "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_AUDIT_ENFORCEMENT",
  "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_LEGACY_ENV_ADMIN_FALLBACK",
  "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_BREAK_GLASS_BOOTSTRAP",
  "EASYSUBWAY_ADMIN_PLATFORM_RELEASE_BLOCKER_MODE",
  "EASYSUBWAY_ADMIN_BREAK_GLASS_USERNAME",
  "EASYSUBWAY_ADMIN_BREAK_GLASS_PASSWORD",
  "EASYSUBWAY_ADMIN_BREAK_GLASS_REASON",
];

  const managed = new Set([
    searchTimeoutKey,
    maxSearchesKey,
    sessionCertKey,
    timetableSeedEnabledKey,
    timetableSeedIncludesItxKey,
    ...DEPRECATED_ADMIN_KEYS,
  ]);
  const preserved = lines.filter((line) => {
    const idx = line.indexOf("=");
    if (idx === -1) return true;
    return !managed.has(line.slice(0, idx).trim());
  });

  while (preserved.length > 0 && preserved[preserved.length - 1].trim() === "") {
    preserved.pop();
  }

  const output = [
    ...preserved,
    `${searchTimeoutKey}=${searchTimeout}`,
    `${maxSearchesKey}=${maxSearches}`,
    `${sessionCertKey}=${sessionCert}`,
    `${timetableSeedEnabledKey}=false`,
    `${timetableSeedIncludesItxKey}=false`,
    "",
  ].join("\n");

  writeFileSync(path, output, { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    if (process.argv.length !== 2) throw new Error("usage: inject-journey-runtime-settings.mjs");
    inject();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
