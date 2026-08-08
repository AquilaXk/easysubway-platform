import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repositoryRoot, "tools/platform/stage-journey-release-tuple.mjs");
const candidatesRoot = join(repositoryRoot, "build/candidates");
const temporaryRoots = [];
let fixture = null;

beforeEach(() => {
  fixture = { buildCreated: false, candidatesCreated: false, buildReplacement: null };
  const build = join(repositoryRoot, "build");
  if (!existsSync(build)) {
    mkdirSync(build);
    fixture.buildCreated = true;
  }
  if (!existsSync(candidatesRoot)) {
    mkdirSync(candidatesRoot);
    fixture.candidatesCreated = true;
  }
});

afterEach(() => {
  const build = join(repositoryRoot, "build");
  if (fixture.buildReplacement === "symlink" && lstatSync(build).isSymbolicLink()) {
    unlinkSync(build);
  } else if (fixture.buildReplacement === "file" && lstatSync(build).isFile()) {
    unlinkSync(build);
  } else {
    rmSync(candidatePath(), { force: true });
    rmSync(siblingCandidatePath(), { force: true });
    if (fixture.candidatesCreated && existsSync(candidatesRoot)) rmdirSync(candidatesRoot);
    if (fixture.buildCreated && existsSync(build)) rmdirSync(build);
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("stages the exact ordered LF tuple hash as one immutable candidate", () => {
  const input = writeInput(validTuple());
  const result = run("--input", input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");

  const destination = candidatePath();
  assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), {
    ...validTuple(),
    tupleSha256: expectedTupleSha256,
  });
  assert.equal(
    readFileSync(destination, "utf8"),
    `${JSON.stringify({ ...validTuple(), tupleSha256: expectedTupleSha256 }, null, 2)}\n`,
  );
});

test("rejects malformed, non-closed, and invalid tuple fields without publishing a candidate", () => {
  const invalidInputs = [
    "{",
    JSON.stringify([validTuple()]),
    JSON.stringify((({ environmentIdentity, ...rest }) => rest)(validTuple())),
    JSON.stringify({ ...validTuple(), unexpected: true }),
    JSON.stringify({ ...validTuple(), schemaVersion: "JOURNEY_RELEASE_TUPLE_V2" }),
    JSON.stringify({ ...validTuple(), backendImageDigest: `sha256:${"A".repeat(64)}` }),
    JSON.stringify({ ...validTuple(), deploymentRevision: "a".repeat(39) }),
    JSON.stringify({ ...validTuple(), environmentIdentity: "production\n" }),
    JSON.stringify({ ...validTuple(), environmentIdentity: "production\u2028" }),
  ];

  for (const body of invalidInputs) {
    const input = writeInputBody(body);
    const result = run("--input", input);
    assert.equal(result.status, 2, body);
    assert.match(result.stderr, /^(E_JRT_INPUT_JSON|E_JRT_TUPLE_SCHEMA)\b/);
    assertCandidateMissing();
  }
});

test("rejects invalid CLI forms and a non-regular input", () => {
  const input = writeInput(validTuple());
  for (const args of [[], ["--unknown", input], ["--input", input, "--input", input], ["--input"]]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^E_JRT_USAGE\b/);
    assertCandidateMissing();
  }
  const directory = makeTemporaryRoot();
  const result = run("--input", directory);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_INPUT_NOT_REGULAR\b/);
  assertCandidateMissing();
});

test("does not overwrite a pre-existing candidate", () => {
  const input = writeInput(validTuple());
  const destination = candidatePath();
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, "existing immutable bytes");

  const result = run("--input", input);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_OUTPUT_EXISTS\b/);
  assert.equal(readFileSync(destination, "utf8"), "existing immutable bytes");
});

test("preserves a different-hash sibling candidate", () => {
  const input = writeInput(validTuple());
  const sibling = siblingCandidatePath();
  writeFileSync(sibling, "different immutable tuple");

  const result = run("--input", input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(sibling, "utf8"), "different immutable tuple");
  assert.equal(readFileSync(candidatePath(), "utf8").includes(expectedTupleSha256), true);
});

test("rejects a symlinked output ancestor without publishing", () => {
  const input = writeInput(validTuple());
  const external = makeTemporaryRoot();
  rmdirSync(candidatesRoot);
  rmdirSync(join(repositoryRoot, "build"));
  symlinkSync(external, join(repositoryRoot, "build"));
  fixture.buildReplacement = "symlink";

  const result = run("--input", input);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_OUTPUT_CONFINEMENT\b/);
  assert.deepEqual(readdirSync(external), []);
});

test("rejects a non-directory output ancestor without publishing", () => {
  const input = writeInput(validTuple());
  rmdirSync(candidatesRoot);
  rmdirSync(join(repositoryRoot, "build"));
  writeFileSync(join(repositoryRoot, "build"), "not a directory");
  fixture.buildReplacement = "file";

  const result = run("--input", input);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_OUTPUT_CONFINEMENT\b/);
  assert.equal(readFileSync(join(repositoryRoot, "build"), "utf8"), "not a directory");
});

test("rejects a symlink input through O_NOFOLLOW without publishing", () => {
  const source = writeInput(validTuple());
  const link = join(makeTemporaryRoot(), "tuple-link.json");
  symlinkSync(source, link);

  const result = run("--input", link);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_INPUT_NOT_REGULAR\b/);
  assertCandidateMissing();
});

test("fails closed when the secure publish helper cannot start", () => {
  const input = writeInput(validTuple());
  const result = runWithEnvironment({ PATH: "" }, "--input", input);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^E_JRT_STAGE_IO\b/);
  assertCandidateMissing();
});

function validTuple() {
  return {
    schemaVersion: "JOURNEY_RELEASE_TUPLE_V1",
    artifactKind: "journey-release-tuple",
    backendImageDigest: `sha256:${"a".repeat(64)}`,
    backendConfigDigest: `sha256:${"b".repeat(64)}`,
    journeyContractDigest: `sha256:${"c".repeat(64)}`,
    serverRouteBundleDigest: `sha256:${"d".repeat(64)}`,
    deploymentRevision: "e".repeat(40),
    environmentIdentity: "production",
  };
}

const expectedTupleSha256 = "sha256:341ae0aa029d74f164efc0f1bb9290c50ec60c8e45680a99dc5972a5db338f0a";

function writeInput(value) {
  return writeInputBody(JSON.stringify(value));
}

function writeInputBody(body) {
  const root = makeTemporaryRoot();
  const input = join(root, "tuple.json");
  writeFileSync(input, body);
  return input;
}

function makeTemporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "journey-release-tuple-test-"));
  temporaryRoots.push(root);
  return root;
}

function candidatePath() {
  return join(candidatesRoot, `journey-release-tuple-${expectedTupleSha256.slice("sha256:".length)}.json`);
}

function siblingCandidatePath() {
  return join(candidatesRoot, `journey-release-tuple-${"f".repeat(64)}.json`);
}

function run(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function runWithEnvironment(environment, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function assertCandidateMissing() {
  assert.throws(() => readFileSync(candidatePath()), { code: "ENOENT" });
}
