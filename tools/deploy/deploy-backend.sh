#!/usr/bin/env bash
set -Eeuo pipefail

# --- Blue/green standby+promotion migration contract (issue #2331) ---------
# The standby container (Stage 1 below) boots the candidate image against the
# SAME live Postgres datasource the canonical "backend" container is still
# serving traffic against. Standby boot commits Flyway migrations and
# TimetableSeedLoader's snapshot swap (DELETE+reinsert, made atomic by its own
# lock + immutable history — that part is safe) BEFORE the canonical
# container is touched and BEFORE any go/no-go decision is made. This design
# therefore only removes the "force-recreate before validation" outage
# window; it does NOT make process-level standby validation a substitute for
# a schema compatibility check. It is only safe because every backend
# migration is required to follow an expand/contract (purely additive)
# contract: a migration must never DROP/RENAME a column or table, add a NOT
# NULL constraint without a default, or otherwise change shape in a way the
# OLD, still-serving canonical code cannot tolerate. A destructive migration
# landing here would corrupt/break the schema out from under the live
# canonical backend during the standby boot window, independent of whether
# Stage 1's readiness check subsequently passes or fails — standby-stage
# abort does not roll back a committed migration. This expand/contract contract
# is mechanically enforced by tools/ci/check-migration-ddl-compat.mjs in both PR
# CI and this deploy job's pre-checks (issue #2365), not by this script.
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/easysubway}"
DEPLOY_REPO_URL="${DEPLOY_REPO_URL:-https://github.com/AquilaXk/easysubway.git}"
DEPLOY_COMPOSE_PROJECT="${DEPLOY_COMPOSE_PROJECT:?DEPLOY_COMPOSE_PROJECT is required}"
DEPLOY_SHA="${DEPLOY_SHA:?DEPLOY_SHA is required}"
INCOMING_DIR="${INCOMING_DIR:?INCOMING_DIR is required}"
# GHCR image digest of the arm64 image the CD build-image job pushed for this
# SHA (issue #1686). The image is pulled and retagged as easysubway-backend:SHA
# by the CD deploy job before this script runs; here we only verify identity.
DEPLOY_IMAGE_DIGEST="${DEPLOY_IMAGE_DIGEST:?DEPLOY_IMAGE_DIGEST is required}"

case "${DEPLOY_SHA}" in
	*[!0-9a-f]*|"") printf 'invalid DEPLOY_SHA\n' >&2; exit 2 ;;
