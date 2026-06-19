#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env.example}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_DIR="${1:-${EASYSUBWAY_PHOTO_BACKUP_DIR:-${ROOT_DIR}/.codex/backups/facility-report-photos}}"
PHOTO_STORAGE_DIR="${EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR:-${TMPDIR:-/tmp}/easysubway-report-photos}"

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

copy_object() {
	local object_key="$1"
	local target_path="$2"
	if [[ -z "${object_key}" ]]; then
		return
	fi
	if [[ "${object_key}" == /* || "${object_key}" == *".."* ]]; then
		printf 'invalid facility report photo object key: %s\n' "${object_key}" >&2
		return 1
	fi
	local source_file="${PHOTO_STORAGE_DIR}/${object_key}"
	if [[ ! -f "${source_file}" ]]; then
		printf 'facility report photo object not found: %s\n' "${source_file}" >&2
		return 1
	fi
	mkdir -p "$(dirname "${target_path}")"
	cp "${source_file}" "${target_path}"
}

mkdir -p "${objects_dir}"
chmod 700 "${run_dir}" "${objects_dir}"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" exec -T postgres sh -lc \
	'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB"' <<'SQL' > "${rows_file}"
COPY (
SELECT report_id,
	REPLACE(REPLACE(ENCODE(CONVERT_TO(COALESCE(photo_file_name, ''), 'UTF8'), 'base64'), E'\n', ''), E'\r', '') AS photo_file_name_base64,
	REPLACE(REPLACE(ENCODE(CONVERT_TO(COALESCE(photo_content_type, ''), 'UTF8'), 'base64'), E'\n', ''), E'\r', '') AS photo_content_type_base64,
	COALESCE(photo_object_key, '') AS photo_object_key,
	COALESCE(photo_thumbnail_object_key, '') AS photo_thumbnail_object_key,
	COALESCE(photo_sha256, '') AS photo_sha256,
	COALESCE(photo_size_bytes::TEXT, '') AS photo_size_bytes
FROM facility_reports
WHERE photo_object_key IS NOT NULL
	AND photo_object_key <> ''
ORDER BY report_id ASC
) TO STDOUT WITH (FORMAT text, DELIMITER E'\t');
SQL

printf 'report_id\tfile_name\tcontent_type\tobject_key\tthumbnail_object_key\tsha256\tsize_bytes\tobject_path\tthumbnail_path\n' > "${manifest_file}"

while IFS=$'\t' read -r report_id file_name_base64 content_type_base64 object_key thumbnail_object_key sha256 size_bytes; do
	if [[ -z "${report_id}" || -z "${object_key}" ]]; then
		continue
	fi
	object_path="objects/${object_key}"
	thumbnail_path="objects/${thumbnail_object_key}"
	object_file="${run_dir}/${object_path}"
	thumbnail_file="${run_dir}/${thumbnail_path}"
	copy_object "${object_key}" "${object_file}"
	copy_object "${thumbnail_object_key}" "${thumbnail_file}"
	file_name="$(manifest_field "${file_name_base64}")"
	content_type="$(manifest_field "${content_type_base64}")"
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
		"${report_id}" \
		"${file_name}" \
		"${content_type}" \
		"${object_key}" \
		"${thumbnail_object_key}" \
		"${sha256}" \
		"${size_bytes}" \
		"${object_path}" \
		"${thumbnail_path}" >> "${manifest_file}"
done < "${rows_file}"

trap - EXIT
cleanup
printf 'facility report photo backup written: %s\n' "${run_dir}"
