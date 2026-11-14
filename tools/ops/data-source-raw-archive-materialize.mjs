#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./data-source-raw-archive-csv.mjs";

const MAX_CSV_BYTES = 16 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const DARWIN_SYSTEM_ROOT_PATTERN = /^\/+(var|tmp|etc)\/(.+)$/;

function stripTrailingSlashes(targetPath) {
  if (targetPath.length <= 1) return targetPath;
  return targetPath.replace(/\/+$/, "") || "/";
}

function normalizeDarwinSystemRoot(inputPath) {
  if (process.platform !== "darwin" || !path.isAbsolute(inputPath)) {
    return inputPath;
  }
  const match = DARWIN_SYSTEM_ROOT_PATTERN.exec(inputPath);
  if (!match) {
    return inputPath;
  }
  const [, rootName, rest] = match;
  try {
    const topLink = lstatSync(`/${rootName}`);
    if (!topLink.isSymbolicLink() || topLink.uid !== 0) {
      return inputPath;
    }
    if (readlinkSync(`/${rootName}`) !== `private/${rootName}`) {
      return inputPath;
    }
    const priv = lstatSync("/private");
    const privSub = lstatSync(`/private/${rootName}`);
    if (priv.isSymbolicLink() || !priv.isDirectory() || privSub.isSymbolicLink() || !privSub.isDirectory()) {
      return inputPath;
    }
    return `/private/${rootName}/${rest}`;
  } catch {
    return inputPath;
  }
}

export async function assertNoSymlinkSegments(targetPath, label, { allowMissing = false } = {}) {
  assert.ok(typeof targetPath === "string" && targetPath.length > 0, `${label} path must be non-empty`);
  assert.equal(targetPath.includes("\0") || targetPath.includes("\r") || targetPath.includes("\n"), false, `${label} contains control characters`);
  assert.equal(targetPath.includes("\\"), false, `${label} must not contain backslashes`);

  const trimmed = stripTrailingSlashes(targetPath);
  assert.notEqual(trimmed, "/", `${label} must not be filesystem root`);

  const normalized = normalizeDarwinSystemRoot(trimmed);
  const rawSegments = normalized.split("/");
  assert.equal(rawSegments.includes(".."), false, `${label} must not contain parent traversal segments: ${targetPath}`);

  const resolved = path.isAbsolute(normalized) ? normalized : path.join(process.cwd(), normalized);
  assert.equal(resolved.split("/").includes(".."), false, `${label} resolved traversal is unsafe: ${targetPath}`);

  const parts = resolved.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  assert.ok(parts.length > 0, `${label} path is invalid: ${targetPath}`);

  let current = "";
  let sawMissing = false;
  for (let i = 0; i < parts.length; i += 1) {
    current = `${current}/${parts[i]}`;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        assert.ok(allowMissing, `${label} does not exist: ${current}`);
        sawMissing = true;
        continue;
      }
      throw error;
    }
    assert.equal(sawMissing, false, `${label} unexpected existing path after missing ancestor: ${current}`);
    assert.equal(info.isSymbolicLink(), false, `${label} must not traverse a symlink: ${current}`);
    if (i < parts.length - 1) {
      assert.equal(info.isDirectory(), true, `${label} parent must be a directory: ${current}`);
    }
  }
  return current;
}

export async function readRegularNoFollow(filePath, maxBytes, label) {
  assert.ok(Number.isInteger(maxBytes) && maxBytes >= 0, `${label} maxBytes must be a non-negative integer`);
  const safePath = await assertNoSymlinkSegments(filePath, label);
  const linkInfo = await lstat(safePath);
  assert.equal(linkInfo.isSymbolicLink(), false, `${label} must not be a symlink: ${filePath}`);
  assert.equal(linkInfo.isFile(), true, `${label} must be a regular file: ${filePath}`);
  assert.ok(linkInfo.size <= maxBytes, `${label} exceeds max bytes (${maxBytes}): ${filePath}`);

  const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  const handle = await open(safePath, openFlags);
  try {
    const info = await handle.stat();
    assert.equal(info.isFile(), true, `${label} must be a regular file: ${filePath}`);
    assert.equal(info.dev === linkInfo.dev && info.ino === linkInfo.ino, true, `${label} changed during open: ${filePath}`);
    assert.ok(info.size <= maxBytes, `${label} exceeds max bytes (${maxBytes}): ${filePath}`);

    const chunks = [];
    let totalRead = 0;
    while (true) {
      const toRead = Math.min(READ_CHUNK_BYTES, maxBytes - totalRead + 1);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(chunk, 0, toRead, totalRead);
      if (bytesRead === 0) {
        break;
      }
      totalRead += bytesRead;
      assert.ok(totalRead <= maxBytes, `${label} exceeds max bytes (${maxBytes}): ${filePath}`);
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalRead);
  } finally {
    await handle.close();
  }
}

