import assert from "node:assert/strict";
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

test("isSubset은 기대 필드가 모두 같으면 참이고 실제 객체의 추가 필드는 허용하지만 배열은 길이까지 같아야 한다", () => {
  assert.equal(isSubset({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2], d: 9 }, e: 0 }), true);
  assert.equal(isSubset({ a: 1 }, { a: 2 }), false);
  assert.equal(isSubset({ a: 1 }, {}), false);
  assert.equal(isSubset({ c: [1, 2] }, { c: [1, 2, 3] }), false);
  assert.equal(isSubset({ a: null }, { a: {} }), false);
  assert.equal(isSubset({ a: {} }, { a: null }), false);
});
