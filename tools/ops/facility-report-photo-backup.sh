#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "${ROOT_DIR}/tools/ops/backup-path-guard.sh"

ENV_FILE="${EASYSUBWAY_ENV_FILE:-${ROOT_DIR}/.env}"
COMPOSE_FILE="${EASYSUBWAY_COMPOSE_FILE:-${ROOT_DIR}/infra/docker-compose.yml}"
COMPOSE_PROJECT="${EASYSUBWAY_COMPOSE_PROJECT:-}"
BACKUP_DIR="${1:-${EASYSUBWAY_PHOTO_BACKUP_DIR:-${ROOT_DIR}/.evidence/backups/facility-report-photos}}"
PHOTO_BUCKET="${EASYSUBWAY_REPORTS_PHOTOS_BUCKET:-}"
PHOTO_STORAGE_DIR="${EASYSUBWAY_REPORTS_PHOTOS_STORAGE_DIR:-${TMPDIR:-/tmp}/easysubway-report-photos}"
BACKUP_RETENTION_DAYS="${EASYSUBWAY_BACKUP_RETENTION_DAYS:-30}"
MAX_OBJECT_BYTES="${EASYSUBWAY_REPORTS_PHOTOS_MAX_OBJECT_BYTES:-52428800}"

ENV_FILE="$(easysubway_resolve_safe_file "${ENV_FILE}" "required environment file")"
COMPOSE_FILE="$(easysubway_resolve_safe_file "${COMPOSE_FILE}" "compose file")"

if [[ ! "${BACKUP_RETENTION_DAYS}" =~ ^[0-9]+$ || "${BACKUP_RETENTION_DAYS}" -lt 1 || "${BACKUP_RETENTION_DAYS}" -gt 365 ]]; then
	printf 'invalid facility report photo backup retention days: %s\n' "${BACKUP_RETENTION_DAYS}" >&2
	exit 1
fi
if [[ ! "${MAX_OBJECT_BYTES}" =~ ^[0-9]+$ || "${MAX_OBJECT_BYTES}" -lt 1 ]]; then
	printf 'invalid facility report photo max object bytes: %s\n' "${MAX_OBJECT_BYTES}" >&2
	exit 1
fi

CANONICAL_STORAGE_DIR=""
if [[ -n "${PHOTO_BUCKET}" ]]; then
	if [[ ! "${PHOTO_BUCKET}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || "${PHOTO_BUCKET}" == *".."* ]]; then
		printf 'invalid facility report photo bucket name: %s\n' "${PHOTO_BUCKET}" >&2
		exit 1
	fi
else
	CANONICAL_STORAGE_DIR="$(easysubway_resolve_safe_dir "${PHOTO_STORAGE_DIR}" "photo storage directory")"
fi

compose_args=()
if [[ -n "${COMPOSE_PROJECT}" ]]; then
	compose_args+=(--project-name "${COMPOSE_PROJECT}")
fi
compose_args+=(--env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

BACKUP_DIR="$(easysubway_prepare_safe_dir "${BACKUP_DIR}" "backup directory")"

run_dir="$(mktemp -d "${BACKUP_DIR}/easysubway-report-photos-${timestamp}.XXXXXX")"
objects_dir="${run_dir}/objects"
manifest_file="${run_dir}/manifest.tsv"
rows_file="${run_dir}/photos.tsv"

cleanup() {
	rm -f "${rows_file}"
	if [[ -d "${objects_dir}" ]]; then
		find "${objects_dir}" -type f -name "*.tmp.$$" -delete 2>/dev/null || true
	fi
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
	local segment
	for segment in "${segments[@]}"; do
		if [[ -z "${segment}" || "${segment}" == "." || "${segment}" == ".." ]]; then
			printf 'invalid facility report photo object key segment: %s\n' "${object_key}" >&2
			return 1
		fi
	done

	easysubway_prepare_safe_dir "$(dirname "${target_path}")" "photo backup object directory" >/dev/null
	if [[ -L "${target_path}" ]]; then
		printf 'unsafe symlink backup target path: %s\n' "${target_path}" >&2
		return 1
	fi
	if [[ -e "${target_path}" ]]; then
		return
	fi

	if [[ -n "${PHOTO_BUCKET}" ]]; then
		local temp_target="${target_path}.tmp.$$"
		rm -f "${temp_target}"
		if ! docker compose "${compose_args[@]}" exec -T object-storage sh -lc \
			'mc_cfg="$(mktemp -d)" && trap '\''rm -rf "${mc_cfg}"'\'' EXIT && mc --config-dir "${mc_cfg}" alias set local http://127.0.0.1:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null && mc --config-dir "${mc_cfg}" cat "local/$1/$2"' \
			sh "${PHOTO_BUCKET}" "${object_key}" </dev/null > "${temp_target}"; then
			rm -f "${temp_target}"
			printf 'failed to fetch facility report photo object from bucket %s: %s\n' "${PHOTO_BUCKET}" "${object_key}" >&2
			return 1
		fi
		if [[ -L "${temp_target}" || ! -f "${temp_target}" ]]; then
			rm -f "${temp_target}"
			printf 'downloaded facility report photo is not a regular file: %s\n' "${object_key}" >&2
			return 1
		fi
		local actual_bytes
		actual_bytes="$(wc -c < "${temp_target}")"
		if [[ "${actual_bytes}" -gt "${MAX_OBJECT_BYTES}" ]]; then
			rm -f "${temp_target}"
			printf 'facility report photo exceeds max object size limit (%s > %s): %s\n' "${actual_bytes}" "${MAX_OBJECT_BYTES}" "${object_key}" >&2
			return 1
		fi
		mv -f "${temp_target}" "${target_path}"
		chmod 600 "${target_path}"
		return
	fi

	local current_path="${CANONICAL_STORAGE_DIR}"
	local index=0
	local last_index=$(( ${#segments[@]} - 1 ))
	for segment in "${segments[@]}"; do
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
	cp -P -- "${source_file}" "${target_path}"
	chmod 600 "${target_path}"
}

mkdir -p "${objects_dir}"
chmod 700 "${run_dir}" "${objects_dir}"

docker compose "${compose_args[@]}" exec -T postgres sh -lc \
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

while IFS=$'\t' read -r -u 3 report_id file_name_base64 content_type_base64 object_key thumbnail_object_key sha256 size_bytes; do
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
done 3< "${rows_file}"

trap - EXIT
cleanup
node "${ROOT_DIR}/tools/ops/prune-sensitive-backups.mjs" \
	--root "${BACKUP_DIR}" \
	--retention-days "${BACKUP_RETENTION_DAYS}"
printf 'facility report photo backup written: %s\n' "${run_dir}"
