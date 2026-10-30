import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scrapeJobSettings, scrapeTargetsByJob } from "./prometheus-scrape-config.mjs";

// platform#270: 원 서버 인증서 만료 감시가 Cloudflare 엣지 인증서가 아니라 호스트 nginx 443의 인증서를 읽고,
// 운영 readiness를 보는 public-edge-probe와 설정·수명이 분리된다는 배선 계약.
// 알림 임계값은 infra/prometheus/alerts.test.yml의 promtool 테스트가, 서비스 호스트 불변식은
// tools/ci/origin-certificate-renew-workflow.test.mjs가 평가한다.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const blackbox = read("infra/blackbox/blackbox.yml");
const prometheus = read("infra/prometheus/prometheus.yml");
const compose = read("infra/docker-compose.yml");
const workflow = read(".github/workflows/origin-certificate-renew.yml");

const ORIGIN_JOB = "origin_certificate_probe";
const ORIGIN_SERVICE = "origin-certificate-probe";

const composeService = (name) => {
  const block = compose.split(new RegExp(`\\n  ${name}:\\n`, "u"))[1]?.split(/\n  [a-z-]+:\n|\n\S/u)[0];
  assert.ok(block, `compose service ${name}`);
  return block.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "" && !line.trimStart().startsWith("#"));
};
const blackboxModule = (name) => {
  const block = blackbox.split(new RegExp(`^  ${name}:\\n`, "mu"))[1]?.split(/^  \S/mu)[0];
  assert.ok(block, `blackbox module ${name}`);
  return block;
};
const blackboxModuleNames = [...blackbox.matchAll(/^ {2}([a-z0-9_]+):$/gmu)].map((match) => match[1]);

test("origin_certificate_probe는 공개 주소가 아니라 호스트 443을 전용 probe 서비스로 조사한다 (#270)", () => {
  const targets = scrapeTargetsByJob(prometheus).get(ORIGIN_JOB);
  assert.deepEqual(targets, ["host.docker.internal:443"]);
  const settings = scrapeJobSettings(prometheus).get(ORIGIN_JOB);
  assert.equal(settings.module, "origin_tls_expiry");
  assert.equal(settings.address, `${ORIGIN_SERVICE}:9115`);
});

test("전용 probe가 쓰는 module은 모두 마운트되는 blackbox 설정에 있다 (#270)", () => {
  // 마운트한 파일이 이미지 기본 설정을 대체하므로 빠진 module이 있으면 해당 probe가 400으로 죽는다.
  const served = [...scrapeJobSettings(prometheus)].filter(([, job]) => job.address === `${ORIGIN_SERVICE}:9115`);
  assert.ok(served.length > 0);
  for (const [name, job] of served) assert.ok(blackboxModuleNames.includes(job.module), `${name}: ${job.module} is not defined in infra/blackbox/blackbox.yml`);
});

test("origin_tls_expiry는 만료된 인증서도 읽도록 검증을 건너뛰고 인증서 이름 SNI로 TLS 핸드셰이크만 한다 (#270)", () => {
  const module = blackboxModule("origin_tls_expiry");
  assert.match(module, /^\s+prober: tcp$/mu);
  assert.match(module, /^\s+tls: true$/mu);
  assert.match(module, /^\s+insecure_skip_verify: true$/mu);
  const cert = workflow.match(/^ {2}CERT_NAME: (\S+)$/mu)[1];
  assert.equal(module.match(/^\s+server_name: (\S+)$/mu)[1], cert);
});

test("origin-certificate-probe 서비스는 blackbox 설정을 읽기 전용으로 마운트하고 host-gateway로 호스트에 닿는다 (#270)", () => {
  const service = composeService(ORIGIN_SERVICE).join("\n");
  const mount = service.match(/^ {6}- (\.\/blackbox\/blackbox\.yml):(\S+):ro$/mu);
  assert.ok(mount, "blackbox.yml read-only mount");
  assert.deepEqual(service.match(/^ {4}command:\n((?: {6}- .+\n?)+)/mu)[1].trim().split("\n").map((line) => line.trim()), [`- "--config.file=${mount[2]}"`]);
  assert.match(service, /^ {4}extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"$/mu);
  assert.match(service, /^ {4}profiles:\n {6}- observability$/mu);
  assert.match(service, /^ {4}restart: unless-stopped$/mu);
  const publicImage = composeService("public-edge-probe").find((line) => line.trimStart().startsWith("image: "));
  assert.ok(service.includes(publicImage.trim()), "두 probe는 같은 고정 이미지를 쓴다");
});

test("public-edge-probe 정의는 원 서버 인증서 감시와 무관하게 그대로다 (#270)", () => {
  assert.deepEqual(composeService("public-edge-probe"), [
    "    image: prom/blackbox-exporter:v0.28.0",
    "    container_name: easysubway-public-edge-probe",
    "    restart: unless-stopped",
    "    profiles:",
    "      - observability",
  ]);
});

test("backend 배포는 blackbox·compose 변경에서만 전용 probe를 다시 만들고 alerts 변경은 어떤 blackbox도 다시 만들지 않는다 (#270)", () => {
  const script = read("tools/deploy/deploy-backend.sh");
  const list = (name) => script.match(new RegExp(`^${name}=\\(([^)]*)\\)$`, "mu"))[1].split(/\s+/u);
  assert.ok(list("OBSERVABILITY_SERVICES").includes(ORIGIN_SERVICE));
  assert.deepEqual(list("OBSERVABILITY_CONFIG_SERVICES").filter((name) => name.endsWith("-probe")), []);
  const pathspec = (flag) => script.match(new RegExp(`${flag}=0\\nif [^\\n]*\\n[^\\n]*\\nelif ! git diff --quiet "\\$\\{current_sha\\}" "\\$\\{DEPLOY_SHA\\}" -- (.+); then`, "u"))[1].split(" ");
  assert.deepEqual(pathspec("recreate_origin_certificate_probe"), ["infra/blackbox", "infra/docker-compose.yml"]);
  assert.equal(pathspec("recreate_observability_config").includes("infra/blackbox"), false);
});

test("CI는 이 계약을 한 번 실행하고 compose와 같은 이미지로 blackbox 설정을 검사한다 (#270)", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.equal(ci.split("node --test tools/platform/origin-certificate-expiry-probe.test.mjs").length - 1, 1);
  const image = composeService(ORIGIN_SERVICE).find((line) => line.includes("image: ")).match(/image: (prom\/blackbox-exporter:v[\d.]+)/u)[1];
  assert.equal(ci.split(`${image} --config.file=/config/blackbox.yml --config.check`).length - 1, 1);
});
