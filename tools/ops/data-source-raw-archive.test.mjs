import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ARCHIVE_SCRIPT = fileURLToPath(new URL("./data-source-raw-archive.sh", import.meta.url));
const MATERIALIZE_SCRIPT = fileURLToPath(new URL("./data-source-raw-archive-materialize.mjs", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "raw-archive-test-"));
  sandboxes.push(root);
  const binDir = path.join(root, "bin");
  const backupDir = path.join(root, "raw-backups");
  const payloadsDir = path.join(root, "payloads");
  const envFile = path.join(root, "runtime.env");
  const composeFile = path.join(root, "docker-compose.yml");
  const streamFixture = path.join(root, "stream.txt");
  const dockerLog = path.join(root, "docker.log");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(payloadsDir, { recursive: true });
  writeFileSync(envFile, "POSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=raw-archive-secret\n");
  chmodSync(envFile, 0o600);
  writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:17\n");

  const payload = Buffer.from('{"stations":[]}');
  const payloadSha = createHash("sha256").update(payload).digest("hex");
  const payloadPath = path.join(payloadsDir, "sample.json");
  writeFileSync(payloadPath, payload);

  writeFileSync(
    streamFixture,
    [
      "BEGIN",
      "__EASYSUBWAY_COLLECTION_RUNS__",
      "run_id,source,status,requested_by,started_at,completed_at,collected_count,failure_message,retryable,operator_action",
      "run-1,kric,SUCCEEDED,scheduler,2026-11-14T00:00:00Z,2026-11-14T00:01:00Z,1,,false,none",
      "__EASYSUBWAY_RAW_ARCHIVES__",
      "archive_id,run_id,source,source_url,storage_uri,payload_sha256,content_type,captured_at",
      `arch-1,run-1,kric,https://example.test/data,${pathToFileURL(payloadPath).href},${payloadSha},application/json,2026-11-14T00:00:30Z`,
      "COMMIT",
      "",
    ].join("\n"),
  );

  const dockerStub = path.join(binDir, "docker");
  writeFileSync(
    dockerStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "${DOCKER_LOG_FILE}"',
      "cat >/dev/null",
      'cat "${STREAM_FIXTURE}"',
      "",
    ].join("\n"),
  );
  chmodSync(dockerStub, 0o755);

  return { root, binDir, backupDir, payloadsDir, envFile, composeFile, streamFixture, dockerLog, payload, payloadSha };
}

