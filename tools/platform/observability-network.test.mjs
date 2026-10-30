import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { COMPOSE_NETWORK, attachmentVerdict, ensureComposeNetwork, reattachDetached } from "./observability-network.mjs";

// platform#273: compose 기본 네트워크는 external이라 두 배포 경로(관측 설정 도구와 backend 배포 스크립트)가 같은 규칙으로 그 네트워크를 보장한다.
// 없으면 계약 서브넷으로 만들고, 같은 서브넷이면 손대지 않고, 다른 서브넷이면 바꾸지 않고 실패한다.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const contract = JSON.parse(read("contracts/release/platform-k3s-observability-contract.json")).composeNetwork;
const script = read("tools/deploy/deploy-backend.sh");

function fakeDocker({ exists, subnet = contract.subnet, connectFails = false, record = null }) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "ls") return { stdout: exists ? `${contract.name}\n` : "" };
    if (args[0] === "network" && args[1] === "create") {
      exists = true;
      return { stdout: "id\n" };
    }
    if (args[0] === "network" && args[1] === "connect" && connectFails) throw new Error("endpoint create failed");
    return { stdout: "" };
  };
  const json = async (args) => {
    calls.push(args);
    if (args[0] === "network") return [{ IPAM: { Config: subnet === null ? [] : [{ Subnet: subnet }] } }];
    if (record instanceof Error) throw record;
    return [record];
  };
  return { calls, docker: { docker, json } };
}

test("관측 도구: 기본 네트워크가 없으면 계약 서브넷으로 만들고, 같으면 읽기만 하며, 다르면 만들지 않고 던진다", async () => {
  const absent = fakeDocker({ exists: false });
  assert.deepEqual(await ensureComposeNetwork(absent.docker, "easysubway"), { ...contract, action: "created" });
  assert.deepEqual(absent.calls.find((args) => args[1] === "create"), [
    "network", "create", "--driver", "bridge", "--subnet", contract.subnet,
    "--label", "com.docker.compose.network=default", "--label", "com.docker.compose.project=easysubway", contract.name,
  ]);
  const same = fakeDocker({ exists: true });
  assert.deepEqual(await ensureComposeNetwork(same.docker, "easysubway"), { ...contract, action: "present" });
  assert.equal(same.calls.some((args) => args[1] === "create"), false);
  for (const subnet of ["172.19.0.0/16", null]) {
    const other = fakeDocker({ exists: true, subnet });
    await assert.rejects(ensureComposeNetwork(other.docker, "easysubway"), new RegExp(`expected ${contract.subnet.replaceAll(".", "\\.")}`, "u"), String(subnet));
    assert.equal(other.calls.some((args) => args[1] === "create"), false, String(subnet));
  }
});

test("관측 도구: 떨어진 컨테이너만 compose alias로 다시 붙이고, 실패·읽기 불가·정지는 실패로 판정한다", async () => {
  const unit = { service: "prometheus", container: "easysubway-prometheus" };
  const attached = fakeDocker({ exists: true, record: { State: { Running: true }, NetworkSettings: { Networks: { [contract.name]: {} } } } });
  const [kept] = await reattachDetached(attached.docker, [unit]);
  assert.equal(kept.action, "ATTACHED");
  assert.equal(attached.calls.some((args) => args[1] === "connect"), false);
  assert.deepEqual(attachmentVerdict([kept]), { notes: [], failed: false });

  const detached = fakeDocker({ exists: true, record: { State: { Running: true }, NetworkSettings: { Networks: {} } } });
  const [reconnected] = await reattachDetached(detached.docker, [unit]);
  assert.equal(reconnected.action, "RECONNECTED");
  assert.deepEqual(detached.calls.find((args) => args[1] === "connect"), ["network", "connect", "--alias", "easysubway-prometheus", "--alias", "prometheus", contract.name, "easysubway-prometheus"]);
  assert.equal(attachmentVerdict([reconnected]).failed, false, "다시 붙인 것은 알리기만 한다");

  const cases = [
    [{ record: { State: { Running: true }, NetworkSettings: { Networks: {} } }, connectFails: true }, /reconnecting it failed: endpoint create failed/u],
    [{ record: new Error("No such container") }, /could not be read: No such container/u],
    [{ record: { State: { Running: false }, NetworkSettings: { Networks: { [contract.name]: {} } } } }, /is not running/u],
  ];
  for (const [options, note] of cases) {
    const entries = await reattachDetached(fakeDocker({ exists: true, ...options }).docker, [unit]);
    const verdict = attachmentVerdict(entries);
    assert.equal(verdict.failed, true, String(note));
    assert.match(verdict.notes.join("; "), note);
  }
});

