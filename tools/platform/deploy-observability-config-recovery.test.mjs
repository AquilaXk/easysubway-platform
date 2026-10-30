import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { deployObservabilityConfig } from "./deploy-observability-config.mjs";
import {
  COMMIT, COMPOSE_NETWORK_NAME, COMPOSE_SUBNET, PREVIOUS,
  base, createHost, failureReceipt, receiptPath, sandbox, seedPreviousRelease, snapshot, verbs,
} from "./deploy-observability-config-fake-host.mjs";

// platform#273: 관측 설정 DEPLOY가 실패·중단·동시 실행에서 호스트를 어떤 상태로 남기고 무엇을 기록하는지의 계약.
// 2026-10-30 사고에서는 compose가 운영 네트워크를 다시 만들려다 prometheus를 떼어 냈고, 복원도 실패했으며, 실패 receipt에는 복원 오류만 남았다.

const deploy = (box, host, overrides = {}) => deployObservabilityConfig(base(box, host, { mode: "DEPLOY", ...overrides }));
const PROMETHEUS_CONNECT = ["--alias", "easysubway-prometheus", "--alias", "prometheus", COMPOSE_NETWORK_NAME, "easysubway-prometheus"];

test("DEPLOY는 어떤 호스트 호출보다 먼저 <deployRoot>/deploy.lock을 잡고 성공·실패 모두 놓으며 PREVIEW는 잡지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost();
    await deploy(box, host);
    assert.deepEqual(host.lock.paths, [join(box.deployRoot, "deploy.lock")]);
    assert.deepEqual(host.lock.callsAtAcquire, [1], "git HEAD 확인 하나 뒤, docker 호출 전에 잡는다");
    assert.equal(host.lock.closed, 1);
    const failing = createHost({ liveAfter: snapshot({ revision: "old" }) });
    await assert.rejects(deploy(box, failing, { runId: "124" }), /E_OBS_DEPLOY_VERIFY/u);
    assert.equal(failing.lock.closed, 1, "실패해도 놓는다");
    const preview = createHost();
    await deployObservabilityConfig(base(box, preview, { mode: "PREVIEW", deployRoot: undefined }));
    assert.deepEqual(preview.lock.paths, []);
  } finally {
    box.cleanup();
  }
});