function runArchive(sandbox, extraEnv = {}, backupDirArg = sandbox.backupDir) {
  const env = {
    ...process.env,
    PATH: `${sandbox.binDir}:${process.env.PATH}`,
    EASYSUBWAY_ENV_FILE: sandbox.envFile,
    EASYSUBWAY_COMPOSE_FILE: sandbox.composeFile,
    EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: sandbox.payloadsDir,
    STREAM_FIXTURE: sandbox.streamFixture,
    DOCKER_LOG_FILE: sandbox.dockerLog,
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync("bash", [ARCHIVE_SCRIPT, backupDirArg], { encoding: "utf8", env });
}

test("data-source-raw-archive.sh fails closed without .env.example fallback or on symlink inputs", () => {
  const sandbox = createSandbox();
  assert.notEqual(runArchive(sandbox, { EASYSUBWAY_ENV_FILE: undefined }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  assert.notEqual(runArchive(sandbox, { EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: undefined }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const symlinkEnv = path.join(sandbox.root, "link.env");
  symlinkSync(sandbox.envFile, symlinkEnv);
  assert.notEqual(runArchive(sandbox, { EASYSUBWAY_ENV_FILE: symlinkEnv }).status, 0);

  const envParentTarget = path.join(sandbox.root, "env-target");
  mkdirSync(envParentTarget);
  const envUnderTarget = path.join(envParentTarget, "runtime.env");
  writeFileSync(envUnderTarget, "POSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=raw-archive-secret\n");
  chmodSync(envUnderTarget, 0o600);
  const symlinkEnvParent = path.join(sandbox.root, "link-env-parent");
  symlinkSync(envParentTarget, symlinkEnvParent);
  assert.notEqual(runArchive(sandbox, { EASYSUBWAY_ENV_FILE: path.join(symlinkEnvParent, "runtime.env") }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const outsideDir = path.join(sandbox.root, "outside");
  mkdirSync(outsideDir);
  chmodSync(outsideDir, 0o755);
  const symlinkBackup = path.join(sandbox.root, "link-backups");
  symlinkSync(outsideDir, symlinkBackup);
  assert.notEqual(runArchive(sandbox, {}, symlinkBackup).status, 0);
  assert.notEqual(runArchive(sandbox, {}, `${symlinkBackup}/`).status, 0);
  assert.notEqual(runArchive(sandbox, {}, path.join(symlinkBackup, "nested")).status, 0);
  assert.equal(existsSync(path.join(outsideDir, "nested")), false);
  assert.equal(statSync(outsideDir).mode & 0o777, 0o755);

  assert.notEqual(runArchive(sandbox, { EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: `${symlinkBackup}/` }).status, 0);
  assert.notEqual(
    runArchive(sandbox, { EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: path.join(symlinkBackup, "storage-sub") }).status,
    0,
  );
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("data-source-raw-archive-materialize.mjs rejects symlinked source payloads and succeeds on regular payloads", () => {
  const sandbox = createSandbox();
  const symlinkPayload = path.join(sandbox.payloadsDir, "link.json");
  symlinkSync(path.join(sandbox.payloadsDir, "sample.json"), symlinkPayload);
  const csvPath = path.join(sandbox.root, "raw.csv");
  const archiveDir = path.join(sandbox.root, "out-archive");
  mkdirSync(archiveDir);
  writeFileSync(
    csvPath,
    [
      "archive_id,run_id,source,source_url,storage_uri,payload_sha256,content_type,captured_at",
      `arch-1,run-1,kric,https://example.test/data,${pathToFileURL(symlinkPayload).href},${sandbox.payloadSha},application/json,2026-11-14T00:00:30Z`,
      "",
    ].join("\n"),
  );
  const bad = spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], {
    encoding: "utf8",
    env: { ...process.env, EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: sandbox.payloadsDir },
  });
  assert.notEqual(bad.status, 0);

  const ok = runArchive(sandbox, {}, `${path.join(sandbox.root, "nested-raw", "sub")}/`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotMatch(ok.stdout + ok.stderr, /raw-archive-secret/);
  const match = ok.stdout.match(/data source archive written:\s*(.+)/);
  assert.ok(match);
  assert.equal(statSync(path.join(sandbox.root, "nested-raw", "sub")).mode & 0o777, 0o700);
  const written = readFileSync(path.join(match[1].trim(), "objects", `${sandbox.payloadSha}.payload`));
  assert.deepEqual(written, sandbox.payload);
});

test("data-source-raw-archive-materialize.mjs rejects storage_uri outside root, intermediate symlinks, and traversal", () => {
  const sandbox = createSandbox();
  const archiveDir = path.join(sandbox.root, "out-archive");
  mkdirSync(archiveDir);
  const csvPath = path.join(sandbox.root, "raw.csv");
  const outsideDir = path.join(sandbox.root, "outside");
  mkdirSync(outsideDir);
  const outsideBytes = Buffer.from("HOST_SECRET_CONTENT");
  const outsideSha = createHash("sha256").update(outsideBytes).digest("hex");
  const outsideFile = path.join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, outsideBytes);

  const writeCsv = (targetPath, storageUri, sha = outsideSha) => {
    writeFileSync(
      targetPath,
      [
        "archive_id,run_id,source,source_url,storage_uri,payload_sha256,content_type,captured_at",
        `arch-1,run-1,kric,https://example.test/data,${storageUri},${sha},application/json,2026-11-14T00:00:30Z`,
        "",
      ].join("\n"),
    );
  };

  // Valid payload fails when EASYSUBWAY_DATA_SOURCE_STORAGE_DIR is omitted
  const validPayloadPath = path.join(sandbox.payloadsDir, "sample.json");
  writeCsv(csvPath, pathToFileURL(validPayloadPath).href, sandbox.payloadSha);
  const missingRootEnv = { ...process.env };
  delete missingRootEnv.EASYSUBWAY_DATA_SOURCE_STORAGE_DIR;
  assert.notEqual(spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], { encoding: "utf8", env: missingRootEnv }).status, 0);

  const storageEnv = { ...process.env, EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: sandbox.payloadsDir };

  // Regular file outside canonical storage root
  writeCsv(csvPath, pathToFileURL(outsideFile).href);
  assert.notEqual(spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], { encoding: "utf8", env: storageEnv }).status, 0);

  // Intermediate symlink directory inside storage root escaping to outsideDir
  symlinkSync(outsideDir, path.join(sandbox.payloadsDir, "escape"));
  const viaEscape = pathToFileURL(path.join(sandbox.payloadsDir, "escape", "secret.txt")).href;
  writeCsv(csvPath, viaEscape);
  assert.notEqual(spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], { encoding: "utf8", env: storageEnv }).status, 0);

  // Encoded traversal and backslash inside storage_uri
  writeCsv(csvPath, `${pathToFileURL(sandbox.payloadsDir).href}/%2e%2e/outside/secret.txt`);
  assert.notEqual(spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], { encoding: "utf8", env: storageEnv }).status, 0);
  writeCsv(csvPath, `${pathToFileURL(sandbox.payloadsDir).href}/sub%5csecret.txt`);
  assert.notEqual(spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, archiveDir], { encoding: "utf8", env: storageEnv }).status, 0);

  // csvPath and archiveDir under intermediate symlink parents
  writeCsv(csvPath, pathToFileURL(validPayloadPath).href, sandbox.payloadSha);
  const linkRoot = path.join(sandbox.root, "link-root");
  symlinkSync(sandbox.root, linkRoot);
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, path.join(linkRoot, "raw.csv"), archiveDir], { encoding: "utf8", env: storageEnv }).status,
    0,
  );
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, path.join(linkRoot, "out-archive")], { encoding: "utf8", env: storageEnv }).status,
    0,
  );
});

