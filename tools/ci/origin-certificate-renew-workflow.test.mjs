import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// platform#270: 원 서버 인증서 확인·갱신 workflow의 경계 계약. 이 workflow는 main에서만 돌아 병합 전에 실행해 볼 수 없다.
// CHECK가 아무것도 바꾸지 않는다는 성질은 step 조건이 아니라 job 분리로 지킨다. check job은 읽기만, renew job만 바꾼다.
const workflow = readFileSync(new URL("../../.github/workflows/origin-certificate-renew.yml", import.meta.url), "utf8");
const template = readFileSync(new URL("../../infra/nginx/host-easysubway.conf.template", import.meta.url), "utf8");

function job(name) {
  const begin = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(begin, -1, name);
  const rest = workflow.slice(begin + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const jobNames = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^  ([A-Za-z0-9_-]+):\n/gmu)].map((match) => match[1]);
const sudoTokens = (text) => [...text.matchAll(/\bsudo\b/gu)].length;

test("job은 check와 renew 둘이고 renew는 check 뒤 RENEW에서만 돈다 (#270)", () => {
  assert.deepEqual(jobNames, ["check", "renew"]);
  const renew = job("renew");
  assert.match(renew, /^ {4}needs: check\n/mu);
  assert.match(renew, /^ {4}if: inputs\.mode == 'RENEW'\n/mu);
  assert.doesNotMatch(renew, /always\(\)|failure\(\)|cancelled\(\)|continue-on-error/u);
});

test("check job의 sudo는 디스크 인증서 만료를 읽는 한 줄뿐이고 상태를 바꾸는 명령이 없다 (#270)", () => {
  const check = job("check");
  const allowed = [...check.matchAll(/sudo --non-interactive openssl x509 -noout -enddate -in "\/etc\/letsencrypt\/live\/\$\{CERT_NAME\}\/cert\.pem" 2>&1\)"; then\n/gu)];
  assert.equal(allowed.length, 1);
  assert.equal(sudoTokens(check), allowed.length);
  assert.doesNotMatch(check, /\bcertbot\s+\w|\bnginx\s+-|\bsystemctl\s+(?:reload|restart|start|stop|enable|disable|mask)\b|\bservice\s+\S+\s+\S+|\bkill\b|\bjournalctl\b/u);
});

test("상태를 바꾸는 명령은 renew job에만 있고 그 순서는 갱신, 설정 검사, reload다 (#270)", () => {
  const renew = job("renew");
  const certbot = renew.indexOf('sudo --non-interactive certbot renew --cert-name "${CERT_NAME}" --no-random-sleep-on-renew --quiet');
  const configTest = renew.indexOf("sudo --non-interactive nginx -t\n");
  const reload = renew.indexOf("sudo --non-interactive nginx -s reload\n");
  assert.ok(certbot !== -1 && certbot < configTest && configTest < reload);
  assert.equal(sudoTokens(renew), 3);
  assert.doesNotMatch(renew, /--dry-run|--force-renewal|certonly/u);
});

test("두 job 모두 실행자 게이트와 영수증 검증을 모든 sudo보다 먼저 한다 (#270)", () => {
  for (const name of jobNames) {
    const body = job(name);
    const steps = body.slice(body.indexOf("    steps:\n"));
    assert.ok(steps.startsWith("    steps:\n      - name: Require an authorized dispatcher\n"), name);
    const admission = steps.indexOf("      - name: Verify production-deploy admission\n");
    assert.ok(admission !== -1 && admission < steps.indexOf("sudo "), name);
    assert.doesNotMatch(body, /continue-on-error/u, name);
  }
});

test("공개 로그에 원 서버 주소가 찍힐 수 있는 certbot·journal 출력을 남기지 않는다 (#270)", () => {
  assert.doesNotMatch(workflow, /journalctl|--dry-run/u);
  assert.match(job("renew"), /certbot renew [^\n]*--quiet >\/dev\/null 2>&1; then\n/u);
});

test("영수증 검증기가 run 기록을 읽을 권한을 선언한다 (#270)", () => {
  assert.match(workflow, /^permissions:\n  contents: read\n(?:  #.*\n)?  actions: read\n/mu);
});

test("공개 health 주소와 서비스 호스트는 nginx 템플릿과 인증서 이름에 맞는다 (#270)", () => {
  const cert = workflow.match(/^ {2}CERT_NAME: (\S+)$/mu)[1];
  const url = new URL(workflow.match(/^ {2}PUBLIC_HEALTH_URL: (\S+)$/mu)[1]);
  assert.equal(url.host, cert);
  const exact = [...template.matchAll(/^\s*location = (\S+) \{\n([\s\S]*?)\n\s*\}/gmu)]
    .filter(([, , body]) => body.includes("proxy_pass"))
    .map(([, location]) => location);
  assert.ok(exact.includes(url.pathname), `${url.pathname} not in ${exact.join(", ")}`);
  const tlsServer = template.slice(template.lastIndexOf("listen 443"));
  const serverNames = tlsServer.match(/server_name ([^;]+);/u)[1].trim().split(/\s+/u);
  const hosts = workflow.match(/^ {2}SERVED_HOSTS: (.+)$/mu)[1].trim().split(/\s+/u);
  assert.deepEqual(hosts, serverNames);
  assert.equal(hosts[0], cert);
});
