#!/usr/bin/env node
// platform#273: infra/docker-compose.yml은 기본 네트워크를 external로 선언한다. compose는 external 네트워크를 만들지도, 설정을 비교해
// 다시 만들지도 않으므로(compose spec networks.<name>.external) 호스트 compose 경로는 compose를 돌리기 전에 이 모듈로 네트워크를 보장한다.
// 관측 설정 도구, 후보 기동, 고정 호스트 활성화는 함수로, tools/deploy/deploy-backend.sh는 CLI로 부른다. 이름과 서브넷의 정본은
// contracts/release/platform-k3s-observability-contract.json의 composeNetwork이고, K3s NetworkPolicy·Prometheus 대상도 같은 값을 읽는다.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { runCommand } from "./lib/process.mjs";

const CONTRACT_URL = new URL("../../contracts/release/platform-k3s-observability-contract.json", import.meta.url);
const { composeNetwork } = JSON.parse(readFileSync(CONTRACT_URL, "utf8"));
export const COMPOSE_NETWORK = Object.freeze({ name: composeNetwork.name, subnet: composeNetwork.subnet });

// CLI 종료 코드. deploy-backend.sh가 서브넷 불일치와 docker 오류를 다른 result detail로 남긴다.
export const EXIT_CODES = Object.freeze({ ensured: 0, dockerError: 1, usage: 2, subnetMismatch: 3 });
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const DOCKER_TIMEOUT_MS = 30_000;
// docker CLI가 같은 daemon과 설정을 쓰게 하는 변수만 넘긴다. compose를 돌리는 셸과 같은 docker를 보게 하려는 것이다.
const DOCKER_ENV_KEYS = Object.freeze(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]);

/** 네트워크는 있지만 서브넷이 계약과 다르다. 바꾸지 않고 멈춰야 하는 상태라 docker 호출 실패와 구분한다. */
export class ComposeNetworkMismatch extends Error {}

/**
 * 기본 네트워크가 없으면 계약 서브넷으로 만들고, 있으면 서브넷이 계약과 같은지 확인한다. 다르면 ComposeNetworkMismatch를 던진다(바꾸지 않는다).
 * run(args)는 `docker <args>`를 실행해 {stdout}을 돌려주고 실패하면 던진다. compose label을 붙여 두는 것은 네트워크를 external로 선언하지 않은
 * compose 파일(구 hub 체크아웃)도 같은 네트워크를 받아들이게 하려는 것이다. 그 compose는 label이 없는 같은 이름의 네트워크를 "incorrect label"로 거부한다.
 */
export async function ensureComposeNetwork(run, project) {
  const { name, subnet } = COMPOSE_NETWORK;
  const { stdout } = await run(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]);
  let action = "present";
  if (!stdout.split("\n").includes(name)) {
    await run(["network", "create", "--driver", "bridge", "--subnet", subnet, "--label", "com.docker.compose.network=default", "--label", `com.docker.compose.project=${project}`, name]);
    action = "created";
  }
  const [network] = JSON.parse((await run(["network", "inspect", name])).stdout);
  const subnets = (network?.IPAM?.Config ?? []).map((entry) => entry.Subnet);
  if (subnets.length !== 1 || subnets[0] !== subnet) throw new ComposeNetworkMismatch(`${name} has subnet ${subnets.join(",") || "none"}, expected ${subnet}`);
  return { name, subnet, action };
}

const dockerEnvironment = (env) => Object.fromEntries(DOCKER_ENV_KEYS.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));

/** `--project <name>`을 받아 네트워크를 보장하고 결과를 JSON 한 줄로 낸다. 실패는 EXIT_CODES로 구분한다. */
export async function main(argv, env, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 2 || argv[0] !== "--project" || !PROJECT_PATTERN.test(argv[1])) {
    stderr.write("E_COMPOSE_NETWORK_USAGE: expected exactly --project <compose project>\n");
    return EXIT_CODES.usage;
  }
  const run = (args) => runCommand("docker", args, { env: dockerEnvironment(env), timeoutMs: DOCKER_TIMEOUT_MS });
  try {
    stdout.write(`${JSON.stringify(await ensureComposeNetwork(run, argv[1]))}\n`);
    return EXIT_CODES.ensured;
  } catch (error) {
    const mismatch = error instanceof ComposeNetworkMismatch;
    stderr.write(`${mismatch ? "E_COMPOSE_NETWORK_MISMATCH" : "E_COMPOSE_NETWORK_DOCKER"}: ${String(error?.message ?? error).slice(0, 600)}\n`);
    return mismatch ? EXIT_CODES.subnetMismatch : EXIT_CODES.dockerError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
