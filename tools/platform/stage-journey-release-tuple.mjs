import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const identityFields = [
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
];
const requiredFields = ["schemaVersion", "artifactKind", ...identityFields];
const digestPattern = /^sha256:[a-f0-9]{64}(?![\s\S])/;
const revisionPattern = /^[a-f0-9]{40}(?![\s\S])/;
const environmentPattern = /^[A-Za-z0-9._-]+(?![\s\S])/;

class JourneyReleaseTupleError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, exitCode, message) {
  throw new JourneyReleaseTupleError(code, exitCode, message);
}

function parseInputArgument(args) {
  if (args.length !== 2 || args[0] !== "--input" || !args[1] || args[1].startsWith("--")) {
    fail("E_JRT_USAGE", 2, "expected exactly --input <regular-file>");
  }
  return args[1];
}

function readTuple(inputPath) {
  let descriptor;
  try {
    descriptor = openSync(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail("E_JRT_INPUT_NOT_REGULAR", 2, "input must be a regular file");
  }
  try {
    if (!fstatSync(descriptor).isFile()) fail("E_JRT_INPUT_NOT_REGULAR", 2, "input must be a regular file");
    const parsed = JSON.parse(readFileSync(descriptor, "utf8"));
    validateTuple(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof JourneyReleaseTupleError) throw error;
    fail("E_JRT_INPUT_JSON", 2, "input must contain valid JSON");
  } finally {
    closeSync(descriptor);
  }
}

function validateTuple(tuple) {
  if (tuple === null || Array.isArray(tuple) || typeof tuple !== "object") {
    fail("E_JRT_TUPLE_SCHEMA", 2, "input must be a JSON object");
  }
  const keys = Object.keys(tuple);
  if (keys.length !== requiredFields.length || !requiredFields.every((field) => Object.hasOwn(tuple, field))) {
    fail("E_JRT_TUPLE_SCHEMA", 2, "input must contain exactly the Journey release tuple fields");
  }
  if (tuple.schemaVersion !== "JOURNEY_RELEASE_TUPLE_V1" || tuple.artifactKind !== "journey-release-tuple") {
    fail("E_JRT_TUPLE_SCHEMA", 2, "input constants do not match JOURNEY_RELEASE_TUPLE_V1");
  }
  if (!identityFields.slice(0, 4).every((field) => typeof tuple[field] === "string" && digestPattern.test(tuple[field]))) {
    fail("E_JRT_TUPLE_SCHEMA", 2, "input digest fields must be lowercase sha256 digests");
  }
  if (typeof tuple.deploymentRevision !== "string" || !revisionPattern.test(tuple.deploymentRevision)) {
    fail("E_JRT_TUPLE_SCHEMA", 2, "deploymentRevision must be a lowercase Git SHA");
  }
  if (typeof tuple.environmentIdentity !== "string" || tuple.environmentIdentity.length > 255 || !environmentPattern.test(tuple.environmentIdentity)) {
    fail("E_JRT_TUPLE_SCHEMA", 2, "environmentIdentity is invalid");
  }
}

function tupleHash(tuple) {
  const bytes = `${identityFields.map((field) => tuple[field]).join("\n")}\n`;
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function lstatDirectory(path) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail("E_JRT_OUTPUT_CONFINEMENT", 2, "output path contains a symlink or non-directory ancestor");
    }
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof JourneyReleaseTupleError) throw error;
    fail("E_JRT_OUTPUT_CONFINEMENT", 2, "cannot inspect output path");
  }
}

function prepareOutput() {
  const rootIdentity = lstatDirectory(repositoryRoot);
  const buildPath = join(repositoryRoot, "build");
  const candidatesPath = join(buildPath, "candidates");
  const buildIdentity = lstatDirectory(buildPath);
  const candidatesIdentity = lstatDirectory(candidatesPath);
  return { rootIdentity, buildPath, buildIdentity, candidatesPath, candidatesIdentity };
}

function verifyOutputRoot(output) {
  const root = lstatDirectory(repositoryRoot);
  const build = lstatDirectory(output.buildPath);
  const candidates = lstatDirectory(output.candidatesPath);
  if (
    root.dev !== output.rootIdentity.dev || root.ino !== output.rootIdentity.ino
    || build.dev !== output.buildIdentity.dev || build.ino !== output.buildIdentity.ino
    || candidates.dev !== output.candidatesIdentity.dev || candidates.ino !== output.candidatesIdentity.ino
  ) {
    fail("E_JRT_OUTPUT_CONFINEMENT", 2, "output root identity changed before publish");
  }
}

function stage(tuple, tupleSha256) {
  const output = prepareOutput();
  const ordered = Object.fromEntries(requiredFields.map((field) => [field, tuple[field]]));
  const content = `${JSON.stringify({ ...ordered, tupleSha256 }, null, 2)}\n`;
  verifyOutputRoot(output);
  const helper = join(repositoryRoot, "tools/platform/secure-publish-journey-release-tuple.py");
  const identityHeader = [
    "EASYSUBWAY_JRT_PUBLISH_V1",
    output.rootIdentity.dev,
    output.rootIdentity.ino,
    output.buildIdentity.dev,
    output.buildIdentity.ino,
    output.candidatesIdentity.dev,
    output.candidatesIdentity.ino,
  ].join(" ");
  const result = spawnSync("/usr/bin/python3", [helper], {
    encoding: "utf8",
    input: `${identityHeader}\n${content}`,
  });
  if (result.error || result.status === null) fail("E_JRT_STAGE_IO", 1, "secure publisher could not run");
  if (result.status === 0) return;
  const code = result.stderr.trim().split(/\s+/, 1)[0];
  if (["E_JRT_OUTPUT_CONFINEMENT", "E_JRT_OUTPUT_EXISTS", "E_JRT_STAGE_IO"].includes(code)) {
    fail(code, code === "E_JRT_STAGE_IO" ? 1 : 2, "secure publisher rejected staging");
  }
  fail("E_JRT_STAGE_IO", 1, "secure publisher failed");
}

function main() {
  const inputPath = parseInputArgument(process.argv.slice(2));
  const tuple = readTuple(inputPath);
  stage(tuple, tupleHash(tuple));
}

try {
  main();
} catch (error) {
  if (error instanceof JourneyReleaseTupleError) {
    console.error(`${error.code} ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error("E_JRT_STAGE_IO unexpected staging failure");
    process.exitCode = 1;
  }
}
