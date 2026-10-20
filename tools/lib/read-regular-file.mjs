import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const isSafeRelativePath = (value) => typeof value === "string" && value.length > 0 && !value.includes("\\")
  && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
  && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

// 경로 구성요소의 symlink와 마지막 구성요소의 symlink(O_NOFOLLOW), 다른 경로와 inode를 공유하는 hardlink를 거부한다.
// 한계: 구성요소를 lstat으로 검사한 뒤 open하기 전에 상위 디렉터리를 symlink로 바꿔치기하는 경쟁(TOCTOU)은
// 막지 못한다. 이 helper는 운영자가 로컬에서 실행하는 도구의 입력 검증용이며 적대적 동시 쓰기를 가정하지 않는다.
export async function readRegularFile(repositoryRoot, relativePath, { label = "input" } = {}) {
  if (!isSafeRelativePath(relativePath)) throw new Error(`${label} path is unsafe`);
  const root = path.resolve(repositoryRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("repositoryRoot must be a regular directory");
  let source = root;
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    source = path.join(source, part);
    const stat = await lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain a symlink`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`${label} must be a regular file`);
  }
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.nlink > 1) throw new Error(`${label} must not be a hardlink`);
    return handle.readFile();
  } finally {
    await handle.close();
  }
}