test("data-source-raw-archive-materialize.mjs rejects oversized payloads, FIFOs, and symlink/FIFO outputs", async () => {
  const sandbox = createSandbox();
  const storageEnv = { ...process.env, EASYSUBWAY_DATA_SOURCE_STORAGE_DIR: sandbox.payloadsDir };
  const csvPath = path.join(sandbox.root, "raw.csv");

  const writeCsv = (storageUri, sha = sandbox.payloadSha) => {
    writeFileSync(
      csvPath,
      [
        "archive_id,run_id,source,source_url,storage_uri,payload_sha256,content_type,captured_at",
        `arch-1,run-1,kric,https://example.test/data,${storageUri},${sha},application/json,2026-11-14T00:00:30Z`,
        "",
      ].join("\n"),
    );
  };

  // Sparse payload > 64 MiB rejected Fail-Closed
  const oversizedFile = path.join(sandbox.payloadsDir, "oversized.bin");
  writeFileSync(oversizedFile, "");
  truncateSync(oversizedFile, 64 * 1024 * 1024 + 1);
  writeCsv(pathToFileURL(oversizedFile).href, "a".repeat(64));
  const oversizedArchiveDir = path.join(sandbox.root, "out-oversized");
  mkdirSync(oversizedArchiveDir);
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, oversizedArchiveDir], { encoding: "utf8", env: storageEnv }).status,
    0,
  );

  // Bounded chunk reader rejects payloads exceeding arbitrary maxBytes cap directly
  const { readRegularNoFollow } = await import("./data-source-raw-archive-materialize.mjs");
  assert.equal(typeof readRegularNoFollow, "function");
  const small17 = path.join(sandbox.payloadsDir, "seventeen.bin");
  writeFileSync(small17, "0123456789abcdefX");
  await assert.rejects(() => readRegularNoFollow(small17, 16, "bounded-test"));

  // Input FIFO does not hang (O_NONBLOCK) and fails closed
  const fifoInput = path.join(sandbox.payloadsDir, "input.fifo");
  assert.equal(spawnSync("mkfifo", [fifoInput], { encoding: "utf8" }).status, 0);
  writeCsv(pathToFileURL(fifoInput).href);
  const fifoInArchiveDir = path.join(sandbox.root, "out-fifo-in");
  mkdirSync(fifoInArchiveDir);
  const fifoInRes = spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, fifoInArchiveDir], {
    encoding: "utf8",
    env: storageEnv,
    timeout: 3000,
  });
  assert.equal(fifoInRes.signal, null, "FIFO input must not hang");
  assert.notEqual(fifoInRes.status, 0);

  // Pre-planted output symlink for payload object does not overwrite outside target
  const validPayloadPath = path.join(sandbox.payloadsDir, "sample.json");
  writeCsv(pathToFileURL(validPayloadPath).href, sandbox.payloadSha);
  const sentinel = path.join(sandbox.root, "sentinel.txt");
  writeFileSync(sentinel, "UNTOUCHED");

  const symPayloadOutDir = path.join(sandbox.root, "out-sym-payload");
  mkdirSync(path.join(symPayloadOutDir, "objects"), { recursive: true });
  symlinkSync(sentinel, path.join(symPayloadOutDir, "objects", `${sandbox.payloadSha}.payload`));
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, symPayloadOutDir], { encoding: "utf8", env: storageEnv }).status,
    0,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");

  // Pre-planted output symlink for objects directory does not escape
  const symObjectsDir = path.join(sandbox.root, "out-sym-objects");
  mkdirSync(symObjectsDir);
  const outsideObjTarget = path.join(sandbox.root, "outside-obj-target");
  mkdirSync(outsideObjTarget);
  symlinkSync(outsideObjTarget, path.join(symObjectsDir, "objects"));
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, symObjectsDir], { encoding: "utf8", env: storageEnv }).status,
    0,
  );
  assert.equal(existsSync(path.join(outsideObjTarget, `${sandbox.payloadSha}.payload`)), false);

  // Pre-planted output symlink and FIFO for payload-manifest.json fail closed without overwriting or hanging
  const symManifestDir = path.join(sandbox.root, "out-sym-manifest");
  mkdirSync(symManifestDir);
  symlinkSync(sentinel, path.join(symManifestDir, "payload-manifest.json"));
  assert.notEqual(
    spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, symManifestDir], { encoding: "utf8", env: storageEnv }).status,
    0,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "UNTOUCHED");

  const fifoManifestDir = path.join(sandbox.root, "out-fifo-manifest");
  mkdirSync(fifoManifestDir);
  assert.equal(spawnSync("mkfifo", [path.join(fifoManifestDir, "payload-manifest.json")], { encoding: "utf8" }).status, 0);
  const fifoManifestRes = spawnSync(process.execPath, [MATERIALIZE_SCRIPT, csvPath, fifoManifestDir], {
    encoding: "utf8",
    env: storageEnv,
    timeout: 3000,
  });
  assert.equal(fifoManifestRes.signal, null, "FIFO manifest output must not hang");
  assert.notEqual(fifoManifestRes.status, 0);
});
