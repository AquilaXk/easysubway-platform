import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const REHEARSAL_SCRIPT = fileURLToPath(new URL("./postgres-restore-rehearsal.sh", import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/postgres-restore-rehearsal.yml", import.meta.url));
const DUMP_NAME = "easysubway-postgres-20261106T010203Z.abc123.dump";
const DUMP_BYTES = Buffer.from("PGDMP-rehearsal-fixture-payload");
const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "postgres-rehearsal-"));
  sandboxes.push(root);
  const backupDir = path.join(root, "backups");
  const binDir = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  const dockerStdin = path.join(root, "docker.stdin");
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const dockerStub = path.join(binDir, "docker");
  writeFileSync(
    dockerStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "${DOCKER_LOG_FILE}"',
      'cat > "${DOCKER_STDIN_FILE}"',
      "",
    ].join("\n"),
  );
  chmodSync(dockerStub, 0o755);

  return { root, backupDir, binDir, dockerLog, dockerStdin };
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeBackupFixture(backupDir, fileName = DUMP_NAME, bytes = DUMP_BYTES) {
  const dumpPath = path.join(backupDir, fileName);
  const digest = sha256Hex(bytes);
  writeFileSync(dumpPath, bytes);
  writeFileSync(`${dumpPath}.sha256`, `${digest}  ${dumpPath}\n`);
  return dumpPath;
}

function runRehearsal(sandbox, backupFileArg, extraEnv = {}) {
  return spawnSync("bash", [REHEARSAL_SCRIPT, backupFileArg], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      EASYSUBWAY_BACKUP_DIR: sandbox.backupDir,
      DOCKER_LOG_FILE: sandbox.dockerLog,
      DOCKER_STDIN_FILE: sandbox.dockerStdin,
      ...extraEnv,
    },
  });
}

