import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { interruptibleRunner, runCommand } from "./lib/process.mjs";
import { isSubset } from "./lib/subset.mjs";

// deploy 도구들이 같이 쓰는 호스트 명령 실행기와 읽기 대조 비교. data-workflow-scheduler와 source-reachability-probe 도구가 같은 사본을 쓴다.
test("자식 프로세스는 최소 환경(PATH)만 받아 환경 변수의 비밀이 상속되지 않는다", async () => {
  process.env.EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY = "inherited-key-must-not-leak";
  process.env.EASYSUBWAY_DISPATCH_APP_CLIENT_ID = "Iv23liInheritedClientId";
  try {
    const { stdout } = await runCommand("env", []);
    assert.deepEqual(stdout.trim().split("\n").map((line) => line.split("=")[0]).filter((name) => name !== "PWD" && name !== "_" && name !== "SHLVL").sort(), ["PATH"]);
    assert.equal(stdout.includes("inherited-key-must-not-leak"), false);
  } finally {
    delete process.env.EASYSUBWAY_DISPATCH_APP_PRIVATE_KEY;
    delete process.env.EASYSUBWAY_DISPATCH_APP_CLIENT_ID;
  }
});

test("실패한 명령은 종료 코드와 stderr를 담아 거부하고 시간 초과도 거부한다", async () => {
  await assert.rejects(runCommand("sh", ["-c", "echo boom >&2; exit 3"]), /host command failed \(3\): boom/u);
  await assert.rejects(runCommand("sleep", ["5"], { timeoutMs: 50 }), /host command timed out/u);
  assert.deepEqual(await runCommand("cat", [], { input: "stdin text" }), { stdout: "stdin text", stderr: "" });
});

// 중단(platform#273): signal이 끊으면 자식을 멈추고, 자식이 실제로 끝난 뒤에야 거부한다. 기다리는 호출자는 자식이 남지 않았음을 안다.
const SIGTERM_TRAP = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); console.log(process.pid); setInterval(() => {}, 1000);";

test("signal로 중단하면 SIGTERM을 보내고 자식이 종료한 뒤에 interrupted로 거부한다", async () => {
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ["-e", SIGTERM_TRAP], { signal: controller.signal, timeoutMs: 10_000 });
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(pending, /host command interrupted/u);
  assert.ok(Date.now() - startedAt >= 250, "SIGTERM 뒤 자식이 끝날 때까지(300ms) 기다린다");
});

test("이미 중단된 signal이면 자식을 띄우지 않고 거부한다", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runCommand(process.execPath, ["-e", "require('node:fs').writeFileSync(1, 'ran')"], { signal: controller.signal }), /interrupted before it started/u);
});

test("interruptibleRunner.stop은 진행 중 호출을 중단하고 그 자식이 끝날 때까지 기다리며 이후 호출은 시작하지 않는다", async () => {
  const runner = interruptibleRunner(runCommand);
  const pending = runner.run(process.execPath, ["-e", SIGTERM_TRAP], { timeoutMs: 10_000 });
  const settled = pending.then(() => "resolved", (error) => error.message);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  await runner.stop();
  assert.equal(await Promise.race([settled, Promise.resolve("still running")]), "host command interrupted", "stop()이 끝났을 때 자식 호출은 이미 끝나 있다");
  await assert.rejects(runner.run("true", []), /interrupted before it started/u);
});

test("출력 한도를 넘거나 시간이 초과된 자식도 종료를 기다린 뒤 거부한다", async () => {
  const chatty = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => console.log('x'.repeat(64)), 20);";
  for (const [args, options, pattern] of [
    [["-e", chatty], { maxOutputBytes: 16, timeoutMs: 10_000 }, /output exceeded the limit/u],
    [["-e", SIGTERM_TRAP], { timeoutMs: 200 }, /timed out/u],
  ]) {
    const startedAt = Date.now();
    await assert.rejects(runCommand(process.execPath, args, options), pattern);
    assert.ok(Date.now() - startedAt >= 300, `${pattern}: SIGTERM 뒤 자식이 끝날 때까지 기다린다`);
  }
});

