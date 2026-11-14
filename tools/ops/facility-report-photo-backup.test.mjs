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

const PHOTO_BACKUP_SCRIPT = fileURLToPath(new URL("./facility-report-photo-backup.sh", import.meta.url));
const RESTORE_CHECK_SCRIPT = fileURLToPath(new URL("./facility-report-photo-restore-check.mjs", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "photo-backup-test-"));
  sandboxes.push(root);
  const binDir = path.join(root, "bin");
  const backupDir = path.join(root, "photo-backups");
  const storageDir = path.join(root, "photo-storage");
  const outsideDir = path.join(root, "outside-secrets");
  const envFile = path.join(root, "runtime.env");
  const composeFile = path.join(root, "docker-compose.yml");
  const rowsFixture = path.join(root, "rows.tsv");
  const dockerLog = path.join(root, "docker.log");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(envFile, "POSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=photo-secret-value\n");
  chmodSync(envFile, 0o600);
  writeFileSync(composeFile, "services:\n  postgres:\n    image: postgres:17\n");
  writeFileSync(path.join(outsideDir, "host-secret.txt"), "SENSITIVE_OUTSIDE_CONTENT");

  const dockerStub = path.join(binDir, "docker");
  writeFileSync(
    dockerStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "${DOCKER_LOG_FILE}"',
      "cat >/dev/null",
      'cat "${ROWS_FIXTURE}"',
      "",
    ].join("\n"),
  );
  chmodSync(dockerStub, 0o755);

  return { root, binDir, backupDir, storageDir, outsideDir, envFile, composeFile, rowsFixture, dockerLog };
}

function tsvRow({ reportId, fileName, contentType, objectKey, thumbnailKey, payload }) {
  const sha = createHash("sha256").update(payload).digest("hex");
  const b64 = (value) => Buffer.from(value, "utf8").toString("base64");
  return [
    reportId,
    b64(fileName),
    b64(contentType),
    objectKey,
    thumbnailKey || "__EASYSUBWAY_EMPTY__",
    sha,
    String(payload.length),
  ].join("\t");
}

function runPhotoBackup(sandbox, extraEnv = {}, backupDirArg = sandbox.backupDir) {
  const env = {
    ...process.env,
    PATH: `${sandbox.binDir}:${process.env.PATH}`,
    EASYSUBWAY_ENV_FILE: sandbox.envFile,
    EASYSUBWAY_COMPOSE_FILE: sandbox.composeFile,
    EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: sandbox.storageDir,
    ROWS_FIXTURE: sandbox.rowsFixture,
    DOCKER_LOG_FILE: sandbox.dockerLog,
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync("bash", [PHOTO_BACKUP_SCRIPT, backupDirArg], {
    encoding: "utf8",
    env,
  });
}

test("facility-report-photo-backup.sh fails closed on missing env, symlink env, symlink storage, or symlink backup dir", () => {
  const sandbox = createSandbox();
  writeFileSync(sandbox.rowsFixture, "");

  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_ENV_FILE: undefined }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);

  const symlinkEnv = path.join(sandbox.root, "link.env");
  symlinkSync(sandbox.envFile, symlinkEnv);
  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_ENV_FILE: symlinkEnv }).status, 0);

  const symlinkStorage = path.join(sandbox.root, "link-storage");
  symlinkSync(sandbox.storageDir, symlinkStorage);
  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: symlinkStorage }).status, 0);
  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: `${symlinkStorage}/` }).status, 0);
  mkdirSync(path.join(sandbox.storageDir, "sub"), { recursive: true });
  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: path.join(symlinkStorage, "sub") }).status, 0);

  chmodSync(sandbox.outsideDir, 0o755);
  const symlinkBackup = path.join(sandbox.root, "link-backups");
  symlinkSync(sandbox.outsideDir, symlinkBackup);
  assert.notEqual(runPhotoBackup(sandbox, {}, symlinkBackup).status, 0);
  assert.notEqual(runPhotoBackup(sandbox, {}, `${symlinkBackup}/`).status, 0);
  assert.notEqual(runPhotoBackup(sandbox, {}, path.join(symlinkBackup, "nested")).status, 0);
  assert.equal(existsSync(path.join(sandbox.outsideDir, "nested")), false);
  assert.equal(statSync(sandbox.outsideDir).mode & 0o777, 0o755);

  const envTargetDir = path.join(sandbox.root, "env-target");
  mkdirSync(envTargetDir, { recursive: true });
  const envTargetFile = path.join(envTargetDir, "runtime.env");
  writeFileSync(envTargetFile, "POSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=photo-secret-value\n");
  chmodSync(envTargetFile, 0o600);
  const symlinkEnvParent = path.join(sandbox.root, "link-env-parent");
  symlinkSync(envTargetDir, symlinkEnvParent);
  assert.notEqual(runPhotoBackup(sandbox, { EASYSUBWAY_ENV_FILE: path.join(symlinkEnvParent, "runtime.env") }).status, 0);
  assert.equal(existsSync(sandbox.dockerLog), false);
});

