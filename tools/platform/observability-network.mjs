// platform#273: 관측 설정 DEPLOY가 관리 컨테이너를 compose 기본 네트워크(external, ensure-compose-network.mjs가 보장)에 붙어 있게 하는 확인과 재연결.
import { COMPOSE_NETWORK } from "./ensure-compose-network.mjs";
import { message } from "./observability-deploy-primitives.mjs";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/**
 * 실패한 compose가 컨테이너를 기본 네트워크에서 떼어 낸 채 둘 수 있다(2026-10-30 사고). unit마다 컨테이너가 떠 있고 붙어 있는지 보고,
 * 떨어져 있으면 compose가 붙일 때와 같은 alias로 다시 붙인다. compose(v2)는 기본 네트워크 endpoint에 container_name과 서비스 이름을 alias로
 * 단다(실측: Aliases ["<container_name>", "<service>"]). 떨어진 컨테이너에는 endpoint가 없으므로 그 두 값을 컨테이너 자신의 이름과
 * compose service label에서 읽는다. 던지지 않고 unit별 결과를 돌려준다(receipt에 그대로 남는다).
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
  const service = record?.Config?.Labels?.[COMPOSE_SERVICE_LABEL];
  if (typeof service !== "string" || service === "") return { ...entry, action: "UNREADABLE", detail: `${unit.container} has no ${COMPOSE_SERVICE_LABEL} label to take the alias from` };
  const aliases = [String(record.Name).replace(/^\//u, ""), service];
  try {
    await docker.docker(["network", "connect", ...aliases.flatMap((alias) => ["--alias", alias]), name, unit.container]);
    return { ...entry, action: "RECONNECTED", detail: `aliases ${aliases.join(",")}` };
  } catch (error) {
    return { ...entry, action: "RECONNECT_FAILED", detail: message(error) };
  }
}

const ATTACHMENT_PROBLEMS = Object.freeze({
  RECONNECT_FAILED: (entry) => `${entry.container} is detached from ${entry.network} and reconnecting it failed: ${entry.detail}`,
  UNREADABLE: (entry) => `${entry.container} network attachment could not be read: ${entry.detail}`,
});

const isUnattached = (entry) => entry.action in ATTACHMENT_PROBLEMS;

/**
 * 재연결 확인 결과를 사람이 읽을 문장과 판정으로 줄인다. reattach는 첫 확인, recheck는 복원 뒤 다시 본 확인(없으면 null)이다.
 * 다시 붙인 일은 두 확인 모두에서 알리고, 판정은 마지막 확인으로 정한다. unattached는 다시 붙이지 못했거나 읽지 못한 컨테이너가 있다는 뜻이고,
 * failed는 거기에 멈춰 있는 컨테이너까지 더한 것이다(배포 전 기준선은 멈춘 probe를 compose up이 다시 띄우므로 unattached만 본다).
 */
export function attachmentVerdict({ reattach, recheck }) {
  const final = recheck ?? reattach;
  const notes = [
    ...[...reattach, ...(recheck ?? [])].filter((entry) => entry.action === "RECONNECTED").map((entry) => `${entry.container} was detached from ${entry.network} and was reconnected with ${entry.detail}`),
    ...final.filter((entry) => entry.action in ATTACHMENT_PROBLEMS).map((entry) => ATTACHMENT_PROBLEMS[entry.action](entry)),
    ...final.filter((entry) => entry.running === false).map((entry) => `${entry.container} is not running`),
  ];
  const unattached = final.some(isUnattached);
  return { notes, unattached, failed: unattached || final.some((entry) => entry.running === false) };
}
