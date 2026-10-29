import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// platform#270: 원 서버 인증서 확인·갱신 workflow의 경계 계약. 이 workflow는 main에서만 돌아 병합 전에 실행해 볼 수 없다.
const workflow = readFileSync(new URL("../../.github/workflows/origin-certificate-renew.yml", import.meta.url), "utf8");
const template = readFileSync(new URL("../../infra/nginx/host-easysubway.conf.template", import.meta.url), "utf8");

function steps() {
  const body = workflow.slice(workflow.indexOf("    steps:\n") + "    steps:\n".length);
  return body.split(/\n(?=      - name: )/u).map((block) => ({
    name: block.match(/^ {6}- name: (.+)$/mu)[1],
    renewOnly: block.includes("        if: ${{ inputs.mode == 'RENEW' }}\n"),
    run: block,
  }));
}

// 인증서를 바꾸는 certbot 하위 명령(dry-run 제외)과 nginx 신호·재시작을 모두 상태 변경으로 본다.
const MUTATING = [
  /certbot\s+(renew|certonly|run|revoke|delete|install|enhance|reconfigure|update_symlinks)\b(?![^\n]*--dry-run)/u,
  /nginx\s+-s\s+\S+/u,
  /systemctl\s+(reload|restart|start|stop|try-restart|reload-or-restart)\s+nginx/u,
  /service\s+nginx\s+\S+/u,
];
const joined = (run) => run.replace(/\\\n\s*/gu, " ");

test("호스트 인증서나 nginx를 바꾸는 명령은 RENEW 전용 step에만 있다 (#270)", () => {
  const found = steps().filter((step) => MUTATING.some((pattern) => pattern.test(joined(step.run))));
  assert.deepEqual(found.map((step) => step.name), ["Origin certificate / Renew and reload nginx"]);
  for (const step of found) assert.ok(step.renewOnly, step.name);
  const check = steps().find((step) => step.name === "Origin certificate / Read current state");
  assert.equal(check.renewOnly, false);
  assert.match(check.run, /certbot renew --cert-name "\$\{CERT_NAME\}" --dry-run/u);
});

test("상태 변경 판정은 흔한 변형도 잡는다 (#270)", () => {
  for (const line of ['certbot renew --cert-name "${CERT_NAME}" --no-random-sleep-on-renew || true', "certbot renew \\\n  --force-renewal", "certbot certonly -d x", "systemctl restart nginx", "nginx -s reopen", "service nginx reload"]) {
    assert.ok(MUTATING.some((pattern) => pattern.test(joined(line))), line);
  }
  for (const line of ['certbot certificates --cert-name "${CERT_NAME}"', 'certbot renew --cert-name "${CERT_NAME}" --dry-run --no-random-sleep-on-renew', "nginx -t", "systemctl is-active certbot.timer"]) {
    assert.ok(!MUTATING.some((pattern) => pattern.test(joined(line))), line);
  }
});

test("영수증 검증기가 run 기록을 읽을 권한을 선언하고, 공개 health 호스트가 인증서 이름과 같다 (#270)", () => {
  assert.match(workflow, /^permissions:\n  contents: read\n(?:  #.*\n)?  actions: read\n/mu);
  const cert = workflow.match(/^ {6}CERT_NAME: (\S+)$/mu)[1];
  const url = workflow.match(/^ {6}PUBLIC_HEALTH_URL: (\S+)$/mu)[1];
  assert.equal(new URL(url).host, cert);
});

test("검증 step도 RENEW 전용이고 갱신 step 뒤에 있다 (#270)", () => {
  const names = steps().map((step) => step.name);
  const renew = names.indexOf("Origin certificate / Renew and reload nginx");
  const verify = names.indexOf("Origin certificate / Verify served certificate and public readiness");
  assert.ok(renew !== -1 && verify === renew + 1);
  assert.ok(steps()[verify].renewOnly);
});

test("공개 health 주소는 호스트 nginx가 백엔드로 넘기는 정확 일치 경로다 (#270)", () => {
  const url = workflow.match(/^ {6}PUBLIC_HEALTH_URL: (\S+)$/mu)[1];
  const path = new URL(url).pathname;
  const exact = [...template.matchAll(/^\s*location = (\S+) \{\n([\s\S]*?)\n\s*\}/gmu)]
    .filter(([, , body]) => body.includes("proxy_pass"))
    .map(([, location]) => location);
  assert.ok(exact.includes(path), `${path} not in ${exact.join(", ")}`);
});

test("RENEW가 아닌 step의 sudo 명령은 CHECK의 허용 목록뿐이고, 영수증 검증이 모든 sudo보다 먼저다 (#270)", () => {
  const allowed = [/^certbot certificates\b/u, /^certbot renew\b.*--dry-run\b/u, /^journalctl\b/u];
  const all = steps();
  for (const step of all.filter((candidate) => !candidate.renewOnly)) {
    for (const [, command] of joined(step.run).matchAll(/sudo --non-interactive (.+)$/gmu)) {
      assert.equal(step.name, "Origin certificate / Read current state", `${step.name}: ${command}`);
      assert.ok(allowed.some((pattern) => pattern.test(command)), command);
    }
    assert.doesNotMatch(joined(step.run).replace(/sudo --non-interactive /gu, ""), /^\s*(sudo|su|pkexec|doas)\b/mu, step.name);
  }
  const admission = all.findIndex((step) => step.name === "Verify production-deploy admission");
  const firstSudo = all.findIndex((step) => step.run.includes("sudo "));
  assert.ok(admission !== -1 && admission < firstSudo);
});

test("RENEW에서는 dry-run을 하지 않는다 (#270)", () => {
  const check = steps().find((step) => step.name === "Origin certificate / Read current state");
  assert.match(check.run, /if \[\[ "\$\{MODE\}" == "CHECK" \]\]; then\n[^\n]*\n\s*timeout 120 sudo --non-interactive certbot renew --cert-name "\$\{CERT_NAME\}" --dry-run/u);
});