test("facility-report-photo-backup.sh rejects direct symlinked photo objects", () => {
  const sandbox = createSandbox();
  const payload = Buffer.from("SENSITIVE_OUTSIDE_CONTENT");
  const key = "reports/101/photo.jpg";
  mkdirSync(path.join(sandbox.storageDir, "reports/101"), { recursive: true });
  symlinkSync(path.join(sandbox.outsideDir, "host-secret.txt"), path.join(sandbox.storageDir, key));
  writeFileSync(
    sandbox.rowsFixture,
    `${tsvRow({
      reportId: "101",
      fileName: "photo.jpg",
      contentType: "image/jpeg",
      objectKey: key,
      thumbnailKey: "",
      payload,
    })}\n`,
  );

  const result = runPhotoBackup(sandbox);
  assert.notEqual(result.status, 0);
});

test("facility-report-photo-backup.sh rejects symlinked ancestor directories escaping storage containment", () => {
  const sandbox = createSandbox();
  const payload = Buffer.from("SENSITIVE_OUTSIDE_CONTENT");
  mkdirSync(path.join(sandbox.storageDir, "reports"), { recursive: true });
  symlinkSync(sandbox.outsideDir, path.join(sandbox.storageDir, "reports/escape"));
  const key = "reports/escape/host-secret.txt";
  writeFileSync(
    sandbox.rowsFixture,
    `${tsvRow({
      reportId: "102",
      fileName: "host-secret.txt",
      contentType: "image/jpeg",
      objectKey: key,
      thumbnailKey: "",
      payload,
    })}\n`,
  );

  const result = runPhotoBackup(sandbox);
  assert.notEqual(result.status, 0);
});

test("facility-report-photo-backup.sh rejects traversal, backslash, and missing object keys", () => {
  const sandbox = createSandbox();
  const payload = Buffer.from("photo-bytes");

  for (const badKey of ["../outside-secrets/host-secret.txt", "reports/../../host-secret.txt", "/abs/photo.jpg", "reports\\photo.jpg", "reports/missing.jpg"]) {
    writeFileSync(
      sandbox.rowsFixture,
      `${tsvRow({
        reportId: "103",
        fileName: "bad.jpg",
        contentType: "image/jpeg",
        objectKey: badKey,
        thumbnailKey: "",
        payload,
      })}\n`,
    );
    const result = runPhotoBackup(sandbox);
    assert.notEqual(result.status, 0, `expected failure for ${badKey}`);
  }
});

