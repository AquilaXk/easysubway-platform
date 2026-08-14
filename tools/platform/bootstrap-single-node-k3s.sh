#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
	printf 'usage: %s --mode INSTALL|VERIFY\n' "$0" >&2
	exit 2
}

[[ $# -eq 2 && "$1" == "--mode" ]] || usage
mode="$2"
[[ "${mode}" == "INSTALL" || "${mode}" == "VERIFY" ]] || usage
[[ "${EUID}" -eq 0 ]] || { printf 'E_K3S_ROOT root is required\n' >&2; exit 2; }
[[ "$(uname -m)" == "aarch64" ]] || { printf 'E_K3S_ARCH expected aarch64\n' >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
K3S_VERSION="v1.36.3+k3s1"
K3S_BINARY_URL="https://github.com/k3s-io/k3s/releases/download/v1.36.3%2Bk3s1/k3s-arm64"
K3S_BINARY_SHA256="c9a209103f480f163b7c6a56f00862b4481927b284dc29a3716bb70d886691a8"
K3S_BINARY="/usr/local/bin/k3s"
K3S_CONFIG_SOURCE="${ROOT_DIR}/infra/k3s/config.yaml"
K3S_CONFIG="/etc/rancher/k3s/config.yaml"
K3S_SERVICE_SOURCE="${ROOT_DIR}/infra/k3s/easysubway-k3s.service"
K3S_SERVICE="/etc/systemd/system/easysubway-k3s.service"
K3S_RBAC="${ROOT_DIR}/infra/k3s/deployer-rbac.json"

verify_file() {
	local expected="$1"
	local actual="$2"
	cmp --silent "${expected}" "${actual}" || { printf 'E_K3S_FILE_DRIFT %s\n' "${actual}" >&2; exit 1; }
}

verify_binary() {
	[[ -x "${K3S_BINARY}" ]] || { printf 'E_K3S_BINARY_MISSING\n' >&2; exit 1; }
	printf '%s  %s\n' "${K3S_BINARY_SHA256}" "${K3S_BINARY}" | sha256sum --check --status || {
		printf 'E_K3S_BINARY_DIGEST\n' >&2
		exit 1
	}
	local version_line
	version_line="$("${K3S_BINARY}" --version | head -n 1)"
	[[ "${version_line}" == "k3s version ${K3S_VERSION} ("* ]] || {
		printf 'E_K3S_VERSION\n' >&2
		exit 1
	}
}

wait_ready() {
	for attempt in $(seq 1 60); do
		if "${K3S_BINARY}" kubectl get --raw=/readyz >/dev/null 2>&1; then
			return
		fi
		sleep 1
	done
	printf 'E_K3S_READINESS_TIMEOUT\n' >&2
	exit 1
}

verify_runtime() {
	verify_binary
	verify_file "${K3S_CONFIG_SOURCE}" "${K3S_CONFIG}"
	verify_file "${K3S_SERVICE_SOURCE}" "${K3S_SERVICE}"
	systemctl is-active --quiet easysubway-k3s.service || { printf 'E_K3S_SERVICE_INACTIVE\n' >&2; exit 1; }
	wait_ready
	"${K3S_BINARY}" kubectl diff --server-side=false -f "${K3S_RBAC}" >/dev/null || {
		printf 'E_K3S_RBAC_DRIFT\n' >&2
		exit 1
	}
	"${K3S_BINARY}" kubectl auth can-i --as system:serviceaccount:easysubway-journey:journey-deployer -n easysubway-journey get deployments | grep -Fqx yes
	"${K3S_BINARY}" kubectl auth can-i --as system:serviceaccount:easysubway-journey:journey-deployer get nodes | grep -Fqx no
}

if [[ "${mode}" == "INSTALL" ]]; then
	temporary="$(mktemp)"
	trap 'rm -f "${temporary}"' EXIT
	curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error "${K3S_BINARY_URL}" --output "${temporary}"
	printf '%s  %s\n' "${K3S_BINARY_SHA256}" "${temporary}" | sha256sum --check --status || {
		printf 'E_K3S_DOWNLOAD_DIGEST\n' >&2
		exit 1
	}
	install -D -m 0755 "${temporary}" "${K3S_BINARY}"
	install -D -m 0600 "${K3S_CONFIG_SOURCE}" "${K3S_CONFIG}"
	install -D -m 0644 "${K3S_SERVICE_SOURCE}" "${K3S_SERVICE}"
	systemctl daemon-reload
	systemctl enable --now easysubway-k3s.service
	wait_ready
	"${K3S_BINARY}" kubectl apply --server-side=true --field-manager=easysubway-platform -f "${K3S_RBAC}"
fi

verify_runtime
