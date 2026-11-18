import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import { pruneSensitiveBackups } from "./prune-sensitive-backups.mjs";

const PRUNE_SCRIPT = fileURLToPath(new URL("./prune-sensitive-backups.mjs", import.meta.url));
const sandboxes = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "prune-backups-test-"));
  sandboxes.push(dir);
  return dir;
}

test("정확한 retentionDays * 86_400_000 경계(+24시간 조기 삭제 버그 제거)로 만료 백업만 삭제한다", async () => {
  const root = createRoot();
  const postgresDir = path.join(root, "postgres");
  mkdirSync(postgresDir, { recursive: true });

  const now = Date.parse("2026-11-14T12:00:00Z");

  // 정확히 30일 전(cutoff): 삭제 대상
  const exactBoundaryDump = path.join(postgresDir, "easysubway-postgres-20261015T120000Z.a1b2c3.dump");
  const exactBoundarySha = `${exactBoundaryDump}.sha256`;
  // 30일에서 1초 모자란 백업: 보존 대상
  const almostExpiredDump = path.join(postgresDir, "easysubway-postgres-20261015T120001Z.d4e5f6.dump");
  // 기존 +86_400_000 버그가 조기 삭제하던 29.5일 전 백업: 반드시 보존 대상
  const bugEarlyDeleteDump = path.join(postgresDir, "easysubway-postgres-20261016T000000Z.f7g8h9.dump");
  const bugEarlyDeleteSha = `${bugEarlyDeleteDump}.sha256`;

  for (const file of [exactBoundaryDump, exactBoundarySha, almostExpiredDump, bugEarlyDeleteDump, bugEarlyDeleteSha]) {
    writeFileSync(file, "backup-data");
  }

  const pruned = await pruneSensitiveBackups({
    root,
    retentionDays: 30,
    now,
  });

  assert.equal(pruned, 2);
  assert.equal(existsSync(exactBoundaryDump), false);
  assert.equal(existsSync(exactBoundarySha), false);
  assert.equal(existsSync(almostExpiredDump), true);
  assert.equal(existsSync(bugEarlyDeleteDump), true);
  assert.equal(existsSync(bugEarlyDeleteSha), true);
});

test("만료된 신고 사진 아카이브(.tar.gz·.sha256·.manifest.tsv)와 실행 디렉터리를 삭제하고 비만료·기타 파일은 보존한다", async () => {
  const root = createRoot();
  const photoRoot = path.join(root, "facility-report-photos");
  mkdirSync(photoRoot, { recursive: true });

  const now = Date.parse("2026-11-14T12:00:00Z");

  const expiredFiles = [
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.tar.gz"),
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.tar.gz.sha256"),
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.tar.gz.manifest.tsv"),
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.manifest.tsv"),
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.run123.tar.gz"),
    path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.run123.tar.gz.sha256"),
  ];
  for (const file of expiredFiles) {
    writeFileSync(file, "expired-photo-archive");
  }

  const expiredRunDir = path.join(photoRoot, "easysubway-report-photos-20261015T115959Z.dir999");
  mkdirSync(path.join(expiredRunDir, "objects/reports/1"), { recursive: true });
  writeFileSync(path.join(expiredRunDir, "manifest.tsv"), "header\n");
  writeFileSync(path.join(expiredRunDir, "objects/reports/1/photo.jpg"), "jpeg");

  const freshFiles = [
    path.join(photoRoot, "easysubway-report-photos-20261015T120001Z.tar.gz"),
    path.join(photoRoot, "easysubway-report-photos-20261015T120001Z.tar.gz.sha256"),
    path.join(photoRoot, "easysubway-report-photos-20261015T120001Z.manifest.tsv"),
    path.join(photoRoot, "unrelated-note.txt"),
  ];
  for (const file of freshFiles) {
    writeFileSync(file, "fresh-photo-archive");
  }

  const freshRunDir = path.join(photoRoot, "easysubway-report-photos-20261015T120001Z.dir111");
  mkdirSync(path.join(freshRunDir, "objects/reports/2"), { recursive: true });
  writeFileSync(path.join(freshRunDir, "objects/reports/2/photo.jpg"), "jpeg");

  const pruned = await pruneSensitiveBackups({
    root,
    retentionDays: 30,
    now,
  });

  assert.equal(pruned, expiredFiles.length + 1);
  for (const file of expiredFiles) {
    assert.equal(existsSync(file), false, `만료 파일이 삭제되어야 한다: ${file}`);
  }
  assert.equal(existsSync(expiredRunDir), false, "만료된 사진 백업 디렉터리가 삭제되어야 한다");

  for (const file of freshFiles) {
    assert.equal(existsSync(file), true, `보존 대상이 유지되어야 한다: ${file}`);
  }
  assert.equal(existsSync(path.join(freshRunDir, "objects/reports/2/photo.jpg")), true);
});

