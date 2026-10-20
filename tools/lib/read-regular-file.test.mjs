import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { readRegularFile } from "./read-regular-file.mjs";

const sandboxes = [];

afterEach(() => {
  for (const directory of sandboxes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function layout() {
  const base = mkdtempSync(path.join(tmpdir(), "read-regular-file-"));
  sandboxes.push(base);
  const root = path.join(base, "root");
  mkdirSync(path.join(root, "dir"), { recursive: true });
  writeFileSync(path.join(root, "dir", "a.txt"), "inside");
  writeFileSync(path.join(base, "outside.txt"), "outside");
  return { base, root };
}

test("reads a regular file under the root", async () => {
  const { root } = layout();
  assert.equal((await readRegularFile(root, "dir/a.txt")).toString("utf8"), "inside");
});

test("rejects a symlinked final component and a symlinked directory component", async () => {
  const { base, root } = layout();
  symlinkSync(path.join(base, "outside.txt"), path.join(root, "dir", "link.txt"));
  await assert.rejects(() => readRegularFile(root, "dir/link.txt"), /symlink/);
  symlinkSync(base, path.join(root, "linkdir"));
  await assert.rejects(() => readRegularFile(root, "linkdir/outside.txt"), /symlink/);
});

test("rejects a hardlink that shares an inode with a file outside the root", async () => {
  const { base, root } = layout();
  linkSync(path.join(base, "outside.txt"), path.join(root, "dir", "hard.txt"));
  await assert.rejects(() => readRegularFile(root, "dir/hard.txt"), /hardlink/);
});

test("rejects unsafe relative paths", async () => {
  const { root } = layout();
  for (const unsafe of ["../outside.txt", "/etc/passwd", "dir//a.txt", "dir\\a.txt", ""]) {
    await assert.rejects(() => readRegularFile(root, unsafe), /unsafe/, unsafe);
  }
});

test("rejects a directory given as the final component", async () => {
  const { root } = layout();
  await assert.rejects(() => readRegularFile(root, "dir"), /regular file/);
});
