import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scrapeJobSettings, scrapeTargetsByJob } from "./prometheus-scrape-config.mjs";

// platform#270: 원 서버 인증서 만료 감시가 Cloudflare 엣지 인증서가 아니라 호스트 nginx 443의 인증서를 읽고,
// 운영 readiness를 보는 public-edge-probe와 설정·수명이 분리된다는 배선 계약.
// 알림 임계값은 infra/prometheus/origin-certificate-alerts.test.yml의 promtool 테스트가, 서비스 호스트 불변식은
// tools/ci/origin-certificate-renew-workflow.test.mjs가, 관측 설정 배포 도구와 compose 마운트의 짝은
// deploy-observability-config.test.mjs가 평가한다.
const repoRoot = new URL("../..", import.meta.url).pathname;
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const blackbox = read("infra/blackbox/origin-certificate.yml");
const prometheus = read("infra/prometheus/prometheus.yml");
const workflow = read(".github/workflows/origin-certificate-renew.yml");

const ORIGIN_JOB = "origin_certificate_probe";
const ORIGIN_SERVICE = "origin-certificate-probe";
const PUBLIC_SERVICE = "public-edge-probe";
const dockerAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const needsDocker = { skip: dockerAvailable ? false : "docker is not installed in this environment" };

const moduleNames = (config) => [...config.matchAll(/^ {2}([a-z0-9_]+):$/gmu)].map((match) => match[1]);
const blackboxModule = (name) => {
  const block = blackbox.split(new RegExp(`^  ${name}:\\n`, "mu"))[1]?.split(/^  \S/mu)[0];
  assert.ok(block, `blackbox module ${name}`);
  return block;
};
const jobsAddressedTo = (service) => [...scrapeJobSettings(prometheus)].filter(([, job]) => job.address === `${service}:9115`);

function composeServices(services) {
  const { status, stdout, stderr } = spawnSync("docker", ["compose", "-f", `${repoRoot}infra/docker-compose.yml`, "--profile", "observability", "config", "--format", "json", ...services], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, EASYSUBWAY_BACKEND_ENV_FILE: "/dev/null", EASYSUBWAY_BACKEND_IMAGE: "ghcr.io/aquilaxk/easysubway-backend@sha256:0000000000000000000000000000000000000000000000000000000000000000" },
  });
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout).services;
}

test("origin_certificate_probe는 공개 주소가 아니라 호스트 443을 전용 probe 서비스로 조사한다 (#270)", () => {
  assert.deepEqual(scrapeTargetsByJob(prometheus).get(ORIGIN_JOB), ["host.docker.internal:443"]);
  const settings = scrapeJobSettings(prometheus).get(ORIGIN_JOB);
  assert.equal(settings.module, "origin_tls_expiry");
  assert.equal(settings.address, `${ORIGIN_SERVICE}:9115`);
});

test("전용 probe가 쓰는 module은 모두 마운트되는 blackbox 설정에 있다 (#270)", () => {
  // 마운트한 파일이 이미지 기본 설정을 대체하므로 빠진 module이 있으면 해당 probe가 400으로 죽는다.
  const served = jobsAddressedTo(ORIGIN_SERVICE);
  assert.ok(served.length > 0);
  for (const [name, job] of served) assert.ok(moduleNames(blackbox).includes(job.module), `${name}: ${job.module} is not defined in infra/blackbox/origin-certificate.yml`);
});

test("public-edge-probe로 가는 job은 그 이미지의 기본 blackbox 설정에 있는 module만 쓴다 (#270)", needsDocker, () => {
  // public-edge-probe는 설정 파일을 마운트하지 않으므로, 전용 probe의 설정에만 module을 더하면 그 job이 400으로 죽는다.
  const { image } = composeServices([PUBLIC_SERVICE])[PUBLIC_SERVICE];
  const defaults = spawnSync("docker", ["run", "--rm", "--entrypoint", "cat", image, "/etc/blackbox_exporter/config.yml"], { encoding: "utf8" });
  assert.equal(defaults.status, 0, defaults.stderr);
  const served = jobsAddressedTo(PUBLIC_SERVICE);
  assert.ok(served.length > 0);
  for (const [name, job] of served) assert.ok(moduleNames(defaults.stdout).includes(job.module), `${name}: ${job.module} is not in the default config of ${image}`);
});

test("origin_tls_expiry는 만료된 인증서도 읽도록 검증을 건너뛰고 인증서 이름 SNI로 TLS 핸드셰이크만 한다 (#270)", () => {
  const module = blackboxModule("origin_tls_expiry");
  assert.match(module, /^\s+prober: tcp$/mu);
  assert.match(module, /^\s+tls: true$/mu);
  assert.match(module, /^\s+insecure_skip_verify: true$/mu);
  const cert = workflow.match(/^ {2}CERT_NAME: (\S+)$/mu)[1];
  assert.equal(module.match(/^\s+server_name: (\S+)$/mu)[1], cert);
});

