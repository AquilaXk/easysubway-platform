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

test("호스트 인증서나 nginx를 바꾸는 명령은 RENEW 전용 step에만 있다 (#270)", () => {
  const mutating = /certbot renew --cert-name "\$\{CERT_NAME\}" --no-random-sleep-on-renew\n|nginx -s reload/u;
  const found = steps().filter((step) => mutating.test(step.run.replace(/--dry-run --no-random-sleep-on-renew/gu, "")));
  assert.deepEqual(found.map((step) => step.name), ["Origin certificate / Renew and reload nginx"]);
  for (const step of found) assert.ok(step.renewOnly, step.name);
  const check = steps().find((step) => step.name === "Origin certificate / Read current state");
  assert.equal(check.renewOnly, false);
  assert.match(check.run, /--dry-run/u);
  assert.doesNotMatch(check.run.replace(/certbot renew --cert-name "\$\{CERT_NAME\}" --dry-run/gu, ""), /certbot renew|nginx -s reload|nginx -t/u);
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