esac
if [[ ${#DEPLOY_SHA} -ne 40 ]]; then
	printf 'invalid DEPLOY_SHA length\n' >&2
	exit 2
fi
if [[ ! "${DEPLOY_IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
	printf 'invalid DEPLOY_IMAGE_DIGEST\n' >&2
	exit 2
fi
if [[ "${DEPLOY_REPO_URL}" != "https://github.com/AquilaXk/easysubway.git" ]]; then
	printf 'unexpected deploy repository URL\n' >&2
	exit 2
fi
if [[ ! "${DEPLOY_COMPOSE_PROJECT}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
	printf 'invalid DEPLOY_COMPOSE_PROJECT\n' >&2
	exit 2
fi
case "${INCOMING_DIR}" in
	"${DEPLOY_ROOT}"/incoming/*) ;;
	*) printf 'invalid INCOMING_DIR\n' >&2; exit 2 ;;
esac

REPOSITORY_DIR="${DEPLOY_ROOT}/repository"
SHARED_DIR="${DEPLOY_ROOT}/shared"
BACKUP_DIR="${DEPLOY_ROOT}/backups/postgres"
DIAGNOSTICS_DIR="${SHARED_DIR}/diagnostics"
STATE_FILE="${SHARED_DIR}/deployment-state.env"
RESULT_FILE="${SHARED_DIR}/last-result.env"
# Separate, informational-only key: which port (if any) a blue/green standby
# container is currently occupying, and whether it is the box actually
# serving public traffic (issue #2331). deployment-state.env's `phase` field
# stays the sole re-entrancy gate (see the `phase=completed` check below); this
# file never gates anything, it only makes the standby's state observable.
STANDBY_STATE_FILE="${SHARED_DIR}/deployment-standby-state.env"
LOCK_FILE="${DEPLOY_ROOT}/deploy.lock"

COMPOSE_ENV="${INCOMING_DIR}/compose.env"
BACKEND_ENV="${INCOMING_DIR}/backend.env"
RUNTIME_SERVICES=(backend back-worker route-v2-gateway)
OBSERVABILITY_SERVICES=(public-edge-probe docker-runtime-probe alertmanager prometheus loki grafana)
OBSERVABILITY_CONFIG_SERVICES=(alertmanager prometheus loki grafana)

# The image content sha (digest hex) replaces the former jar sha256 as the
# deployed-artifact identity; it flows into the compose metadata label.
image_digest_hex="${DEPLOY_IMAGE_DIGEST#sha256:}"
# Safety margin (seconds) for the timetable snapshot freshness precheck. If the
# candidate image's bundled snapshot expires within "now + margin", the new
# container would fail closed at boot or shortly after the deploy completes, so
# we abort before touching the running backend (issue #2330). 2h upper-bounds the
# build restart + propagation + health-check window.
SNAPSHOT_FRESHNESS_PRECHECK_MARGIN_SECONDS="${SNAPSHOT_FRESHNESS_PRECHECK_MARGIN_SECONDS:-7200}"
SNAPSHOT_EVIDENCE_PATH="backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json"

for file in "${COMPOSE_ENV}" "${BACKEND_ENV}"; do
	[[ -f "${file}" ]] || { printf 'missing staged file: %s\n' "${file}" >&2; exit 2; }
	chmod 600 "${file}"
done

mkdir -p "${REPOSITORY_DIR}" "${SHARED_DIR}/env-sets" "${DIAGNOSTICS_DIR}" "${BACKUP_DIR}"
chmod 700 "${SHARED_DIR}" "${SHARED_DIR}/env-sets" "${DIAGNOSTICS_DIR}" "${BACKUP_DIR}"

write_result() {
	local status="$1"
	local detail="${2:-none}"
	local tmp
	tmp="$(mktemp "${SHARED_DIR}/last-result.XXXXXX")"
	chmod 600 "${tmp}"
	{
		printf 'status=%s\n' "${status}"
		printf 'detail=%s\n' "${detail}"
		printf 'sha=%s\n' "${DEPLOY_SHA}"
	} > "${tmp}"
	mv "${tmp}" "${RESULT_FILE}"
}

write_phase() {
	local phase="$1"
	local tmp
	tmp="$(mktemp "${SHARED_DIR}/deployment-state.XXXXXX")"
	chmod 600 "${tmp}"
	{
		printf 'phase=%s\n' "${phase}"
		printf 'sha=%s\n' "${DEPLOY_SHA}"
	} > "${tmp}"
	mv "${tmp}" "${STATE_FILE}"
}

write_standby_state() {
	local phase="$1"
	local port="${2:-none}"
	local tmp
	tmp="$(mktemp "${SHARED_DIR}/deployment-standby-state.XXXXXX")"
	chmod 600 "${tmp}"
	{
		printf 'phase=%s\n' "${phase}"
		printf 'sha=%s\n' "${DEPLOY_SHA}"
		printf 'port=%s\n' "${port}"
	} > "${tmp}"
	mv "${tmp}" "${STANDBY_STATE_FILE}"
}

exec 9>"${LOCK_FILE}"
flock 9

# Reset the standby observability file at the start of every locked session
# (issue #2331 review). This is a "this attempt has started fresh" marker,
# not a live guarantee that no standby container exists: if a PRIOR run
# exited in a "*_standby_serving" degraded state (see the promotion recovery
# runbook below) and an operator has not yet followed it, a standby may still
# genuinely be serving production traffic even though this file now reads
# "idle" for the few seconds before this run either reaches Stage 1 itself or
# is blocked by an earlier gate (e.g. managed_image_drift, which a degraded
# exit's current-sha/canonical mismatch reliably triggers). Ground truth is
# always `docker ps`/`current-route-v2-ingress-enabled`, not this file — it
# only prevents a genuinely stale reading from lingering indefinitely across
# unrelated, already-blocked deploy attempts.
write_standby_state "idle"

if [[ -f "${STATE_FILE}" ]] && ! grep -qx 'phase=completed' "${STATE_FILE}"; then
	write_result "blocked" "interrupted_state"
	printf 'previous deployment state is incomplete\n' >&2
	exit 1
fi

cleanup() {
	rm -rf "${INCOMING_DIR}"
}
trap cleanup EXIT

if [[ ! -d "${REPOSITORY_DIR}/.git" ]]; then
	git clone "${DEPLOY_REPO_URL}" "${REPOSITORY_DIR}"
fi
cd "${REPOSITORY_DIR}"

origin_url="$(git config --get remote.origin.url)"
if [[ "${origin_url}" != "${DEPLOY_REPO_URL}" ]]; then
	write_result "failed" "repository_url_mismatch"
	exit 1
fi

timeout 120 git fetch origin main
if ! git merge-base --is-ancestor "${DEPLOY_SHA}" origin/main; then
	write_result "blocked" "target_not_on_main"
	exit 1
fi

current_sha=""
if [[ -f "${SHARED_DIR}/current-sha" ]]; then
	current_sha="$(cat "${SHARED_DIR}/current-sha")"
	if ! git merge-base --is-ancestor "${current_sha}" "${DEPLOY_SHA}"; then
		write_result "blocked" "downgrade_or_divergent"
		exit 1
	fi
fi

git checkout --detach "${DEPLOY_SHA}"
git clean -ffdx

read_env_value() {
	local file="$1"
	local name="$2"
	sed -nE "s/^${name}=//p" "${file}" | tail -n 1 | sed -E 's/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/'
}
yaml_quote() {
	local value="$1"
	value="${value//\\/\\\\}"
	value="${value//\"/\\\"}"
	printf '"%s"' "${value}"
}
is_truthy_compose_env() {
	local name="$1"
	case "$(read_env_value "${COMPOSE_ENV}" "${name}" | tr '[:upper:]' '[:lower:]')" in
		true|on|yes|1) true ;;
		*) false ;;
	esac
}
write_alertmanager_config() {
	local path="$1"
	if is_truthy_compose_env EASYSUBWAY_ALERT_EMAIL_ENABLED; then
		for name in EASYSUBWAY_ALERTMANAGER_EXTERNAL_URL EASYSUBWAY_ALERT_EMAIL_TO EASYSUBWAY_ALERT_EMAIL_FROM EASYSUBWAY_ALERT_SMTP_SMARTHOST EASYSUBWAY_ALERT_SMTP_USERNAME EASYSUBWAY_ALERT_SMTP_PASSWORD; do
			if [[ -z "$(read_env_value "${COMPOSE_ENV}" "${name}")" ]]; then
				write_result "blocked" "missing_${name}"
				exit 1
			fi
		done
		local require_tls
		require_tls="$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_SMTP_REQUIRE_TLS)"
		require_tls="${require_tls:-true}"
		require_tls="$(printf '%s' "${require_tls}" | tr '[:upper:]' '[:lower:]')"
		case "${require_tls}" in
			true|on|yes|1) require_tls=true ;;
			false|off|no|0) require_tls=false ;;
			*) write_result "blocked" "invalid_alert_smtp_require_tls"; exit 1 ;;
		esac
		{
			printf 'templates:\n'
			printf '  - /etc/alertmanager/templates/*.tmpl\n\n'
			printf 'route:\n'
			printf '  receiver: operations-email\n'
			printf '  group_by: ["alertname", "service", "job"]\n'
			printf '  group_wait: 30s\n'
			printf '  group_interval: 5m\n'
			printf '  repeat_interval: 3h\n\n'
			printf 'receivers:\n'
			printf '  - name: operations-email\n'
			printf '    email_configs:\n'
			printf '      - send_resolved: true\n'
			printf '        to: %s\n' "$(yaml_quote "$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_EMAIL_TO)")"
			printf '        from: %s\n' "$(yaml_quote "$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_EMAIL_FROM)")"
			printf '        smarthost: %s\n' "$(yaml_quote "$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_SMTP_SMARTHOST)")"
			printf '        auth_username: %s\n' "$(yaml_quote "$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_SMTP_USERNAME)")"
			printf '        auth_password: %s\n' "$(yaml_quote "$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ALERT_SMTP_PASSWORD)")"
			printf '        require_tls: %s\n' "${require_tls}"
			printf '        headers:\n'
			printf "          Subject: '{{ template \"easysubway.email.subject\" . }}'\n"
			printf "        text: '{{ template \"easysubway.email.text\" . }}'\n"
			printf "        html: '{{ template \"easysubway.email.html\" . }}'\n"
		} > "${path}"
	else
		{
			printf 'templates:\n'
			printf '  - /etc/alertmanager/templates/*.tmpl\n\n'
			printf 'route:\n'
			printf '  receiver: operations-null\n'
			printf '  group_by: ["alertname", "service", "job"]\n'
			printf '  group_wait: 30s\n'
			printf '  group_interval: 5m\n'
			printf '  repeat_interval: 3h\n\n'
			printf 'receivers:\n'
			printf '  - name: operations-null\n'
		} > "${path}"
	fi
}
ensure_backend_env_value() {
	local name="$1"
	local value="$2"
	if [[ -z "$(read_env_value "${BACKEND_ENV}" "${name}")" ]]; then
		printf '%s=%s\n' "${name}" "${value}" >> "${BACKEND_ENV}"
	fi
}
ensure_backend_env_value EASYSUBWAY_ADMIN_REVISION "${DEPLOY_SHA}"
ensure_backend_env_value EASYSUBWAY_ADMIN_MASTER_DATA_VERSION "${DEPLOY_SHA}"

backend_port="$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_BACKEND_PORT)"
backend_port="${backend_port:-8080}"
# Internal-only alternate port for the transient standby container used to
# validate a candidate image before it is promoted onto the canonical
# "backend" container name/port (issue #2331). Not operator-configurable via
# the deployment env allowlists — it never appears in nginx's steady-state
# config, only briefly during a deploy's promotion window.
backend_standby_port="$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_BACKEND_STANDBY_PORT)"
backend_standby_port="${backend_standby_port:-8082}"
route_v2_gateway_port="$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ROUTE_V2_GATEWAY_PORT)"
route_v2_gateway_port="${route_v2_gateway_port:-8081}"
route_v2_ingress_enabled="$(read_env_value "${COMPOSE_ENV}" EASYSUBWAY_ROUTE_V2_INGRESS_ENABLED | tr '[:upper:]' '[:lower:]')"
case "${route_v2_ingress_enabled}" in
	true|on|yes|1)
		route_v2_ingress_enabled_normalized=true
		route_v2_host_action="proxy_pass http://127.0.0.1:${route_v2_gateway_port};"
		;;
	""|false|off|no|0)
		route_v2_ingress_enabled_normalized=false
		route_v2_host_action="return 404;"
		;;
	*) printf 'invalid Route V2 ingress enabled value\n' >&2; exit 2 ;;
esac
# A prior signed-RC canary budget breach (issue #2095,
# tools/ops/verify-production-route-v2-canary-rollback.sh) closes Route V2
# ingress and leaves this lock so a routine, UNRELATED deploy cannot silently
# re-open it by re-rendering EASYSUBWAY_ROUTE_V2_INGRESS_ENABLED=true from
# compose.env's stale desired state. An operator must explicitly remove the
# lock file after investigating before ingress can open again.
route_v2_canary_rollback_lock="${SHARED_DIR}/route-v2-canary-rollback-lock.json"
if [[ -f "${route_v2_canary_rollback_lock}" ]]; then
	route_v2_ingress_enabled_normalized=false
	route_v2_host_action="return 404;"
	printf 'Route V2 ingress forced closed by canary rollback lock: %s\n' "${route_v2_canary_rollback_lock}" >&2
fi
report_upload_bucket="$(read_env_value "${BACKEND_ENV}" EASYSUBWAY_REPORT_UPLOAD_BUCKET)"
if [[ -z "${report_upload_bucket}" ]]; then
	write_result "blocked" "missing_report_upload_bucket"
	exit 1
fi

compose() {
	local backend_env="$1"
	local compose_env="$2"
	local image_tag="$3"
	shift 3
	EASYSUBWAY_BACKEND_ENV_FILE="${backend_env}" \
	EASYSUBWAY_BACKEND_IMAGE_TAG="${image_tag}" \
	EASYSUBWAY_BACKEND_JAR_SHA256="${image_digest_hex}" \
	EASYSUBWAY_ALERTMANAGER_CONFIG_FILE="${SHARED_DIR}/current-env/alertmanager.yml" \
	docker compose --project-name "${DEPLOY_COMPOSE_PROJECT}" --env-file "${compose_env}" -f infra/docker-compose.yml "$@"
}

compose_services_running() {
	local backend_env="$1"
	local compose_env="$2"
	local image_tag="$3"
	shift 3
	local service
	local container_id
	local running
	for service in "$@"; do
		container_id="$(compose "${backend_env}" "${compose_env}" "${image_tag}" ps -q "${service}" 2>/dev/null || true)"
		if [[ -z "${container_id}" ]]; then
			return 1
		fi
		running="$(docker inspect --format '{{.State.Running}}' "${container_id}" 2>/dev/null || true)"
		if [[ "${running}" != "true" ]]; then
			return 1
		fi
	done
}

start_observability_services() {
	local backend_env="$1"
	local compose_env="$2"
	local image_tag="$3"
	local recreate_alertmanager="$4"
	local recreate_config_services="$5"
	compose "${backend_env}" "${compose_env}" "${image_tag}" --profile observability up -d --no-build "${OBSERVABILITY_SERVICES[@]}" || return 1
	if [[ "${recreate_config_services}" -eq 1 ]]; then
		compose "${backend_env}" "${compose_env}" "${image_tag}" --profile observability up -d --no-build --force-recreate "${OBSERVABILITY_CONFIG_SERVICES[@]}" || return 1
	elif [[ "${recreate_alertmanager}" -eq 1 ]]; then
		compose "${backend_env}" "${compose_env}" "${image_tag}" --profile observability up -d --no-build --force-recreate alertmanager || return 1
	fi
}

verify_runtime_hardening() {
	local service="$1"
	local container_id=""
	local runtime_config=""
	local uid=""
	local gid=""
	local process_status=""
	local cap_eff=""
	local no_new_privs=""

	container_id="$(compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" ps -q "${service}" 2>/dev/null || true)"
	[[ -n "${container_id}" ]] || return 1
	runtime_config="$(docker inspect --format '{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{json .HostConfig.Tmpfs}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}' "${container_id}")"
	[[ "${runtime_config}" == '10001:10001|true|{"/tmp":"rw,nosuid,nodev"}|["ALL"]|["no-new-privileges:true"]' ]] || return 1

	uid="$(docker exec "${container_id}" id -u)"
	gid="$(docker exec "${container_id}" id -g)"
	[[ "${uid}:${gid}" == "10001:10001" ]] || return 1
	if docker exec "${container_id}" touch /app/app.jar >/dev/null 2>&1; then
		return 1
	fi
	docker exec "${container_id}" sh -c 'probe="$(mktemp /tmp/easysubway-hardening.XXXXXX)" && rm -f "$probe"' || return 1

	process_status="$(docker exec "${container_id}" cat /proc/1/status)"
	cap_eff="$(awk '$1 == "CapEff:" { print $2 }' <<<"${process_status}")"
	no_new_privs="$(awk '$1 == "NoNewPrivs:" { print $2 }' <<<"${process_status}")"
	[[ "${cap_eff}" == "0000000000000000" && "${no_new_privs}" == "1" ]] || return 1

	printf 'runtime_hardening service=%s uid=%s gid=%s rootfs=read-only tmpfs=/tmp cap_eff=%s no_new_privs=%s image_digest=%s\n' \
		"${service}" "${uid}" "${gid}" "${cap_eff}" "${no_new_privs}" "${DEPLOY_IMAGE_DIGEST}"
}

runtime_services_hardened() {
	local service
	for service in "$@"; do
		verify_runtime_hardening "${service}" || return 1
	done
}

compose "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" config --quiet

LEGACY_BACKEND_UNIT="easysubway-backend.service"
LEGACY_BACKEND_JAR="${DEPLOY_ROOT}/easysubway-backend.jar"
legacy_backend_was_active=0
legacy_backend_was_enabled=0
legacy_restore_on_error=0

restore_legacy_backend_service() {
	if [[ "${legacy_backend_was_enabled}" -eq 1 ]]; then
		sudo -n systemctl enable "${LEGACY_BACKEND_UNIT}" >/dev/null || return 1
	fi
	if [[ "${legacy_backend_was_active}" -eq 1 ]]; then
		sudo -n systemctl start "${LEGACY_BACKEND_UNIT}" || return 1
	fi
}

restore_legacy_on_unhandled_error() {
	local exit_code="$?"
	trap - ERR INT TERM HUP
	if [[ "${legacy_restore_on_error}" -eq 1 ]]; then
		restore_legacy_backend_service || true
		write_result "failed" "legacy_restore_unhandled_error" || true
		write_phase "interrupted" || true
	fi
	exit "${exit_code}"
}

restore_legacy_on_interruption() {
	local signal="$1"
	local exit_code=130
	local detail="legacy_restore_interrupted_int"
	case "${signal}" in
		HUP) exit_code=129; detail="legacy_restore_interrupted_hup" ;;
		TERM) exit_code=143; detail="legacy_restore_interrupted_term" ;;
	esac
	trap - ERR INT TERM HUP
	if [[ "${legacy_restore_on_error}" -eq 1 ]]; then
		restore_legacy_backend_service || true
		write_result "failed" "${detail}" || true
		write_phase "interrupted" || true
	fi
	exit "${exit_code}"
}

stop_legacy_backend_service() {
	if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${LEGACY_BACKEND_UNIT}" --no-pager --no-legend 2>/dev/null | grep -q "^${LEGACY_BACKEND_UNIT}"; then
		if systemctl is-active --quiet "${LEGACY_BACKEND_UNIT}"; then
			legacy_backend_was_active=1
			if ! sudo -n systemctl stop "${LEGACY_BACKEND_UNIT}"; then
				write_result "failed" "legacy_backend_stop_failed"
				write_phase "completed"
				exit 1
			fi
		fi
		if systemctl is-enabled --quiet "${LEGACY_BACKEND_UNIT}"; then
			legacy_backend_was_enabled=1
			if ! sudo -n systemctl disable "${LEGACY_BACKEND_UNIT}" >/dev/null; then
				restore_legacy_backend_service || true
				write_result "failed" "legacy_backend_disable_failed"
				write_phase "completed"
				exit 1
			fi
		fi
	fi

	if pgrep -f "java -jar ${LEGACY_BACKEND_JAR}" >/dev/null; then
		restore_legacy_backend_service || true
		write_result "blocked" "legacy_backend_still_running"
		write_phase "completed"
		exit 1
	fi
}

EASYSUBWAY_BACKEND_ENV_FILE="${BACKEND_ENV}" \
EASYSUBWAY_BACKEND_IMAGE_TAG="${DEPLOY_SHA}" \
EASYSUBWAY_BACKEND_JAR_SHA256="${image_digest_hex}" \
	timeout 600 docker compose --project-name "${DEPLOY_COMPOSE_PROJECT}" --env-file "${COMPOSE_ENV}" -f infra/docker-compose.yml up -d --no-build postgres object-storage

wait_stateful_service() {
	local service="$1"
	local container_id=""
	local label_project=""
	local label_service=""
	local health=""
	for _ in $(seq 1 60); do
		container_id="$(compose "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" ps -q "${service}" || true)"
		if [[ -n "${container_id}" ]]; then
			label_project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "${container_id}")"
			label_service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "${container_id}")"
			if [[ "${label_project}" != "${DEPLOY_COMPOSE_PROJECT}" || "${label_service}" != "${service}" ]]; then
				write_result "blocked" "stateful_${service}_drift"
				exit 1
			fi
			health="$(docker inspect --format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}missing{{ end }}' "${container_id}")"
			if [[ "${health}" == "healthy" ]]; then
				return 0
			fi
		fi
		sleep 5
	done
	write_result "blocked" "stateful_${service}_unhealthy"
	exit 1
}

for service in postgres object-storage; do
	wait_stateful_service "${service}"
done

if ! compose "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" exec -T \
	-e REPORT_UPLOAD_BUCKET="${report_upload_bucket}" \
	object-storage sh -lc 'mc alias set local http://127.0.0.1:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null && mc mb --ignore-existing "local/${REPORT_UPLOAD_BUCKET}" >/dev/null'; then
	write_result "failed" "report_upload_bucket_init_failed"
	exit 1
fi

backend_id="$(compose "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" ps -q backend || true)"
back_worker_id="$(compose "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" ps -q back-worker || true)"
if [[ -z "${current_sha}" && ( -n "${backend_id}" || -n "${back_worker_id}" ) ]]; then
	write_result "blocked" "unmanaged_backend"
	exit 1
fi
if [[ -n "${current_sha}" ]]; then
	current_image_id="$(docker image inspect "easysubway-backend:${current_sha}" --format '{{.Id}}' 2>/dev/null || true)"
	running_image_id=""
	if [[ -n "${backend_id}" ]]; then
		running_image_id="$(docker inspect --format '{{.Image}}' "${backend_id}" 2>/dev/null || true)"
	fi
	if [[ -z "${backend_id}" || -z "${current_image_id}" || "${running_image_id}" != "${current_image_id}" ]]; then
		write_result "blocked" "managed_image_drift"
		exit 1
	fi
	if [[ -n "${back_worker_id}" ]]; then
		running_worker_image_id="$(docker inspect --format '{{.Image}}' "${back_worker_id}" 2>/dev/null || true)"
		if [[ "${running_worker_image_id}" != "${current_image_id}" ]]; then
			write_result "blocked" "managed_image_drift"
			exit 1
		fi
	fi
fi

target_env_hash="$(
	{
		printf 'compose.env\0'
		sha256sum "${COMPOSE_ENV}" | cut -d ' ' -f 1
		printf '\nbackend.env\0'
		sha256sum "${BACKEND_ENV}" | cut -d ' ' -f 1
		printf '\n'
	} | sha256sum | cut -d ' ' -f 1
)"
current_env_hash=""
if [[ -f "${SHARED_DIR}/current-env/metadata.env" ]]; then
	current_env_hash="$(sed -n 's/^env_hash=//p' "${SHARED_DIR}/current-env/metadata.env")"
fi
recreate_alertmanager=0
if [[ "${current_env_hash}" != "${target_env_hash}" ]]; then
	recreate_alertmanager=1
fi
recreate_observability_config=0
if [[ -z "${current_sha}" ]]; then
	recreate_observability_config=1
elif ! git diff --quiet "${current_sha}" "${DEPLOY_SHA}" -- infra/prometheus infra/alertmanager/templates infra/loki infra/grafana/provisioning; then
	recreate_observability_config=1
fi

if [[ "${current_sha}" == "${DEPLOY_SHA}" && "${current_env_hash}" == "${target_env_hash}" ]]; then
	if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${backend_port}/actuator/health/readiness" >/dev/null 2>&1 \
		&& compose_services_running "${BACKEND_ENV}" "${COMPOSE_ENV}" "${DEPLOY_SHA}" "${RUNTIME_SERVICES[@]}" "${OBSERVABILITY_SERVICES[@]}" \
		&& runtime_services_hardened "${RUNTIME_SERVICES[@]}"; then
		write_phase "completed"
		write_result "noop" "same_sha_same_env_services_ready"
		exit 0
	fi
fi

# build-once, deploy-same: the arm64 image was built and pushed to GHCR by the
# CD build-image job, then pulled and retagged as easysubway-backend:SHA by the
# CD deploy job. There is no on-server build; we only verify the pulled image is
# exactly the digest CI produced, and that it carries the expected revision.
if ! docker image inspect "easysubway-backend:${DEPLOY_SHA}" >/dev/null 2>&1; then
	write_result "blocked" "image_missing"
	exit 1
fi
repo_digests="$(docker image inspect "easysubway-backend:${DEPLOY_SHA}" --format '{{join .RepoDigests "\n"}}' 2>/dev/null || true)"
if ! grep -qF "@${DEPLOY_IMAGE_DIGEST}" <<<"${repo_digests}"; then
	write_result "blocked" "image_digest_mismatch"
	exit 1
fi
image_revision="$(docker image inspect "easysubway-backend:${DEPLOY_SHA}" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
if [[ "${image_revision}" != "${DEPLOY_SHA}" ]]; then
	write_result "blocked" "image_revision_mismatch"
	exit 1
fi

# Timetable snapshot freshness precheck (issue #2330). The candidate commit's
# bundled snapshot evidence is what gets baked into the image; if its freshUntil
# is already past or expires within the deploy-completion margin, booting the new
# container fails closed and would destroy the running service. Run this before
# any container swap — the running backend is still untouched here (postgres and
# object-storage were only started idempotently), so a stale candidate aborts the
# deploy with the existing backend left intact. Fail closed on any error.
if ! node tools/deploy/check-snapshot-freshness-precheck.mjs \
	"${SNAPSHOT_EVIDENCE_PATH}" \
	--margin-seconds "${SNAPSHOT_FRESHNESS_PRECHECK_MARGIN_SECONDS}"; then
	write_result "blocked" "stale_snapshot_precheck_failed"
	exit 1
fi

needs_backup=0
if [[ -z "${current_sha}" ]]; then
	needs_backup=1
elif git diff --name-only "${current_sha}" "${DEPLOY_SHA}" -- backend/src/main/resources/db/migration/postgresql | grep -q .; then
	needs_backup=1
fi
if [[ "${needs_backup}" -eq 1 ]]; then
	EASYSUBWAY_ENV_FILE="${COMPOSE_ENV}" \
	EASYSUBWAY_COMPOSE_FILE="${REPOSITORY_DIR}/infra/docker-compose.yml" \
	EASYSUBWAY_COMPOSE_PROJECT="${DEPLOY_COMPOSE_PROJECT}" \
	EASYSUBWAY_BACKEND_ENV_FILE="${BACKEND_ENV}" \
	EASYSUBWAY_BACKUP_DIR="${BACKUP_DIR}" \
		timeout 300 tools/ops/postgres-backup.sh
fi

stop_legacy_backend_service
legacy_restore_on_error=1
trap restore_legacy_on_unhandled_error ERR
trap 'restore_legacy_on_interruption INT' INT
trap 'restore_legacy_on_interruption TERM' TERM
trap 'restore_legacy_on_interruption HUP' HUP

write_phase "started"
env_set="${SHARED_DIR}/env-sets/${DEPLOY_SHA}-${target_env_hash}-$(date -u +%Y%m%dT%H%M%SZ)"
tmp_env_set="${env_set}.tmp"
rm -rf "${tmp_env_set}"
mkdir -p "${tmp_env_set}"
chmod 700 "${tmp_env_set}"
cp "${COMPOSE_ENV}" "${tmp_env_set}/compose.env"
cp "${BACKEND_ENV}" "${tmp_env_set}/backend.env"
write_alertmanager_config "${tmp_env_set}/alertmanager.yml"
{
	printf 'sha=%s\n' "${DEPLOY_SHA}"
	printf 'image_digest=%s\n' "${DEPLOY_IMAGE_DIGEST}"
	printf 'env_hash=%s\n' "${target_env_hash}"
} > "${tmp_env_set}/metadata.env"
chmod 600 "${tmp_env_set}/compose.env" "${tmp_env_set}/backend.env" "${tmp_env_set}/metadata.env"
# Alertmanager runs as nobody in the official image; the private env-set directory keeps this config scoped.
chmod 644 "${tmp_env_set}/alertmanager.yml"
# Capture whatever current-env pointed at (if anything) BEFORE swapping it to
# this run's candidate env-set, so a pre-promotion standby-stage abort can put
# it back (see abort_standby_stage below, issue #2331 review). This matters
# because Stage 1-2 (standby boot + Nginx switch) must already read the NEW
# env-set through current-env to build the standby with the candidate SHA's
# config — the swap can't simply be deferred until promotion succeeds without
# threading a second env-file path through every compose() call in those
# stages. Restoring on abort is the smaller, scoped fix: it corrects the
# externally-visible "current-env = what canonical is actually running"
# invariant (tools/ops/verify-production-route-v2-capacity.sh and
# verify-production-route-v2-canary-rollback.sh both read
# current-env/compose.env as ground truth) for exactly the window where that
# invariant would otherwise be wrong — before canonical is ever touched.
# Post-promotion "*_standby_serving" degraded exits deliberately do NOT
# restore this: by then the standby (already running the new SHA) is what is
# actually serving, so current-env pointing at the new env-set is correct.
previous_env_set=""
if [[ -L "${SHARED_DIR}/current-env" ]]; then
	previous_env_set="$(readlink "${SHARED_DIR}/current-env")"
fi
mv "${tmp_env_set}" "${env_set}"
ln -sfn "${env_set}" "${SHARED_DIR}/current-env.next"
mv -Tf "${SHARED_DIR}/current-env.next" "${SHARED_DIR}/current-env"

wait_backend_http_ready() {
	local port="$1"
	local _attempt
	for _attempt in $(seq 1 60); do
		if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${port}/actuator/health/readiness" >/dev/null 2>&1; then
			return 0
		fi
		sleep 5
	done
	return 1
}

dump_diagnostics() {
	local tag="$1"
	local profile="$2"
	shift 2
	local diagnostic
	diagnostic="$(mktemp "${DIAGNOSTICS_DIR}/${DEPLOY_SHA}-${tag}-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.log")"
	chmod 600 "${diagnostic}"
	if [[ -n "${profile}" ]]; then
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" --profile "${profile}" ps > "${diagnostic}" 2>&1 || true
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" --profile "${profile}" logs --no-color --tail=200 "$@" >> "${diagnostic}" 2>&1 || true
	else
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" ps > "${diagnostic}" 2>&1 || true
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" logs --no-color --tail=200 "$@" >> "${diagnostic}" 2>&1 || true
	fi
	chmod 600 "${diagnostic}"
}

cleanup_standby() {
	compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" rm -f -s backend-standby || true
}

abort_deploy() {
	local detail="$1"
	write_result "failed" "${detail}"
	printf '%s\n' "${DEPLOY_SHA}" > "${SHARED_DIR}/failed-sha"
	write_phase "completed"
}

# Only reachable from the pre-promotion standby stages below, where the
# canonical "backend" container has not been touched at all. If this is the
# very first managed deploy (current_sha empty) and stop_legacy_backend_service
# above stopped/disabled the pre-Docker systemd unit, that unit is the only
# thing that could still serve traffic — restore it, mirroring the safety net
# the old rollback path used to provide for that same narrow case. Once
# promotion has started, canonical "backend" is Docker-managed territory
# regardless of current_sha history, so later failure branches do not call
# this (see the "leave nginx pointed at the proven-healthy standby" comment
# below instead).
#
# Also restores current-env to whatever it pointed at before this run staged
# its candidate env-set (issue #2331 review): the canonical container was
# never touched in this path, so current-env must keep describing that
# untouched, actually-running config — otherwise the next deploy's same-SHA
# no-op/alertmanager-recreate decisions, and external tools that read
# current-env/compose.env as ground truth (verify-production-route-v2-capacity.sh,
# verify-production-route-v2-canary-rollback.sh), would compute against an
# uncommitted candidate env instead of what canonical is actually running.
abort_standby_stage() {
	local detail="$1"
	if [[ -n "${previous_env_set}" ]]; then
		ln -sfn "${previous_env_set}" "${SHARED_DIR}/current-env.next"
		mv -Tf "${SHARED_DIR}/current-env.next" "${SHARED_DIR}/current-env"
	else
		rm -f "${SHARED_DIR}/current-env"
	fi
	if [[ -z "${current_sha}" && ( "${legacy_backend_was_active}" -eq 1 || "${legacy_backend_was_enabled}" -eq 1 ) ]]; then
		if restore_legacy_backend_service; then
			abort_deploy "${detail}_legacy_restore_attempted"
		else
			abort_deploy "${detail}_legacy_restore_failed"
		fi
	else
		abort_deploy "${detail}"
	fi
}

install_route_v2_host_ingress() {
	local target_backend_port="$1"
	local site_target="/etc/nginx/sites-available/easysubway"
	local route_snippet_target="/etc/nginx/snippets/easysubway-route-v2-proxy.conf"
	local default_snippet_target="/etc/nginx/snippets/easysubway-default-proxy.conf"
	local candidate site_backup route_snippet_backup default_snippet_backup
	local site_existed=0 route_snippet_existed=0 default_snippet_existed=0
	local install_failed=0 restore_failed=0
	if ! candidate="$(mktemp)"; then
		return 1
	fi
	if ! site_backup="$(mktemp)"; then
		rm -f "${candidate}"
		return 1
	fi
	if ! route_snippet_backup="$(mktemp)"; then
		rm -f "${candidate}" "${site_backup}"
		return 1
	fi
	if ! default_snippet_backup="$(mktemp)"; then
		rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}"
		return 1
	fi
	if ! sed \
		-e "s/__BACKEND_PORT__/${target_backend_port}/g" \
		-e "s|__ROUTE_V2_ACTION__|${route_v2_host_action}|g" \
		infra/nginx/host-easysubway.conf.template > "${candidate}"; then
		rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
		return 1
	fi
	if sudo test -f "${site_target}"; then
		if ! sudo cp "${site_target}" "${site_backup}"; then
			rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
			return 1
		fi
		site_existed=1
	fi
	if sudo test -f "${route_snippet_target}"; then
		if ! sudo cp "${route_snippet_target}" "${route_snippet_backup}"; then
			rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
			return 1
		fi
		route_snippet_existed=1
	fi
	if sudo test -f "${default_snippet_target}"; then
		if ! sudo cp "${default_snippet_target}" "${default_snippet_backup}"; then
			rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
			return 1
		fi
		default_snippet_existed=1
	fi
	if ! sudo install -m 0644 infra/nginx/host-route-v2-proxy.conf "${route_snippet_target}"; then
		install_failed=1
	fi
	if [[ "${install_failed}" -eq 0 ]] && ! sudo install -m 0644 infra/nginx/host-default-proxy.conf "${default_snippet_target}"; then
		install_failed=1
	fi
	if [[ "${install_failed}" -eq 0 ]] && ! sudo install -m 0644 "${candidate}" "${site_target}"; then
		install_failed=1
	fi
	if [[ "${install_failed}" -eq 0 ]] && ! sudo nginx -t >/dev/null 2>&1; then
		install_failed=1
	fi
	if [[ "${install_failed}" -eq 0 ]] && ! sudo systemctl reload nginx; then
		install_failed=1
	fi
	if [[ "${install_failed}" -ne 0 ]]; then
		if [[ "${site_existed}" -eq 1 ]]; then
			if ! sudo install -m 0644 "${site_backup}" "${site_target}"; then restore_failed=1; fi
		else
			if ! sudo rm -f "${site_target}"; then restore_failed=1; fi
		fi
		if [[ "${route_snippet_existed}" -eq 1 ]]; then
			if ! sudo install -m 0644 "${route_snippet_backup}" "${route_snippet_target}"; then restore_failed=1; fi
		else
			if ! sudo rm -f "${route_snippet_target}"; then restore_failed=1; fi
		fi
		if [[ "${default_snippet_existed}" -eq 1 ]]; then
			if ! sudo install -m 0644 "${default_snippet_backup}" "${default_snippet_target}"; then restore_failed=1; fi
		else
			if ! sudo rm -f "${default_snippet_target}"; then restore_failed=1; fi
		fi
		if [[ "${restore_failed}" -eq 0 ]] && ! sudo nginx -t >/dev/null 2>&1; then
			restore_failed=1
		fi
		if [[ "${restore_failed}" -eq 0 ]] && ! sudo systemctl reload nginx; then
			restore_failed=1
		fi
		rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
		if [[ "${restore_failed}" -ne 0 ]]; then
			printf 'failed to restore Route V2 host ingress\n' >&2
		fi
		return 1
	fi
	rm -f "${candidate}" "${site_backup}" "${route_snippet_backup}" "${default_snippet_backup}"
}

# --- Stage 1: bring up a standby container on an alternate port running the
# candidate image and validate it end-to-end, entirely without touching the
# running canonical "backend" container (issue #2331). If anything in this
# stage fails, the canonical container and Nginx are left completely alone —
# the deploy fails with the old backend still fully serving. There is
# deliberately no "restart the previous image" fallback here: that path is
# exactly what this issue removes, because the standby step already proves
# whether the candidate image can serve before anything live is touched.
write_phase "standby_starting"
write_standby_state "starting" "${backend_standby_port}"
if ! compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" up -d --no-deps --no-build --force-recreate backend-standby; then
	cleanup_standby
	write_standby_state "idle"
	abort_standby_stage "standby_start_failed"
	exit 1
fi
if ! runtime_services_hardened backend-standby; then
	dump_diagnostics "standby" "" backend-standby
	cleanup_standby
	write_standby_state "idle"
	abort_standby_stage "standby_hardening_failed"
	exit 1
fi
if ! wait_backend_http_ready "${backend_standby_port}"; then
	dump_diagnostics "standby" "" backend-standby
	cleanup_standby
	write_standby_state "idle"
	abort_standby_stage "standby_readiness_failed"
	exit 1
fi
write_phase "standby_ready"
write_standby_state "ready" "${backend_standby_port}"

# --- Stage 2: the standby is proven healthy on the candidate image. Point
# host Nginx's default location at the standby port so public traffic keeps
# flowing while the canonical "backend" container is torn down and recreated
# below — the window that used to be a hard outage (force-recreate before any
# validation).
if ! install_route_v2_host_ingress "${backend_standby_port}"; then
	cleanup_standby
	write_standby_state "idle"
	abort_standby_stage "nginx_alt_switch_failed"
	exit 1
fi
write_phase "nginx_alt"
write_standby_state "nginx_alt" "${backend_standby_port}"

# --- Stage 3: promote — recreate the canonical "backend" container with the
# candidate image while the standby keeps serving public traffic. A failure
# here is the one case where the standby is deliberately left serving as the
# terminal state instead of being cleaned up: the candidate image already
# proved itself on the standby, so a promotion failure here points at
# infra/resource trouble (e.g. two backend containers briefly competing for
# host resources), not at the image — and there is no previous-image restart
# to fall back to. The safest available state is "leave the proven-healthy
# standby serving and stop", recorded with a distinct "_standby_serving"
# detail so an operator can find it.
#
# Manual recovery runbook for a "*_standby_serving" degraded exit
# (canonical_promotion_failed_standby_serving / canonical_hardening_failed_standby_serving /
# canonical_readiness_failed_standby_serving / nginx_canonical_switchback_failed_standby_serving,
# issue #2331 review):
#   1. Symptom: last-result.env's detail ends in "_standby_serving". Public
#      traffic is fine — Nginx is on the standby (candidate SHA), which is
#      already proven healthy. Canonical "backend" is broken, stopped, or
#      still on the old SHA.
#   2. ${SHARED_DIR}/current-sha still names the OLD SHA (never advanced,
#      because promotion did not complete) while canonical/standby may
#      actually be on the new one. This is why the NEXT automatic deploy
#      attempt is expected to be blocked by managed_image_drift — it is not a
#      bug, it is this design's fail-closed guard against retrying blindly
#      over an inconsistent ledger.
#   3. Investigate why canonical promotion/hardening/readiness failed (check
#      the diagnostics log dump_diagnostics wrote under
#      ${DIAGNOSTICS_DIR}/${DEPLOY_SHA}-canonical-*.log — usually host
#      resource pressure from the standby+canonical overlap, not the image).
#   4. Once resolved, re-promote canonical manually with the same compose
#      invocation this stage uses (`... up -d --no-deps --no-build
#      --force-recreate backend`) against ${SHARED_DIR}/current-env, or simply
#      redeploy the same DEPLOY_SHA through the normal CD pipeline once the
#      drift block is cleared.
#   5. Confirm canonical is healthy, then switch Nginx back to the canonical
#      port (this script's install_route_v2_host_ingress logic, or the
#      equivalent manual sed+install+reload) and stop/remove backend-standby.
#   6. Only after canonical is confirmed to match what is actually deployed
#      should ${SHARED_DIR}/current-sha be corrected to match, unblocking
#      normal automated deploys again.
write_phase "promoting"
# Promotion recreates the canonical Docker container on the same port the
# pre-Docker legacy systemd unit used to own. From here on, a legacy-restore
# trap firing (e.g. on an unrelated crash mid-promotion) would try to start
# that legacy jar on a port the Docker canonical container may already hold —
# disarm it now; abort_standby_stage (the only caller of
# restore_legacy_backend_service) is unreachable past this point (issue #2331
# review).
legacy_restore_on_error=0
if ! compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" up -d --no-deps --no-build --force-recreate backend; then
	write_standby_state "serving_standby_degraded" "${backend_standby_port}"
	abort_deploy "canonical_promotion_failed_standby_serving"
	exit 1
fi
if ! runtime_services_hardened backend; then
	dump_diagnostics "canonical" "" backend
	write_standby_state "serving_standby_degraded" "${backend_standby_port}"
	abort_deploy "canonical_hardening_failed_standby_serving"
	exit 1
fi
if ! wait_backend_http_ready "${backend_port}"; then
	dump_diagnostics "canonical" "" backend
	write_standby_state "serving_standby_degraded" "${backend_standby_port}"
	abort_deploy "canonical_readiness_failed_standby_serving"
	exit 1
fi
write_phase "promoted"

# --- Stage 4: the canonical container is proven healthy on the candidate
# image. Switch host Nginx back to the canonical port. If this switch itself
# fails, both the canonical and the standby are healthy — install_route_v2_host_ingress
# already attempted to restore whatever Nginx had immediately before this
# call (i.e. pointed at the standby), so public traffic keeps flowing either
# way; the standby is deliberately left running (not cleaned up) so this
# stays true, again recorded with a "_standby_serving" detail.
if ! install_route_v2_host_ingress "${backend_port}"; then
	write_standby_state "serving_standby_degraded" "${backend_standby_port}"
	abort_deploy "nginx_canonical_switchback_failed_standby_serving"
	exit 1
fi

printf '%s\n' "${route_v2_ingress_enabled_normalized}" > "${SHARED_DIR}/current-route-v2-ingress-enabled"
chmod 600 "${SHARED_DIR}/current-route-v2-ingress-enabled"

# --- Stage 5: Nginx is back on the canonical port and the standby is no
# longer needed. Retire it promptly — it is pure standby-window memory
# overhead on the host (issue #2331 background).
write_phase "standby_cleanup"
if ! compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" rm -f -s backend-standby; then
	write_standby_state "orphaned" "${backend_standby_port}"
	abort_deploy "standby_cleanup_failed"
	exit 1
fi
write_standby_state "idle"

# --- Stage 6: recreate the remaining runtime services. Neither sits behind
# host Nginx's default location (already switched back to canonical above),
# so their recreation is not on the zero-downtime path: back-worker has no
# external HTTP exposure at all, and route-v2-gateway's brief restart only
# affects the two Route V2 endpoints, which already have their own
# canary/rollback safety net (issue #2095/#2337). The canonical backend is
# already promoted and serving at this point, so a failure here is reported
# without touching it further.
write_phase "finalizing"
if ! compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" up -d --no-deps --no-build --force-recreate back-worker route-v2-gateway; then
	dump_diagnostics "back-worker-gateway" "" back-worker route-v2-gateway
	abort_deploy "back_worker_gateway_recreate_failed"
	exit 1
fi
if ! runtime_services_hardened back-worker route-v2-gateway; then
	dump_diagnostics "back-worker-gateway" "" back-worker route-v2-gateway
	abort_deploy "back_worker_gateway_hardening_failed"
	exit 1
fi

if ! start_observability_services "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" "${recreate_alertmanager}" "${recreate_observability_config}"; then
	abort_deploy "observability_start_failed"
	exit 1
fi

observability_ready=0
for _ in $(seq 1 12); do
	if compose_services_running "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" "${RUNTIME_SERVICES[@]}" "${OBSERVABILITY_SERVICES[@]}"; then
		observability_ready=1
		break
	fi
	sleep 5
done

if [[ "${observability_ready}" -ne 1 ]]; then
	dump_diagnostics "observability" "observability" "${RUNTIME_SERVICES[@]}" "${OBSERVABILITY_SERVICES[@]}"
	abort_deploy "observability_readiness_failed"
	exit 1
fi

legacy_restore_on_error=0
trap - ERR INT TERM HUP

printf '%s\n' "${DEPLOY_SHA}" > "${SHARED_DIR}/current-sha"
printf '%s\n' "${DEPLOY_IMAGE_DIGEST}" > "${SHARED_DIR}/current-image-digest"
chmod 600 "${SHARED_DIR}/current-sha" "${SHARED_DIR}/current-image-digest"
write_phase "completed"
write_result "success" "backend_ready"
