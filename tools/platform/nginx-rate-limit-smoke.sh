#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CONTAINER_NAME="es-nginx-smoke"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

mkdir -p "${TEMP_DIR}/snippets" "${TEMP_DIR}/conf.d" "${TEMP_DIR}/certs"

# 자체 서명 인증서 생성
openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
  -keyout "${TEMP_DIR}/certs/privkey.pem" \
  -out "${TEMP_DIR}/certs/fullchain.pem" \
  -subj "/CN=easysubway-api.aquilaxk.site" >/dev/null 2>&1

# snippets 복사
cp "${REPO_ROOT}/infra/nginx/host-real-ip.conf" "${TEMP_DIR}/snippets/easysubway-real-ip.conf"
cp "${REPO_ROOT}/infra/nginx/host-default-proxy.conf" "${TEMP_DIR}/snippets/easysubway-default-proxy.conf"

# Nginx 템플릿 치환 및 stub backend 서버 추가
sed 's/__BACKEND_PORT__/18080/g' "${REPO_ROOT}/infra/nginx/host-easysubway.conf.template" > "${TEMP_DIR}/conf.d/easysubway.conf"

cat << 'EOF' >> "${TEMP_DIR}/conf.d/easysubway.conf"

server {
    listen 18080;
    location / {
        default_type application/json;
        return 200 '{"status":"UP"}';
    }
}
EOF

# Nginx 컨테이너 기동
docker run -d --name "${CONTAINER_NAME}" \
  -p 18443:443 \
  -v "${TEMP_DIR}/snippets:/etc/nginx/snippets:ro" \
  -v "${TEMP_DIR}/conf.d:/etc/nginx/conf.d:ro" \
  -v "${TEMP_DIR}/certs/fullchain.pem:/etc/letsencrypt/live/easysubway-api.aquilaxk.site/fullchain.pem:ro" \
  -v "${TEMP_DIR}/certs/privkey.pem:/etc/letsencrypt/live/easysubway-api.aquilaxk.site/privkey.pem:ro" \
  nginx:alpine >/dev/null

# 설정 검증
docker exec "${CONTAINER_NAME}" nginx -t

# 컨테이너 readiness 대기
ready=0
for _ in $(seq 1 30); do
  if curl -sk -o /dev/null -H 'Host: easysubway-api.aquilaxk.site' https://127.0.0.1:18443/actuator/health/readiness; then
    ready=1
    break
  fi
  sleep 0.2
done

if [[ "${ready}" -ne 1 ]]; then
  echo "Error: Nginx smoke container did not become ready in time" >&2
  docker logs "${CONTAINER_NAME}" >&2
  exit 1
fi

echo "Nginx smoke container is ready. Running rate-limit verification..."

# 1. Journey 엔드포인트 40회 연속 호출 -> 429가 1회 이상 발생해야 함
journey_429_count=0
journey_retry_after_checked=0
for _ in $(seq 1 40); do
  resp_headers=$(mktemp)
  resp_body=$(mktemp)
  status=$(curl -sk -D "${resp_headers}" -o "${resp_body}" -w '%{http_code}' \
    -X POST -H 'Host: easysubway-api.aquilaxk.site' \
    https://127.0.0.1:18443/api/v3/journeys/search || true)

  if [[ "${status}" == "429" ]]; then
    journey_429_count=$((journey_429_count + 1))
    if [[ "${journey_retry_after_checked}" -eq 0 ]]; then
      grep -iq "Retry-After: 1" "${resp_headers}" || {
        echo "Error: 429 response missing 'Retry-After: 1' header" >&2
        cat "${resp_headers}" >&2
        rm -f "${resp_headers}" "${resp_body}"
        exit 1
      }
      grep -q '"code":"RATE_LIMITED"' "${resp_body}" || {
        echo "Error: 429 response body did not match RATE_LIMITED" >&2
        cat "${resp_body}" >&2
        rm -f "${resp_headers}" "${resp_body}"
        exit 1
      }
      journey_retry_after_checked=1
    fi
  fi
  rm -f "${resp_headers}" "${resp_body}"
done

echo "Journey rate limit check: ${journey_429_count}/40 requests were 429"
if [[ "${journey_429_count}" -lt 1 ]]; then
  echo "Error: Expected at least one 429 response for journey endpoint, got ${journey_429_count}" >&2
  exit 1
fi

# 2. Probe 엔드포인트 40회 연속 호출 -> 429가 0회여야 함 (무제한)
probe_429_count=0
for _ in $(seq 1 40); do
  status=$(curl -sk -o /dev/null -w '%{http_code}' \
    -H 'Host: easysubway-api.aquilaxk.site' \
    https://127.0.0.1:18443/actuator/health/readiness || true)
  if [[ "${status}" == "429" ]]; then
    probe_429_count=$((probe_429_count + 1))
  fi
done

echo "Probe rate limit check: ${probe_429_count}/40 requests were 429"
if [[ "${probe_429_count}" -ne 0 ]]; then
  echo "Error: Expected zero 429 responses for probe endpoint, got ${probe_429_count}" >&2
  exit 1
fi

echo "Nginx rate limit smoke test PASSED successfully."
