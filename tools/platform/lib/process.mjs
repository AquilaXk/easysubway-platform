// 호스트 명령 실행 공용 도구(deploy 도구들이 같이 쓴다). 자식 프로세스에는 PATH와 호출자가 넘긴 env만 넘겨, 이 프로세스 환경의 비밀이 sudo·kubectl로 상속되지 않는다.
import { spawn } from "node:child_process";

const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
// SIGTERM을 무시하는 자식은 이만큼 기다린 뒤 SIGKILL한다. GitHub Actions는 취소할 때 SIGINT 뒤 7.5초, 그 뒤 2.5초(총 10초) 안에 끝내지 않으면
// 강제 종료하므로, 중단 처리(자식 종료 대기 → 상태 되돌림 · reference 정리 → receipt)가 그 안에 끝나게 한다.
export const KILL_GRACE_MS = 5000;
export const DEFAULT_STOP_DEADLINE_MS = KILL_GRACE_MS + 500;
export const GITHUB_CANCEL_WINDOW_MS = 10_000;

class HostCommandError extends Error {}

/** 자식이 이끄는 프로세스 그룹 전체에 signal을 보낸다(run-fixed-host-journey-activation.mjs의 terminateProcessGroup과 같은 방식). */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // 그룹이 이미 비었거나 자식이 그룹을 만들기 전에 끝났다. 자식 하나에라도 보낸다.
  }
  try {
    child.kill(signal);
  } catch {
    // 자식이 이미 끝났다.
  }
}

/**
 * 명령을 실행하고 stdout·stderr를 모은다. 자식은 자기 프로세스 그룹을 이끌고(detached), 시간 초과·출력 한도·signal 중단이면 그룹 전체에
 * SIGTERM, killGraceMs 뒤 SIGKILL을 보낸다. 정상 종료는 출력을 끝까지 읽은 뒤(close) 끝난다. 멈춘 명령은 stop 시점부터 이미 출력을 버리고
 * settle에서 SIGKILL과 stdio destroy를 함께 수행하므로, pipe를 물고 그룹 밖으로 나간 자손이 있어도 killGraceMs 직후 바로 끝난다.
 */
export function runCommand(command, args, { input, env = {}, timeoutMs = 120_000, maxOutputBytes = DEFAULT_OUTPUT_LIMIT_BYTES, signal, killGraceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HostCommandError("host command interrupted before it started"));
      return;
    }
    const child = spawn(command, args, { env: { PATH: SAFE_PATH, ...env }, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], detached: true });
    const stdout = [];
    const stderr = [];
    const timers = [];
    let size = 0;
    let stopReason = null;
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (stopReason !== null) {
        signalGroup(child, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }
      callback();
    };
    const killAfterGrace = () => settle(() => reject(stopReason));
    const stop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      signalGroup(child, "SIGTERM");
      timers.push(setTimeout(killAfterGrace, killGraceMs));
    };
    const onAbort = () => stop(new HostCommandError("host command interrupted"));
    timers.push(setTimeout(() => stop(new HostCommandError("host command timed out")), timeoutMs));
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
 * runner(command, args, options)를 감싸 진행 중인 호출을 추적한다. stop()은 모든 호출에 중단 signal을 보내고 진행 중이던 호출이
 * 모두 끝나거나 deadlineMs가 지날 때까지 기다린 뒤, 모두 끝났는지를 돌려준다. 중단 뒤에 시작하는 호출은 runner가 바로 거부한다.
 * signal은 그 중단 signal이라, 명령이 아닌 대기(sleep)도 중단을 알 수 있다.
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
  const stop = async ({ deadlineMs = DEFAULT_STOP_DEADLINE_MS } = {}) => {
    controller.abort();
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs); });
    const stopped = await Promise.race([Promise.allSettled(inflight).then(() => true), deadline]);
    clearTimeout(timer);
    return stopped;
  };
  return { run, stop, signal: controller.signal };
}
