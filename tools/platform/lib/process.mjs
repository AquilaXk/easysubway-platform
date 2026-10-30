// 호스트 명령 실행 공용 도구(deploy 도구들이 같이 쓴다). 자식 프로세스에는 PATH와 호출자가 넘긴 env만 넘겨, 이 프로세스 환경의 비밀이 sudo·kubectl로 상속되지 않는다.
import { spawn } from "node:child_process";

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
// SIGTERM을 무시하는 자식은 이만큼 기다린 뒤 SIGKILL한다. GitHub Actions는 취소할 때 SIGINT 뒤 7.5초를 기다려 SIGTERM을 보내므로,
// 중단 처리(자식 종료 대기 → 상태 되돌림 → receipt)가 그 안에 끝나게 한다.
const KILL_GRACE_MS = 5000;

class HostCommandError extends Error {}

/**
 * 명령을 실행하고 stdout·stderr를 모은다. 시간 초과·출력 한도·signal 중단으로 멈춘 자식은 실제로 종료한 뒤에 거부하므로,
 * 이 promise를 기다리는 호출자는 자식 프로세스가 끝났음을 안다.
 */
export function runCommand(command, args, { input, env = {}, timeoutMs = 120_000, maxOutputBytes = DEFAULT_OUTPUT_LIMIT_BYTES, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HostCommandError("host command interrupted before it started"));
      return;
    }
    const child = spawn(command, args, { env: { PATH: SAFE_PATH, ...env }, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let stopReason = null;
    let killTimer = null;
    let settled = false;
    const stop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => stop(new HostCommandError("host command interrupted"));
    const timeout = setTimeout(() => stop(new HostCommandError("host command timed out")), timeoutMs);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const collect = (target) => (chunk) => {
      if (stopReason !== null) return;
      size += chunk.length;
      if (size > maxOutputBytes) {
        stop(new HostCommandError("host command output exceeded the limit"));
        return;
      }
      target.push(chunk);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code) => settle(() => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (stopReason !== null) reject(stopReason);
      else if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: errorText });
      else reject(new HostCommandError(`host command failed (${code}): ${errorText.slice(0, 1000)}`));
    }));
    if (input) child.stdin.end(input);
  });
}

/**
 * runner(command, args, options)를 감싸 진행 중인 호출을 추적한다. stop()은 모든 호출에 중단 signal을 보내고
 * 진행 중이던 호출이 모두 끝날 때까지 기다린다. 중단 뒤에 시작하는 호출은 runner가 바로 거부한다.
 */
export function interruptibleRunner(runner) {
  const controller = new AbortController();
  const inflight = new Set();
  const run = (command, args, options = {}) => {
    const pending = Promise.resolve().then(() => runner(command, args, { ...options, signal: controller.signal }));
    inflight.add(pending);
    const forget = () => inflight.delete(pending);
    pending.then(forget, forget);
    return pending;
  };
  const stop = async () => {
    controller.abort();
    await Promise.allSettled([...inflight]);
  };
  return { run, stop };
}
