// platform#227: 관측 설정 배포가 Prometheus(라이브 컨테이너와 격리 reference)에서 상태를 읽고 커밋 기준 기대와 대조하는 부분.
// 읽기는 컨테이너 안의 wget으로 한다. 판정은 문제 문자열 목록으로 돌려주고, 반복·실패 처리는 deploy-observability-config.mjs가 맡는다.
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { sha256 } from "./observability-deploy-primitives.mjs";

// 이슈 #220이 레포에서 제거한 대상. 라이브에 남아 있으면 상시 경보를 내므로 reference 대조와 별개로 이름을 명시해 막는다.
export const REMOVED_JOBS = Object.freeze(["back_worker"]);

const promUrl = (path) => `http://127.0.0.1:9090${path}`;

async function promGet(docker, target, path) {
  const { stdout } = await docker.docker(["exec", target, "wget", "-qO-", promUrl(path)]);
  return stdout;
}

const rulesProjection = (groups) => groups.map((group) => ({
  name: group.name,
  file: group.file,
  interval: group.interval ?? null,
  rules: (group.rules ?? []).map((rule) => ({
    name: rule.name, type: rule.type, query: rule.query, duration: rule.duration ?? null, keepFiringFor: rule.keepFiringFor ?? null, labels: rule.labels ?? {}, annotations: rule.annotations ?? {},
  })),
}));

const JOB_PREFIX = "- job_name: ";
const jobsOf = (yaml) => yaml.split("\n")
  .filter((line) => line.startsWith(JOB_PREFIX))
  .map((line) => line.slice(JOB_PREFIX.length).trim().replace(/^["']|["']$/gu, ""))
  .toSorted(codepointCompare);

export async function promData(docker, target, path) {
  const parsed = JSON.parse(await promGet(docker, target, path));
  if (parsed.status !== "success") throw new Error(`prometheus ${path} did not succeed`);
  return parsed.data;
}

export async function readSnapshot(docker, target) {
  const data = (path) => promData(docker, target, path);
  const ready = await promGet(docker, target, "/-/ready");
  if (!ready.includes("Ready")) throw new Error("prometheus is not ready");
  const [build, flags, config, rules] = [
    await data("/api/v1/status/buildinfo"), await data("/api/v1/status/flags"), await data("/api/v1/status/config"), await data("/api/v1/rules"),
  ];
  const targets = (await data("/api/v1/targets?state=active")).activeTargets.map((target) => ({ job: target.scrapePool, health: target.health })).sort((a, b) => codepointCompare(a.job, b.job) || codepointCompare(a.health, b.health));
  const allRules = rules.groups.flatMap((group) => (group.rules ?? []).map((rule) => ({ name: rule.name, health: rule.health })));
  // Prometheus가 자기 자신을 scrape하지 않으므로(prometheus.yml에 self job 없음) PromQL이 아니라 /metrics 본문에서 읽는다.
  const metrics = await promGet(docker, target, "/metrics");
  const projected = rulesProjection(rules.groups);
  return {
    version: build.version,
    flags,
    yaml: config.yaml,
    statusConfigSha256: sha256(config.yaml),
    rulesSha256: sha256(JSON.stringify(projected)),
    jobs: jobsOf(config.yaml),
    targets,
    ruleHealth: { total: allRules.length, ok: allRules.filter((rule) => rule.health === "ok").length },
    unhealthyRules: allRules.filter((rule) => rule.health !== "ok").map((rule) => `${rule.name}=${rule.health}`),
    reloadSuccessful: metricToken(metrics, "prometheus_config_last_reload_successful"),
    lowestTimestamp: metricToken(metrics, "prometheus_tsdb_lowest_timestamp"),
  };
}

const metricToken = (text, name) => text.split("\n").find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? null;

export function compareSnapshots(expected, live, flagKeys) {
  const problems = [];
  if (live.version !== expected.version) problems.push(`version ${live.version} != ${expected.version}`);
  for (const key of flagKeys) if (live.flags[key] !== expected.flags[key]) problems.push(`flag ${key}: ${JSON.stringify(live.flags[key])} != ${JSON.stringify(expected.flags[key])}`);
  if (live.statusConfigSha256 !== expected.statusConfigSha256) problems.push("/api/v1/status/config differs from the deployed commit");
  if (live.rulesSha256 !== expected.rulesSha256) problems.push("/api/v1/rules differs from the deployed commit");
  if (JSON.stringify(live.jobs) !== JSON.stringify(expected.jobs)) problems.push(`jobs [${live.jobs.join(",")}] != [${expected.jobs.join(",")}]`);
  for (const job of REMOVED_JOBS) if (live.jobs.includes(job)) problems.push(`removed job ${job} is still configured`);
  problems.push(...runtimeProblems(expected, live));
  return problems;
}

// reference는 네트워크가 없어 scrape할 수 없으므로 target·규칙 health는 라이브만 본다. 첫 scrape·첫 평가는 검증 반복이 기다린다.
function runtimeProblems(expected, live) {
  const problems = expected.jobs.map((job) => targetProblem(job, live.targets.filter((target) => target.job === job))).filter(Boolean);
  if (live.unhealthyRules.length > 0) problems.push(`rule health is not ok: ${live.unhealthyRules.join(",")}`);
  if (live.reloadSuccessful !== "1") problems.push("prometheus_config_last_reload_successful is not 1");
  return problems;
}

function targetProblem(job, own) {
  if (own.length === 0) return `job ${job} has no active target`;
  if (own.some((target) => target.health !== "up")) return `job ${job} target is not up (${own.map((target) => target.health).join(",")})`;
  return null;
}