test("compose 해석: 전용 probe는 public-edge-probe와 같은 이미지·수명이고 public-edge-probe는 설정 파일 없이 이미지 기본값을 쓴다 (#270)", needsDocker, () => {
  const services = composeServices([PUBLIC_SERVICE, ORIGIN_SERVICE]);
  const origin = services[ORIGIN_SERVICE];
  const edge = services[PUBLIC_SERVICE];
  assert.equal(origin.image, edge.image);
  for (const service of [origin, edge]) {
    assert.deepEqual(service.profiles, ["observability"]);
    assert.equal(service.restart, "unless-stopped");
  }
  assert.deepEqual(origin.volumes.map((volume) => [volume.source, volume.read_only]), [[`${repoRoot}infra/blackbox/origin-certificate.yml`, true]]);
  assert.equal(edge.container_name, "easysubway-public-edge-probe");
  assert.equal(edge.command ?? null, null);
  assert.equal(edge.volumes, undefined);
  assert.equal(edge.extra_hosts, undefined);
});

// deploy-backend.sh의 배열 정의와 start_observability_services를 그대로 실행하고 compose만 바꿔 끼워 실제 호출을 본다.
function runStartObservability(recreate) {
  const script = read("tools/deploy/deploy-backend.sh");
  const arrays = script.split("\n").filter((line) => /^OBSERVABILITY_[A-Z_]+=\(/u.test(line)).join("\n");
  const start = script.match(/^start_observability_services\(\) \{\n[\s\S]*?\n\}$/mu)[0];
  const program = `${arrays}\ncompose() { shift 3; printf '%s\\n' "$*"; }\n${start}\nstart_observability_services backend.env compose.env tag "$@"\nprintf 'running %s\\n' "\${OBSERVABILITY_RUNNING_SERVICES[*]}"`;
  const { status, stdout, stderr } = spawnSync("bash", ["-c", program, "bash", ...recreate], { encoding: "utf8" });
  assert.equal(status, 0, stderr);
  const lines = stdout.trim().split("\n");
  return { ups: lines.filter((line) => !line.startsWith("running ")).map((line) => line.split(" ")), running: lines.at(-1).split(" ").slice(1) };
}

test("backend 배포는 전용 probe를 없을 때 만들기만 하고 다시 만들지 않으며 public-edge-probe는 일반 up으로만 맞춘다 (#270)", () => {
  for (const recreate of [[], ["alertmanager"], ["alertmanager", "prometheus", "loki", "grafana", "alloy"]]) {
    const { ups, running } = runStartObservability(recreate);
    const withProbe = ups.filter((args) => args.includes(ORIGIN_SERVICE));
    assert.deepEqual(withProbe, [["--profile", "observability", "up", "-d", "--no-build", "--no-recreate", ORIGIN_SERVICE]], JSON.stringify(recreate));
    const forced = ups.filter((args) => args.includes("--force-recreate"));
    assert.deepEqual(forced.map((args) => args.slice(args.indexOf("--force-recreate") + 1)), recreate.length > 0 ? [recreate] : [], "재생성은 한 번의 호출로 모은다");
    assert.equal(ups.filter((args) => args.includes(PUBLIC_SERVICE) && !args.includes("--force-recreate") && !args.includes("--no-recreate")).length, 1);
    assert.ok(running.includes(ORIGIN_SERVICE) && running.includes(PUBLIC_SERVICE), "배포 완료 확인은 두 probe가 떠 있기를 요구한다");
  }
});

test("CI는 이 계약을 한 번 실행하고 compose와 같은 이미지로 blackbox 설정을 검사한다 (#270)", needsDocker, () => {
  const ci = read(".github/workflows/ci.yml");
  assert.equal(ci.split("node --test tools/platform/origin-certificate-expiry-probe.test.mjs").length - 1, 1);
  const { image } = composeServices([ORIGIN_SERVICE])[ORIGIN_SERVICE];
  assert.equal(ci.split(`${image} --config.file=/config/origin-certificate.yml --config.check`).length - 1, 1);
});

// 배포 게이트가 같은 집합을 돌린다는 점(하위 디렉터리 제외)은 deploy-observability-config.test.mjs의 PREVIEW 시험이 확인한다.
test("CI는 promtool로 infra/prometheus 바로 아래의 *.test.yml 전부를 glob 하나로 시험한다 (#270)", () => {
  const promtoolLines = read(".github/workflows/ci.yml").split("\n").filter((line) => /promtool .*test rules /u.test(line));
  assert.equal(promtoolLines.length, 1, "CI의 promtool test rules 단계는 하나다");
  const words = promtoolLines[0].trim().split(/\s+/u);
  assert.deepEqual(words.slice(words.indexOf("rules") + 1), ["infra/prometheus/*.test.yml"], "시험 파일을 나열하지 않고 glob 하나만 넘긴다");
});