async function resolveSafeSourcePath(storageUri, canonicalStorageRoot, archiveId) {
  assert.ok(
    typeof storageUri === "string" && storageUri.startsWith("file://"),
    `unsupported storage_uri for self-contained archive: ${archiveId}`,
  );
  let parsedUrl;
  try {
    parsedUrl = new URL(storageUri);
  } catch {
    assert.fail(`invalid storage_uri for self-contained archive: ${archiveId}`);
  }
  assert.equal(parsedUrl.protocol, "file:", `unsupported storage_uri protocol: ${archiveId}`);
  assert.equal(parsedUrl.hostname, "", `storage_uri host must be empty for local files: ${archiveId}`);
  assert.equal(parsedUrl.search === "" && parsedUrl.hash === "", true, `storage_uri must not include query or fragment: ${archiveId}`);

  const lowerUri = storageUri.toLowerCase();
  assert.equal(
    lowerUri.includes("%00") || lowerUri.includes("%5c") || lowerUri.includes("\\"),
    false,
    `unsafe characters in storage_uri: ${archiveId}`,
  );
  for (const rawSeg of parsedUrl.pathname.split("/")) {
    if (rawSeg === "") continue;
    let decodedSeg;
    try {
      decodedSeg = decodeURIComponent(rawSeg);
    } catch {
      assert.fail(`invalid percent encoding in storage_uri: ${archiveId}`);
    }
    assert.equal(
      decodedSeg === "." || decodedSeg === ".." || decodedSeg.includes("/") || decodedSeg.includes("\\") || decodedSeg.includes("\0"),
      false,
      `unsafe path segment in storage_uri: ${archiveId}`,
    );
  }

  const rawSourcePath = fileURLToPath(parsedUrl);
  const safeSourcePath = await assertNoSymlinkSegments(rawSourcePath, `raw archive payload ${archiveId}`);
  const canonicalSource = await realpath(safeSourcePath);
  const relative = path.relative(canonicalStorageRoot, canonicalSource);
  assert.ok(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    `storage_uri escapes data source storage root: ${archiveId}`,
  );
  return canonicalSource;
}

