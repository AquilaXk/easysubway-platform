import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const script = new URL("tools/platform/inject-datapack-callback-secrets.mjs", root);
const tokenKey = "EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN";
const hmacKey = "EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY";
const token = "workflow-token-value";
const hmac = "callback-hmac-key-with-at-least-32-bytes";

test("replaces only exact callback definitions, preserves unrelated dotenv bytes, and locks mode", () => {
  const fixture = makeFixture(
    "# keep this comment\r\nOTHER=before\r\n"
      + `${tokenKey}=old-token\r\n${hmacKey}=old-hmac\r\n`
      + ` ${tokenKey}=not-an-exact-definition\r\n${tokenKey}_SUFFIX=keep\r\nOTHER=after\r\n`,
  );
  try {
    const result = run(fixture.path);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(
      readFileSync(fixture.path, "utf8"),
      "# keep this comment\r\nOTHER=before\r\n"
        + ` ${tokenKey}=not-an-exact-definition\r\n${tokenKey}_SUFFIX=keep\r\nOTHER=after\r\n`
        + `${tokenKey}=${token}\n${hmacKey}=${hmac}\n`,
    );
    assert.equal(lstatSync(fixture.path).mode & 0o777, 0o600);
  } finally {
    fixture.cleanup();
  }
});

test("rejects invalid secrets before changing the dotenv", () => {
  const cases = [
    [{ [tokenKey]: undefined }, tokenKey],
    [{ [tokenKey]: "" }, tokenKey],
    [{ [tokenKey]: "   " }, tokenKey],
    [{ [tokenKey]: " workflow-token-value" }, tokenKey],
    [{ [tokenKey]: "workflow-token-value\u00a0" }, tokenKey],
    [{ [tokenKey]: "line\nbreak" }, tokenKey],
    [{ [hmacKey]: undefined }, hmacKey],
    [{ [hmacKey]: "short" }, hmacKey],
    [{ [hmacKey]: "line\rbreak" }, hmacKey],
  ];
  for (const [env, expected] of cases) {
    const fixture = makeFixture("KEEP=unchanged\n");
    try {
      const result = run(fixture.path, env);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(expected));
      for (const value of Object.values(env)) {
        if (typeof value === "string" && value.length > 0) {
          assert.equal(result.stdout.includes(value), false);
          assert.equal(result.stderr.includes(value), false);
        }
      }
      assert.equal(readFileSync(fixture.path, "utf8"), "KEEP=unchanged\n");
    } finally {
      fixture.cleanup();
    }
  }
});

test("rejects symlink dotenv input without mutating its target", () => {
  const fixture = makeFixture("KEEP=target\n");
  const linked = join(fixture.directory, "linked.env");
  try {
    symlinkSync(fixture.path, linked);
    const result = run(linked);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /regular non-symlink dotenv/);
    assert.equal(readFileSync(fixture.path, "utf8"), "KEEP=target\n");
  } finally {
    fixture.cleanup();
  }
});

function makeFixture(contents) {
  const directory = mkdtempSync(join(tmpdir(), "datapack-callback-secrets-"));
  const path = join(directory, "deployment.env");
  writeFileSync(path, contents, { mode: 0o644 });
  chmodSync(path, 0o644);
  return { directory, path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function run(path, overrides = {}) {
  const env = { ...process.env, [tokenKey]: token, [hmacKey]: hmac, ...overrides };
  return spawnSync(process.execPath, [script.pathname, path], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}
