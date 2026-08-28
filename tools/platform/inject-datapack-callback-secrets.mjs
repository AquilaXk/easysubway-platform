import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const workflowTokenKey = "EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN";
const callbackHmacKey = "EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY";
const managedKeys = [workflowTokenKey, callbackHmacKey];

function fail(message) {
  throw new Error(message);
}

function requiredSecret(environment, key, { minimumUtf8Bytes = 1, rejectTrimWhitespace = false } = {}) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    fail(`${key} must be a nonempty single-line value`);
  }
  if (Buffer.byteLength(value, "utf8") < minimumUtf8Bytes) {
    fail(`${key} must be at least ${minimumUtf8Bytes} UTF-8 bytes`);
  }
  if (rejectTrimWhitespace && value.trim() !== value) {
    fail(`${key} must not have leading or trailing whitespace`);
  }
  return value;
}

function regularFileSnapshot(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("dotenv input must be a regular non-symlink dotenv file");
  }
  return metadata;
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

function withoutManagedDefinitions(contents) {
  return contents.split(/(?<=\n)/).filter((line) =>
    !managedKeys.some((key) => line.startsWith(`${key}=`)),
  ).join("");
}

function replacementContents(contents, values) {
  const preserved = withoutManagedDefinitions(contents);
  const separator = preserved.length > 0 && !preserved.endsWith("\n") ? "\n" : "";
  return `${preserved}${separator}${workflowTokenKey}=${values.workflowToken}\n${callbackHmacKey}=${values.callbackHmac}\n`;
}

function atomicReplace(path, contents, expectedSnapshot) {
  const temporaryPath = join(dirname(path), `.datapack-callback-${randomBytes(16).toString("hex")}`);
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

export function inject(path, environment = process.env) {
  const values = {
    workflowToken: requiredSecret(environment, workflowTokenKey, { rejectTrimWhitespace: true }),
    callbackHmac: requiredSecret(environment, callbackHmacKey, { minimumUtf8Bytes: 32 }),
  };
  const source = stableRead(path);
  atomicReplace(path, replacementContents(source.contents, values), source.snapshot);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  try {
    if (process.argv.length !== 3) fail("usage: inject-datapack-callback-secrets.mjs <dotenv-path>");
    inject(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
