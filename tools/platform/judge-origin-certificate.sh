#!/usr/bin/env bash
# AquilaXk/easysubway-platform#270: 호스트 nginx(127.0.0.1:443)가 SERVED_HOSTS 각 호스트에 내보내는 인증서의
# 만료 잔여 일수(--days), 호스트 이름 일치(-checkhost), 디스크 인증서 만료 시각과의 일치(--disk-not-after)를 판정한다.
# origin-certificate-renew.yml의 CHECK(14일, 1회)와 RENEW 검증(30일, 재시도)이 함께 쓴다.
set -euo pipefail

min_days=""
attempts=1
retry_sleep=2
disk_not_after=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      min_days="${2:-}"
      shift 2
      ;;
    --attempts)
      attempts="${2:-}"
      shift 2
      ;;
    --retry-sleep)
      retry_sleep="${2:-}"
      shift 2
      ;;
    --disk-not-after)
      disk_not_after="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "${min_days}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--days must be a positive integer" >&2
  exit 2
fi
if [[ ! "${attempts}" =~ ^[1-9][0-9]*$ ]]; then
  echo "--attempts must be a positive integer" >&2
  exit 2
fi

normalize_not_after() {
  local raw="${1#notAfter=}"
  if [[ "${raw}" =~ ^([A-Za-z]{3})[[:space:]]+([0-9]{1,2})[[:space:]]+([0-9]{2}:[0-9]{2}:[0-9]{2})[[:space:]]+([0-9]{4})[[:space:]]+GMT$ ]]; then
    local mon="${BASH_REMATCH[1]}"
    local day="${BASH_REMATCH[2]}"
    local hms="${BASH_REMATCH[3]}"
    local year="${BASH_REMATCH[4]}"
    local mm=""
    case "${mon}" in
      Jan) mm="01" ;; Feb) mm="02" ;; Mar) mm="03" ;; Apr) mm="04" ;;
      May) mm="05" ;; Jun) mm="06" ;; Jul) mm="07" ;; Aug) mm="08" ;;
      Sep) mm="09" ;; Oct) mm="10" ;; Nov) mm="11" ;; Dec) mm="12" ;;
      *) return 1 ;;
    esac
    printf '%04d-%s-%02d %s+00:00\n' "${year}" "${mm}" "$((10#${day}))" "${hms}"
    return 0
  fi
  if [[ "${raw}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}\+[0-9]{2}:[0-9]{2}$ ]]; then
    printf '%s\n' "${raw}"
    return 0
  fi
  return 1
}

read -r -a hosts <<< "${SERVED_HOSTS:-}"
if [[ "${#hosts[@]}" -eq 0 ]]; then
  echo "SERVED_HOSTS must not be empty"
  exit 1
fi

check_seconds=$(( min_days * 86400 ))
failed=0

for host in "${hosts[@]}"; do
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    host_errors=()
    enddate=""
    if served="$(echo | timeout 5 openssl s_client -connect 127.0.0.1:443 -servername "${host}" 2>/dev/null | openssl x509 2>/dev/null)" && [[ -n "${served}" ]]; then
      enddate="$(echo "${served}" | openssl x509 -noout -enddate)"
      if ! echo "${served}" | openssl x509 -noout -checkend "${check_seconds}" >/dev/null; then
        host_errors+=("${host}: served certificate is expired or expires within ${min_days} days (RENEW needed)")
      fi
      if ! echo "${served}" | openssl x509 -noout -checkhost "${host}" | grep -q 'does match'; then
        host_errors+=("${host}: served certificate does not name this host (check the nginx server block and lineage domains)")
      fi
      if [[ -n "${disk_not_after}" ]]; then
        if ! served_not_after="$(normalize_not_after "${enddate}")" || [[ "${served_not_after}" != "${disk_not_after}" ]]; then
          host_errors+=("${host}: served certificate expiry (${served_not_after:-${enddate#notAfter=}}) does not match on-disk lineage (${disk_not_after}) (nginx reload needed)")
        fi
      fi
    else
      host_errors+=("${host}: no certificate read from 127.0.0.1:443")
    fi

    if [[ "${#host_errors[@]}" -eq 0 ]]; then
      echo "${host}: served ${enddate}"
      break
    fi
    if (( attempt < attempts )); then
      sleep "${retry_sleep}"
    else
      if [[ -n "${enddate}" ]]; then
        echo "${host}: served ${enddate}"
      fi
      for err in "${host_errors[@]}"; do
        echo "${err}"
      done
      failed=1
    fi
  done
done

exit "${failed}"
