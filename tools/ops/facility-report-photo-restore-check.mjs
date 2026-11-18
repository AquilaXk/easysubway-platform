#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { readRegularFile } from "../lib/read-regular-file.mjs";

const backupDir = process.argv[2] ?? process.env.EASYSUBWAY_PHOTO_RESTORE_DIR;

if (!backupDir) {
  console.error("Usage: node tools/ops/facility-report-photo-restore-check.mjs <restored-photo-backup-dir>");
  process.exit(2);
}

const root = process.cwd();
const requestedDir = path.resolve(root, backupDir);
assert.ok(existsSync(requestedDir), `photo restore directory missing: ${requestedDir}`);
// 운영자가 지정한 복구 디렉터리 자체는 해석해 기준 루트로 삼고, 그 아래 경로는 symlink 없이 일반 파일만 읽는다.
const restoredDir = realpathSync(requestedDir);
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

async function readFileInsideBackup(relativePath, label) {
  assertSafeRelativeKey(relativePath, label);
  try {
    return await readRegularFile(restoredDir, relativePath, { label });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} missing: ${relativePath}`);
    }
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const manifestBytes = await readFileInsideBackup("manifest.tsv", "photo restore manifest");
const lines = manifestBytes.toString("utf8").trimEnd().split(/\r?\n/);
assert.ok(lines.length > 1, "photo restore manifest must contain at least one object row");
assert.deepEqual(lines[0].split("\t"), expectedHeader);

async function verifyManifestRow(line, rowNumber) {
  const columns = line.split("\t");
  assert.equal(columns.length, expectedHeader.length, `manifest row ${rowNumber} must have ${expectedHeader.length} columns`);

  const row = Object.fromEntries(expectedHeader.map((name, columnIndex) => [name, columns[columnIndex]]));
  assert.ok(row.report_id.length > 0, `manifest row ${rowNumber} report_id must not be empty`);
  assertSafeRelativeKey(row.object_key, `manifest row ${rowNumber} object_key`);
  assertSafeOptionalKey(row.thumbnail_object_key, `manifest row ${rowNumber} thumbnail_object_key`);
  assert.equal(row.object_path, `objects/${row.object_key}`, `manifest row ${rowNumber} object_path must match object_key`);

  const objectBytes = await readFileInsideBackup(row.object_path, `manifest row ${rowNumber} object_path`);

  if (row.thumbnail_object_key.length > 0) {
    assert.equal(
      row.thumbnail_path,
      `objects/${row.thumbnail_object_key}`,
      `manifest row ${rowNumber} thumbnail_path must match thumbnail_object_key`,
    );
    await readFileInsideBackup(row.thumbnail_path, `manifest row ${rowNumber} thumbnail_path`);
  } else {
    assert.equal(row.thumbnail_path, "objects/", `manifest row ${rowNumber} thumbnail_path must be empty marker`);
  }

  if (row.size_bytes.length > 0) {
    assert.match(row.size_bytes, /^\d+$/, `manifest row ${rowNumber} size_bytes must be numeric`);
    assert.equal(objectBytes.length, Number(row.size_bytes), `manifest row ${rowNumber} object size mismatch`);
  }

  if (row.sha256.length > 0) {
    assert.match(row.sha256, /^[a-f0-9]{64}$/i, `manifest row ${rowNumber} sha256 must be hex`);
    assert.equal(sha256(objectBytes), row.sha256.toLowerCase(), `manifest row ${rowNumber} object sha256 mismatch`);
  }
}

// 사진 수가 많을 수 있어 행을 하나씩 순서대로 읽는다(동시에 읽으면 메모리·파일 핸들이 사진 수만큼 커진다).
for (const [index, line] of lines.slice(1).entries()) {
  await verifyManifestRow(line, index + 2); // NOSONAR -- 순차 실행이 의도다: 행마다 사진 전체를 메모리에 올리므로 동시 실행하면 사진 수만큼 메모리와 파일 핸들이 늘어난다.
}

console.log(`facility report photo restore rehearsal ok: ${restoredDir}`);
