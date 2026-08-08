import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceReader = fileURLToPath(new URL("./read-staged-journey-release-tuple.py", import.meta.url));
const revision = "e".repeat(40);
const environment = "production";

test("reads only the exact requested canonical staged tuple", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    const bytes = canonical(candidate);
    writeCandidate(fixture, candidate, bytes);
    const result = run(fixture, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout, Buffer.from(bytes));
    assert.equal(result.stderr.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("external reader symlink resolves to its tracked fixture repository only", () => {
  const fixture = createFixture();
  const external = mkdtempSync(join(tmpdir(), "journey-tuple-reader-external-"));
  try {
    const candidate = tuple();
    const bytes = canonical(candidate);
    const externalReader = join(external, "tools/platform/read-staged-journey-release-tuple.py");
    const externalCandidate = join(external, "build/candidates", `journey-release-tuple-${sha(candidate)}.json`);
    writeCandidate(fixture, candidate, bytes);
    mkdirSync(dirname(externalReader), { recursive: true });
    mkdirSync(dirname(externalCandidate), { recursive: true });
    symlinkSync(fixture.reader, externalReader);
    writeFileSync(externalCandidate, "external symlink-tree candidate");
    const result = spawnSync("/usr/bin/python3", [externalReader, "--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment], { cwd: external, encoding: null, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.deepEqual(result.stdout, Buffer.from(bytes));
    rmSync(candidatePath(fixture, candidate));
    assertFailure(spawnSync("/usr/bin/python3", [externalReader, "--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment], { cwd: external, encoding: null, timeout: 5000 }), "E_JRT_CANDIDATE_NOT_REGULAR");
    assert.equal(readFileSync(externalCandidate, "utf8"), "external symlink-tree candidate");
  } finally {
    fixture.cleanup();
    rmSync(external, { recursive: true, force: true });
  }
});

test("rejects invalid CLI shapes without stdout", () => {
  const fixture = createFixture();
  try {
    for (const args of [[], ["--deployment-revision", revision, "--tuple-sha256", "a".repeat(64), "--environment-identity", environment], ["--tuple-sha256", "A".repeat(64), "--deployment-revision", revision, "--environment-identity", environment], ["--tuple-sha256", "a".repeat(64), "--deployment-revision", revision, "--environment-identity", environment, "--environment-identity", environment]]) {
      const result = runArgs(fixture, args);
      assertFailure(result, "E_JRT_READ_USAGE");
    }
  } finally {
    fixture.cleanup();
  }
});

test("rejects absent, symlink, special, and oversized candidates", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    assertFailure(run(fixture, candidate), "E_JRT_CANDIDATE_NOT_REGULAR");
    const path = candidatePath(fixture, candidate);
    symlinkSync("elsewhere.json", path);
    assertFailure(run(fixture, candidate), "E_JRT_READ_CONFINEMENT");
    rmSync(path);
    createFifo(path);
    assertFailure(run(fixture, candidate), "E_JRT_CANDIDATE_NOT_REGULAR");
    rmSync(path, { recursive: true });
    writeFileSync(path, "x".repeat(4097));
    assertFailure(run(fixture, candidate), "E_JRT_CANDIDATE_NOT_REGULAR");
  } finally {
    fixture.cleanup();
  }
});

test("rejects ancestor replacement and never selects a sibling", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    const sibling = tuple({ environmentIdentity: "staging" });
    const siblingBytes = canonical(sibling);
    writeCandidate(fixture, sibling, siblingBytes);
    const before = readdirSync(fixture.candidates).sort();
    assertFailure(run(fixture, candidate), "E_JRT_CANDIDATE_NOT_REGULAR");
    assert.deepEqual(readdirSync(fixture.candidates).sort(), before);
    assert.deepEqual(readFileSync(candidatePath(fixture, sibling)), Buffer.from(siblingBytes));
    rmSync(fixture.candidates, { recursive: true });
    symlinkSync("/tmp", fixture.candidates);
    assertFailure(run(fixture, candidate), "E_JRT_READ_CONFINEMENT");
  } finally {
    fixture.cleanup();
  }
});

test("rejects malformed, duplicate, reordered, extra, and non-canonical candidates", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    const cases = [
      ["{", "E_JRT_CANDIDATE_JSON"],
      [`{"schemaVersion":"JOURNEY_RELEASE_TUPLE_V1","schemaVersion":"JOURNEY_RELEASE_TUPLE_V1"}`, "E_JRT_CANDIDATE_JSON"],
      [JSON.stringify(Object.fromEntries(Object.entries(candidate).reverse()), null, 2) + "\n", "E_JRT_CANDIDATE_SCHEMA"],
      [canonical({ ...candidate, unexpected: true }), "E_JRT_CANDIDATE_SCHEMA"],
      [canonical(candidate).replace("\n", "\r\n"), "E_JRT_CANDIDATE_SCHEMA"],
    ];
    for (const [bytes, code] of cases) {
      writeCandidate(fixture, candidate, bytes);
      assertFailure(run(fixture, candidate), code);
    }
  } finally {
    fixture.cleanup();
  }
});

test("converts a decoder RecursionError to typed candidate JSON failure", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    writeCandidate(fixture, candidate, canonical(candidate));
    writeFileSync(join(fixture.root, "tools/platform/recursion-harness.py"), `import importlib.util\nimport os\n\npath = os.path.join(os.path.dirname(__file__), "read-staged-journey-release-tuple.py")\nspec = importlib.util.spec_from_file_location("reader", path)\nreader = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(reader)\ndef recursive_loads(*args, **kwargs):\n    raise RecursionError("fixture decoder recursion")\nreader.json.loads = recursive_loads\nreader.main()\n`);
    const result = spawnSync("/usr/bin/python3", [join(fixture.root, "tools/platform/recursion-harness.py"), "--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment], { cwd: fixture.root, encoding: null, timeout: 5000 });
    assertFailure(result, "E_JRT_CANDIDATE_JSON");
  } finally {
    fixture.cleanup();
  }
});

test("converts a closed stdout fd to typed I/O without traceback", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    writeCandidate(fixture, candidate, canonical(candidate));
    const harness = join(fixture.root, "tools/platform/closed-stdout-harness.py");
    writeFileSync(harness, `import importlib.util\nimport os\n\npath = os.path.join(os.path.dirname(__file__), "read-staged-journey-release-tuple.py")\nspec = importlib.util.spec_from_file_location("reader", path)\nreader = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(reader)\nos.close(1)\nreader.main()\n`);
    const result = spawnSync("/usr/bin/python3", [harness, "--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment], { cwd: fixture.root, encoding: null, timeout: 5000 });
    assertFailure(result, "E_JRT_READ_IO");
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when the first-read candidate inode changes before the fresh guard", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    const bytes = canonical(candidate);
    writeCandidate(fixture, candidate, bytes);
    writeFileSync(join(fixture.root, "tools/platform/toctou-harness.py"), `import importlib.util\nimport os\n\npath = os.path.join(os.path.dirname(__file__), "read-staged-journey-release-tuple.py")\nspec = importlib.util.spec_from_file_location("reader", path)\nreader = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(reader)\noriginal = reader.read_candidate\nfirst = True\ndef mutate_after_first_read(fd, filename):\n    global first\n    value = original(fd, filename)\n    if first:\n        first = False\n        candidate = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(path))), "build", "candidates", filename)\n        replacement = b"x" * len(value[0])\n        replacement_fd = os.open(candidate, os.O_WRONLY)\n        try:\n            os.write(replacement_fd, replacement)\n        finally:\n            os.close(replacement_fd)\n    return value\nreader.read_candidate = mutate_after_first_read\nreader.main()\n`);
    const result = spawnSync("/usr/bin/python3", [join(fixture.root, "tools/platform/toctou-harness.py"), "--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment], { cwd: fixture.root, encoding: null, timeout: 5000 });
    assertFailure(result, "E_JRT_READ_CONFINEMENT");
  } finally {
    fixture.cleanup();
  }
});

test("binds filename, body hash, revision, and environment exactly", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple();
    writeCandidate(fixture, candidate, canonical({ ...candidate, tupleSha256: `sha256:${"0".repeat(64)}` }));
    assertFailure(run(fixture, candidate), "E_JRT_CANDIDATE_IDENTITY");
    writeCandidate(fixture, candidate, canonical(candidate));
    assertFailure(runArgs(fixture, ["--tuple-sha256", sha(candidate), "--deployment-revision", "a".repeat(40), "--environment-identity", environment]), "E_JRT_CANDIDATE_IDENTITY");
    assertFailure(runArgs(fixture, ["--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", "staging"]), "E_JRT_CANDIDATE_IDENTITY");
  } finally {
    fixture.cleanup();
  }
});

test("rejects a canonical 256-character environment identity as candidate schema", () => {
  const fixture = createFixture();
  try {
    const candidate = tuple({ environmentIdentity: "a".repeat(256) });
    writeCandidate(fixture, candidate, canonical(candidate));
    assertFailure(runArgs(fixture, ["--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", candidate.environmentIdentity]), "E_JRT_CANDIDATE_SCHEMA");
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "journey-tuple-reader-"));
  const reader = join(root, "tools/platform/read-staged-journey-release-tuple.py");
  const candidates = join(root, "build/candidates");
  mkdirSync(dirname(reader), { recursive: true });
  mkdirSync(candidates, { recursive: true });
  if (existsSync(sourceReader)) cpSync(sourceReader, reader);
  return { root, reader, candidates, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function tuple(overrides = {}) {
  const base = { backendImageDigest: `sha256:${"a".repeat(64)}`, backendConfigDigest: `sha256:${"b".repeat(64)}`, journeyContractDigest: `sha256:${"c".repeat(64)}`, serverRouteBundleDigest: `sha256:${"d".repeat(64)}`, deploymentRevision: revision, environmentIdentity: environment, ...overrides };
  const values = [base.backendImageDigest, base.backendConfigDigest, base.journeyContractDigest, base.serverRouteBundleDigest, base.deploymentRevision, base.environmentIdentity];
  return { schemaVersion: "JOURNEY_RELEASE_TUPLE_V1", artifactKind: "journey-release-tuple", ...base, tupleSha256: `sha256:${createHash("sha256").update(`${values.join("\n")}\n`, "utf8").digest("hex")}` };
}

function sha(candidate) { return candidate.tupleSha256.slice("sha256:".length); }
function canonical(candidate) { return `${JSON.stringify(candidate, null, 2)}\n`; }
function candidatePath(fixture, candidate, requested = sha(candidate)) { return join(fixture.candidates, `journey-release-tuple-${requested}.json`); }
function writeCandidate(fixture, candidate, bytes, requested = sha(candidate)) { writeFileSync(candidatePath(fixture, candidate, requested), bytes); }
function run(fixture, candidate) { return runArgs(fixture, ["--tuple-sha256", sha(candidate), "--deployment-revision", revision, "--environment-identity", environment]); }
function runArgs(fixture, args) { return spawnSync("/usr/bin/python3", [fixture.reader, ...args], { cwd: fixture.root, encoding: null, timeout: 5000 }); }
function createFifo(path) { const result = spawnSync("mkfifo", [path], { encoding: null, timeout: 5000 }); assert.equal(result.status, 0, result.stderr?.toString()); }
function assertFailure(result, code) { assert.equal(result.status, code === "E_JRT_READ_IO" ? 1 : 2, result.stderr?.toString()); assert.equal(result.stdout?.length ?? 0, 0); assert.match(result.stderr.toString(), new RegExp(`^${code}\\b`)); }
