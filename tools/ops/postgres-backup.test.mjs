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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const BACKUP_SCRIPT = fileURLToPath(new URL("./postgres-backup.sh", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "postgres-backup-test-"));
  sandboxes.push(root);
  const binDir = path.join(root, "bin");
  const backupDir = path.join(root, "backups");
  const envFile = path.join(root, "runtime.env");
  const composeFile = path.join(root, "docker-compose.yml");
  const dockerLog = path.join(root, "docker.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(
    envFile,
    "POSTGRES_USER=easysubway_user\nPOSTGRES_DB=easysubway\nPOSTGRES_PASSWORD=super-secret-pg-test-value\n",
  );
  chmodSync(envFile, 0o600);
  writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:17\n");

  const dockerStub = path.join(binDir, "docker");
  writeFileSync(
    dockerStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "${DOCKER_LOG_FILE}"',
      'case " $* " in',
      '  *" pg_dump "*) printf "PGDMP-valid-fixture-payload" ;;',
      '  *" pg_restore --list "*) cat >/dev/null ;;',
      '  *) echo "unexpected docker command: $*" >&2; exit 99 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(dockerStub, 0o755);

  return { root, binDir, backupDir, envFile, composeFile, dockerLog };
}

function runBackup(sandbox, extraEnv = {}, backupDirArg = sandbox.backupDir) {
  const env = {
    ...process.env,
    PATH: `${sandbox.binDir}:${process.env.PATH}`,
    EASYSUBWAY_ENV_FILE: sandbox.envFile,
    EASYSUBWAY_COMPOSE_FILE: sandbox.composeFile,
    DOCKER_LOG_FILE: sandbox.dockerLog,
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const args = backupDirArg === null ? [BACKUP_SCRIPT] : [BACKUP_SCRIPT, backupDirArg];
  return spawnSync("bash", args, {
    encoding: "utf8",
    env,
  });
}

test("postgres-backup.sh fails closed when EASYSUBWAY_ENV_FILE is missing without falling back to .env.example", () => {
  const sandbox = createSandbox();
  const result = runBackup(sandbox, { EASYSUBWAY_ENV_FILE: undefined });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false, "docker must not run when env file is missing");
  assert.doesNotMatch(result.stdout + result.stderr, /\.env\.example/);
});

test("postgres-backup.sh fails closed when EASYSUBWAY_ENV_FILE or EASYSUBWAY_COMPOSE_FILE is a symlink", () => {
  const sandbox = createSandbox();
  const symlinkEnv = path.join(sandbox.root, "symlink.env");
  symlinkSync(sandbox.envFile, symlinkEnv);
  const envRes = runBackup(sandbox, { EASYSUBWAY_ENV_FILE: symlinkEnv });
  assert.notEqual(envRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const symlinkCompose = path.join(sandbox.root, "symlink-compose.yml");
  symlinkSync(sandbox.composeFile, symlinkCompose);
  const composeRes = runBackup(sandbox, { EASYSUBWAY_COMPOSE_FILE: symlinkCompose });
  assert.notEqual(composeRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("postgres-backup.sh fails closed on symlinked, trailing-slash, or traversal BACKUP_DIR and symlinked env parent", () => {
  const sandbox = createSandbox();
  const outsideTarget = path.join(sandbox.root, "outside");
  mkdirSync(outsideTarget, { recursive: true });
  chmodSync(outsideTarget, 0o755);
  const symlinkBackupDir = path.join(sandbox.root, "linked-backups");
  symlinkSync(outsideTarget, symlinkBackupDir);

  const symlinkRes = runBackup(sandbox, {}, symlinkBackupDir);
  assert.notEqual(symlinkRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const trailingSymlinkRes = runBackup(sandbox, {}, `${symlinkBackupDir}/`);
  assert.notEqual(trailingSymlinkRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);
  assert.equal(statSync(outsideTarget).mode & 0o777, 0o755);

  const nestedUnderSymlinkRes = runBackup(sandbox, {}, path.join(symlinkBackupDir, "nested"));
  assert.notEqual(nestedUnderSymlinkRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);
  assert.equal(existsSync(path.join(outsideTarget, "nested")), false);
  assert.equal(statSync(outsideTarget).mode & 0o777, 0o755);

  const envParentTarget = path.join(sandbox.root, "env-target");
  mkdirSync(envParentTarget, { recursive: true });
  const envTargetFile = path.join(envParentTarget, "runtime.env");
  writeFileSync(envTargetFile, "POSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=super-secret-pg-test-value\n");
  chmodSync(envTargetFile, 0o600);
  const symlinkEnvParent = path.join(sandbox.root, "link-env-parent");
  symlinkSync(envParentTarget, symlinkEnvParent);
  assert.notEqual(runBackup(sandbox, { EASYSUBWAY_ENV_FILE: path.join(symlinkEnvParent, "runtime.env") }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const traversalRes = runBackup(sandbox, {}, `${sandbox.backupDir}/../backups`);
  assert.notEqual(traversalRes.status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const nestedValidDir = path.join(sandbox.root, "new-dir", "sub");
  const trailingValidRes = runBackup(sandbox, {}, `${nestedValidDir}/`);
  assert.equal(trailingValidRes.status, 0, trailingValidRes.stderr);
  assert.equal(statSync(nestedValidDir).mode & 0o777, 0o700);
});

test("postgres-backup.sh writes 0600 dump and sha256 without leaking env secrets", () => {
  const sandbox = createSandbox();
  const result = runBackup(sandbox);
  assert.equal(result.status, 0, result.stderr);
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(combinedOutput, /super-secret-pg-test-value/);
  assert.doesNotMatch(combinedOutput, /POSTGRES_PASSWORD/);

  const backupPath = result.stdout.trim().split("\n").pop();
  assert.ok(backupPath && backupPath.endsWith(".dump"), `unexpected output: ${result.stdout}`);
  assert.equal(existsSync(backupPath), true);
  assert.equal(existsSync(`${backupPath}.sha256`), true);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.equal(statSync(`${backupPath}.sha256`).mode & 0o777, 0o600);
  assert.equal(statSync(sandbox.backupDir).mode & 0o777, 0o700);

  const expectedDigest = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  const checksumLine = readFileSync(`${backupPath}.sha256`, "utf8").trim();
  assert.match(checksumLine, new RegExp(`^${expectedDigest}\\s+`));

  const dockerCalls = readFileSync(sandbox.dockerLog, "utf8");
  assert.match(dockerCalls, new RegExp(`--env-file ${sandbox.envFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(dockerCalls, /\.env\.example/);
});
