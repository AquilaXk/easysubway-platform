#!/usr/bin/env node

import { lstat, opendir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAILY_SWEEP_INTERVAL_MS = 86_400_000;
const POSTGRES_BACKUP = /^easysubway-postgres-(\d{8}T\d{6}Z)(?:\.[A-Za-z0-9]+)?\.dump(?:\.sha256)?$/;
const REPORT_PHOTO_BACKUP_FILE = /^easysubway-report-photos-(\d{8}T\d{6}Z)(?:[.-][A-Za-z0-9_]+)?(?:\.tar\.gz(?:\.(?:sha256|manifest\.tsv))?|\.(?:sha256|manifest\.tsv))$/;
const REPORT_PHOTO_BACKUP_DIR = /^easysubway-report-photos-(\d{8}T\d{6}Z)(?:[.-][A-Za-z0-9_]+)?$/;

function backupCreatedAt(name, pattern) {
  const match = name.match(pattern);
  if (!match) {
    return null;
  }
  const compact = match[1];
  const isoTimestamp = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const createdAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(createdAt) || `${new Date(createdAt).toISOString().slice(0, 19)}Z` !== isoTimestamp) {
    throw new Error(`invalid backup creation timestamp: ${name}`);
  }
  return createdAt;
}

function fileBackupCreatedAt(name) {
  return backupCreatedAt(name, POSTGRES_BACKUP) ?? backupCreatedAt(name, REPORT_PHOTO_BACKUP_FILE);
}

export async function pruneSensitiveBackups({
  root: rootValue,
  retentionDays,
  now = Date.now(),
  lstat: lstatEntry = lstat,
}) {
  const root = path.resolve(rootValue ?? "");
  if (!rootValue || root === path.parse(root).root) {
    throw new Error("--root must be a non-root backup directory");
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("--retention-days must be an integer from 1 to 365");
  }
  if (!Number.isFinite(now)) {
    throw new Error("--now must be a valid ISO-8601 timestamp");
  }
  const cutoff = now - retentionDays * DAILY_SWEEP_INTERVAL_MS;
  let pruned = 0;

  async function pruneDirectory(directory, required = false) {
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (error?.code === "ENOENT" && !required) {
        return;
      }
      throw error;
    }

    for await (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let metadata;
      try {
        metadata = await lstatEntry(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        continue;
      }

      const createdAt = metadata.isFile() ? fileBackupCreatedAt(entry.name) : null;
      if (createdAt !== null && createdAt <= cutoff) {
        await rm(candidate, { force: true });
        pruned += 1;
        continue;
      }
      if (metadata.isDirectory()) {
        const dirCreatedAt = backupCreatedAt(entry.name, REPORT_PHOTO_BACKUP_DIR);
        if (dirCreatedAt !== null) {
          if (dirCreatedAt <= cutoff) {
            await rm(candidate, { recursive: true, force: true });
            pruned += 1;
          }
          continue;
        }
        await pruneDirectory(candidate);
      }
    }
  }

  await pruneDirectory(root, true);
  return pruned;
}

function parseCliArgs(argv) {
  if (argv.length % 2 !== 0) {
    throw new Error(`missing option value near: ${argv[argv.length - 1]}`);
  }
  const allowed = new Set(["--root", "--retention-days", "--now"]);
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
    if (args.has(flag)) {
      throw new Error(`duplicate option: ${flag}`);
    }
    args.set(flag, value);
  }
  const rawRetention = args.get("--retention-days") ?? "";
  if (!/^[1-9]\d*$/.test(rawRetention)) {
    throw new Error("--retention-days must be an integer from 1 to 365");
  }
  const retentionDays = Number(rawRetention);
  const now = args.has("--now") ? Date.parse(args.get("--now")) : Date.now();
  return {
    root: args.get("--root"),
    retentionDays,
    now,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliArgs(process.argv.slice(2));
  const pruned = await pruneSensitiveBackups(options);
  console.log(`sensitive-backup-retention: pruned=${pruned} retention_days=${options.retentionDays}`);
}
