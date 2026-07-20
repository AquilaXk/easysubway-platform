#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseCsv } from "./data-source-raw-archive-csv.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const archiveDir = resolveArchiveDirectory(process.env.EASYSUBWAY_DATA_SOURCE_RESTORE_DIR);

const collectionRuns = parseCsv(readArchiveMetadata("collection-runs.csv"));
const rawArchives = parseCsv(readArchiveMetadata("raw-archives.csv"));
const manifest = JSON.parse(readArchiveMetadata("payload-manifest.json"));
assert.equal(manifest.schemaVersion, 1);
assert.ok(manifest.materialized.length > 0, "source archive must contain at least one materialized payload");

const collectionHeader = collectionRuns.shift();
const rawHeader = rawArchives.shift();
const collectionRunIndex = collectionHeader.indexOf("run_id");
const rawIndex = Object.fromEntries(rawHeader.map((name, column) => [name, column]));
assert.ok(collectionRunIndex >= 0, "collection-runs.csv missing run_id");
for (const name of ["archive_id", "run_id", "payload_sha256"]) {
  assert.ok(Number.isInteger(rawIndex[name]), `raw-archives.csv missing ${name}`);
}
for (const row of collectionRuns) {
  assert.ok(row[collectionRunIndex]?.trim(), "run_id must not be empty");
}
for (const row of rawArchives) {
  assert.ok(row[rawIndex.archive_id]?.trim(), "archive_id must not be empty");
  assert.ok(row[rawIndex.run_id]?.trim(), "run_id must not be empty");
}
const runIds = new Set(collectionRuns.map((row) => row[collectionRunIndex]));
assert.equal(runIds.size, collectionRuns.length, "collection run IDs must be unique");
const archives = new Map(rawArchives.map((row) => [row[rawIndex.archive_id], row]));
assert.equal(archives.size, rawArchives.length, "raw archive IDs must be unique");
const materializedArchiveIds = manifest.materialized.map((record) => record.archiveId);
assert.equal(
  new Set(materializedArchiveIds).size,
  materializedArchiveIds.length,
  "materialized archive IDs must be unique",
);
assert.equal(
  manifest.materialized.length,
  rawArchives.length,
  "every raw archive row must have a materialized payload",
);
assert.deepEqual(
  materializedArchiveIds.toSorted(compareStrings),
  [...archives.keys()].toSorted(compareStrings),
);

for (const record of manifest.materialized) {
  assert.ok(record.archiveId?.trim(), "materialized archiveId must not be empty");
  assert.ok(record.runId?.trim(), "materialized runId must not be empty");
  const row = archives.get(record.archiveId);
  assert.ok(row, `materialized archive missing from raw-archives.csv: ${record.archiveId}`);
  assert.ok(runIds.has(record.runId), `materialized archive run missing from collection-runs.csv: ${record.runId}`);
  assert.equal(row[rawIndex.run_id], record.runId);
  const rawSha256 = row[rawIndex.payload_sha256];
  assert.match(rawSha256, /^[a-f0-9]{64}$/i, "raw archive payload_sha256 must be hex");
  assert.equal(rawSha256.toLowerCase(), record.sha256);
  assertSafeRelativePath(record.objectPath);
  const objectPath = path.resolve(archiveDir, record.objectPath);
  assert.ok(objectPath.startsWith(`${archiveDir}${path.sep}`));
  assert.ok(existsSync(objectPath), `materialized payload missing: ${record.objectPath}`);
  const objectStatus = lstatSync(objectPath);
  assert.equal(objectStatus.isSymbolicLink(), false, `materialized payload must not be a symlink: ${record.objectPath}`);
  assert.equal(objectStatus.isFile(), true, `materialized payload must be a regular file: ${record.objectPath}`);
  const realObjectPath = realpathSync(objectPath);
  assert.ok(realObjectPath.startsWith(`${archiveDir}${path.sep}`), "materialized payload must stay inside archive");
  assert.equal(statSync(realObjectPath).size, record.sizeBytes);
  assert.equal(createHash("sha256").update(readFileSync(realObjectPath)).digest("hex"), record.sha256);
}
console.log(`data source archive restore rehearsal ok: ${manifest.materialized.length} payload(s)`);

function assertSafeRelativePath(value) {
  assert.equal(path.isAbsolute(value), false, "objectPath must be relative");
  assert.equal(value.split(/[\\/]/).includes(".."), false, "objectPath must not contain traversal");
}

function readArchiveMetadata(fileName) {
  const filePath = path.join(archiveDir, fileName);
  const status = lstatSync(filePath);
  assert.equal(status.isSymbolicLink(), false, `archive metadata must not be a symlink: ${fileName}`);
  assert.equal(status.isFile(), true, `archive metadata must be a regular file: ${fileName}`);
  const realFilePath = realpathSync(filePath);
  assert.ok(realFilePath.startsWith(`${archiveDir}${path.sep}`), `archive metadata must stay inside archive: ${fileName}`);
  return readFileSync(realFilePath, "utf8");
}

function resolveArchiveDirectory(value) {
  assert.ok(value, "EASYSUBWAY_DATA_SOURCE_RESTORE_DIR is required");
  const resolved = path.resolve(value);
  const status = lstatSync(resolved);
  if (status.isSymbolicLink()) throw new Error("archive directory must not be a symlink");
  if (!status.isDirectory()) throw new Error("archive directory must be a directory");
  return realpathSync(resolved);
}

function compareStrings(left, right) {
  return codepointCompare(left, right);
}
