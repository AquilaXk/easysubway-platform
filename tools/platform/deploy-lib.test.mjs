import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "./lib/process.mjs";
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

test("isSubset은 기대 필드가 모두 같으면 참이고 실제 객체의 추가 필드는 허용하지만 배열은 길이까지 같아야 한다", () => {
  assert.equal(isSubset({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2], d: 9 }, e: 0 }), true);
  assert.equal(isSubset({ a: 1 }, { a: 2 }), false);
  assert.equal(isSubset({ a: 1 }, {}), false);
  assert.equal(isSubset({ c: [1, 2] }, { c: [1, 2, 3] }), false);
  assert.equal(isSubset({ a: null }, { a: {} }), false);
  assert.equal(isSubset({ a: {} }, { a: null }), false);
});
