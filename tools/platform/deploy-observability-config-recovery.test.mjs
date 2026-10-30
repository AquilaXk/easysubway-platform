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
const MUTATING_VERBS = new Set(["compose:up", "restart", "network:connect", "network:create", "run:reference"]);
const actionsOf = (entries) => entries.map((entry) => [entry.service, entry.action]);

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

test("다른 배포가 deploy.lock을 쥐고 있으면 E_OBS_DEPLOY_LOCKED, 잠금을 걸 수 없는 환경이면 E_OBS_DEPLOY_LOCK_UNAVAILABLE로 바로 실패하고 아무것도 바꾸지 않는다", async () => {
  const cases = [
    ["경합", Object.assign(new Error("shared deploy lock is held by another deploy"), { contended: true }), /E_OBS_DEPLOY_LOCKED: .*deploy\.lock is held by another deploy.*nothing was changed/u],
    ["획득 불가", Object.assign(new Error("shared deploy lock could not be acquired: /usr/bin/flock exited 66: cannot open lock file"), { contended: false }), /E_OBS_DEPLOY_LOCK_UNAVAILABLE: .*deploy\.lock could not be locked; nothing was changed: .*flock exited 66/u],
  ];
  for (const [label, refusal, pattern] of cases) {
    const box = sandbox();
    try {
      seedPreviousRelease(box);
      const host = createHost();
      await assert.rejects(deploy(box, host, { acquireDeployLock: async () => { throw refusal; } }), pattern, label);
      assert.deepEqual(verbs(host), ["git"], `${label}: docker를 한 번도 부르지 않는다`);
      assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS), label);
      assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false, label);
      assert.equal(existsSync(join(box.deployRoot, "release-receipts", `observability-config-${COMMIT.slice(0, 12)}-123`)), false, label);
    } finally {
      box.cleanup();
    }
  }
});

test("잠금 holder가 DEPLOY 도중 죽으면 다음 호스트 명령 전에 멈추고 복원도 하지 않으며 그 사실을 receipt에 남긴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost();
    const runner = async (command, args, options) => {
      const result = await host.runner(command, args, options);
      if (args[0] === "compose" && args.includes("up")) host.lock.lose();
      return result;
    };
    await assert.rejects(deploy(box, host, { commandRunner: runner }), /E_OBS_DEPLOY_LOCK_LOST: the deploy\.lock holder exited.*stopped before the next host change/u);
    const trail = verbs(host);
    assert.deepEqual(trail.slice(trail.indexOf("compose:up") + 1), [], "compose up 뒤로는 어떤 호스트 명령도 시작하지 않는다");
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", COMMIT), "다른 배포가 돌 수 있으므로 current도 되돌리지 않는다");
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "FAILED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_LOCK_LOST");
    assert.equal(failure.restore, "LOCK_LOST");
    assert.equal(failure.restoreError.code, "E_OBS_DEPLOY_LOCK_LOST");
  } finally {
    box.cleanup();
  }
});

test("복구 도중 잠금을 잃으면 복원 전에 멈춰 current를 되돌리지 않고 복원 실패로 남긴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ forwardUpFails: true });
    let forwardFailed = false;
    const runner = async (command, args, options) => {
      if (forwardFailed) host.lock.lose();
      try {
        return await host.runner(command, args, options);
      } catch (error) {
        if (args[0] === "compose" && args.includes("up")) forwardFailed = true;
        throw error;
      }
    };
    await assert.rejects(deploy(box, host, { commandRunner: runner }), /E_OBS_DEPLOY_RESTORE: forward failure E_OBS_DEPLOY_VERIFY: compose up failed.*restore verification failed for previous release b{40}: the deploy\.lock holder exited/su);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", COMMIT), "잠금을 잃은 뒤에는 current도 되돌리지 않는다");
    const trail = verbs(host);
    assert.deepEqual([...new Set(trail.slice(trail.indexOf("compose:up") + 1))], ["inspect"], "잠금을 잃는 동안 시작된 연결 확인(병렬 inspect) 뒤로는 호스트 명령이 없다");
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "FAILED");
    assert.equal(failure.restoreError.code, "E_OBS_DEPLOY_LOCK_LOST");
  } finally {
    box.cleanup();
  }
});

