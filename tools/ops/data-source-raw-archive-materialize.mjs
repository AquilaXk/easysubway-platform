#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./data-source-raw-archive-csv.mjs";

const [csvPath, archiveDir] = process.argv.slice(2);
assert.ok(csvPath && archiveDir, "usage: data-source-raw-archive-materialize.mjs <raw-archives.csv> <archive-dir>");

const rows = parseCsv(await readFile(csvPath, "utf8"));
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

const objectsDir = path.join(archiveDir, "objects");
await mkdir(objectsDir, { recursive: true, mode: 0o700 });
const materialized = [];
for (const row of rows) {
  const storageUri = row[index.storage_uri] ?? "";
  assert.ok(
    storageUri.startsWith("file://"),
    `unsupported storage_uri for self-contained archive: ${row[index.archive_id]}`,
  );
  const expectedSha256 = row[index.payload_sha256];
  assert.match(expectedSha256, /^[a-f0-9]{64}$/i, "payload_sha256 must be hex");
  const sourcePath = fileURLToPath(new URL(storageUri));
  const bytes = await readFile(sourcePath);
  assert.equal(sha256(bytes), expectedSha256.toLowerCase(), `payload hash mismatch: ${row[index.archive_id]}`);
  const objectPath = path.posix.join("objects", `${expectedSha256.toLowerCase()}.payload`);
  await writeFile(path.join(archiveDir, objectPath), bytes, { mode: 0o600 });
  materialized.push({
    archiveId: row[index.archive_id],
    runId: row[index.run_id],
    source: row[index.source],
    sha256: expectedSha256.toLowerCase(),
    sizeBytes: bytes.length,
    objectPath,
  });
}

await writeFile(
  path.join(archiveDir, "payload-manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, materialized }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`data source payloads materialized: ${materialized.length}`);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
