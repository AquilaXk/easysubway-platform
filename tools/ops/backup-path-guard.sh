#!/usr/bin/env bash
# Shared fail-closed path guards for ops backup scripts (Bash 3.2+ compatible).

easysubway_strip_trailing_slashes() {
	local value="$1"
	while [[ "${#value}" -gt 1 && "${value}" == */ ]]; do
		value="${value%/}"
	done
	printf '%s' "${value}"
}

_easysubway_normalize_darwin_prefix() {
	local path="$1"
	if [[ "$(uname -s)" != "Darwin" ]]; then
		printf '%s' "${path}"
		return 0
	fi
	local name rest link_target
	for name in var tmp etc; do
		if [[ "${path}" == "/${name}/"* ]]; then
			rest="${path#"/${name}"}"
			if [[ -L "/${name}" ]]; then
				link_target="$(readlink "/${name}" 2>/dev/null || true)"
				if [[ "${link_target}" == "private/${name}" && ! -L "/private" && -d "/private" && ! -L "/private/${name}" && -d "/private/${name}" ]]; then
					printf '/private/%s%s' "${name}" "${rest}"
					return 0
				fi
			fi
		fi
	done
	printf '%s' "${path}"
}

_easysubway_validate_path_segments() {
	local raw_path="$1"
	local label="$2"
	local allow_missing="$3"

	if [[ -z "${raw_path}" || "${raw_path}" == "/" || "${raw_path}" == *$'\n'* || "${raw_path}" == *$'\r'* || "${raw_path}" == *\\* || "${raw_path}" == *".."* ]]; then
		printf '%s missing or unsafe: %s\n' "${label}" "${raw_path:-<empty>}" >&2
		return 1
	fi

	local check_path
	check_path="$(_easysubway_normalize_darwin_prefix "${raw_path}")"

	local is_abs=0
	local split_target="${check_path}"
	if [[ "${check_path}" == /* ]]; then
		is_abs=1
		split_target="${check_path#/}"
	fi

	local -a raw_segments=()
	IFS='/' read -r -a raw_segments <<< "${split_target}"
	local -a clean_segments=()
	local seg
	if [[ ${#raw_segments[@]} -gt 0 ]]; then
		for seg in "${raw_segments[@]}"; do
			if [[ -z "${seg}" || "${seg}" == "." ]]; then
				continue
			fi
			if [[ "${seg}" == ".." ]]; then
				printf '%s contains unsafe segment: %s\n' "${label}" "${raw_path}" >&2
				return 1
			fi
			clean_segments+=("${seg}")
		done
	fi

	if [[ ${#clean_segments[@]} -eq 0 ]]; then
		printf '%s is invalid: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi

	local prefix=""
	local last_index=$(( ${#clean_segments[@]} - 1 ))
	local idx=0
	local saw_missing=0
	for seg in "${clean_segments[@]}"; do
		if [[ "${is_abs}" -eq 1 ]]; then
			prefix="${prefix}/${seg}"
		elif [[ -z "${prefix}" ]]; then
			prefix="${seg}"
		else
			prefix="${prefix}/${seg}"
		fi

		if [[ -L "${prefix}" ]]; then
			printf '%s contains symlink segment: %s\n' "${label}" "${prefix}" >&2
			return 1
		fi

		if [[ "${saw_missing}" -eq 1 ]]; then
			if [[ -e "${prefix}" ]]; then
				printf '%s unexpected path state: %s\n' "${label}" "${prefix}" >&2
				return 1
			fi
		elif [[ "${idx}" -lt "${last_index}" ]]; then
			if [[ -e "${prefix}" ]]; then
				if [[ ! -d "${prefix}" ]]; then
					printf '%s ancestor is not a directory: %s\n' "${label}" "${prefix}" >&2
					return 1
				fi
			else
				if [[ "${allow_missing}" -ne 1 ]]; then
					printf '%s parent directory missing: %s\n' "${label}" "${prefix}" >&2
					return 1
				fi
				saw_missing=1
			fi
		fi

		idx=$(( idx + 1 ))
	done

	printf '%s' "${prefix}"
}

easysubway_resolve_safe_file() {
	local raw_path="$1"
	local label="$2"
	if [[ "${raw_path}" == */ ]]; then
		printf '%s must be a regular file path: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	local safe_path
	safe_path="$(_easysubway_validate_path_segments "${raw_path}" "${label}" 0)"
	if [[ -L "${safe_path}" || ! -f "${safe_path}" || ! -r "${safe_path}" ]]; then
		printf '%s missing, unreadable, or unsafe: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	printf '%s' "${raw_path}"
}

easysubway_resolve_safe_dir() {
	local raw_path="$1"
	local label="$2"
	local stripped
	stripped="$(easysubway_strip_trailing_slashes "${raw_path}")"
	local safe_path
	safe_path="$(_easysubway_validate_path_segments "${stripped}" "${label}" 0)"
	if [[ -L "${safe_path}" || ! -d "${safe_path}" ]]; then
		printf '%s missing or not a regular directory: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	local canonical
	canonical="$(cd "${safe_path}" && pwd -P)"
	if [[ -z "${canonical}" || -L "${canonical}" || ! -d "${canonical}" ]]; then
		printf '%s canonical resolution failed: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	printf '%s' "${canonical}"
}

easysubway_prepare_safe_dir() {
	local raw_path="$1"
	local label="$2"
	local stripped
	stripped="$(easysubway_strip_trailing_slashes "${raw_path}")"
	local safe_path
	safe_path="$(_easysubway_validate_path_segments "${stripped}" "${label}" 1)"
	if [[ -e "${safe_path}" && ( -L "${safe_path}" || ! -d "${safe_path}" ) ]]; then
		printf '%s exists and is not a regular directory: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	mkdir -p "${safe_path}"
	safe_path="$(_easysubway_validate_path_segments "${stripped}" "${label}" 0)"
	if [[ -L "${safe_path}" || ! -d "${safe_path}" ]]; then
		printf '%s is not a regular directory: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	local canonical
	canonical="$(cd "${safe_path}" && pwd -P)"
	if [[ -z "${canonical}" || -L "${canonical}" || ! -d "${canonical}" ]]; then
		printf '%s canonical resolution failed: %s\n' "${label}" "${raw_path}" >&2
		return 1
	fi
	chmod 700 "${canonical}"
	printf '%s' "${canonical}"
}
