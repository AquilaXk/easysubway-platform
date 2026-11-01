import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMPOSE_NETWORK, EXIT_CODES, ensureComposeNetwork } from "./ensure-compose-network.mjs";
import { attachmentVerdict, reattachDetached } from "./observability-network.mjs";

// platform#273: compose 기본 네트워크는 external이라 호스트 compose 경로가 모두 ensure-compose-network.mjs 하나로 그 네트워크를 보장한다.
// 없으면 계약 서브넷으로 만들고, 같은 서브넷이면 손대지 않고, 다른 서브넷이면 바꾸지 않고 실패한다.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const contract = JSON.parse(read("contracts/release/platform-k3s-observability-contract.json")).composeNetwork;
const CLI = new URL("./ensure-compose-network.mjs", import.meta.url).pathname;
const CREATE_ARGS = [
  "network", "create", "--driver", "bridge", "--subnet", contract.subnet,
  "--label", "com.docker.compose.network=default", "--label", "com.docker.compose.project=easysubway", contract.name,
];

function fakeDocker({ exists, subnet = contract.subnet, connectFails = false, record = null }) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "ls") return { stdout: exists ? `${contract.name}\n` : "" };
    if (args[0] === "network" && args[1] === "create") {
      exists = true;
      return { stdout: "id\n" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { stdout: JSON.stringify([{ IPAM: { Config: subnet === null ? [] : [{ Subnet: subnet }] } }]) };
    if (args[0] === "network" && args[1] === "connect" && connectFails) throw new Error("endpoint create failed");
    return { stdout: "" };
  };
  const json = async (args) => {
    calls.push(args);
    if (record instanceof Error) throw record;
    return [record];
  };
  return { calls, docker: { docker, json } };
}

test("네트워크 이름과 서브넷은 계약 파일에서 읽는다", () => {
  assert.deepEqual(COMPOSE_NETWORK, contract);
});

test("ensureComposeNetwork: 없으면 계약 서브넷과 compose label로 만들고, 같으면 읽기만 하며, 다르면 만들지 않고 던진다", async () => {
  const absent = fakeDocker({ exists: false });
  assert.deepEqual(await ensureComposeNetwork(absent.docker.docker, "easysubway"), { ...contract, action: "created" });
  assert.deepEqual(absent.calls.find((args) => args[1] === "create"), CREATE_ARGS);
  const same = fakeDocker({ exists: true });
  assert.deepEqual(await ensureComposeNetwork(same.docker.docker, "easysubway"), { ...contract, action: "present" });
  assert.equal(same.calls.some((args) => args[1] === "create"), false);
  for (const subnet of ["172.19.0.0/16", null]) {
    const other = fakeDocker({ exists: true, subnet });
    await assert.rejects(ensureComposeNetwork(other.docker.docker, "easysubway"), new RegExp(`expected ${contract.subnet.replaceAll(".", "\\.")}`, "u"), String(subnet));
    assert.equal(other.calls.some((args) => args[1] === "create"), false, String(subnet));
  }
});

// CLI는 PATH 앞에 둔 가짜 docker를 부른다. 가짜 docker는 상태 파일로 네트워크 유무·서브넷을 흉내 내고 호출을 log에 남긴다.
function fakeDockerBin(root, { subnet = null, failLs = false }) {
  const state = join(root, "network-subnet");
  const log = join(root, "docker.log");
  if (subnet !== null) writeFileSync(state, subnet);
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "network ls") ${failLs ? "echo 'Cannot connect to the Docker daemon' >&2; exit 1" : `[ -f '${state}' ] && echo '${contract.name}'; exit 0`} ;;
  "network create") prev=""; for arg in "$@"; do [ "$prev" = "--subnet" ] && printf '%s' "$arg" > '${state}'; prev="$arg"; done; exit 0 ;;
  "network inspect") printf '[{"IPAM":{"Config":[{"Subnet":"%s"}]}}]' "$(cat '${state}')"; exit 0 ;;
