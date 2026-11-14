#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/tools/ops/backup-path-guard.sh"

ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
BACKUP_DIR="${1:-${EASYSUBWAY_PHOTO_BACKUP_DIR:-${ROOT_DIR}/.evidence/backups/facility-report-photos}}"
PHOTO_STORAGE_DIR="${EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR:-${TMPDIR:-/tmp}/easysubway-report-photos}"

ENV_FILE="$(easysubway_resolve_safe_file "${ENV_FILE}" "required environment file")"
COMPOSE_FILE="$(easysubway_resolve_safe_file "${COMPOSE_FILE}" "compose file")"
CANONICAL_STORAGE_DIR="$(easysubway_resolve_safe_dir "${PHOTO_STORAGE_DIR}" "photo storage directory")"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

BACKUP_DIR="$(easysubway_prepare_safe_dir "${BACKUP_DIR}" "backup directory")"

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
	if [[ "${object_key}" == /* || "${object_key}" == */ || "${object_key}" == *//* || "${object_key}" == *\\* || "${object_key}" == *".."* ]]; then
		printf 'invalid facility report photo object key: %s\n' "${object_key}" >&2
		return 1
	fi
	local -a segments=()
	IFS='/' read -r -a segments <<< "${object_key}"
	local current_path="${CANONICAL_STORAGE_DIR}"
	local index=0
	local last_index=$(( ${#segments[@]} - 1 ))
	local segment
	for segment in "${segments[@]}"; do
		if [[ -z "${segment}" || "${segment}" == "." || "${segment}" == ".." ]]; then
			printf 'invalid facility report photo object key segment: %s\n' "${object_key}" >&2
			return 1
		fi
		current_path="${current_path}/${segment}"
		if [[ -L "${current_path}" ]]; then
			printf 'symlink rejected in facility report photo path: %s\n' "${current_path}" >&2
			return 1
		fi
		if [[ "${index}" -lt "${last_index}" && ! -d "${current_path}" ]]; then
			printf 'facility report photo directory not found: %s\n' "${current_path}" >&2
			return 1
		fi
		index=$(( index + 1 ))
	done
	local source_file="${current_path}"
	if [[ -L "${source_file}" || ! -f "${source_file}" ]]; then
		printf 'facility report photo object not found or not regular file: %s\n' "${source_file}" >&2
		return 1
	fi
	local resolved_source_dir
	resolved_source_dir="$(cd "$(dirname "${source_file}")" && pwd -P)"
	if [[ "${resolved_source_dir}" != "${CANONICAL_STORAGE_DIR}" && "${resolved_source_dir}" != "${CANONICAL_STORAGE_DIR}/"* ]]; then
		printf 'facility report photo path escaped storage containment: %s\n' "${source_file}" >&2
		return 1
	fi
	easysubway_prepare_safe_dir "$(dirname "${target_path}")" "photo backup object directory" >/dev/null
	if [[ -L "${target_path}" ]]; then
		printf 'unsafe symlink backup target path: %s\n' "${target_path}" >&2
		return 1
	fi
	if [[ ! -e "${target_path}" ]]; then
		cp -P -- "${source_file}" "${target_path}"
		chmod 600 "${target_path}"
	fi
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
	COALESCE(photo_thumbnail_object_key, '__EASYSUBWAY_EMPTY__') AS photo_thumbnail_object_key,
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
	if [[ "${thumbnail_object_key}" == "__EASYSUBWAY_EMPTY__" ]]; then
		thumbnail_object_key=""
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
