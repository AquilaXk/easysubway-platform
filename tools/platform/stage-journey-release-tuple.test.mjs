import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRepositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceScript = join(sourceRepositoryRoot, "tools/platform/stage-journey-release-tuple.mjs");
const sourceHelper = join(sourceRepositoryRoot, "tools/platform/secure-publish-journey-release-tuple.py");
const temporaryRoots = [];
let repositoryRoot;
let script;
let helper;
let candidatesRoot;

beforeEach(() => {
  repositoryRoot = makeTemporaryRoot();
  script = join(repositoryRoot, "tools/platform/stage-journey-release-tuple.mjs");
  helper = join(repositoryRoot, "tools/platform/secure-publish-journey-release-tuple.py");
  candidatesRoot = join(repositoryRoot, "build/candidates");
  mkdirSync(join(repositoryRoot, "tools/platform"), { recursive: true });
  mkdirSync(candidatesRoot, { recursive: true });
  copyFileSync(sourceScript, script);
  copyFileSync(sourceHelper, helper);
});

afterEach(() => {
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

test("accepts a 255-character environment identity and rejects 256 characters without a new candidate", () => {
  const accepted = writeInput({ ...validTuple(), environmentIdentity: "a".repeat(255) });
  const acceptedResult = run("--input", accepted);
  assert.equal(acceptedResult.status, 0, acceptedResult.stderr);
  const before = readdirSync(candidatesRoot).sort();

  const rejected = writeInput({ ...validTuple(), environmentIdentity: "a".repeat(256) });
  const rejectedResult = run("--input", rejected);
  assert.equal(rejectedResult.status, 2);
  assert.match(rejectedResult.stderr, /^E_JRT_TUPLE_SCHEMA\b/);
  assert.deepEqual(readdirSync(candidatesRoot).sort(), before);
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

test("rejects a FIFO input without blocking", () => {
  const fifo = join(makeTemporaryRoot(), "tuple.fifo");
  const create = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);

  const result = run("--input", fifo);
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

test("helper rejects arguments and unbound candidate content without publishing", () => {
  const argumentResult = runHelper("{}", "unexpected");
  assert.equal(argumentResult.status, 2);
  assert.match(argumentResult.stderr, /^E_JRT_USAGE\b/);
  assertCandidateMissing();

  const malformedResult = runHelper("{");
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /^E_JRT_STAGE_IO\b/);
  assertCandidateMissing();

  const unbound = JSON.stringify({ ...validTuple(), tupleSha256: `sha256:${"f".repeat(64)}` });
  const contentResult = runHelper(unbound);
  assert.equal(contentResult.status, 1);
  assert.match(contentResult.stderr, /^E_JRT_STAGE_IO\b/);
  assertCandidateMissing();
});

test("helper rejects a directory identity not captured by the caller", () => {
  const content = candidateBody();
  const identities = outputIdentities();
  identities[5] += 1n;
  const result = runHelperRequest(publicationRequest(content, identities));

  assert.equal(result.status, 2);
  assert.match(result.stderr, /^E_JRT_OUTPUT_CONFINEMENT\b/);
  assertCandidateMissing();
  assert.deepEqual(readdirSync(candidatesRoot), []);
});

test("helper fails closed on oversized stdin payloads and enforces bounded candidate size equivalence", () => {
  const oversizedTuple = {
    ...validTuple(),
    environmentIdentity: "p".repeat(10_000),
  };
  const sha = createHash("sha256")
    .update(
      `${[
        oversizedTuple.backendImageDigest,
        oversizedTuple.backendConfigDigest,
        oversizedTuple.journeyContractDigest,
        oversizedTuple.serverRouteBundleDigest,
        oversizedTuple.deploymentRevision,
        oversizedTuple.environmentIdentity,
      ].join("\n")}\n`,
      "utf8",
    )
    .digest("hex");
  const oversizedBody = `${JSON.stringify({ ...oversizedTuple, tupleSha256: `sha256:${sha}` }, null, 2)}\n`;
  const oversizedResult = runHelperRequest(publicationRequest(oversizedBody));
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, /^E_JRT_STAGE_IO\b/);
  assert.deepEqual(readdirSync(candidatesRoot), []);

  const paddedBody = `${candidateBody()}${" ".repeat(4097)}`;
  const paddedResult = runHelperRequest(publicationRequest(paddedBody));
  assert.equal(paddedResult.status, 1);
  assert.match(paddedResult.stderr, /^E_JRT_STAGE_IO\b/);
  assertCandidateMissing();

  const unitEquivalence = spawnSync(
    "/usr/bin/python3",
    [
      "-B",
      "-c",
      [
        "import importlib.util, os, sys",
        "spec = importlib.util.spec_from_file_location('publisher', sys.argv[1])",
        "mod = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mod)",
        "r_fd, w_fd = os.pipe()",
        "payload = b'abcdef' * 500",
        "os.write(w_fd, payload[:7])",
        "os.write(w_fd, payload[7:211])",
        "os.write(w_fd, payload[211:])",
        "os.close(w_fd)",
        "actual = mod.read_all(r_fd, len(payload))",
        "os.close(r_fd)",
        "assert actual == payload",
        "assert mod.exact_candidate_object([(k, k) for k in mod.REQUIRED_FIELDS]) == {k: k for k in mod.REQUIRED_FIELDS}",
      ].join("\n"),
      helper,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(unitEquivalence.status, 0, unitEquivalence.stderr);

  const validInput = writeInput(validTuple());
  const stageResult = run("--input", validInput);
  assert.equal(stageResult.status, 0, stageResult.stderr);
  const readerScript = join(repositoryRoot, "tools/platform/read-staged-journey-release-tuple.py");
  copyFileSync(join(sourceRepositoryRoot, "tools/platform/read-staged-journey-release-tuple.py"), readerScript);
  const readResult = spawnSync(
    "/usr/bin/python3",
    [
      readerScript,
      "--tuple-sha256",
      expectedTupleSha256.slice("sha256:".length),
      "--deployment-revision",
      validTuple().deploymentRevision,
      "--environment-identity",
      validTuple().environmentIdentity,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(readResult.status, 0, readResult.stderr);
  assert.equal(readResult.stdout, candidateBody());
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
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5_000 });
}

function runHelper(input, ...args) {
  return runHelperRequest(publicationRequest(input), ...args);
}

function runHelperRequest(input, ...args) {
  return spawnSync("/usr/bin/python3", [helper, ...args], {
    encoding: "utf8",
    input,
    timeout: 5_000,
  });
}

function outputIdentities() {
  return [repositoryRoot, join(repositoryRoot, "build"), candidatesRoot]
    .flatMap((path) => {
      const identity = lstatSync(path, { bigint: true });
      return [identity.dev, identity.ino];
    });
}

function publicationRequest(content, identities = outputIdentities()) {
  return `EASYSUBWAY_JRT_PUBLISH_V1 ${identities.join(" ")}\n${content}`;
}

function candidateBody() {
  return `${JSON.stringify({ ...validTuple(), tupleSha256: expectedTupleSha256 }, null, 2)}\n`;
}

function assertCandidateMissing() {
  assert.throws(() => readFileSync(candidatePath()), { code: "ENOENT" });
}
