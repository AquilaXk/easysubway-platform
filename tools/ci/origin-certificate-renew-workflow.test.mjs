import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("job은 check와 renew 둘이고 각자 자기 모드에서만, 서로 기대지 않고 돈다 (#270)", () => {
  assert.deepEqual(jobNames, ["check", "renew"]);
  assert.match(job("check"), /^ {4}if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1 && github\.triggering_actor == 'AquilaXk' && inputs\.mode == 'CHECK'\n/mu);
  assert.doesNotMatch(workflow, /^ {4}needs:/mu);
  const renew = job("renew");
  assert.match(renew, /^ {4}if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1 && github\.triggering_actor == 'AquilaXk' && inputs\.mode == 'RENEW'\n/mu);
  assert.doesNotMatch(renew, /always\(\)|failure\(\)|cancelled\(\)|continue-on-error/u);
});

test("check job의 sudo는 디스크 인증서 목록을 읽는 한 줄뿐이고 상태를 바꾸는 명령이 없다 (#270)", () => {
  const check = job("check");
  const allowed = [...check.matchAll(/"\$\(timeout 60 sudo --non-interactive certbot certificates --cert-name "\$\{CERT_NAME\}" 2>&1\)" \|\| rc=\$\?\n/gu)];
  assert.equal(allowed.length, 1);
  assert.equal(sudoTokens(check), allowed.length);
  assert.doesNotMatch(check.replace(/certbot certificates --cert-name/gu, ""), /\bcertbot\s+\w|\bnginx\s+-|\bsystemctl\s+(?:reload|restart|try-restart|reload-or-restart|start|stop|enable|disable|mask)\b|(?:^|[\s;|&(])service\s+\S+\s+(?:start|stop|restart|reload|force-reload|try-restart)\b|\bkill\b|\bjournalctl\b|\b(?:su|pkexec|doas)\b/u);
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
    assert.ok(admission !== -1 && admission < steps.search(/\bsudo\b/u), name);
    const admissionStep = steps.slice(admission, steps.indexOf("\n      - name:", admission + 1));
    assert.match(admissionStep, /set -euo pipefail\n\s*node tools\/platform\/verify-production-deploy-effective-admission-receipt\.mjs \\\n/u, name);
    assert.match(body, /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n(?! {6})/mu, name);
    assert.doesNotMatch(body, /continue-on-error/u, name);
  }
});

