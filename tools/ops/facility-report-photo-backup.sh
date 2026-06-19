#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_DIR="${1:-${EASYSUBWAY_PHOTO_BACKUP_DIR:-${ROOT_DIR}/.codex/backups/facility-report-photos}}"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

run_dir="$(mktemp -d "${BACKUP_DIR}/easysubway-report-photos-${timestamp}.XXXXXX")"
objects_dir="${run_dir}/objects"
manifest_file="${run_dir}/manifest.tsv"
rows_file="${run_dir}/photos.tsv"

cleanup() {
	rm -f "${rows_file}"
}
trap cleanup EXIT

decode_base64_to_file() {
	local encoded="$1"
	local object_file="$2"
	if printf '%s' "${encoded}" | base64 --decode > "${object_file}"; then
		return
	fi
	printf '%s' "${encoded}" | base64 -D > "${object_file}"
}

decode_manifest_field() {
	local encoded="$1"
	if [[ -z "${encoded}" ]]; then
		return
	fi
	if printf '%s' "${encoded}" | base64 --decode 2>/dev/null; then
		return
	fi
	printf '%s' "${encoded}" | base64 -D
}

manifest_field() {
	local encoded="$1"
	decode_manifest_field "${encoded}" | tr '\t\r\n' ' '
}

mkdir -p "${objects_dir}"
chmod 700 "${run_dir}" "${objects_dir}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres sh -lc \
	'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL' > "${rows_file}"
COPY (
SELECT report_id,
	REPLACE(REPLACE(ENCODE(CONVERT_TO(COALESCE(photo_file_name, ''), 'UTF8'), 'base64'), E'\n', ''), E'\r', '') AS photo_file_name_base64,
	REPLACE(REPLACE(ENCODE(CONVERT_TO(COALESCE(photo_content_type, ''), 'UTF8'), 'base64'), E'\n', ''), E'\r', '') AS photo_content_type_base64,
	photo_data_base64
FROM facility_reports
WHERE photo_data_base64 IS NOT NULL
	AND photo_data_base64 <> ''
ORDER BY report_id ASC
) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
SQL

printf 'report_id\tfile_name\tcontent_type\tobject_path\n' > "${manifest_file}"

while IFS=$'\t' read -r report_id file_name_base64 content_type_base64 photo_data_base64; do
	if [[ -z "${report_id}" || -z "${photo_data_base64}" ]]; then
		continue
	fi
	safe_report_id="$(printf '%s' "${report_id}" | tr -c 'A-Za-z0-9._-' '_')"
	object_path="objects/${safe_report_id}.bin"
	object_file="${run_dir}/${object_path}"
	decode_base64_to_file "${photo_data_base64}" "${object_file}"
	file_name="$(manifest_field "${file_name_base64}")"
	content_type="$(manifest_field "${content_type_base64}")"
	printf '%s\t%s\t%s\t%s\n' "${report_id}" "${file_name}" "${content_type}" "${object_path}" >> "${manifest_file}"
done < "${rows_file}"

trap - EXIT
cleanup
printf 'facility report photo backup written: %s\n' "${run_dir}"