test("심볼릭 링크는 따라가지 않고 원본을 보존하며 잘못된 인자는 Fail-Closed로 거부한다", async () => {
  const root = createRoot();
  const outside = createRoot();
  const outsideSecret = path.join(outside, "keep-me.txt");
  const outsideDir = path.join(outside, "keep-dir");
  writeFileSync(outsideSecret, "do-not-delete");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, "item.txt"), "do-not-delete-dir");

  symlinkSync(outsideSecret, path.join(root, "easysubway-postgres-20200101T000000Z.link1.dump"));
  symlinkSync(outsideSecret, path.join(root, "easysubway-report-photos-20200101T000000Z.tar.gz"));
  symlinkSync(outsideDir, path.join(root, "easysubway-report-photos-20200101T000000Z.dirlink"));

  const pruned = await pruneSensitiveBackups({
    root,
    retentionDays: 30,
    now: Date.parse("2026-11-14T12:00:00Z"),
  });

  assert.equal(pruned, 0);
  assert.equal(existsSync(outsideSecret), true);
  assert.equal(existsSync(path.join(outsideDir, "item.txt")), true);

  await assert.rejects(() => pruneSensitiveBackups({ root: "", retentionDays: 30 }), /--root/);
  await assert.rejects(() => pruneSensitiveBackups({ root: "/", retentionDays: 30 }), /--root/);
  await assert.rejects(() => pruneSensitiveBackups({ root, retentionDays: 0 }), /--retention-days/);
  await assert.rejects(() => pruneSensitiveBackups({ root, retentionDays: 366 }), /--retention-days/);
  await assert.rejects(() => pruneSensitiveBackups({ root, retentionDays: 30, now: Number.NaN }), /--now/);

  writeFileSync(path.join(root, "easysubway-postgres-20261399T000000Z.badts.dump"), "x");
  await assert.rejects(() => pruneSensitiveBackups({ root, retentionDays: 30 }), /invalid backup creation timestamp/);

  // 2월 31일처럼 달력 오버플로가 나는 타임스탬프도 거부
  writeFileSync(path.join(root, "easysubway-postgres-20260231T000000Z.dump"), "x");
  await assert.rejects(() => pruneSensitiveBackups({ root, retentionDays: 30 }), /invalid backup creation timestamp/);

  for (const badArgs of [
    ["--root", root, "--unknown", "1", "--retention-days", "30"],
    ["--root", root, "--retention-days", "30", "--dangling"],
  ]) {
    const res = spawnSync(process.execPath, [PRUNE_SCRIPT, ...badArgs], { encoding: "utf8" });
    assert.notEqual(res.status, 0);
  }

  const cliMissingRoot = spawnSync(
    process.execPath,
    [PRUNE_SCRIPT, "--root", path.join(root, "missing"), "--retention-days", "30"],
    { encoding: "utf8" },
  );
  assert.notEqual(cliMissingRoot.status, 0);
});