test("잠금을 기준선을 읽은 뒤 잃으면 release를 설치하지 않고 NOT_STARTED로 남긴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost();
    const runner = async (command, args, options) => {
      const result = await host.runner(command, args, options);
      if (args[0] === "exec" && args[1] === "easysubway-prometheus" && args.at(-1).endsWith("/metrics")) host.lock.lose();
      return result;
    };
    await assert.rejects(deploy(box, host, { commandRunner: runner }), /E_OBS_DEPLOY_LOCK_LOST/u);
    assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(verbs(host).some((verb) => MUTATING_VERBS.has(verb) && verb !== "run:reference"), false);
    assert.equal(failureReceipt(box).restore, "NOT_STARTED");
  } finally {
    box.cleanup();
  }
});

test("compose 기본 네트워크가 없으면 계약 서브넷과 compose label로 만든 뒤 진행하고, 있으면 만들지 않는다", async () => {
  const box = sandbox();
  try {
    const host = createHost({ composeNetwork: { exists: false } });
    const result = await deploy(box, host);
    const trail = verbs(host);
    assert.ok(trail.indexOf("network:create") < trail.indexOf("compose:up"), "만든 다음에 compose up한다");
    const created = host.calls.find((call) => call.args[1] === "create").args;
    assert.deepEqual(created.slice(created.indexOf("--subnet"), created.indexOf("--subnet") + 2), ["--subnet", COMPOSE_SUBNET]);
    assert.deepEqual(host.state.composeNetwork.labels, ["com.docker.compose.network=default", "com.docker.compose.project=easysubway"]);
    assert.deepEqual(result.composeNetwork, { name: COMPOSE_NETWORK_NAME, subnet: COMPOSE_SUBNET, action: "created" });
    const present = createHost();
    await deploy(box, present, { runId: "124" });
    assert.equal(verbs(present).includes("network:create"), false);
  } finally {
    box.cleanup();
  }
});

test("기본 네트워크의 서브넷이 계약과 다르면 바꾸지 않고 release 설치·compose up 전에 실패하고 NOT_STARTED receipt를 남긴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ composeNetwork: { exists: true, subnet: "172.19.0.0/16" } });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_NETWORK: .*172\.19\.0\.0\/16, expected 172\.18\.0\.0\/16/u);
    assert.equal(verbs(host).some((verb) => verb === "compose:up" || verb === "network:create"), false);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    assert.equal(existsSync(join(box.observability, "releases", COMMIT)), false);
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "FAILED");
    assert.equal(failure.restore, "NOT_STARTED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_NETWORK");
    assert.equal(failure.composeNetwork, null, "보장에 실패했으므로 결과가 없다");
    assert.equal(failure.previousCommit, null, "current를 읽기 전에 멈췄다");
  } finally {
    box.cleanup();
  }
});

test("기본 네트워크를 external 없이 암묵 기본값 밖의 속성으로 선언한 release는 compose up 전에 거부하고, 암묵 기본값과 external은 통과한다", async () => {
  const owned = [
    ["ipam", { ipam: { config: [{ subnet: COMPOSE_SUBNET }] } }],
    ["labels", { labels: { team: "obs" } }],
    ["driver", { driver: "bridge" }],
    ["driver_opts", { driver_opts: { "com.docker.network.bridge.name": "br-easysubway" } }],
    ["internal", { internal: false }],
    ["enable_ipv6", { enable_ipv6: false }],
    ["attachable", { attachable: true }],
  ];
  for (const [property, definition] of owned) {
    const box = sandbox();
    try {
      const host = createHost({ composeNetworkConfig: { name: COMPOSE_NETWORK_NAME, ipam: {}, ...definition } });
      await assert.rejects(deploy(box, host), new RegExp(`E_OBS_DEPLOY_SOURCE: .*default network ${COMPOSE_NETWORK_NAME} with ${property} but not external`, "u"), property);
      assert.equal(verbs(host).includes("compose:up"), false, property);
    } finally {
      box.cleanup();
    }
  }
  for (const definition of [{ name: COMPOSE_NETWORK_NAME, external: true }, { name: COMPOSE_NETWORK_NAME, ipam: {} }]) {
    const box = sandbox();
    try {
      await deploy(box, createHost({ composeNetworkConfig: definition }));
    } finally {
      box.cleanup();
    }
  }
});

