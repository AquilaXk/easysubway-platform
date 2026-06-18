#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_DIR="${1:-${EASYSUBWAY_BACKUP_DIR:-${ROOT_DIR}/.codex/backups}}"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

temp_file="$(mktemp "${BACKUP_DIR}/easysubway-postgres-${timestamp}.XXXXXX")"
backup_file="${temp_file}.dump"

cleanup() {
	rm -f "${temp_file}"
}
trap cleanup EXIT

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres sh -lc \
	'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
	> "${temp_file}"

test -s "${temp_file}"
mv "${temp_file}" "${backup_file}"
trap - EXIT
printf '%s\n' "${backup_file}"