async function writeRegularExclusiveNoFollow(filePath, bytes, label) {
  const safeParent = await assertNoSymlinkSegments(path.dirname(filePath), `${label} parent`);
  const safeTarget = path.join(safeParent, path.basename(filePath));
  try {
    await lstat(safeTarget);
    assert.fail(`${label} output target already exists: ${filePath}`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);
  const handle = await open(safeTarget, writeFlags, 0o600);
  try {
    const info = await handle.stat();
    assert.equal(info.isFile(), true, `${label} output target must be a regular file: ${filePath}`);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      assert.ok(bytesWritten > 0, `${label} write returned 0 bytes at offset ${offset}`);
      offset += bytesWritten;
    }
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function materializeRawArchives({
  csvPath,
  archiveDir,
  storageDir = process.env.EASYSUBWAY_DATA_SOURCE_STORAGE_DIR ?? "",
}) {
  assert.ok(csvPath && archiveDir, "usage: data-source-raw-archive-materialize.mjs <raw-archives.csv> <archive-dir>");
  assert.ok(
    typeof storageDir === "string" && storageDir.trim().length > 0,
    "EASYSUBWAY_DATA_SOURCE_STORAGE_DIR is required to confine data source raw archive inputs",
  );

  const safeStorageRoot = await assertNoSymlinkSegments(storageDir, "data source storage root");
  const storageRootInfo = await lstat(safeStorageRoot);
  assert.equal(storageRootInfo.isDirectory(), true, `data source storage root must be a directory: ${storageDir}`);
  const canonicalStorageRoot = await realpath(safeStorageRoot);
  const canonicalRootInfo = await lstat(canonicalStorageRoot);
  assert.equal(
    !canonicalRootInfo.isSymbolicLink() && canonicalRootInfo.isDirectory(),
    true,
    `canonical data source storage root is unsafe: ${storageDir}`,
  );

  const safeCsvPath = await assertNoSymlinkSegments(csvPath, "raw archive CSV");
  const rows = parseCsv((await readRegularNoFollow(safeCsvPath, MAX_CSV_BYTES, "raw archive CSV")).toString("utf8"));
  const header = rows.shift() ?? [];
  const index = Object.fromEntries(header.map((name, column) => [name, column]));
  for (const name of ["archive_id", "run_id", "source", "storage_uri", "payload_sha256"]) {
    assert.ok(Number.isInteger(index[name]), `raw archive CSV missing ${name}`);
  }
  assert.ok(rows.length > 0, "source archive must contain at least one raw archive row");
  for (const row of rows) {
    assert.ok(row[index.archive_id]?.trim(), "archive_id must not be empty");
    assert.ok(row[index.run_id]?.trim(), "run_id must not be empty");
  }
  const archiveIds = rows.map((row) => row[index.archive_id]);
  assert.equal(new Set(archiveIds).size, archiveIds.length, "raw archive IDs must be unique");

  const preArchiveDir = await assertNoSymlinkSegments(archiveDir, "archive directory", { allowMissing: true });
  try {
    const existingArchiveInfo = await lstat(preArchiveDir);
    assert.equal(existingArchiveInfo.isSymbolicLink(), false, `archive directory must not be a symlink: ${archiveDir}`);
    assert.equal(existingArchiveInfo.isDirectory(), true, `archive directory exists and is not a directory: ${archiveDir}`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  await mkdir(preArchiveDir, { recursive: true, mode: 0o700 });
  const safeArchiveDir = await assertNoSymlinkSegments(preArchiveDir, "archive directory");
  assert.equal((await lstat(safeArchiveDir)).isDirectory(), true, `archive directory must be a directory: ${archiveDir}`);

  const preObjectsDir = await assertNoSymlinkSegments(path.join(safeArchiveDir, "objects"), "archive objects directory", {
    allowMissing: true,
  });
  try {
    const existingObjectsInfo = await lstat(preObjectsDir);
    assert.equal(existingObjectsInfo.isSymbolicLink(), false, `archive objects directory must not be a symlink: ${preObjectsDir}`);
    assert.equal(existingObjectsInfo.isDirectory(), true, `archive objects path exists and is not a directory: ${preObjectsDir}`);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  await mkdir(preObjectsDir, { recursive: true, mode: 0o700 });
  const safeObjectsDir = await assertNoSymlinkSegments(preObjectsDir, "archive objects directory");
  assert.equal((await lstat(safeObjectsDir)).isDirectory(), true, `archive objects directory must be a directory: ${preObjectsDir}`);

  const materialized = [];
  const writtenObjects = new Set();
  for (const row of rows) {
    const archiveId = row[index.archive_id];
    const storageUri = row[index.storage_uri] ?? "";
    const expectedSha256 = row[index.payload_sha256];
    assert.match(expectedSha256, /^[a-f0-9]{64}$/i, "payload_sha256 must be hex");

    const canonicalSourcePath = await resolveSafeSourcePath(storageUri, canonicalStorageRoot, archiveId);
    const bytes = await readRegularNoFollow(canonicalSourcePath, MAX_PAYLOAD_BYTES, `raw archive payload ${archiveId}`);
    const actualSha256 = sha256(bytes);
    assert.equal(actualSha256, expectedSha256.toLowerCase(), `payload hash mismatch: ${archiveId}`);

    const objectFileName = `${actualSha256}.payload`;
    const objectPath = path.posix.join("objects", objectFileName);
    if (!writtenObjects.has(objectPath)) {
      await writeRegularExclusiveNoFollow(path.join(safeObjectsDir, objectFileName), bytes, `archive object ${objectPath}`);
      writtenObjects.add(objectPath);
    }

    materialized.push({
      archiveId,
      runId: row[index.run_id],
      source: row[index.source],
      sha256: actualSha256,
      sizeBytes: bytes.length,
      objectPath,
    });
  }

  await writeRegularExclusiveNoFollow(
    path.join(safeArchiveDir, "payload-manifest.json"),
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, materialized }, null, 2)}\n`, "utf8"),
    "payload manifest",
  );
  console.log(`data source payloads materialized: ${materialized.length}`);
  return { materialized };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [csvPath, archiveDir] = process.argv.slice(2);
  await materializeRawArchives({ csvPath, archiveDir });
}
