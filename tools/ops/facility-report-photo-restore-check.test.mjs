import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("./facility-report-photo-restore-check.mjs", import.meta.url));
const HEADER = ["report_id", "file_name", "content_type", "object_key", "thumbnail_object_key", "sha256", "size_bytes", "object_path", "thumbnail_path"];
const PHOTO = Buffer.from("photo-bytes");
const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sandbox() {
  const directory = mkdtempSync(path.join(tmpdir(), "photo-restore-"));
  sandboxes.push(directory);
  return directory;
}

function manifestRow(objectKey, bytes) {
  return ["r1", "a.jpg", "image/jpeg", objectKey, "", createHash("sha256").update(bytes).digest("hex"), String(bytes.length), `objects/${objectKey}`, "objects/"];
}

function writeManifest(restoreDir, rows) {
  writeFileSync(path.join(restoreDir, "manifest.tsv"), [HEADER, ...rows].map((row) => row.join("\t")).join("\n"));
}

function runCheck(restoreDir) {
  return spawnSync(process.execPath, [CHECK, restoreDir], { encoding: "utf8" });
}

function restoreDirWithPhoto() {
  const restoreDir = path.join(sandbox(), "restore");
  mkdirSync(path.join(restoreDir, "objects"), { recursive: true });
  writeFileSync(path.join(restoreDir, "objects", "a.jpg"), PHOTO);
  writeManifest(restoreDir, [manifestRow("a.jpg", PHOTO)]);
  return restoreDir;
}

test("a regular restored backup passes", () => {
  const result = runCheck(restoreDirWithPhoto());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /photo restore rehearsal ok/);
});

test("an object symlinked outside the backup is rejected even when size and sha256 match", () => {
  const restoreDir = restoreDirWithPhoto();
  const outside = path.join(path.dirname(restoreDir), "outside.jpg");
  writeFileSync(outside, PHOTO);
  rmSync(path.join(restoreDir, "objects", "a.jpg"));
  symlinkSync(outside, path.join(restoreDir, "objects", "a.jpg"));
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
});

test("an object hardlinked to a file outside the backup is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  const outside = path.join(path.dirname(restoreDir), "outside.jpg");
  writeFileSync(outside, PHOTO);
  rmSync(path.join(restoreDir, "objects", "a.jpg"));
  linkSync(outside, path.join(restoreDir, "objects", "a.jpg"));
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hardlink/);
});

test("an objects directory symlinked outside the backup is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  const outsideObjects = path.join(path.dirname(restoreDir), "outside-objects");
  mkdirSync(outsideObjects);
  writeFileSync(path.join(outsideObjects, "a.jpg"), PHOTO);
  rmSync(path.join(restoreDir, "objects"), { recursive: true });
  symlinkSync(outsideObjects, path.join(restoreDir, "objects"));
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
});

test("a manifest symlinked outside the backup is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  const outsideManifest = path.join(path.dirname(restoreDir), "outside-manifest.tsv");
  writeFileSync(outsideManifest, [HEADER, manifestRow("a.jpg", PHOTO)].map((row) => row.join("\t")).join("\n"));
  rmSync(path.join(restoreDir, "manifest.tsv"));
  symlinkSync(outsideManifest, path.join(restoreDir, "manifest.tsv"));
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
});

test("a traversal object key is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  writeManifest(restoreDir, [manifestRow("../outside.jpg", PHOTO)]);
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /traversal/);
});

test("a size or sha256 mismatch is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  writeManifest(restoreDir, [manifestRow("a.jpg", Buffer.from("other-bytes"))]);
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
});

test("a missing object is rejected", () => {
  const restoreDir = restoreDirWithPhoto();
  writeManifest(restoreDir, [manifestRow("missing.jpg", PHOTO)]);
  const result = runCheck(restoreDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing/);
});
