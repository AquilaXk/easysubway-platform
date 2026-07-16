#!/usr/bin/env node

import { lstat, opendir, rm } from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = path.resolve(args.get("--root") ?? "");
const retentionDays = Number(args.get("--retention-days"));

if (!args.get("--root") || root === path.parse(root).root) {
  throw new Error("--root must be a non-root backup directory");
}
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
  throw new Error("--retention-days must be an integer from 1 to 365");
}

const dailySweepIntervalMs = 24 * 60 * 60 * 1000;
const now = args.has("--now") ? Date.parse(args.get("--now")) : Date.now();
if (!Number.isFinite(now)) {
  throw new Error("--now must be a valid ISO-8601 timestamp");
}
const cutoff = now - retentionDays * dailySweepIntervalMs + dailySweepIntervalMs;
const postgresBackup = /^easysubway-postgres-(\d{8}T\d{6}Z)\.[A-Za-z0-9]+\.dump(?:\.sha256)?$/;
let pruned = 0;

function backupCreatedAt(name, pattern) {
  const match = name.match(pattern);
  if (!match) {
    return null;
  }
  const compact = match[1];
  const isoTimestamp = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`;
  const createdAt = Date.parse(isoTimestamp);
  if (!Number.isFinite(createdAt)) {
    throw new Error(`invalid backup creation timestamp: ${name}`);
  }
  return createdAt;
}

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
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      continue;
    }

    const createdAt = entry.isFile() ? backupCreatedAt(entry.name, postgresBackup) : null;
    if (createdAt !== null && createdAt <= cutoff) {
      await rm(candidate, { force: true });
      pruned += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await pruneDirectory(candidate);
    }
  }
}

await pruneDirectory(root, true);
console.log(`sensitive-backup-retention: pruned=${pruned} retention_days=${retentionDays}`);
