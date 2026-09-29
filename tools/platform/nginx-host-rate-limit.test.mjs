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
