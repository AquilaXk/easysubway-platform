// platform#273: infra/docker-compose.yml은 기본 네트워크를 external로 선언한다. compose는 external 네트워크를 만들지도, 설정을 비교해
// 다시 만들지도 않으므로(compose spec networks.<name>.external) 호스트에 그 네트워크가 있게 하는 일은 배포 도구가 맡는다. 이름과 서브넷의
// 정본은 contracts/release/platform-k3s-observability-contract.json의 composeNetwork이고, K3s NetworkPolicy·Prometheus 대상도 같은 값을 읽는다.
import { readFileSync } from "node:fs";

import { message } from "./observability-deploy-primitives.mjs";

const CONTRACT_URL = new URL("../../contracts/release/platform-k3s-observability-contract.json", import.meta.url);
const { composeNetwork } = JSON.parse(readFileSync(CONTRACT_URL, "utf8"));
export const COMPOSE_NETWORK = Object.freeze({ name: composeNetwork.name, subnet: composeNetwork.subnet });

/**
 * 기본 네트워크가 없으면 계약 서브넷으로 만들고, 있으면 서브넷이 계약과 같은지 확인한다. 다르면 던진다(바꾸지 않는다).
 * compose label을 붙여 두는 것은 네트워크를 external로 선언하지 않은 compose 파일(구 hub 체크아웃)도 같은 네트워크를 받아들이게 하려는 것이다.
 * 그 compose는 label이 없는 같은 이름의 네트워크를 "incorrect label"로 거부한다.
 */
export async function ensureComposeNetwork(docker, project) {
  const { name, subnet } = COMPOSE_NETWORK;
  const { stdout } = await docker.docker(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]);
  let action = "present";
  if (!stdout.split("\n").includes(name)) {
    await docker.docker(["network", "create", "--driver", "bridge", "--subnet", subnet, "--label", "com.docker.compose.network=default", "--label", `com.docker.compose.project=${project}`, name]);
    action = "created";
  }
  const [network] = await docker.json(["network", "inspect", name]);
  const subnets = (network?.IPAM?.Config ?? []).map((entry) => entry.Subnet);
  if (subnets.length !== 1 || subnets[0] !== subnet) throw new Error(`${name} has subnet ${subnets.join(",") || "none"}, expected ${subnet}`);
  return { name, subnet, action };
}

/**
 * 실패한 compose가 컨테이너를 기본 네트워크에서 떼어 낸 채 둘 수 있다(2026-10-30 사고). unit마다 컨테이너가 떠 있고 붙어 있는지 보고,
 * 떨어져 있으면 compose가 붙일 때와 같은 alias(container_name과 서비스 이름)로 다시 붙인다. 던지지 않고 unit별 결과를 돌려준다(receipt에 그대로 남는다).
 */
export function reattachDetached(docker, units) {
  return Promise.all(units.map((unit) => reattachUnit(docker, unit)));
}

async function reattachUnit(docker, unit) {
  const { name } = COMPOSE_NETWORK;
  const entry = { service: unit.service, container: unit.container, network: name, running: null, action: "ATTACHED", detail: null };
  let record;
  try {
    [record] = await docker.json(["inspect", "--type", "container", unit.container]);
  } catch (error) {
    return { ...entry, action: "UNREADABLE", detail: message(error) };
  }
  entry.running = record?.State?.Running === true;
  if (name in (record?.NetworkSettings?.Networks ?? {})) return entry;
  try {
    await docker.docker(["network", "connect", "--alias", unit.container, "--alias", unit.service, name, unit.container]);
    return { ...entry, action: "RECONNECTED" };
  } catch (error) {
    return { ...entry, action: "RECONNECT_FAILED", detail: message(error) };
  }
}

const ATTACHMENT_PROBLEMS = Object.freeze({
  RECONNECT_FAILED: (entry) => `${entry.container} is detached from ${entry.network} and reconnecting it failed: ${entry.detail}`,
  UNREADABLE: (entry) => `${entry.container} network attachment could not be read: ${entry.detail}`,
});

/** reattachDetached 결과를 사람이 읽을 문장과 실패 여부로 줄인다. 다시 붙인 것은 알리기만 하고, 다시 붙이지 못했거나 읽지 못했거나 멈춰 있으면 실패다. */
export function attachmentVerdict(entries) {
  const notes = entries.flatMap((entry) => [
    ...(entry.action === "RECONNECTED" ? [`${entry.container} was detached from ${entry.network} and was reconnected with aliases ${entry.container},${entry.service}`] : []),
    ...(entry.action in ATTACHMENT_PROBLEMS ? [ATTACHMENT_PROBLEMS[entry.action](entry)] : []),
    ...(entry.running === false ? [`${entry.container} is not running`] : []),
  ]);
  return { notes, failed: entries.some((entry) => entry.action in ATTACHMENT_PROBLEMS || entry.running === false) };
}
