#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/tools/ops/backup-path-guard.sh"

ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
COMPOSE_PROJECT="${EASYSUBWAY_COMPOSE_PROJECT:-}"
BACKUP_DIR="${1:-${EASYSUBWAY_BACKUP_DIR:-${ROOT_DIR}/.evidence/backups}}"

ENV_FILE="$(easysubway_resolve_safe_file "${ENV_FILE}" "required environment file")"
COMPOSE_FILE="$(easysubway_resolve_safe_file "${COMPOSE_FILE}" "compose file")"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

BACKUP_DIR="$(easysubway_prepare_safe_dir "${BACKUP_DIR}" "backup directory")"

temp_file="$(mktemp "${BACKUP_DIR}/easysubway-postgres-${timestamp}.XXXXXX")"
backup_file="${temp_file}.dump"
if [[ -L "${temp_file}" || -L "${backup_file}" || -e "${backup_file}" ]]; then
	printf 'unsafe backup target path: %s\n' "${backup_file}" >&2
	exit 1
fi

cleanup() {
	rm -f "${temp_file}"
}
trap cleanup EXIT

compose_args=()
if [[ -n "${COMPOSE_PROJECT}" ]]; then
	compose_args+=(--project-name "${COMPOSE_PROJECT}")
fi
compose_args+=(--env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

docker compose "${compose_args[@]}" exec -T postgres sh -lc \
	'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' \
	> "${temp_file}"

test -s "${temp_file}"
docker compose "${compose_args[@]}" exec -T postgres sh -lc 'pg_restore --list >/dev/null' < "${temp_file}"
mv "${temp_file}" "${backup_file}"
if command -v sha256sum >/dev/null 2>&1; then
	sha256sum "${backup_file}" > "${backup_file}.sha256"
else
	shasum -a 256 "${backup_file}" > "${backup_file}.sha256"
fi
chmod 600 "${backup_file}" "${backup_file}.sha256"
trap - EXIT
node "${ROOT_DIR}/tools/ops/prune-sensitive-backups.mjs" \
	--root "${BACKUP_DIR}" \
	--retention-days "30"
printf '%s\n' "${backup_file}"