test("공개 로그에 원 서버 주소가 찍힐 수 있는 certbot·journal 출력을 남기지 않는다 (#270)", () => {
  assert.doesNotMatch(workflow, /journalctl|--dry-run/u);
  assert.match(job("renew"), /certbot renew [^\n]*--quiet >\/dev\/null 2>&1 \|\| rc=\$\?\n/u);
  // check는 certbot certificates 출력 중 만료 줄만 남긴다.
  assert.doesNotMatch(job("check"), /echo "\$\{lineage\}"\s*$/mu);
  assert.match(job("check"), /expiry="\$\(echo "\$\{lineage\}" \| grep -E '\^\\s\*Expiry Date:' \| sed /u);
});

test("권한은 workflow 수준에서 비우고 job마다 필요한 만큼만 선언한다 (#270)", () => {
  assert.match(workflow, /^permissions: \{\}\n/mu);
});

test("renew의 바꾸는 step과 검증 step은 errexit로 돌고 검증은 SERVED_HOSTS 전체를 돈다 (#270)", () => {
  const renew = job("renew");
  for (const name of ["Origin certificate / Renew and reload nginx", "Origin certificate / Verify served certificate and public readiness"]) {
    const at = renew.indexOf(`      - name: ${name}\n`);
    assert.ok(at !== -1, name);
    const end = renew.indexOf("\n      - name:", at + 1);
    assert.match(renew.slice(at, end === -1 ? undefined : end), /run: \|\n\s*set -euo pipefail\n/u, name);
  }
  assert.match(renew, /for host in \$\{SERVED_HOSTS\}; do\n/u);
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

test("check는 concurrency group 밖에 있고 renew만 group에 있다 (#270)", () => {
  // check를 group에 넣으면 대기 중인 긴급 renew가 나중 dispatch에 밀려 취소된다.
  assert.doesNotMatch(job("check"), /^ {4}concurrency:/mu);
  assert.match(job("renew"), /^ {4}concurrency:\n {6}group: origin-certificate-production\n/mu);
  assert.doesNotMatch(job("check"), /systemctl|renewal-hooks/u);
});

// check step을 대역 sudo·openssl·timeout으로 실제 실행해 종료 코드와 출력을 본다.
function checkScript() {
  const check = job("check");
  const at = check.indexOf("      - name: Origin certificate / Judge served and on-disk expiry\n");
  const body = check.slice(check.indexOf("        run: |\n", at) + "        run: |\n".length);
  return body.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
}

const STUBS = {
  timeout: '#!/bin/bash\nshift\nexec "$@"\n',
  sudo: '#!/bin/bash\n[[ "$*" == "--non-interactive certbot certificates --cert-name ${CERT_NAME}" ]] || exit 99\nprintf "%b" "${STUB_LINEAGE}"\nprintf "%b" "${STUB_LEAK:-}" >&2\nexit "${STUB_LINEAGE_RC}"\n',
  openssl: [
    "#!/bin/bash",
    'if [[ "$1" == s_client ]]; then [[ "${STUB_SERVED}" == 1 ]] && echo "PEM ${@: -1}"; exit 0; fi',
    'input="$(cat)"; [[ -n "${input}" ]] || exit 1',
    'bad() { [[ -n "${STUB_BAD_HOST:-}" && "${input}" == "PEM ${STUB_BAD_HOST}" ]]; }',
    'case " $* " in',
    '  *" -checkend "*) [[ " $* " == *" -checkend 1209600 "* ]] || exit 98; bad && [[ "${STUB_BAD}" == expiry ]] && exit 1; exit 0 ;;',
    '  *" -checkhost "*) if bad && [[ "${STUB_BAD}" == name ]]; then echo "Hostname ${@: -1} does NOT match certificate"; else echo "Hostname ${@: -1} does match certificate"; fi ;;',
    '  *" -enddate "*) echo "notAfter=Jan 1 00:00:00 2027 GMT" ;;',
    '  *) echo "${input}" ;;',
    "esac",
    "",
  ].join("\n"),
};

function runCheck(overrides) {
  const dir = mkdtempSync(join(tmpdir(), "origin-cert-check-"));
  try {
    for (const [name, text] of Object.entries(STUBS)) {
      writeFileSync(join(dir, name), text);
      chmodSync(join(dir, name), 0o755);
    }
    const env = {
      PATH: `${dir}:${process.env.PATH}`,
      CERT_NAME: "a.example",
      SERVED_HOSTS: "a.example b.example",
      STUB_SERVED: "1",
      STUB_BAD_HOST: "",
      STUB_BAD: "",
      STUB_LINEAGE: "  Certificate Name: a.example\\n    Domains: a.example b.example\\n    Expiry Date: 2027-01-01 00:00:00+00:00 (VALID: 62 days)\\n",
      STUB_LINEAGE_RC: "0",
      ...overrides,
    };
    // GitHub은 `shell: bash` step을 `bash --noprofile --norc -eo pipefail`로 돌린다.
    return spawnSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", checkScript()], { encoding: "utf8", env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("check 실행: 건강하면 통과하고 만료·불일치·읽기 실패·만료 줄 없음·INVALID는 실패한다 (#270)", () => {
  const healthy = runCheck({});
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.equal((healthy.stdout.match(/^on-disk /gmu) ?? []).length, 1);
  assert.match(healthy.stdout, /^on-disk Expiry Date: 2027-01-01/mu);
  assert.doesNotMatch(healthy.stdout + healthy.stderr, /Domains|Certificate Name/u);
  const cases = {
    "first host expiring": [{ STUB_BAD_HOST: "a.example", STUB_BAD: "expiry" }, /^a\.example: served certificate is expired or expires within 14 days \(RENEW needed\)$/mu],
    "second host expiring": [{ STUB_BAD_HOST: "b.example", STUB_BAD: "expiry" }, /^b\.example: served certificate is expired or expires within 14 days/mu],
    "first host mismatch": [{ STUB_BAD_HOST: "a.example", STUB_BAD: "name" }, /^a\.example: served certificate does not name this host \(check the nginx server block and lineage domains\)$/mu],
    "second host mismatch": [{ STUB_BAD_HOST: "b.example", STUB_BAD: "name" }, /^b\.example: served certificate does not name this host \(check the nginx server block and lineage domains\)$/mu],
    "nothing served": [{ STUB_SERVED: "0" }, /a\.example: no certificate read/u],
    "lineage read failed": [{ STUB_LINEAGE: "secret 203.0.113.9 detail\\n", STUB_LEAK: "secret 203.0.113.9 stderr\\n", STUB_LINEAGE_RC: "1" }, /on-disk lineage could not be read \(exit 1\)/u],
    "no lineage": [{ STUB_LINEAGE: "No certificates found.\\n" }, /on-disk lineage has no expiry line/u],
    "invalid lineage": [{ STUB_LINEAGE: "    Expiry Date: 2026-10-26 13:24:00+00:00 (INVALID: EXPIRED)\\n" }, /^on-disk certificate is not marked valid \(check the lineage on the host\)$/mu],
    "reworded lineage": [{ STUB_LINEAGE: "    Expiry Date: 2026-10-26 13:24:00+00:00 (EXPIRED)\\n" }, /on-disk certificate is not marked valid/u],
    "lineage exits 124": [{ STUB_LINEAGE: "", STUB_LINEAGE_RC: "124" }, /could not be read \(exit 124\)/u],
  };
  for (const [name, [env, line]] of Object.entries(cases)) {
    const run = runCheck(env);
    assert.equal(run.status, 1, name);
    // RENEW로 고쳐지는 만료만 RENEW를 권한다.
    if (!/expiring/u.test(name)) assert.doesNotMatch(run.stdout, /RENEW needed/u, name);
    assert.match(run.stdout, line, name);
    assert.doesNotMatch(run.stdout + run.stderr, /203\.0\.113\.9|No certificates found/u, name);
  }
});