// deploy-backend.sh의 ensure_compose_network를 그대로 실행하고 docker만 바꿔 끼운다. FAKE_NETWORK가 비면 네트워크가 없다.
// 가짜 docker는 호출을 fd 3(원래 stdout)에 남겨, 명령 치환이 잡는 출력과 섞이지 않게 한다.
function runEnsure({ network, failLs = false }) {
  const constants = script.split("\n").filter((line) => /^COMPOSE_NETWORK_[A-Z]+=/u.test(line)).join("\n");
  const ensure = script.match(/^ensure_compose_network\(\) \{\n[\s\S]*?\n\}$/mu)[0];
  const docker = `docker() {
  printf '%s\\n' "$*" >&3
  case "$1 $2" in
    "network ls") [[ -n "\${FAIL_LS}" ]] && return 1; [[ -n "\${FAKE_NETWORK}" ]] && printf '%s\\n' "${contract.name}"; return 0 ;;
    "network create") FAKE_NETWORK="$(sed -n 's/.*--subnet \\([^ ]*\\).*/\\1/p' <<<"$*")"; return 0 ;;
    "network inspect") printf '%s ' "\${FAKE_NETWORK}"; return 0 ;;
  esac
  return 1
}`;
  const program = `exec 3>&1\nDEPLOY_COMPOSE_PROJECT=easysubway\n${constants}\n${docker}\n${ensure}\nensure_compose_network\nprintf 'status %s\\n' "$?"`;
  const { status, stdout, stderr } = spawnSync("bash", ["-c", program], { encoding: "utf8", env: { PATH: process.env.PATH, FAKE_NETWORK: network ?? "", FAIL_LS: failLs ? "1" : "" } });
  assert.equal(status, 0, stderr);
  const lines = stdout.trim().split("\n");
  return { calls: lines.filter((line) => !line.startsWith("status ")), status: Number(lines.at(-1).split(" ")[1]) };
}

test("backend 배포: ensure_compose_network는 없으면 계약 서브넷과 compose label로 만들고, 같으면 읽기만 하며, 다르거나 읽지 못하면 실패한다", () => {
  const absent = runEnsure({ network: null });
  assert.equal(absent.status, 0);
  assert.ok(absent.calls.includes(`network create --driver bridge --subnet ${contract.subnet} --label com.docker.compose.network=default --label com.docker.compose.project=easysubway ${contract.name}`), absent.calls.join("\n"));
  const same = runEnsure({ network: contract.subnet });
  assert.equal(same.status, 0);
  assert.equal(same.calls.some((line) => line.startsWith("network create")), false);
  const other = runEnsure({ network: "172.19.0.0/16" });
  assert.notEqual(other.status, 0);
  assert.equal(other.calls.some((line) => line.startsWith("network create")), false);
  assert.notEqual(runEnsure({ network: contract.subnet, failLs: true }).status, 0, "네트워크 목록을 읽지 못하면 만들지도 통과하지도 않는다");
});

test("backend 배포의 네트워크 이름·서브넷은 계약과 같고, 첫 compose up보다 먼저 네트워크를 보장하며 실패하면 멈춘다", () => {
  assert.equal(script.match(/^COMPOSE_NETWORK_NAME="([^"]+)"$/mu)[1], contract.name);
  assert.equal(script.match(/^COMPOSE_NETWORK_SUBNET="([^"]+)"$/mu)[1], contract.subnet);
  assert.deepEqual(COMPOSE_NETWORK, contract);
  const guard = script.indexOf('if ! ensure_compose_network; then\n\twrite_result "blocked" "compose_network_mismatch"\n\texit 1\nfi');
  const firstUp = script.search(/^[^#\n]*docker compose [^\n]* up /mu);
  assert.ok(guard > 0 && firstUp > guard, "ensure_compose_network가 첫 compose up보다 앞에 있다");
});