test("facility-report-photo-backup.sh copies valid regular photos and passes facility-report-photo-restore-check", () => {
  const sandbox = createSandbox();
  const photoBytes = Buffer.from("valid-jpeg-bytes-123");
  const thumbBytes = Buffer.from("valid-thumb-bytes-456");
  const photoKey = "reports/200/photo.jpg";
  const thumbKey = "reports/200/thumb.jpg";

  mkdirSync(path.join(sandbox.storageDir, "reports/200"), { recursive: true });
  writeFileSync(path.join(sandbox.storageDir, photoKey), photoBytes);
  writeFileSync(path.join(sandbox.storageDir, thumbKey), thumbBytes);
  writeFileSync(
    sandbox.rowsFixture,
    `${tsvRow({
      reportId: "200",
      fileName: "station-lift.jpg",
      contentType: "image/jpeg",
      objectKey: photoKey,
      thumbnailKey: thumbKey,
      payload: photoBytes,
    })}\n`,
  );

  const nestedBackupDir = path.join(sandbox.root, "nested-photo-backups", "sub");
  const result = runPhotoBackup(sandbox, {}, `${nestedBackupDir}/`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(nestedBackupDir).mode & 0o777, 0o700);
  assert.doesNotMatch(result.stdout + result.stderr, /photo-secret-value/);

  const match = result.stdout.match(/facility report photo backup written:\s*(.+)/);
  assert.ok(match, `unexpected stdout: ${result.stdout}`);
  const runDir = match[1].trim();
  assert.equal(statSync(runDir).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", photoKey)), photoBytes);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", thumbKey)), thumbBytes);

  const check = spawnSync(process.execPath, [RESTORE_CHECK_SCRIPT, runDir], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("facility-report-photo-backup.sh supports EASYSUBWAY_REPORTS_PHOTOS_BUCKET via object-storage and fails closed on invalid bucket or missing object", () => {
  const sandbox = createSandbox();
  const photoBytes = Buffer.from("minio-jpeg-bytes-300");
  const thumbBytes = Buffer.from("minio-thumb-bytes-300");
  const photoKey = "reports/300/photo.jpg";
  const thumbKey = "reports/300/thumb.jpg";
  const secondPhotoBytes = Buffer.from("minio-jpeg-bytes-301");
  const secondThumbBytes = Buffer.from("minio-thumb-bytes-301");
  const secondPhotoKey = "reports/301/photo.jpg";
  const secondThumbKey = "reports/301/thumb.jpg";

  writeFileSync(
    sandbox.rowsFixture,
    [
      tsvRow({
        reportId: "300",
        fileName: "lift-minio.jpg",
        contentType: "image/jpeg",
        objectKey: photoKey,
        thumbnailKey: thumbKey,
        payload: photoBytes,
      }),
      tsvRow({
        reportId: "301",
        fileName: "lift-minio-2.jpg",
        contentType: "image/jpeg",
        objectKey: secondPhotoKey,
        thumbnailKey: secondThumbKey,
        payload: secondPhotoBytes,
      }),
    ].join("\n") + "\n",
  );

  // object-storage(mc)와 postgres(psql) 호출을 모두 모사하는 docker 스텁
  const bucketObjectsDir = path.join(sandbox.root, "minio-bucket-objects");
  mkdirSync(path.join(bucketObjectsDir, "easysubway-report-uploads/reports/300"), { recursive: true });
  mkdirSync(path.join(bucketObjectsDir, "easysubway-report-uploads/reports/301"), { recursive: true });
  writeFileSync(path.join(bucketObjectsDir, "easysubway-report-uploads", photoKey), photoBytes);
  writeFileSync(path.join(bucketObjectsDir, "easysubway-report-uploads", thumbKey), thumbBytes);
  writeFileSync(path.join(bucketObjectsDir, "easysubway-report-uploads", secondPhotoKey), secondPhotoBytes);
  writeFileSync(path.join(bucketObjectsDir, "easysubway-report-uploads", secondThumbKey), secondThumbBytes);

  writeFileSync(
    path.join(sandbox.binDir, "docker"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$*" >> "${DOCKER_LOG_FILE}"',
      'case " $* " in',
      '  *" postgres "*)',
      "    cat >/dev/null",
      '    cat "${ROWS_FIXTURE}"',
      "    ;;",
      '  *" object-storage "*)',
      // docker exec -T가 stdin을 소비하는 상황에서도 루프 FD가 소진되지 않음을 검증한다.
      "    cat >/dev/null",
      '    bucket="${@: -2:1}"',
      '    object_key="${@: -1:1}"',
      '    obj_path="${BUCKET_OBJECTS_DIR}/${bucket}/${object_key}"',
      '    if [[ ! -f "${obj_path}" ]]; then',
      '      echo "object missing in mock MinIO: ${obj_path}" >&2',
      "      exit 1",
      "    fi",
      '    cat "${obj_path}"',
      "    ;;",
      "  *)",
      '    echo "unexpected docker invocation: $*" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(sandbox.binDir, "docker"), 0o755);

  for (const badBucket of ["../escape", "UPPERCASE", "bad..bucket", "a"]) {
    const badRes = runPhotoBackup(sandbox, {
      EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: undefined,
      EASYSUBWAY_REPORTS_PHOTOS_BUCKET: badBucket,
      BUCKET_OBJECTS_DIR: bucketObjectsDir,
    });
    assert.notEqual(badRes.status, 0, `잘못된 버킷 이름은 거부되어야 한다: ${badBucket}`);
  }
  assert.equal(existsSync(sandbox.dockerLog), false);

  const result = runPhotoBackup(sandbox, {
    EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: undefined,
    EASYSUBWAY_REPORTS_PHOTOS_BUCKET: "easysubway-report-uploads",
    BUCKET_OBJECTS_DIR: bucketObjectsDir,
  });
  assert.equal(result.status, 0, result.stderr);

  const match = result.stdout.match(/facility report photo backup written:\s*(.+)/);
  assert.ok(match, `unexpected stdout: ${result.stdout}`);
  const runDir = match[1].trim();
  assert.equal(statSync(runDir).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", photoKey)), photoBytes);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", thumbKey)), thumbBytes);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", secondPhotoKey)), secondPhotoBytes);
  assert.deepEqual(readFileSync(path.join(runDir, "objects", secondThumbKey)), secondThumbBytes);
  const manifestLines = readFileSync(path.join(runDir, "manifest.tsv"), "utf8").trim().split("\n");
  assert.equal(manifestLines.length, 3);

  const check = spawnSync(process.execPath, [RESTORE_CHECK_SCRIPT, runDir], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);

  // MinIO 버킷에 객체가 누락되면 실패해야 한다
  rmSync(path.join(bucketObjectsDir, "easysubway-report-uploads", secondThumbKey));
  const missingObjRes = runPhotoBackup(sandbox, {
    EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR: undefined,
    EASYSUBWAY_REPORTS_PHOTOS_BUCKET: "easysubway-report-uploads",
    BUCKET_OBJECTS_DIR: bucketObjectsDir,
  });
  assert.notEqual(missingObjRes.status, 0);
});

test("facility-report-photo-backup.sh prunes expired backups via prune-sensitive-backups.mjs on completion", () => {
  const sandbox = createSandbox();
  const photoBytes = Buffer.from("prune-check-bytes");
  const photoKey = "reports/400/photo.jpg";

  mkdirSync(path.join(sandbox.storageDir, "reports/400"), { recursive: true });
  writeFileSync(path.join(sandbox.storageDir, photoKey), photoBytes);
  writeFileSync(
    sandbox.rowsFixture,
    `${tsvRow({
      reportId: "400",
      fileName: "prune.jpg",
      contentType: "image/jpeg",
      objectKey: photoKey,
      thumbnailKey: "",
      payload: photoBytes,
    })}\n`,
  );

  const expiredDir = path.join(sandbox.backupDir, "easysubway-report-photos-20200101T000000Z.old001");
  mkdirSync(path.join(expiredDir, "objects"), { recursive: true });
  writeFileSync(path.join(expiredDir, "manifest.tsv"), "old\n");
  const expiredArchive = path.join(sandbox.backupDir, "easysubway-report-photos-20200101T000000Z.tar.gz");
  writeFileSync(expiredArchive, "old-tar");
  const futureDir = path.join(sandbox.backupDir, "easysubway-report-photos-20990101T000000Z.new001");
  mkdirSync(path.join(futureDir, "objects"), { recursive: true });

  const result = runPhotoBackup(sandbox);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(expiredDir), false, "만료된 사진 백업 디렉터리는 삭제되어야 한다");
  assert.equal(existsSync(expiredArchive), false, "만료된 사진 백업 아카이브는 삭제되어야 한다");
  assert.equal(existsSync(futureDir), true, "유효 기간 내 백업 디렉터리는 유지되어야 한다");
});