test("복원할 직전 release의 compose가 기본 네트워크를 소유하면 복원도 compose에 넘기지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ liveAfter: snapshot({ revision: "old" }), restoreComposeNetworkConfig: { name: COMPOSE_NETWORK_NAME, ipam: { config: [{ subnet: COMPOSE_SUBNET }] } } });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_RESTORE: forward failure E_OBS_DEPLOY_VERIFY.*with ipam but not external/su);
    assert.equal(verbs(host).filter((verb) => verb === "compose:up").length, 1, "복원 compose up은 돌지 않는다");
    const failure = failureReceipt(box);
    assert.equal(failure.restore, "FAILED");
    assert.equal(failure.restoreError.code, "E_OBS_DEPLOY_SOURCE");
  } finally {
    box.cleanup();
  }
});

test("사고 재현: 적용 compose up이 prometheus를 떼어 내고 복원 compose up이 다시 시작만 하면, 먼저 다시 붙인 뒤 복원해 붙은 prometheus로 RESTORED를 확인한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ forwardUpFails: true, detachOnFailedUp: true, recreateOnUp: false });
    await assert.rejects(deploy(box, host), (error) => {
      assert.equal(error.code, "E_OBS_DEPLOY_VERIFY", "복원에 성공했으므로 정방향 원인으로 끝난다");
      assert.match(error.message, /compose up failed.*restored previous release b{40}.*easysubway-prometheus was detached from easysubway_default and was reconnected with aliases easysubway-prometheus,prometheus/su);
      return true;
    });
    assert.equal(host.state.detachedReads, 0, "복원 대조는 붙어 있는 prometheus를 읽었다(떨어진 채 down을 기다리지 않았다)");
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "FAILED");
    assert.equal(failure.restore, "RESTORED");
    assert.equal(failure.restoreError, null);
    assert.deepEqual(failure.networkAttachment.reattach.find((entry) => entry.service === "prometheus"), {
      service: "prometheus", container: "easysubway-prometheus", network: COMPOSE_NETWORK_NAME, running: true, action: "RECONNECTED", detail: "aliases easysubway-prometheus,prometheus",
    });
    assert.deepEqual(actionsOf(failure.networkAttachment.recheck), [["prometheus", "ATTACHED"], ["origin-certificate-probe", "ATTACHED"]], "복원 뒤 다시 확인한 최종 상태");
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT]);
  } finally {
    box.cleanup();
  }
});

test("사고 재현: 적용과 복원의 compose up이 모두 실패해 prometheus가 떨어지면 receipt는 두 원인을 따로 남기고 복원 전후로 prometheus를 다시 붙인다", async () => {
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
    assert.deepEqual(actionsOf(failure.networkAttachment.reattach), [["prometheus", "RECONNECTED"], ["origin-certificate-probe", "ATTACHED"]]);
    assert.deepEqual(actionsOf(failure.networkAttachment.recheck), [["prometheus", "RECONNECTED"], ["origin-certificate-probe", "ATTACHED"]], "실패한 복원 up이 다시 떼어 내 한 번 더 붙였다");
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT, PROMETHEUS_CONNECT]);
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
    assert.equal(failure.networkAttachment.recheck.find((entry) => entry.service === "prometheus").action, "RECONNECT_FAILED");
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
    assert.deepEqual(actionsOf(failure.networkAttachment.reattach), [["prometheus", "RECONNECTED"], ["origin-certificate-probe", "ATTACHED"]]);
    assert.deepEqual(actionsOf(failure.networkAttachment.recheck), [["prometheus", "ATTACHED"], ["origin-certificate-probe", "ATTACHED"]]);
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT], "probe는 붙어 있어 connect하지 않는다");
  } finally {
    box.cleanup();
  }
});

test("지난 실패가 prometheus를 떼어 둔 채 끝났으면 기준선을 읽기 전에 다시 붙여, 떨어진 배선을 기준으로 삼지 않는다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ detachedBefore: true });
    const result = await deploy(box, host);
    const trail = verbs(host);
    assert.ok(trail.indexOf("network:connect") < trail.indexOf("compose:up"), "적용 전에 다시 붙인다");
    assert.deepEqual(actionsOf(result.baselineAttachment), [["prometheus", "RECONNECTED"], ["origin-certificate-probe", "ATTACHED"]]);
    assert.deepEqual(result.verification.network.networks, [COMPOSE_NETWORK_NAME]);
    assert.deepEqual(host.state.connected, [PROMETHEUS_CONNECT]);
  } finally {
    box.cleanup();
  }
  const refused = sandbox();
  try {
    seedPreviousRelease(refused);
    const host = createHost({ detachedBefore: true, connectFails: true });
    await assert.rejects(deploy(refused, host), /E_OBS_DEPLOY_NETWORK: managed containers are not attached to easysubway_default: .*reconnecting it failed/u);
    assert.equal(verbs(host).includes("compose:up"), false);
    assert.equal(failureReceipt(refused).restore, "NOT_STARTED");
  } finally {
    refused.cleanup();
  }
});

