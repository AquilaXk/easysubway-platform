import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// platform#270: 원 서버 인증서 만료 감시가 Cloudflare 엣지 인증서가 아니라 호스트 nginx 443의 인증서를 읽는다는 배선 계약.
// 알림 임계값 자체는 infra/prometheus/alerts.test.yml의 promtool 테스트가 평가 결과로 검증한다.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const blackbox = read("infra/blackbox/blackbox.yml");
const prometheus = read("infra/prometheus/prometheus.yml");
const compose = read("infra/docker-compose.yml");
const template = read("infra/nginx/host-easysubway.conf.template");
const workflow = read(".github/workflows/origin-certificate-renew.yml");

const section = (text, header, indent) => {
  const begin = text.indexOf(`\n${" ".repeat(indent)}${header}\n`);
  assert.notEqual(begin, -1, header);
  const rest = text.slice(begin + 1);
  const next = rest.slice(1).search(new RegExp(`\\n {0,${indent}}\\S`, "u"));
  return next === -1 ? rest : rest.slice(0, next + 1);
};

const blackboxModules = [...blackbox.matchAll(/^ {2}([a-z0-9_]+):$/gmu)].map((match) => match[1]);
const scrapeJob = (name) => section(prometheus, `- job_name: "${name}"`, 2);

test("prometheus의 모든 job이 쓰는 blackbox module이 마운트되는 설정에 있다 (#270)", () => {
  // 마운트한 파일이 이미지 기본 설정을 대체하므로 빠진 module이 있으면 해당 probe가 400으로 죽는다.
  const used = [...prometheus.matchAll(/^\s+module: \[([a-z0-9_]+)\]$/gmu)].map((match) => match[1]);
  assert.ok(used.includes("http_2xx") && used.includes("origin_tls_expiry"), used.join(","));
  for (const module of used) assert.ok(blackboxModules.includes(module), `${module} is not defined in infra/blackbox/blackbox.yml`);
});

test("origin_tls_expiry는 만료된 인증서도 읽도록 검증을 건너뛰고 서비스 호스트 SNI로 TLS 핸드셰이크만 한다 (#270)", () => {
  const module = section(blackbox, "origin_tls_expiry:", 2);
  assert.match(module, /^ {4}prober: tcp$/mu);
  assert.match(module, /^ {6}tls: true$/mu);
  assert.match(module, /^ {8}insecure_skip_verify: true$/mu);
  const cert = workflow.match(/^ {2}CERT_NAME: (\S+)$/mu)[1];
  assert.equal(module.match(/^ {8}server_name: (\S+)$/mu)[1], cert);
  const tlsServer = template.slice(template.lastIndexOf("listen 443"));
  assert.deepEqual(tlsServer.match(/server_name ([^;]+);/u)[1].trim().split(/\s+/u), [cert]);
});

test("origin_certificate_probe는 공개 주소가 아니라 호스트 443을 public-edge-probe로 조사한다 (#270)", () => {
  const job = scrapeJob("origin_certificate_probe");
  assert.match(job, /^ {4}params:\n {6}module: \[origin_tls_expiry\]$/mu);
  assert.deepEqual([...job.matchAll(/^ {10}- "([^"]+)"$/gmu)].map((match) => match[1]), ["host.docker.internal:443"]);
  assert.match(job, /^ {8}replacement: public-edge-probe:9115$/mu);
  assert.doesNotMatch(job, /aquilaxk\.site/u);
});

test("public-edge-probe는 blackbox 설정을 기본 경로에 마운트하고 host-gateway로 호스트에 닿는다 (#270)", () => {
  const service = section(compose, "public-edge-probe:", 2);
  assert.match(service, /^ {6}- \.\/blackbox\/blackbox\.yml:\/etc\/blackbox_exporter\/config\.yml:ro$/mu);
  assert.match(service, /^ {4}extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"$/mu);
});

test("nginx server_name과 인증서 lineage 이름은 하나뿐이다 (#270)", () => {
  // lineage가 다른 서비스의 이름까지 담으면 그 이름의 HTTP-01 실패가 갱신 전체를 멈춘다.
  const cert = workflow.match(/^ {2}CERT_NAME: (\S+)$/mu)[1];
  assert.equal(workflow.match(/^ {2}SERVED_HOSTS: (.+)$/mu)[1].trim(), cert);
  const names = [...template.matchAll(/^\s+server_name ([^;]+);$/gmu)].map((match) => match[1].trim());
  assert.ok(names.includes(cert));
  for (const name of names) assert.ok(name === cert || name === "_", name);
});

test("blackbox 설정이 바뀌면 backend 배포가 public-edge-probe를 다시 만든다 (#270)", () => {
  // 파일 단위 bind mount는 내용만 바뀌면 컨테이너가 재생성되지 않는다.
  const script = read("tools/deploy/deploy-backend.sh");
  assert.match(script, /^OBSERVABILITY_CONFIG_SERVICES=\(public-edge-probe /mu);
  assert.match(script, /git diff --quiet "\$\{current_sha\}" "\$\{DEPLOY_SHA\}" -- infra\/blackbox /u);
});

test("CI는 이 계약을 한 번 실행하고 compose와 같은 이미지로 blackbox 설정을 검사한다 (#270)", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.equal(ci.split("node --test tools/platform/origin-certificate-expiry-probe.test.mjs").length - 1, 1);
  const image = compose.match(/image: (prom\/blackbox-exporter:v[\d.]+)/u)[1];
  assert.equal(ci.split(`${image} --config.file=/config/blackbox.yml --config.check`).length - 1, 1);
});