test("다른 배포가 deploy.lock을 쥐고 있으면 기다리지 않고 E_OBS_DEPLOY_LOCKED로 실패하며 아무것도 바꾸지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost();
    const held = async () => { throw new Error("shared deploy lock unavailable"); };
    await assert.rejects(deploy(box, host, { acquireDeployLock: held }), /E_OBS_DEPLOY_LOCKED: .*deploy\.lock is held by another deploy.*nothing was changed/u);
    assert.deepEqual(verbs(host), ["git"], "docker를 한 번도 부르지 않는다");
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false);
    assert.equal(existsSync(join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`)), false);
  } finally {
    box.cleanup();
  }
});

test("compose 기본 네트워크가 없으면 계약 서브넷과 compose label로 만든 뒤 진행하고, 있으면 만들지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ composeNetwork: { exists: false } });
    await deploy(box, host);
    const trail = verbs(host);
    assert.ok(trail.indexOf("network:create") < trail.indexOf("compose:up"), "만든 다음에 compose up한다");
    const created = host.calls.find((call) => call.args[1] === "create").args;
    assert.deepEqual(created.slice(created.indexOf("--subnet"), created.indexOf("--subnet") + 2), ["--subnet", COMPOSE_SUBNET]);
    assert.deepEqual(host.state.composeNetwork.labels, ["com.docker.compose.network=default", "com.docker.compose.project=easysubway"]);
    const present = createHost();
    await deploy(box, present, { runId: "124" });
    assert.equal(verbs(present).includes("network:create"), false);
  } finally {
    box.cleanup();
  }
});

test("기본 네트워크의 서브넷이 계약과 다르면 바꾸지 않고 release 설치·compose up 전에 E_OBS_DEPLOY_NETWORK로 실패한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ composeNetwork: { exists: true, subnet: "172.19.0.0/16" } });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_NETWORK: .*172\.19\.0\.0\/16, expected 172\.18\.0\.0\/16/u);
    assert.equal(verbs(host).some((verb) => verb === "compose:up" || verb === "network:create"), false);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false);
  } finally {
    box.cleanup();
  }
});

test("기본 네트워크를 external 없이 ipam으로 선언한 release는 compose up 전에 거부한다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ composeNetworkConfig: { name: COMPOSE_NETWORK_NAME, ipam: { config: [{ subnet: COMPOSE_SUBNET }] } } });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_SOURCE: .*with ipam but not external/u);
    assert.equal(verbs(host).includes("compose:up"), false);
    const external = createHost({ composeNetworkConfig: { name: COMPOSE_NETWORK_NAME, external: true } });
    await deploy(box, external, { runId: "124" });
  } finally {
    box.cleanup();
  }
});

test("사고 재현: 적용과 복원의 compose up이 모두 실패해 prometheus가 떨어지면 receipt는 두 원인을 따로 남기고 prometheus를 compose alias로 다시 붙인다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ upFails: true, detachOnFailedUp: true });
    await assert.rejects(deploy(box, host), (error) => {
      assert.equal(error.code, "E_OBS_DEPLOY_RESTORE");
      assert.match(error.message, /forward failure E_OBS_DEPLOY_VERIFY: compose up failed/u);
      assert.match(error.message, /restore verification failed for previous release b{40}: compose up failed/u);
      assert.match(error.message, /easysubway-prometheus was detached from easysubway_default and was reconnected/u);
      return true;
    });
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "FAILED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_VERIFY");
    assert.match(failure.error.detail, /^compose up failed/u, "error는 정방향 실패다");
    assert.equal(failure.restore, "FAILED");
    assert.equal(failure.restoreError.code, "E_OBS_DEPLOY_RESTORE");
    assert.match(failure.restoreError.detail, /restore verification failed .*compose up failed/u);
    const prometheus = failure.networkAttachment.find((entry) => entry.service === "prometheus");
    assert.deepEqual(prometheus, { service: "prometheus", container: "easysubway-prometheus", network: COMPOSE_NETWORK_NAME, running: true, action: "RECONNECTED", detail: null });
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT]);
    assert.deepEqual(host.state.networks, [COMPOSE_NETWORK_NAME]);
  } finally {
    box.cleanup();
  }
});

test("다시 붙이기가 실패하면 그 사실을 오류와 receipt에 명시하고 복원 실패로 끝난다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ upFails: true, detachOnFailedUp: true, connectFails: true });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_RESTORE: forward failure .*easysubway-prometheus is detached from easysubway_default and reconnecting it failed: .*endpoint create failed/su);
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "NO_MANAGED_PREVIOUS");
    assert.equal(failure.restoreError, null);
    assert.equal(failure.networkAttachment.find((entry) => entry.service === "prometheus").action, "RECONNECT_FAILED");
  } finally {
    box.cleanup();
  }
});

test("복원할 release가 없어도 떨어진 prometheus는 다시 붙이고, 붙어 있던 컨테이너는 건드리지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ upFails: true, detachOnFailedUp: true });
    await assert.rejects(deploy(box, host), /Error: E_OBS_DEPLOY_VERIFY: compose up failed.*first rollout.*reconnected/su);
    const failure = failureReceipt(box);
    assert.deepEqual(failure.networkAttachment.map((entry) => [entry.service, entry.action]), [["prometheus", "RECONNECTED"], ["origin-certificate-probe", "ATTACHED"]]);
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT], "probe는 붙어 있어 connect하지 않는다");
  } finally {
    box.cleanup();
  }
});

test("복원도 배포 전 상태 대비 범위·네트워크 배선을 검사해, 복원이 다른 컨테이너나 배선을 바꾸면 RESTORED라고 하지 않는다", async () => {
  const cases = [
    ["다른 컨테이너 재시작", (ctx) => { ctx.others[0].startedAt = "2026-10-08T02:00:00Z"; }, "E_OBS_DEPLOY_SCOPE", /easysubway-postgres startedAt changed/u],
    ["extra_hosts 변경", (ctx) => { ctx.state.extraHosts = []; }, "E_OBS_DEPLOY_VERIFY", /extra_hosts changed/u],
  ];
  for (const [label, changeOnRestoreUp, code, detail] of cases) {
    const box = sandbox();
    try {
      seedPreviousRelease(box);
      const host = createHost({ liveAfter: snapshot({ revision: "old" }), changeOnRestoreUp });
      await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_RESTORE: forward failure E_OBS_DEPLOY_VERIFY/u, label);
      const failure = failureReceipt(box);
      assert.equal(failure.restore, "FAILED", label);
      assert.equal(failure.restoreError.code, code, label);
      assert.match(failure.restoreError.detail, detail, label);
    } finally {
      box.cleanup();
    }
  }
});

test("중단 시그널은 진행 중인 compose 자식에 중단을 보내고 그 자식이 끝난 뒤에야 current를 되돌리고 INTERRUPTED receipt를 쓴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost();
    const signals = new EventEmitter();
    const exits = [];
    const atChildExit = [];
    const runner = (command, args, options) => {
      if (args[0] !== "compose" || !args.includes("up")) return host.runner(command, args, options);
      host.calls.push({ command, args, env: options.env });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => setTimeout(() => {
          atChildExit.push({ current: readlinkSync(join(box.observability, "current")), receipt: existsSync(receiptPath(box, "failure-receipt.json")) });
          reject(new Error("host command interrupted"));
        }, 20));
        setImmediate(() => signals.emit("SIGTERM", "SIGTERM"));
      });
    };
    await assert.rejects(deploy(box, host, { commandRunner: runner, signalSource: signals, exit: (code) => { exits.push(code); } }), /host command interrupted/u);
    assert.deepEqual(atChildExit, [{ current: join("releases", COMMIT), receipt: false }], "자식이 끝날 때까지 current와 receipt를 건드리지 않는다");
    assert.deepEqual(exits, [143]);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "INTERRUPTED");
    assert.match(failure.error.detail, /SIGTERM received while applying; in-flight host commands were stopped/u);
    assert.equal(failure.restore, "LINK_RESTORED");
    assert.equal(verbs(host).at(-1), "compose:up", "중단 뒤에는 어떤 호스트 명령도 시작하지 않는다");
    assert.equal(host.lock.closed, 1);
  } finally {
    box.cleanup();
  }
});
