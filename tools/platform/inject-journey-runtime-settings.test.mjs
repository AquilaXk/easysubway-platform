import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const script = new URL("tools/platform/inject-journey-runtime-settings.mjs", root);

const searchTimeoutKey = "EASYSUBWAY_JOURNEY_SEARCH_TIMEOUT";
const maxSearchesKey = "EASYSUBWAY_JOURNEY_MAX_SEARCHES_PER_SESSION";
const sessionCertKey = "EASYSUBWAY_JOURNEY_SESSION_CERTIFICATE_SHA256";
const playIntegrityCertKey = "EASYSUBWAY_ROUTE_V2_PLAY_INTEGRITY_CERTIFICATE_SHA256";
const timetableSeedEnabledKey = "EASYSUBWAY_TIMETABLE_SEED_ENABLED";

const dummyCert = "A".repeat(43);

function makeFixture(initialContents) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "journey-runtime-test-")));
  const path = join(directory, "deployment.env");
  writeFileSync(path, initialContents, { mode: 0o600 });
  return {
    directory,
    path,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function run(fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [script.pathname], {
    env: {
      ...process.env,
      RUNNER_TEMP: fixture.directory,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

test("injects default Journey V3 runtime settings using Play Integrity cert from dotenv", () => {
  const fixture = makeFixture(
    `# existing deployment env\nOTHER=foo\n${playIntegrityCertKey}=${dummyCert}\n`,
  );
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const content = readFileSync(fixture.path, "utf8");
    assert.match(content, /^OTHER=foo$/m);
    assert.match(content, new RegExp(`^${searchTimeoutKey}=PT2S$`, "m"));
    assert.match(content, new RegExp(`^${maxSearchesKey}=12$`, "m"));
    assert.match(content, new RegExp(`^${sessionCertKey}=${dummyCert}$`, "m"));
    assert.match(content, new RegExp(`^${timetableSeedEnabledKey}=false$`, "m"));
    assert.equal(lstatSync(fixture.path).mode & 0o777, 0o600);
  } finally {
    fixture.cleanup();
  }
});

test("preserves existing Journey V3 settings if already in dotenv", () => {
  const fixture = makeFixture(
    `${playIntegrityCertKey}=${dummyCert}\n`
      + `${searchTimeoutKey}=PT5S\n`
      + `${maxSearchesKey}=20\n`
      + `${sessionCertKey}=${"B".repeat(43)}\n`,
  );
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(fixture.path, "utf8");
    assert.match(content, new RegExp(`^${searchTimeoutKey}=PT5S$`, "m"));
    assert.match(content, new RegExp(`^${maxSearchesKey}=20$`, "m"));
    assert.match(content, new RegExp(`^${sessionCertKey}=${"B".repeat(43)}$`, "m"));
    assert.match(content, new RegExp(`^${timetableSeedEnabledKey}=false$`, "m"));
  } finally {
    fixture.cleanup();
  }
});

test("allows environment variables to override defaults", () => {
  const customCert = "C".repeat(43);
  const fixture = makeFixture(
    `${playIntegrityCertKey}=${dummyCert}\n`,
  );
  try {
    const result = run(fixture, {
      [searchTimeoutKey]: "PT1S",
      [maxSearchesKey]: "6",
      [sessionCertKey]: customCert,
    });
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(fixture.path, "utf8");
    assert.match(content, new RegExp(`^${searchTimeoutKey}=PT1S$`, "m"));
    assert.match(content, new RegExp(`^${maxSearchesKey}=6$`, "m"));
    assert.match(content, new RegExp(`^${sessionCertKey}=${customCert}$`, "m"));
  } finally {
    fixture.cleanup();
  }
});

test("fails if Play Integrity cert is missing and session cert is not provided", () => {
  const fixture = makeFixture("OTHER=foo\n");
  try {
    const result = run(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(sessionCertKey));
  } finally {
    fixture.cleanup();
  }
});

test("fails if certificate format is invalid", () => {
  const fixture = makeFixture(`${playIntegrityCertKey}=too-short\n`);
  try {
    const result = run(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid certificate SHA-256/);
  } finally {
    fixture.cleanup();
  }
});

test("strips deprecated admin configuration keys from deployment.env", () => {
  const fixture = makeFixture(
    `OTHER=foo\n${playIntegrityCertKey}=${dummyCert}\n`
    + "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_RBAC_ENFORCEMENT=true\n"
    + "EASYSUBWAY_ADMIN_PLATFORM_FLAGS_AUDIT_ENFORCEMENT=true\n"
    + "EASYSUBWAY_ADMIN_BREAK_GLASS_BOOTSTRAP_ENABLED=true\n",
  );
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(fixture.path, "utf8");
    assert.doesNotMatch(content, /EASYSUBWAY_ADMIN_PLATFORM_FLAGS_RBAC_ENFORCEMENT/);
    assert.doesNotMatch(content, /EASYSUBWAY_ADMIN_PLATFORM_FLAGS_AUDIT_ENFORCEMENT/);
    assert.doesNotMatch(content, /EASYSUBWAY_ADMIN_BREAK_GLASS_BOOTSTRAP_ENABLED/);
    assert.match(content, /^OTHER=foo$/m);
  } finally {
    fixture.cleanup();
  }
});

