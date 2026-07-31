#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const build = resolve(root, "build");
const artifactUrl = "https://raw.githubusercontent.com/AquilaXk/easysubway/main/contracts/bundles/platform-contracts-v1.0.0.json";
const resource = "platform/deployment-contract.json";

try {
  const options = parseArguments(process.argv.slice(2));
  assertFile(options.lock, "lock");
  assertFile(options.input, "input");
  const output = outputBelowBuild(options.output);
  const lock = json(readFileSync(options.lock), "lock");
  exactKeys(lock, ["schemaVersion", "bundleVersion", "artifactUrl", "sha256"], "lock");
  if (lock.schemaVersion !== 1 || lock.bundleVersion !== "1.0.0" || lock.artifactUrl !== artifactUrl || !/^[a-f0-9]{64}$/.test(lock.sha256)) throw new Error("invalid lock");

  const bytes = readFileSync(options.input);
  if (sha(bytes) !== lock.sha256) throw new Error("bundle sha256 mismatch");
  const bundle = json(bytes, "bundle");
  exactKeys(bundle, ["schemaVersion", "bundleVersion", "componentManifestSchemaSha256", "issueRefSchemaSha256", "resources"], "bundle");
  if (bundle.schemaVersion !== 1 || bundle.bundleVersion !== lock.bundleVersion) throw new Error("bundle version mismatch");
  if (bundle.componentManifestSchemaSha256 !== sha(readFileSync(resolve(root, "contracts/release/component-manifest.schema.json")))) throw new Error("component schema pin mismatch");
  if (bundle.issueRefSchemaSha256 !== sha(readFileSync(resolve(root, "contracts/release/issue-ref.schema.json")))) throw new Error("issueRef schema pin mismatch");
  exactKeys(bundle.resources, [resource], "resources");
  if (typeof bundle.resources[resource] !== "string") throw new Error("invalid resource");
  const document = json(Buffer.from(bundle.resources[resource]), "resource");
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("invalid resource");

  const temporary = `${output}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    const destination = resolve(temporary, resource);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bundle.resources[resource]);
    mkdirSync(dirname(output), { recursive: true });
    rmSync(output, { recursive: true, force: true });
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  const allowed = new Set(["--lock", "--input", "--output"]);
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(key)) throw new Error(`unknown option: ${key}`);
    if (!value || value.startsWith("--")) throw new Error(`missing value: ${key}`);
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  if (values.size !== allowed.size) throw new Error("lock, input, and output are required");
  return { lock: values.get("--lock"), input: values.get("--input"), output: values.get("--output") };
}

function assertFile(path, label) {
  if (!lstatSync(path).isFile()) throw new Error(`${label} must be a regular file`);
}

function outputBelowBuild(path) {
  const output = resolve(path);
  const below = relative(build, output);
  if (!below || below.startsWith("..") || below.includes("../")) throw new Error("output must be below build");
  mkdirSync(build, { recursive: true });
  if (lstatSync(build).isSymbolicLink()) throw new Error("build must not be a symlink");
  const normalizedBuild = realpathSync(build);
  let current = build;
  for (const segment of below.split("/")) {
    current = resolve(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error("output must not have a symlink ancestor");
    if (!lstatSync(current).isDirectory()) throw new Error("output ancestor must be a directory");
  }
  return resolve(normalizedBuild, below);
}

function json(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(`invalid ${label} JSON`); }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`invalid ${label}`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
