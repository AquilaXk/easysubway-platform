#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_FILE="${1:-}"
RESTORE_DB="${EASYSUBWAY_RESTORE_DB:-easysubway_restore_rehearsal}"

if [[ -z "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
	printf 'Usage: tools/ops/postgres-restore-rehearsal.sh <backup-file>\n' >&2
	exit 2
fi

cat "${BACKUP_FILE}" | docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T -e RESTORE_DB="${RESTORE_DB}" postgres sh -lc '
set -eu

cleanup() {
	dropdb --if-exists -U "$POSTGRES_USER" "$RESTORE_DB"
}

case "$RESTORE_DB" in
	"$POSTGRES_DB"|postgres|template0|template1)
		printf 'Refusing to use protected restore database: %s\n' "$RESTORE_DB" >&2
		exit 2
		;;
esac

dropdb --if-exists -U "$POSTGRES_USER" "$RESTORE_DB"
createdb -U "$POSTGRES_USER" "$RESTORE_DB"
trap cleanup EXIT
pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$RESTORE_DB"
'

printf 'restore rehearsal succeeded: %s\n' "${RESTORE_DB}"