function extractWorkflowStepRun(workflowText) {
  const marker = "- name: Rehearse database backup restoration\n";
  const stepStart = workflowText.indexOf(marker);
  assert.notEqual(stepStart, -1);
  const stepBody = workflowText.slice(stepStart);
  const runMarker = "        run: |\n";
  const runStart = stepBody.indexOf(runMarker);
  assert.notEqual(runStart, -1);
  return stepBody
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

test("postgres-restore-rehearsal workflow passes backup_file via env and delegates boundary checks to postgres-restore-rehearsal.sh", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  const runScript = extractWorkflowStepRun(workflow);

  assert.doesNotMatch(runScript, /\$\{\{\s*github\.event\.inputs/u);
  assert.match(workflow, /BACKUP_FILE_INPUT:\s*\$\{\{\s*github\.event\.inputs\.backup_file\s*\}\}/u);
  assert.doesNotMatch(workflow, /EASYSUBWAY_BACKUP_DIR:\s*\/opt\/easysubway\/backups/u);
  assert.doesNotMatch(runScript, /\bexit 0\b/u);
  assert.match(runScript, /bash tools\/ops\/postgres-restore-rehearsal\.sh "\$\{BACKUP_FILE_INPUT:-\}"/u);

  const missingDirSandbox = createSandbox();
  const missingDirPath = path.join(missingDirSandbox.root, "missing-backups");
  const missingDirResult = spawnSync("bash", ["-c", runScript], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${missingDirSandbox.binDir}:${process.env.PATH}`,
      EASYSUBWAY_BACKUP_DIR: missingDirPath,
      BACKUP_FILE_INPUT: "",
      DOCKER_LOG_FILE: missingDirSandbox.dockerLog,
      DOCKER_STDIN_FILE: missingDirSandbox.dockerStdin,
    },
  });
  assert.equal(missingDirResult.status, 1);
  assert.match(missingDirResult.stderr + missingDirResult.stdout, /Invalid backup directory:/u);

  const emptyDirSandbox = createSandbox();
  const emptyDirResult = spawnSync("bash", ["-c", runScript], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${emptyDirSandbox.binDir}:${process.env.PATH}`,
      EASYSUBWAY_BACKUP_DIR: emptyDirSandbox.backupDir,
      BACKUP_FILE_INPUT: "",
      DOCKER_LOG_FILE: emptyDirSandbox.dockerLog,
      DOCKER_STDIN_FILE: emptyDirSandbox.dockerStdin,
    },
  });
  assert.equal(emptyDirResult.status, 1);
  assert.match(emptyDirResult.stderr + emptyDirResult.stdout, /No PostgreSQL backup dump found in /u);

  const autoSelectSandbox = createSandbox();
  const olderBytes = Buffer.from("PGDMP-older-legacy-payload");
  const newerBytes = Buffer.from("PGDMP-newer-easysubway-payload");
  writeBackupFixture(autoSelectSandbox.backupDir, "postgres-20260701T000000Z.dump", olderBytes);
  writeFileSync(path.join(autoSelectSandbox.backupDir, "postgres-test.dump"), "not-a-valid-timestamped-dump");
  writeBackupFixture(autoSelectSandbox.backupDir, DUMP_NAME, newerBytes);
  const autoSelectResult = spawnSync("bash", ["-c", runScript], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${autoSelectSandbox.binDir}:${process.env.PATH}`,
      DEPLOY_ROOT: autoSelectSandbox.root,
      EASYSUBWAY_BACKUP_DIR: "",
      BACKUP_FILE_INPUT: "",
      DOCKER_LOG_FILE: autoSelectSandbox.dockerLog,
      DOCKER_STDIN_FILE: autoSelectSandbox.dockerStdin,
    },
  });
  assert.equal(autoSelectResult.status, 0, autoSelectResult.stderr);
  assert.equal(readFileSync(autoSelectSandbox.dockerStdin).equals(newerBytes), true);

  const bareNameSandbox = createSandbox();
  writeBackupFixture(bareNameSandbox.backupDir, DUMP_NAME);
  const bareNameResult = runRehearsal(bareNameSandbox, DUMP_NAME);
  assert.equal(bareNameResult.status, 0, bareNameResult.stderr);
  assert.equal(readFileSync(bareNameSandbox.dockerStdin).equals(DUMP_BYTES), true);
});

test("postgres-restore-rehearsal.sh rejects path traversal and files outside EASYSUBWAY_BACKUP_DIR", () => {
  const sandbox = createSandbox();
  const outsideDump = writeBackupFixture(sandbox.root, DUMP_NAME);

  const relativeTraversal = runRehearsal(sandbox, "../secret.dump");
  assert.notEqual(relativeTraversal.status, 0);
  assert.match(relativeTraversal.stderr, /traversal/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const parentEscape = runRehearsal(sandbox, `${sandbox.backupDir}/../${DUMP_NAME}`);
  assert.notEqual(parentEscape.status, 0);
  assert.match(parentEscape.stderr, /traversal/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const outsideDirect = runRehearsal(sandbox, outsideDump);
  assert.notEqual(outsideDirect.status, 0);
  assert.match(outsideDirect.stderr, /reside directly inside/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-restore-rehearsal.sh rejects a symlinked dump file", () => {
  const sandbox = createSandbox();
  const outsideDump = writeBackupFixture(sandbox.root, DUMP_NAME);
  const symlinkDump = path.join(sandbox.backupDir, DUMP_NAME);
  symlinkSync(outsideDump, symlinkDump);
  writeFileSync(`${symlinkDump}.sha256`, `${sha256Hex(DUMP_BYTES)}  ${symlinkDump}\n`);

  const result = runRehearsal(sandbox, symlinkDump);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-restore-rehearsal.sh rejects an invalid filename pattern", () => {
  const sandbox = createSandbox();
  const invalidDump = writeBackupFixture(sandbox.backupDir, "unexpected-backup.dump");

  const result = runRehearsal(sandbox, invalidDump);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /filename|pattern/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-restore-rehearsal.sh rejects a missing or symlinked .sha256 companion file", () => {
  const sandbox = createSandbox();
  const dumpPath = writeBackupFixture(sandbox.backupDir, DUMP_NAME);
  rmSync(`${dumpPath}.sha256`);

  const missingResult = runRehearsal(sandbox, dumpPath);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /checksum|sha256/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const outsideSha = path.join(sandbox.root, "outside.sha256");
  writeFileSync(outsideSha, `${sha256Hex(DUMP_BYTES)}  ${dumpPath}\n`);
  symlinkSync(outsideSha, `${dumpPath}.sha256`);

  const symlinkResult = runRehearsal(sandbox, dumpPath);
  assert.notEqual(symlinkResult.status, 0);
  assert.match(symlinkResult.stderr, /checksum|sha256/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-restore-rehearsal.sh rejects a mismatched .sha256 digest", () => {
  const sandbox = createSandbox();
  const dumpPath = writeBackupFixture(sandbox.backupDir, DUMP_NAME);
  writeFileSync(`${dumpPath}.sha256`, `${"0".repeat(64)}  ${dumpPath}\n`);

  const result = runRehearsal(sandbox, dumpPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mismatch/iu);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-restore-rehearsal.sh succeeds for valid backup dumps and matching .sha256", () => {
  for (const fileName of [DUMP_NAME, "postgres-20261106T010203Z.dump"]) {
    const sandbox = createSandbox();
    const dumpPath = writeBackupFixture(sandbox.backupDir, fileName);

    const result = runRehearsal(sandbox, dumpPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /restore rehearsal succeeded: easysubway_restore_rehearsal/u);
    assert.equal(readFileSync(sandbox.dockerStdin).equals(DUMP_BYTES), true);
    assert.match(readFileSync(sandbox.dockerLog, "utf8"), /compose .* exec -T -e RESTORE_DB=easysubway_restore_rehearsal postgres sh -lc/u);
  }
});

test("Platform CI runs postgres-restore-rehearsal.test.mjs", () => {
  const ciWorkflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ciWorkflow, /^\s*node --test tools\/ops\/postgres-restore-rehearsal\.test\.mjs$/mu);
});
