#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const backupDir = process.argv[2] ?? process.env.EASYSUBWAY_PHOTO_RESTORE_DIR;

if (!backupDir) {
  console.error("Usage: node tools/ops/facility-report-photo-restore-check.mjs <restored-photo-backup-dir>");
  process.exit(2);
}

const root = process.cwd();
const restoredDir = path.resolve(root, backupDir);
const manifestPath = path.join(restoredDir, "manifest.tsv");
const expectedHeader = [
  "report_id",
  "file_name",
  "content_type",
  "object_key",
  "thumbnail_object_key",
  "sha256",
  "size_bytes",
  "object_path",
  "thumbnail_path",
];

function assertSafeRelativeKey(value, label) {
  assert.ok(value.length > 0, `${label} must not be empty`);
  assert.equal(path.isAbsolute(value), false, `${label} must be relative`);
  assert.equal(value.split(/[\\/]/).includes(".."), false, `${label} must not include traversal`);
}

function assertSafeOptionalKey(value, label) {
  if (value.length === 0) {
    return;
  }
  assertSafeRelativeKey(value, label);
}

function assertFileInsideBackup(relativePath, label) {
  assertSafeRelativeKey(relativePath, label);
  const resolvedPath = path.resolve(restoredDir, relativePath);
  assert.ok(resolvedPath.startsWith(`${restoredDir}${path.sep}`), `${label} must stay inside backup directory`);
  assert.ok(existsSync(resolvedPath), `${label} missing: ${relativePath}`);
  return resolvedPath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

assert.ok(existsSync(restoredDir), `photo restore directory missing: ${restoredDir}`);
assert.ok(existsSync(manifestPath), `photo restore manifest missing: ${manifestPath}`);

const lines = readFileSync(manifestPath, "utf8").trimEnd().split(/\r?\n/);
assert.ok(lines.length > 1, "photo restore manifest must contain at least one object row");
assert.deepEqual(lines[0].split("\t"), expectedHeader);

for (const [index, line] of lines.slice(1).entries()) {
  const rowNumber = index + 2;
  const columns = line.split("\t");
  assert.equal(columns.length, expectedHeader.length, `manifest row ${rowNumber} must have ${expectedHeader.length} columns`);

  const row = Object.fromEntries(expectedHeader.map((name, columnIndex) => [name, columns[columnIndex]]));
  assert.ok(row.report_id.length > 0, `manifest row ${rowNumber} report_id must not be empty`);
  assertSafeRelativeKey(row.object_key, `manifest row ${rowNumber} object_key`);
  assertSafeOptionalKey(row.thumbnail_object_key, `manifest row ${rowNumber} thumbnail_object_key`);
  assert.equal(row.object_path, `objects/${row.object_key}`, `manifest row ${rowNumber} object_path must match object_key`);

  const objectFile = assertFileInsideBackup(row.object_path, `manifest row ${rowNumber} object_path`);

  if (row.thumbnail_object_key.length > 0) {
    assert.equal(
      row.thumbnail_path,
      `objects/${row.thumbnail_object_key}`,
      `manifest row ${rowNumber} thumbnail_path must match thumbnail_object_key`,
    );
    assertFileInsideBackup(row.thumbnail_path, `manifest row ${rowNumber} thumbnail_path`);
  } else {
    assert.equal(row.thumbnail_path, "objects/", `manifest row ${rowNumber} thumbnail_path must be empty marker`);
  }

  if (row.size_bytes.length > 0) {
    assert.match(row.size_bytes, /^\d+$/, `manifest row ${rowNumber} size_bytes must be numeric`);
    assert.equal(statSync(objectFile).size, Number(row.size_bytes), `manifest row ${rowNumber} object size mismatch`);
  }

  if (row.sha256.length > 0) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/i, `manifest row ${rowNumber} sha256 must be hex`);
    assert.equal(sha256(objectFile), row.sha256.toLowerCase(), `manifest row ${rowNumber} object sha256 mismatch`);
  }
}

console.log(`facility report photo restore rehearsal ok: ${restoredDir}`);
