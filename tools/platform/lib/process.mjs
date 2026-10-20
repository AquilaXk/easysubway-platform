// 호스트 명령 실행 공용 도구(deploy 도구들이 같이 쓴다). 자식 프로세스에는 PATH만 넘겨, 이 프로세스 환경의 비밀이 sudo·kubectl로 상속되지 않는다.
import { spawn } from "node:child_process";

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

class HostCommandError extends Error {}

export function runCommand(command, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { PATH: SAFE_PATH }, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => reject(new HostCommandError("host command output exceeded the limit")));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new HostCommandError(`host command failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`));
    }));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new HostCommandError("host command timed out")));
    }, timeoutMs);
    if (input) child.stdin.end(input);
  });
}
