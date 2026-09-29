import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

function extractLocations(text) {
  const locations = new Map();
  const locRegex = /location\s+([^{]+)\s*\{/g;
  let match;
  while ((match = locRegex.exec(text)) !== null) {
    const matcher = match[1].trim();
    const startIndex = match.index + match[0].length;
    let depth = 1;
    let endIndex = startIndex;
    while (endIndex < text.length && depth > 0) {
      if (text[endIndex] === "{") depth++;
      else if (text[endIndex] === "}") depth--;
      endIndex++;
    }
    const body = text.substring(startIndex, endIndex - 1);
    locations.set(matcher, body);
  }
  return locations;
}

const templatePath = new URL("../../infra/nginx/host-easysubway.conf.template", import.meta.url);
const defaultProxyPath = new URL("../../infra/nginx/host-default-proxy.conf", import.meta.url);
const realIpPath = new URL("../../infra/nginx/host-real-ip.conf", import.meta.url);

test("host nginx 요청·연결 제한 및 real IP 설정 정적 검증", () => {
  const template = readFileSync(templatePath, "utf8");
  const defaultProxy = readFileSync(defaultProxyPath, "utf8");
  const realIp = existsSync(realIpPath) ? readFileSync(realIpPath, "utf8") : "";

  // 1. 파일 맨 앞 영역(첫 server { 전)에 zone 정의 확인
  const firstServerIndex = template.indexOf("server {");
  assert.ok(firstServerIndex !== -1, "server 블록이 있어야 한다");
  const headerArea = template.substring(0, firstServerIndex);

  assert.match(
    headerArea,
    /limit_req_zone\s+\$binary_remote_addr\s+zone=easysubway_journey:10m\s+rate=5r\/s;/,
    "easysubway_journey zone 정의가 있어야 한다"
  );
  assert.match(
    headerArea,
    /limit_req_zone\s+\$binary_remote_addr\s+zone=easysubway_upload:10m\s+rate=2r\/s;/,
    "easysubway_upload zone 정의가 있어야 한다"
  );
  assert.match(
    headerArea,
    /limit_req_zone\s+\$binary_remote_addr\s+zone=easysubway_api:10m\s+rate=30r\/s;/,
    "easysubway_api zone 정의가 있어야 한다"
  );
  assert.match(
    headerArea,
    /limit_conn_zone\s+\$binary_remote_addr\s+zone=easysubway_conn:10m;/,
    "easysubway_conn zone 정의가 있어야 한다"
  );

  // 2. 443 서버 블록 파싱
  const mainServerStart = template.indexOf("server_name easysubway-api.aquilaxk.site");
  assert.ok(mainServerStart !== -1, "443 메인 서버 블록이 있어야 한다");
  const mainServerBlock = template.substring(mainServerStart);

  assert.match(
    mainServerBlock,
    /include\s+\/etc\/nginx\/snippets\/easysubway-real-ip\.conf;/,
    "443 서버 블록에 easysubway-real-ip.conf include가 있어야 한다"
  );
  assert.match(mainServerBlock, /limit_req_status\s+429;/, "limit_req_status 429 설정이 있어야 한다");
  assert.match(mainServerBlock, /limit_conn_status\s+429;/, "limit_conn_status 429 설정이 있어야 한다");
  assert.match(
    mainServerBlock,
    /error_page\s+429\s+=\s+@easysubway_rate_limited;/,
    "429 error_page 지정이 있어야 한다"
  );

  // 3. location 블록 추출 및 검증
  const locations = extractLocations(mainServerBlock);

  // ^~ /api/v3/journeys/
  const journeyLoc = locations.get("^~ /api/v3/journeys/");
  assert.ok(journeyLoc, "^~ /api/v3/journeys/ location이 있어야 한다");
  assert.match(
    journeyLoc,
    /limit_req\s+zone=easysubway_journey\s+burst=20\s+nodelay;/,
    "journey location에 limit_req 설정이 있어야 한다"
  );
  assert.match(
    journeyLoc,
    /limit_conn\s+easysubway_conn\s+50;/,
    "journey location에 limit_conn 설정이 있어야 한다"
  );

  // ^~ /api/v1/report-uploads
  const uploadLoc = locations.get("^~ /api/v1/report-uploads");
  assert.ok(uploadLoc, "^~ /api/v1/report-uploads location이 있어야 한다");
  assert.match(
    uploadLoc,
    /limit_req\s+zone=easysubway_upload\s+burst=10\s+nodelay;/,
    "report-uploads location에 limit_req 설정이 있어야 한다"
  );
  assert.match(
    uploadLoc,
    /limit_conn\s+easysubway_conn\s+50;/,
    "report-uploads location에 limit_conn 설정이 있어야 한다"
  );

  // ^~ /api/v1/reports
  const reportLoc = locations.get("^~ /api/v1/reports");
  assert.ok(reportLoc, "^~ /api/v1/reports location이 있어야 한다");
  assert.match(
    reportLoc,
    /limit_req\s+zone=easysubway_upload\s+burst=10\s+nodelay;/,
    "reports location에 limit_req 설정이 있어야 한다"
  );
  assert.match(
    reportLoc,
    /limit_conn\s+easysubway_conn\s+50;/,
    "reports location에 limit_conn 설정이 있어야 한다"
  );

  // /
  const rootLoc = locations.get("/");
  assert.ok(rootLoc, "/ location이 있어야 한다");
  assert.match(
    rootLoc,
    /limit_req\s+zone=easysubway_api\s+burst=60\s+nodelay;/,
    "/ location에 limit_req 설정이 있어야 한다"
  );
  assert.match(
    rootLoc,
    /limit_conn\s+easysubway_conn\s+50;/,
    "/ location에 limit_conn 설정이 있어야 한다"
  );

  // probe locations: limit_req / limit_conn 없어야 함
  const readinessLoc = locations.get("= /actuator/health/readiness");
  assert.ok(readinessLoc, "= /actuator/health/readiness location이 있어야 한다");
  assert.equal(/limit_req/.test(readinessLoc), false, "readiness probe에는 limit_req가 없어야 한다");
  assert.equal(/limit_conn/.test(readinessLoc), false, "readiness probe에는 limit_conn이 없어야 한다");

  const livenessLoc = locations.get("= /actuator/health/liveness");
  assert.ok(livenessLoc, "= /actuator/health/liveness location이 있어야 한다");
  assert.equal(/limit_req/.test(livenessLoc), false, "liveness probe에는 limit_req가 없어야 한다");
  assert.equal(/limit_conn/.test(livenessLoc), false, "liveness probe에는 limit_conn이 없어야 한다");

  // @easysubway_rate_limited named location
  const rateLimitedLoc = locations.get("@easysubway_rate_limited");
  assert.ok(rateLimitedLoc, "@easysubway_rate_limited location이 있어야 한다");
  assert.match(rateLimitedLoc, /add_header\s+Retry-After\s+1\s+always;/, "Retry-After 헤더가 있어야 한다");
  assert.match(rateLimitedLoc, /default_type\s+application\/json;/, "application/json default_type이어야 한다");
  assert.match(rateLimitedLoc, /return\s+429\s+'\{"code":"RATE_LIMITED"\}';/, "429 반환 본문이 있어야 한다");

  // 4. snippet 검증
  assert.equal(/set_real_ip_from/.test(defaultProxy), false, "host-default-proxy.conf에 set_real_ip_from이 없어야 한다");
  assert.match(realIp, /real_ip_header\s+CF-Connecting-IP;/, "host-real-ip.conf에 real_ip_header CF-Connecting-IP가 있어야 한다");

  // 5. 증거 토큰
  assert.match(template, /\/actuator\/health\/readiness/);
  assert.match(template, /proxy_pass\s+http:\/\/127\.0\.0\.1:__BACKEND_PORT__;/);
});

function extractServerBlocks(text) {
  const servers = [];
  const serverRegex = /\bserver\s*\{/g;
  let match;
  while ((match = serverRegex.exec(text)) !== null) {
    const startIndex = match.index;
    let depth = 0;
    let endIndex = startIndex;
    for (let i = startIndex; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
    servers.push(text.substring(startIndex, endIndex));
  }
  return servers;
}

test("(1) 세 가상 호스트 모두 조건부 access_log가 있고 무조건 access_log는 없다", () => {
  const template = readFileSync(templatePath, "utf8");
  const serverBlocks = extractServerBlocks(template);
  assert.equal(serverBlocks.length, 3, "세 가상 호스트(포트 80, 443 기본, 443 메인)가 있어야 한다");

  for (let i = 0; i < serverBlocks.length; i++) {
    const block = serverBlocks[i];
    assert.match(
      block,
      /access_log\s+\/var\/log\/nginx\/easysubway-edge\.log\s+easysubway_edge_json\s+if=\$easysubway_edge_loggable;/,
      `가상 호스트 #${i + 1}에 조건부 access_log가 있어야 한다`
    );
    const withoutConditionalLog = block.replace(/access_log\s+[^;]*if=\$easysubway_edge_loggable;/g, "");
    assert.doesNotMatch(
      withoutConditionalLog,
      /\baccess_log\b/,
      `가상 호스트 #${i + 1}에 무조건 access_log(또는 access_log off)가 없어야 한다`
    );
  }
});

test("(2) map이 429와 500·503은 1, 200·404는 0이다", () => {
  const template = readFileSync(templatePath, "utf8");
  const mapRegex = /map\s+\$status\s+\$easysubway_edge_loggable\s*\{([^}]+)\}/;
  const match = mapRegex.exec(template);
  assert.ok(match, "map $status $easysubway_edge_loggable 정의가 있어야 한다");

  const mapBody = match[1];
  const entries = mapBody
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean);

  let defaultValue = "0";
  const rules = [];

  for (const entry of entries) {
    const parts = entry.split(/\s+/);
    if (parts[0] === "default") {
      defaultValue = parts[1];
    } else if (parts.length >= 2) {
      rules.push({ pattern: parts[0].replace(/^["']|["']$/g, ""), value: parts[1] });
    }
  }

  function resolveStatus(status) {
    const statusStr = String(status);
    for (const rule of rules) {
      if (rule.pattern.startsWith("~")) {
        const regexStr = rule.pattern.substring(1);
        const re = new RegExp(regexStr);
        if (re.test(statusStr)) return rule.value;
      } else if (rule.pattern === statusStr) {
        return rule.value;
      }
    }
    return defaultValue;
  }

  assert.equal(resolveStatus(429), "1", "429는 1이어야 한다");
  assert.equal(resolveStatus(500), "1", "500은 1이어야 한다");
  assert.equal(resolveStatus(503), "1", "503은 1이어야 한다");
  assert.equal(resolveStatus(200), "0", "200은 0이어야 한다");
  assert.equal(resolveStatus(404), "0", "404는 0이어야 한다");
});

test("(3) 로그 형식에 $args·$request_uri·$http_ 변수가 없다", () => {
  const template = readFileSync(templatePath, "utf8");
  const logFormatRegex = /log_format\s+easysubway_edge_json\s+(?:escape=json\s+)?([\s\S]*?);/;
  const match = logFormatRegex.exec(template);
  assert.ok(match, "log_format easysubway_edge_json 정의가 있어야 한다");

  const formatStr = match[1];
  assert.doesNotMatch(formatStr, /\$args\b/, "쿼리 파라미터 $args는 제외되어야 한다");
  assert.doesNotMatch(formatStr, /\$request_uri\b/, "쿼리를 포함하는 $request_uri는 제외되어야 한다");
  assert.doesNotMatch(formatStr, /\$http_/, "헤더 정보를 담는 $http_*는 제외되어야 한다");

  assert.match(formatStr, /\$remote_addr\b/, "$remote_addr가 포함되어야 한다");
  assert.match(formatStr, /\$status\b/, "$status가 포함되어야 한다");
  assert.match(formatStr, /\$request_method\b/, "$request_method가 포함되어야 한다");
  assert.match(formatStr, /\$uri\b/, "$uri(쿼리 제외 경로)가 포함되어야 한다");
  assert.match(formatStr, /\$request_time\b/, "$request_time이 포함되어야 한다");
  assert.match(formatStr, /\$(?:time_iso8601|time_local)\b/, "시각 변수가 포함되어야 한다");
  assert.match(formatStr, /\$easysubway_edge_location|\$easysubway_zone/, "location/zone 식별자 변수가 포함되어야 한다");
});

test("(4) real-ip 목록이 IPv4 15개와 IPv6 7개의 고정 기대 목록과 정확히 같다", () => {
  const realIp = existsSync(realIpPath) ? readFileSync(realIpPath, "utf8") : "";
  const ipMatches = [...realIp.matchAll(/set_real_ip_from\s+([^;]+);/g)].map((m) => m[1].trim());

  const expectedIpv4 = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ];

  const expectedIpv6 = [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ];

  const actualIpv4 = ipMatches.filter((ip) => ip.includes("."));
  const actualIpv6 = ipMatches.filter((ip) => ip.includes(":"));

  assert.deepEqual(actualIpv4, expectedIpv4, "Cloudflare IPv4 15개 대역이 기대값과 일치해야 한다");
  assert.deepEqual(actualIpv6, expectedIpv6, "Cloudflare IPv6 7개 대역이 기대값과 일치해야 한다");
  assert.equal(ipMatches.length, 22, "전체 real_ip_from 항목은 정확히 22개(15+7)여야 한다");
});

test("(5) real_ip_header CF-Connecting-IP가 유지된다", () => {
  const realIp = existsSync(realIpPath) ? readFileSync(realIpPath, "utf8") : "";
  assert.match(realIp, /real_ip_header\s+CF-Connecting-IP;/, "real_ip_header CF-Connecting-IP가 유지되어야 한다");
  assert.match(realIp, /real_ip_recursive\s+on;/, "real_ip_recursive on이 유지되어야 한다");
});