// 자식이 띄운 손자가 stdout pipe를 물고 SIGTERM을 무시하면 close가 오지 않는다(platform#274 리뷰). 프로세스 그룹 전체를 끝내고 제한 안에 거부해야 한다.
const PIPE_HOLDING_GRANDCHILD = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"], detached: process.argv[2] === "escape" });
require("node:fs").writeFileSync(process.argv[1], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function waitUntilGone(pid, deadlineMs) {
  const startedAt = Date.now();
  while (isAlive(pid) && Date.now() - startedAt < deadlineMs) {
    // 종료 신호를 받은 프로세스가 사라지는 시점은 비동기라 짧게 다시 본다.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  return !isAlive(pid);
}

test("시간 초과·중단은 pipe를 문 손자까지 끝내고 제한 안에 거부하며, 정상 종료는 출력을 끝까지 읽은 뒤 끝난다", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-command-"));
  const pidFile = join(root, "grandchild.pid");
  let grandchild = null;
  try {
    for (const [label, options] of [["timeout", { timeoutMs: 300 }], ["abort", { signal: AbortSignal.timeout(300) }]]) {
      const startedAt = Date.now();
      const pending = runCommand(process.execPath, ["-e", PIPE_HOLDING_GRANDCHILD, pidFile], { timeoutMs: 10_000, killGraceMs: 300, ...options });
      const outcome = await Promise.race([
        pending.then(() => "resolved", (error) => error.message),
        new Promise((resolve) => { setTimeout(() => resolve("still pending"), 4000).unref(); }),
      ]);
      grandchild = Number(readFileSync(pidFile, "utf8"));
      assert.match(outcome, label === "timeout" ? /timed out/u : /interrupted/u, label);
      assert.ok(Date.now() - startedAt < 2000, `${label}: SIGTERM 300ms + SIGKILL 유예 300ms + 배수 안에 끝난다`);
      assert.equal(await waitUntilGone(grandchild, 1000), true, `${label}: pipe를 문 손자도 끝났다`);
    }
    const startedAt = Date.now();
    const escaped = runCommand(process.execPath, ["-e", PIPE_HOLDING_GRANDCHILD, pidFile, "escape"], { timeoutMs: 300, killGraceMs: 300 });
    await assert.rejects(escaped, /timed out/u);
    grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Date.now() - startedAt < 2000, "그룹 밖으로 나가 pipe를 문 손자가 있어도 SIGKILL 뒤 배수 시간이 지나면 끝낸다");
    process.kill(grandchild, "SIGKILL");
    const { stdout } = await runCommand("sh", ["-c", "printf one; sleep 0.2; printf two"]);
    assert.equal(stdout, "onetwo");
  } finally {
    if (grandchild !== null && isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("interruptibleRunner.stop은 중단 signal을 무시하는 runner도 정해진 시간 안에 돌아오고 모두 끝났는지를 알린다", async () => {
  const stuck = interruptibleRunner(() => new Promise(() => {}));
  stuck.run("never", []);
  const startedAt = Date.now();
  assert.equal(await stuck.stop({ deadlineMs: 200 }), false);
  assert.ok(Date.now() - startedAt < 1000);
  const settles = interruptibleRunner(runCommand);
  settles.run("sleep", ["5"]).catch(() => {});
  assert.equal(await settles.stop({ deadlineMs: 6000 }), true);
});

test("isSubset은 기대 필드가 모두 같으면 참이고 실제 객체의 추가 필드는 허용하지만 배열은 길이까지 같아야 한다", () => {
  assert.equal(isSubset({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2], d: 9 }, e: 0 }), true);
  assert.equal(isSubset({ a: 1 }, { a: 2 }), false);
  assert.equal(isSubset({ a: 1 }, {}), false);
  assert.equal(isSubset({ c: [1, 2] }, { c: [1, 2, 3] }), false);
  assert.equal(isSubset({ a: null }, { a: {} }), false);
  assert.equal(isSubset({ a: {} }, { a: null }), false);
});
