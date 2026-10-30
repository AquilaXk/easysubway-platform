import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireSharedDeployLock } from "./shared-deploy-lock.mjs";

// platform#273: 관측 설정 DEPLOY와 후보 기동이 쓰는 deploy.lock은 tools/deploy/deploy-backend.sh의 `exec 9>deploy.lock; flock 9`와
// 같은 파일의 같은 배타 flock이어야 서로를 막는다. flock(1)이 있는 Linux(CI·운영 호스트)에서 실제 잠금으로 확인한다.
const flockAvailable = existsSync("/usr/bin/flock");
const needsFlock = { skip: flockAvailable ? false : "/usr/bin/flock is not installed in this environment" };

/** deploy-backend.sh와 같은 방식으로 잠금을 쥐는 bash. 잡으면 held를 내고 stdin이 닫히거나 30초가 지나면 끝난다. */
function holdLikeBackendDeploy(lockPath) {
  const child = spawn("bash", ["-c", 'exec 9>"$1"; flock 9; echo held; read -r -t 30 _ || true', "bash", lockPath], { stdio: ["pipe", "pipe", "ignore"] });
  const held = new Promise((resolve) => { child.stdout.once("data", resolve); });
  const release = () => new Promise((resolve) => {
    child.once("close", resolve);
    child.stdin.end();
  });
  return { held, release };
}

const backendCanLock = (lockPath) => spawnSync("bash", ["-c", 'exec 9>"$1"; flock --nonblock 9', "bash", lockPath]).status === 0;

test("backend 배포가 deploy.lock을 쥐고 있으면 바로 거부하고, 놓으면 잡으며, 잡은 동안은 backend 배포가 잡지 못한다", needsFlock, async () => {
  const root = mkdtempSync(join(tmpdir(), "shared-deploy-lock-"));
  const lockPath = join(root, "deploy.lock");
  try {
    const backend = holdLikeBackendDeploy(lockPath);
    await backend.held;
    const startedAt = Date.now();
    await assert.rejects(acquireSharedDeployLock({ lockPath }), /shared deploy lock unavailable/u);
    assert.ok(Date.now() - startedAt < 4000, "기다리지 않는다(holder 준비 제한 5초보다 빨리 실패)");
    await backend.release();

    const lock = await acquireSharedDeployLock({ lockPath });
    await lock.verify();
    assert.equal(backendCanLock(lockPath), false, "도구가 쥔 동안 backend 배포의 flock은 실패한다");
    await lock.close();
    assert.equal(backendCanLock(lockPath), true, "놓으면 backend 배포가 잡는다");
    await assert.rejects(lock.verify(), /shared deploy lock was lost/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