esac
exit 1
`;
  writeFileSync(join(root, "docker"), script);
  chmodSync(join(root, "docker"), 0o755);
  return { calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: `${root}:${process.env.PATH}` } });
}

test("CLI: 없으면 만들고 결과를 JSON으로 내며, 서브넷 불일치는 3, docker 오류는 1, 잘못된 인자는 2로 끝난다", () => {
  const cases = [
    ["없음", {}, EXIT_CODES.ensured, "created"],
    ["같은 서브넷", { subnet: contract.subnet }, EXIT_CODES.ensured, "present"],
    ["다른 서브넷", { subnet: "172.19.0.0/16" }, EXIT_CODES.subnetMismatch, /^E_COMPOSE_NETWORK_MISMATCH: .*172\.19\.0\.0\/16, expected 172\.18\.0\.0\/16/u],
    ["docker 오류", { failLs: true }, EXIT_CODES.dockerError, /^E_COMPOSE_NETWORK_DOCKER: .*Cannot connect to the Docker daemon/u],
  ];
  for (const [label, options, status, outcome] of cases) {
    const root = mkdtempSync(join(tmpdir(), "ensure-compose-network-"));
    try {
      const docker = fakeDockerBin(root, options);
      const result = runCli(root, ["--project", "easysubway"]);
      assert.equal(result.status, status, `${label}: ${result.stderr}`);
      if (typeof outcome === "string") assert.deepEqual(JSON.parse(result.stdout), { ...contract, action: outcome }, label);
      else assert.match(result.stderr, outcome, label);
      assert.equal(docker.calls().includes(CREATE_ARGS.join(" ")), outcome === "created", `${label}: 없을 때만 만든다`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const root = mkdtempSync(join(tmpdir(), "ensure-compose-network-"));
  try {
    const docker = fakeDockerBin(root, {});
    for (const args of [[], ["--project"], ["--project", "../x"], ["--project", "easysubway", "extra"]]) {
      assert.equal(runCli(root, args).status, EXIT_CODES.usage, args.join(" "));
    }
    assert.deepEqual(docker.calls(), [], "잘못된 인자면 docker를 부르지 않는다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend 배포는 첫 compose up보다 먼저 ensure CLI를 부르고 서브넷 불일치와 docker 오류를 다른 result로 남기며 자체 구현을 두지 않는다", () => {
  const script = read("tools/deploy/deploy-backend.sh");
  const call = script.indexOf('node tools/platform/ensure-compose-network.mjs --project "${DEPLOY_COMPOSE_PROJECT}" >/dev/null || network_status=$?');
  const firstUp = script.search(/^[^#\n]*docker compose [^\n]* up /mu);
  assert.ok(call > 0 && firstUp > call, "ensure CLI가 첫 compose up보다 앞에 있다");
  assert.ok(script.includes(`\t${EXIT_CODES.subnetMismatch}) write_result "blocked" "compose_network_mismatch"; exit 1 ;;`));
  assert.ok(script.includes('\t*) write_result "failed" "compose_network_unavailable"; exit 1 ;;'));
  for (const duplicate of ["ensure_compose_network", "COMPOSE_NETWORK_NAME", "COMPOSE_NETWORK_SUBNET", contract.subnet]) assert.equal(script.includes(duplicate), false, duplicate);
});

const detachedRecord = (overrides = {}) => ({ Name: "/easysubway-prometheus", Config: { Labels: { "com.docker.compose.service": "prometheus" } }, State: { Running: true }, NetworkSettings: { Networks: {} }, ...overrides });

test("관측 도구: 떨어진 컨테이너만 그 컨테이너의 이름과 compose service label을 alias로 다시 붙이고, 실패·읽기 불가·정지는 실패로 판정한다", async () => {
  const unit = { service: "prometheus", container: "easysubway-prometheus" };
  const attached = fakeDocker({ exists: true, record: detachedRecord({ NetworkSettings: { Networks: { [contract.name]: {} } } }) });
  const [kept] = await reattachDetached(attached.docker, [unit]);
  assert.equal(kept.action, "ATTACHED");
  assert.equal(attached.calls.some((args) => args[1] === "connect"), false);
  assert.deepEqual(attachmentVerdict({ reattach: [kept], recheck: null }), { notes: [], unattached: false, failed: false });

  const detached = fakeDocker({ exists: true, record: detachedRecord({ Name: "/easysubway-prometheus-renamed", Config: { Labels: { "com.docker.compose.service": "prom" } } }) });
  const [reconnected] = await reattachDetached(detached.docker, [unit]);
  assert.equal(reconnected.action, "RECONNECTED");
  assert.deepEqual(detached.calls.find((args) => args[1] === "connect"), ["network", "connect", "--alias", "easysubway-prometheus-renamed", "--alias", "prom", contract.name, "easysubway-prometheus"]);
  assert.equal(attachmentVerdict({ reattach: [reconnected], recheck: null }).failed, false, "다시 붙인 것은 알리기만 한다");

  const cases = [
    [{ record: detachedRecord(), connectFails: true }, /reconnecting it failed: endpoint create failed/u],
    [{ record: new Error("No such container") }, /could not be read: No such container/u],
    [{ record: detachedRecord({ Config: { Labels: {} } }) }, /has no com\.docker\.compose\.service label/u],
    [{ record: detachedRecord({ State: { Running: false }, NetworkSettings: { Networks: { [contract.name]: {} } } }) }, /is not running/u],
  ];
  for (const [options, note] of cases) {
    const entries = await reattachDetached(fakeDocker({ exists: true, ...options }).docker, [unit]);
    const verdict = attachmentVerdict({ reattach: entries, recheck: null });
    assert.equal(verdict.failed, true, String(note));
    assert.equal(verdict.unattached, String(note) !== String(/is not running/u), `${note}: 멈춘 것은 연결 문제가 아니다`);
    assert.match(verdict.notes.join("; "), note);
  }
});

test("판정은 마지막 확인으로 정하고 다시 붙인 일은 두 확인 모두에서 알린다", () => {
  const entry = (action, running = true) => ({ service: "prometheus", container: "easysubway-prometheus", network: contract.name, running, action, detail: action === "RECONNECTED" ? "aliases easysubway-prometheus,prometheus" : "x" });
  const healed = attachmentVerdict({ reattach: [entry("RECONNECT_FAILED")], recheck: [entry("ATTACHED")] });
  assert.equal(healed.failed, false, "복원 뒤 붙어 있으면 실패가 아니다");
  const relapsed = attachmentVerdict({ reattach: [entry("RECONNECTED")], recheck: [entry("RECONNECT_FAILED")] });
  assert.equal(relapsed.failed, true, "복원 뒤 다시 떨어져 붙이지 못하면 실패다");
  assert.match(relapsed.notes.join("; "), /was reconnected with aliases easysubway-prometheus,prometheus.*reconnecting it failed/u);
});
