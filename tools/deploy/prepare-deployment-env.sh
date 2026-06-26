#!/usr/bin/env bash
set -euo pipefail

usage() {
	printf 'usage: %s <source.env> <compose.allowlist> <backend.allowlist> <output-dir>\n' "$0" >&2
	exit 2
}

[[ $# -eq 4 ]] || usage

source_env="$1"
compose_allowlist="$2"
backend_allowlist="$3"
output_dir="$4"

for file in "${source_env}" "${compose_allowlist}" "${backend_allowlist}"; do
	[[ -f "${file}" ]] || { printf 'missing file: %s\n' "${file}" >&2; exit 2; }
done

env_lines_file="$(mktemp)"
env_values_file="$(mktemp)"
compose_keys_file="$(mktemp)"
backend_keys_file="$(mktemp)"
cleanup_temp_files() {
	rm -f "${env_lines_file}" "${env_values_file}" "${compose_keys_file}" "${backend_keys_file}"
}
trap cleanup_temp_files EXIT

strip_quotes() {
	local value="$1"
	if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
		printf '%s' "${value:1:${#value}-2}"
	elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
		printf '%s' "${value:1:${#value}-2}"
	else
		printf '%s' "${value}"
	fi
}

while IFS= read -r line || [[ -n "${line}" ]]; do
	line="${line%$'\r'}"
	[[ -z "${line}" || "${line}" == \#* ]] && continue
	if [[ ! "${line}" =~ ^[A-Z0-9_]+= ]]; then
		printf 'invalid dotenv line: %s\n' "${line}" >&2
		exit 1
	fi
	name="${line%%=*}"
	value="${line#*=}"
	if grep -Eq "^${name}=" "${env_lines_file}"; then
		printf 'duplicate dotenv key: %s\n' "${name}" >&2
		exit 1
	fi
	if [[ "${value}" == *'$'* && "${value}" != \'*\' ]]; then
		printf 'cross-key interpolation is not allowed: %s\n' "${name}" >&2
		exit 1
	fi
	printf '%s\n' "${line}" >> "${env_lines_file}"
	printf '%s=%s\n' "${name}" "$(strip_quotes "${value}")" >> "${env_values_file}"
done < "${source_env}"

read_allowlist() {
	local allowlist="$1"
	local output_file="$2"
	: > "${output_file}"
	while IFS= read -r name || [[ -n "${name}" ]]; do
		name="${name%$'\r'}"
		[[ -z "${name}" || "${name}" == \#* ]] && continue
		if [[ ! "${name}" =~ ^[A-Z0-9_]+$ ]]; then
			printf 'invalid allowlist key: %s\n' "${name}" >&2
			exit 1
		fi
		if grep -qx "${name}" "${output_file}"; then
			printf 'duplicate allowlist key: %s\n' "${name}" >&2
			exit 1
		fi
		printf '%s\n' "${name}" >> "${output_file}"
	done < "${allowlist}"
}

read_allowlist "${compose_allowlist}" "${compose_keys_file}"
read_allowlist "${backend_allowlist}" "${backend_keys_file}"

value() {
	local name="$1"
	local line
	line="$(grep -E "^${name}=" "${env_values_file}" || true)"
	if [[ -n "${line}" ]]; then
		printf '%s' "${line#*=}"
	fi
}

require_nonempty() {
	local name="$1"
	if [[ -z "$(value "${name}")" ]]; then
		printf 'required deployment env is empty: %s\n' "${name}" >&2
		exit 1
	fi
}

require_port() {
	local name="$1"
	local raw
	raw="$(value "${name}")"
	[[ -z "${raw}" ]] && return 0
	if [[ ! "${raw}" =~ ^[0-9]+$ || "${raw}" -lt 1 || "${raw}" -gt 65535 ]]; then
		printf 'invalid port: %s\n' "${name}" >&2
		exit 1
	fi
}

require_nonempty EASYSUBWAY_ADMIN_USERNAME
require_nonempty EASYSUBWAY_ADMIN_PASSWORD
require_nonempty EASYSUBWAY_POSTGRES_USER
require_nonempty EASYSUBWAY_POSTGRES_PASSWORD
require_nonempty EASYSUBWAY_DATASOURCE_USERNAME
require_nonempty EASYSUBWAY_DATASOURCE_PASSWORD
require_nonempty EASYSUBWAY_REPORT_UPLOAD_BUCKET
require_nonempty EASYSUBWAY_OBJECT_STORAGE_ACCESS_KEY
require_nonempty EASYSUBWAY_OBJECT_STORAGE_SECRET_KEY

receipt_pepper="$(value EASYSUBWAY_REPORT_RECEIPT_PEPPER)"
legacy_pepper="$(value EASYSUBWAY_REPORT_RECEIPT_TOKEN_PEPPER)"
intent_key="$(value EASYSUBWAY_REPORT_UPLOAD_INTENT_SIGNING_KEY)"
pepper="${receipt_pepper:-${legacy_pepper}}"
if [[ ${#pepper} -lt 32 || "${pepper}" == *local* || "${pepper}" == *test* ]]; then
	printf 'receipt pepper must be production strength\n' >&2
	exit 1
fi
if [[ -n "${intent_key}" && ${#intent_key} -lt 32 ]]; then
	printf 'upload intent signing key must be production strength\n' >&2
	exit 1
fi

if [[ "$(value EASYSUBWAY_DATASOURCE_URL)" != jdbc:postgresql://postgres:5432/* ]]; then
	printf 'datasource must target postgres:5432 inside Compose\n' >&2
	exit 1
fi
if [[ "$(value EASYSUBWAY_DATASOURCE_USERNAME)" != "$(value EASYSUBWAY_POSTGRES_USER)" ]]; then
	printf 'datasource username must match Compose postgres user\n' >&2
	exit 1
fi
if [[ "$(value EASYSUBWAY_DATASOURCE_PASSWORD)" != "$(value EASYSUBWAY_POSTGRES_PASSWORD)" ]]; then
	printf 'datasource password must match Compose postgres password\n' >&2
	exit 1
fi
if [[ "$(value EASYSUBWAY_REPORT_OBJECT_STORAGE_INTERNAL_ENDPOINT)" != "http://object-storage:9000" ]]; then
	printf 'report object storage internal endpoint must be http://object-storage:9000\n' >&2
	exit 1
fi

public_upload_url="$(value EASYSUBWAY_REPORT_UPLOAD_PUBLIC_BASE_URL)"
if [[ ! "${public_upload_url}" =~ ^https://[^/@\?#:]+(:[0-9]+)?/?$ ]]; then
	printf 'public upload URL must be an HTTPS origin\n' >&2
	exit 1
fi
public_upload_url_normalized="$(printf '%s' "${public_upload_url}" | tr '[:upper:]' '[:lower:]')"
case "${public_upload_url_normalized}" in
	*localhost*|*127.*|*::1*|*object-storage*) printf 'public upload URL must not be internal\n' >&2; exit 1 ;;
esac

trusted_proxy_cidrs="$(value EASYSUBWAY_TRUSTED_PROXY_CIDRS)"
if [[ -n "${trusted_proxy_cidrs}" ]]; then
	IFS=',' read -r -a cidrs <<< "${trusted_proxy_cidrs}"
	for cidr in "${cidrs[@]}"; do
		if [[ ! "${cidr}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[1-2][0-9]|3[0-2])$ ]]; then
			printf 'invalid trusted proxy CIDR\n' >&2
			exit 1
		fi
	done
fi

require_port EASYSUBWAY_POSTGRES_PORT
require_port EASYSUBWAY_OBJECT_STORAGE_PORT
require_port EASYSUBWAY_OBJECT_STORAGE_CONSOLE_PORT
require_port EASYSUBWAY_BACKEND_PORT

mkdir -p "${output_dir}"
chmod 700 "${output_dir}"
compose_tmp="$(mktemp "${output_dir}/compose.env.XXXXXX")"
backend_tmp="$(mktemp "${output_dir}/backend.env.XXXXXX")"
chmod 600 "${compose_tmp}" "${backend_tmp}"

write_output() {
	local path="$1"
	local keys_file="$2"
	while IFS= read -r name || [[ -n "${name}" ]]; do
		line="$(grep -E "^${name}=" "${env_lines_file}" || true)"
		if [[ -n "${line}" ]]; then
			printf '%s\n' "${line}" >> "${path}"
		fi
	done < "${keys_file}"
}

write_output "${compose_tmp}" "${compose_keys_file}"
write_output "${backend_tmp}" "${backend_keys_file}"

mv "${compose_tmp}" "${output_dir}/compose.env"
mv "${backend_tmp}" "${output_dir}/backend.env"
chmod 600 "${output_dir}/compose.env" "${output_dir}/backend.env"
printf '%s\n' "${output_dir}"
