#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_FILE="${1:-}"
BACKUP_DIR="${EASYSUBWAY_BACKUP_DIR:-${DEPLOY_ROOT:-/opt/easysubway}/backups}"
RESTORE_DB="${EASYSUBWAY_RESTORE_DB:-easysubway_restore_rehearsal}"

if [[ ! -d "${BACKUP_DIR}" || -L "${BACKUP_DIR}" ]]; then
	printf 'Invalid backup directory: %s\n' "${BACKUP_DIR}" >&2
	exit 1
fi

if [[ -z "${BACKUP_FILE}" ]]; then
	latest_key=""
	latest_path=""
	shopt -s nullglob
	for candidate in "${BACKUP_DIR}"/*.dump; do
		if [[ -L "${candidate}" || ! -f "${candidate}" ]]; then
			continue
		fi
		candidate_name="$(basename "${candidate}")"
		if [[ "${candidate_name}" =~ ^(easysubway-)?postgres-([0-9]{8}T[0-9]{6}Z)(\.[A-Za-z0-9]+)?\.dump$ ]]; then
			candidate_ts="${BASH_REMATCH[2]}"
			candidate_prefix_rank="0"
			if [[ -n "${BASH_REMATCH[1]}" ]]; then
				candidate_prefix_rank="1"
			fi
			candidate_key="${candidate_ts}:${candidate_prefix_rank}:${candidate_name}"
			if [[ -z "${latest_key}" || "${candidate_key}" > "${latest_key}" ]]; then
				latest_key="${candidate_key}"
				latest_path="${candidate}"
			fi
		fi
	done
	shopt -u nullglob
	if [[ -z "${latest_path}" ]]; then
		printf 'No PostgreSQL backup dump found in %s\n' "${BACKUP_DIR}" >&2
		exit 1
	fi
	BACKUP_FILE="${latest_path}"
elif [[ "${BACKUP_FILE}" != */* && "${BACKUP_FILE}" != *..* ]]; then
	BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILE}"
fi

backup_parent_dir="$(dirname "${BACKUP_FILE}")"
if [[ "${BACKUP_FILE}" == *..* || ! -d "${backup_parent_dir}" || -L "${backup_parent_dir}" ]]; then
	printf 'Backup file path traversal or invalid parent directory rejected: %s\n' "${BACKUP_FILE}" >&2
	exit 1
fi

resolved_backup_dir="$(cd "${BACKUP_DIR}" && pwd -P)"
resolved_file_dir="$(cd "${backup_parent_dir}" && pwd -P)"
if [[ "${resolved_file_dir}" != "${resolved_backup_dir}" ]]; then
	printf 'Backup file must reside directly inside %s: %s\n' "${resolved_backup_dir}" "${BACKUP_FILE}" >&2
	exit 1
fi

backup_basename="$(basename "${BACKUP_FILE}")"
if [[ ! "${backup_basename}" =~ ^(easysubway-)?postgres-[0-9]{8}T[0-9]{6}Z(\.[A-Za-z0-9]+)?\.dump$ ]]; then
	printf 'Invalid backup filename pattern: %s\n' "${backup_basename}" >&2
	exit 1
fi

if [[ -L "${BACKUP_FILE}" || ! -f "${BACKUP_FILE}" ]]; then
	printf 'Backup file must be an existing regular non-symlink file: %s\n' "${BACKUP_FILE}" >&2
	exit 1
fi

checksum_file="${BACKUP_FILE}.sha256"
if [[ -L "${checksum_file}" || ! -f "${checksum_file}" ]]; then
	printf 'Missing or invalid companion checksum file: %s\n' "${checksum_file}" >&2
	exit 1
fi

expected_sha256="$(awk 'NR == 1 { print tolower($1) }' "${checksum_file}")"
if [[ ! "${expected_sha256}" =~ ^[0-9a-f]{64}$ ]]; then
	printf 'Malformed SHA-256 digest in checksum file: %s\n' "${checksum_file}" >&2
	exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
	actual_sha256="$(sha256sum "${BACKUP_FILE}" | awk '{ print tolower($1) }')"
else
	actual_sha256="$(shasum -a 256 "${BACKUP_FILE}" | awk '{ print tolower($1) }')"
fi

if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
	printf 'Backup SHA-256 checksum mismatch for %s\n' "${BACKUP_FILE}" >&2
	exit 1
fi

cat "${BACKUP_FILE}" | docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T -e RESTORE_DB="${RESTORE_DB}" postgres sh -lc '
set -eu

cleanup() {
	dropdb --if-exists -U "$POSTGRES_USER" "$RESTORE_DB"
}

case "$RESTORE_DB" in
	"$POSTGRES_DB"|postgres|template0|template1)
		printf "Refusing to use protected restore database: %s\n" "$RESTORE_DB" >&2
		exit 2
		;;
esac

dropdb --if-exists -U "$POSTGRES_USER" "$RESTORE_DB"
createdb -U "$POSTGRES_USER" "$RESTORE_DB"
trap cleanup EXIT
pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$RESTORE_DB"
'

printf 'restore rehearsal succeeded: %s\n' "${RESTORE_DB}"
