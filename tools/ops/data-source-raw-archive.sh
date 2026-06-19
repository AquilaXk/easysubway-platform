#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_DIR="${1:-${EASYSUBWAY_DATA_SOURCE_ARCHIVE_DIR:-${ROOT_DIR}/.codex/backups/data-sources}}"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

run_dir="$(mktemp -d "${BACKUP_DIR}/easysubway-data-sources-${timestamp}.XXXXXX")"
collection_runs_file="${run_dir}/collection-runs.csv"
raw_archives_file="${run_dir}/raw-archives.csv"
stream_file="${run_dir}/archive-stream.txt"

cleanup() {
	rm -f "${stream_file}"
}
trap cleanup EXIT

chmod 700 "${run_dir}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres sh -lc \
	'psql -v ON_ERROR_STOP=1 -A -t -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL' > "${stream_file}"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT '__EASYSUBWAY_COLLECTION_RUNS__';
COPY (
SELECT run_id,
	source,
	status,
	requested_by,
	started_at,
	completed_at,
	collected_count,
	failure_message,
	retryable,
	operator_action
FROM data_collection_runs
ORDER BY started_at DESC, run_id ASC
) TO STDOUT WITH (FORMAT csv, HEADER true);
SELECT '__EASYSUBWAY_RAW_ARCHIVES__';
COPY (
SELECT archive_id,
	run_id,
	source,
	source_url,
	storage_uri,
	payload_sha256,
	content_type,
	captured_at
FROM data_source_raw_archives
ORDER BY captured_at DESC, archive_id ASC
) TO STDOUT WITH (FORMAT csv, HEADER true);
COMMIT;
SQL

awk -v collection_runs_file="${collection_runs_file}" -v raw_archives_file="${raw_archives_file}" '
	$0 == "__EASYSUBWAY_COLLECTION_RUNS__" {
		target = collection_runs_file
		next
	}
	$0 == "__EASYSUBWAY_RAW_ARCHIVES__" {
		target = raw_archives_file
		next
	}
	$0 == "BEGIN" || $0 == "COMMIT" {
		next
	}
	target {
		print > target
	}
' "${stream_file}"

trap - EXIT
cleanup
printf 'data source archive written: %s\n' "${run_dir}"
