#!/usr/bin/env node
// 운영 호스트의 `${DEPLOY_ROOT}/deploy.lock`을 잡는 공용 잠금. tools/deploy/deploy-backend.sh는 `exec 9>deploy.lock; flock 9`로 같은 파일에
// 배타 flock(2)을 건다. Node에는 flock이 없으므로 `flock --nonblock --exclusive <lock> node <이 파일> --hold-shared-deploy-lock`을 띄워
// 그 자식이 잠금을 쥔 채 stdin이 닫힐 때까지 기다리게 한다. 다른 쪽이 잠금을 쥐고 있으면 flock이 바로 실패하므로 기다리지 않는다.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOLDER_ARGUMENT = "--hold-shared-deploy-lock";
const READY = "EASYSUBWAY_STANDBY_LOCKED\n";
const ACQUIRE_TIMEOUT_MS = 5000;
const FORCE_KILL_GRACE_MS = 1000;
const FLOCK = "/usr/bin/flock";

class SharedDeployLock {
  constructor(child, lostError) {
    this.child = child;
    this.lostError = lostError;
    this.active = true;
    this.closed = new Promise((resolveClosed) => {
      child.once("close", () => {
        this.active = false;
        resolveClosed();
      });
    });
  }

  async verify() {
    if (!this.active || this.child.exitCode !== null || this.child.signalCode !== null) throw this.lostError();
  }

  async close() {
    if (!this.active) return;
    this.child.stdin.end();
    const closed = await Promise.race([
      this.closed.then(() => true),
      new Promise((resolveClosed) => setTimeout(() => resolveClosed(false), FORCE_KILL_GRACE_MS)),
    ]);
    if (!closed && this.active) {
      this.child.kill("SIGKILL");
      await this.closed;
    }
  }
}

/** 잠금을 잡으면 SharedDeployLock으로, 다른 실행이 쥐고 있거나 holder가 제때 준비되지 않으면 거부한다. lostError는 verify()가 던질 오류를 만든다. */
export function acquireSharedDeployLock({ lockPath, env = {}, lostError = () => new Error("shared deploy lock was lost") }) {
  return new Promise((resolveLock, rejectLock) => {
    const child = spawn(FLOCK, ["--nonblock", "--exclusive", lockPath, process.execPath, fileURLToPath(import.meta.url), HOLDER_ARGUMENT], {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lock = new SharedDeployLock(child, lostError);
    let output = "";
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill("SIGTERM");
      rejectLock(new Error("shared deploy lock unavailable"));
    };
    const timer = setTimeout(fail, ACQUIRE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (!READY.startsWith(output)) {
        fail();
        return;
      }
      if (output === READY) {
        settled = true;
        clearTimeout(timer);
        resolveLock(lock);
      }
    });
    child.once("error", fail);
    child.once("close", () => {
      if (!settled) fail();
    });
  });
}

async function holdSharedDeployLock() {
  process.stdout.write(READY);
  process.stdin.resume();
  await new Promise((resolveEnd) => {
    process.stdin.once("end", resolveEnd);
    process.stdin.once("close", resolveEnd);
  });
}

const isMainModule = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule && process.argv.length === 3 && process.argv[2] === HOLDER_ARGUMENT) await holdSharedDeployLock();