test("적용 뒤 prometheus가 계약 네트워크에서 떨어져 있으면 통과시키지 않고 복원한다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ networksAfterUp: [] });
    await assert.rejects(deploy(box, host), /E_OBS_DEPLOY_VERIFY/u);
    assert.equal(existsSync(receiptPath(box)), false);
    assert.equal(failureReceipt(box).restore, "RESTORED");
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

// compose up을 붙잡아 두는 runner. pause(index)번째 up(1부터)이 시작되면 signal을 보내고, 중단 signal을 받으면 20ms 뒤 거부한다.
function pausingRunner(host, box, { pause, signal }) {
  const signals = new EventEmitter();
  const exits = [];
  const atChildExit = [];
  let ups = 0;
  const runner = (command, args, options) => {
    if (args[0] !== "compose" || !args.includes("up")) return host.runner(command, args, options);
    ups += 1;
    if (ups !== pause) return host.runner(command, args, options);
    host.calls.push({ command, args, env: options.env });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => setTimeout(() => {
        atChildExit.push({ current: readlinkSync(join(box.observability, "current")), receipt: existsSync(receiptPath(box, "failure-receipt.json")) });
        reject(new Error("host command interrupted"));
      }, 20));
      setImmediate(() => signals.emit(signal, signal));
    });
  };
  return { exits, atChildExit, options: { commandRunner: runner, signalSource: signals, exit: (code) => { exits.push(code); } } };
}

test("중단 시그널은 진행 중인 compose 자식에 중단을 보내고 그 자식이 끝난 뒤에야 current를 되돌리고, 떨어진 컨테이너만 확인한 뒤 INTERRUPTED를 쓴다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost();
    const paused = pausingRunner(host, box, { pause: 1, signal: "SIGTERM" });
    await assert.rejects(deploy(box, host, paused.options), /E_OBS_DEPLOY_INTERRUPTED: SIGTERM received while applying; in-flight host commands were stopped/u);
    assert.deepEqual(paused.atChildExit, [{ current: join("releases", COMMIT), receipt: false }], "자식이 끝날 때까지 current와 receipt를 건드리지 않는다");
    assert.deepEqual(paused.exits, [143]);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "INTERRUPTED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_INTERRUPTED");
    assert.equal(failure.restore, "LINK_RESTORED");
    assert.equal(failure.restoreError, null);
    assert.deepEqual(actionsOf(failure.networkAttachment.reattach), [["prometheus", "ATTACHED"], ["origin-certificate-probe", "ATTACHED"]], "중단 signal과 무관하게 연결을 확인한다");
    const trail = verbs(host);
    assert.deepEqual([...new Set(trail.slice(trail.indexOf("compose:up") + 1))], ["inspect"], "중단 뒤에는 연결 확인 inspect만 한다");
    assert.equal(host.lock.closed, 1);
  } finally {
    box.cleanup();
  }
});

test("복원 도중 중단 시그널이 오면 정방향 실패를 error에, 복원 중단을 restoreError에 남기고 같은 종료 코드로 끝난다", async () => {
  const box = sandbox();
  try {
    seedPreviousRelease(box);
    const host = createHost({ liveAfter: snapshot({ revision: "old" }) });
    const paused = pausingRunner(host, box, { pause: 2, signal: "SIGINT" });
    await assert.rejects(deploy(box, host, paused.options), /E_OBS_DEPLOY_INTERRUPTED: SIGINT received while restoring/u);
    assert.deepEqual(paused.exits, [130]);
    assert.equal(readlinkSync(join(box.observability, "current")), join("releases", PREVIOUS));
    const failure = failureReceipt(box);
    assert.equal(failure.outcome, "INTERRUPTED");
    assert.equal(failure.error.code, "E_OBS_DEPLOY_VERIFY", "정방향 실패가 남는다");
    assert.equal(failure.restore, "LINK_RESTORED");
    assert.equal(failure.restoreError.code, "E_OBS_DEPLOY_INTERRUPTED");
    assert.match(failure.restoreError.detail, /SIGINT received while restoring/u);
    assert.equal(verbs(host).filter((verb) => verb === "compose:up").length, 2, "복원 up 뒤로 compose를 더 돌리지 않는다");
    assert.equal(host.lock.closed, 1);
  } finally {
    box.cleanup();
  }
});
