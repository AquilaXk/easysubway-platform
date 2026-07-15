#!/usr/bin/env bash
set -Eeuo pipefail

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
LOCK_FILE="${DEPLOY_ROOT}/deploy.lock"

COMPOSE_ENV="${INCOMING_DIR}/compose.env"
BACKEND_ENV="${INCOMING_DIR}/backend.env"
RUNTIME_SERVICES=(backend back-worker)
OBSERVABILITY_SERVICES=(public-edge-probe docker-runtime-probe alertmanager prometheus loki grafana)
OBSERVABILITY_CONFIG_SERVICES=(alertmanager prometheus loki grafana)

# The image content sha (digest hex) replaces the former jar sha256 as the
# deployed-artifact identity; it flows into the compose metadata label.
image_digest_hex="${DEPLOY_IMAGE_DIGEST#sha256:}"
# GHCR repository the CD build-image job pushes to; used as the rollback source
# of truth when a previous image is no longer in the server-local cache.
GHCR_IMAGE="${DEPLOY_GHCR_IMAGE:-ghcr.io/aquilaxk/easysubway-backend}"

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

exec 9>"${LOCK_FILE}"
flock 9

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
	for service in "${RUNTIME_SERVICES[@]}"; do
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
		&& runtime_services_hardened; then
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
mv "${tmp_env_set}" "${env_set}"
if [[ -L "${SHARED_DIR}/current-env" ]]; then
	previous_target="$(readlink "${SHARED_DIR}/current-env")"
	ln -sfn "${previous_target}" "${SHARED_DIR}/previous-env"
fi
ln -sfn "${env_set}" "${SHARED_DIR}/current-env.next"
mv -Tf "${SHARED_DIR}/current-env.next" "${SHARED_DIR}/current-env"

ensure_rollback_image() {
	local sha="$1"
	if docker image inspect "easysubway-backend:${sha}" >/dev/null 2>&1; then
		return 0
	fi
	# Local image was pruned; restore it from GHCR using the digest recorded when
	# that SHA was deployed (issue #1686 — removes server-local cache dependence).
	local prev_digest=""
	if [[ -f "${SHARED_DIR}/previous-env/metadata.env" ]]; then
		prev_digest="$(sed -n 's/^image_digest=//p' "${SHARED_DIR}/previous-env/metadata.env")"
	fi
	if [[ ! "${prev_digest}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
		return 1
	fi
	if ! timeout 300 docker pull "${GHCR_IMAGE}@${prev_digest}" >/dev/null 2>&1; then
		return 1
	fi
	docker tag "${GHCR_IMAGE}@${prev_digest}" "easysubway-backend:${sha}"
}

fail_backend_deployment() {
	local detail="$1"
	if [[ -n "${current_sha}" && -L "${SHARED_DIR}/previous-env" ]]; then
		ln -sfn "$(readlink "${SHARED_DIR}/previous-env")" "${SHARED_DIR}/current-env.next"
		mv -Tf "${SHARED_DIR}/current-env.next" "${SHARED_DIR}/current-env"
		ensure_rollback_image "${current_sha}" || true
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${current_sha}" up -d --no-deps --no-build "${RUNTIME_SERVICES[@]}" || true
		start_observability_services "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${current_sha}" "${recreate_alertmanager}" "${recreate_observability_config}" || true
		write_result "failed" "${detail}_rollback_attempted"
	else
		compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" rm -f -s "${RUNTIME_SERVICES[@]}" || true
		if [[ "${legacy_backend_was_active}" -eq 1 || "${legacy_backend_was_enabled}" -eq 1 ]]; then
			if restore_legacy_backend_service; then
				write_result "failed" "${detail}_legacy_restore_attempted"
			else
				write_result "failed" "${detail}_legacy_restore_failed"
			fi
		else
			write_result "failed" "${detail}_rollback_unavailable"
		fi
	fi
	write_phase "completed"
	printf '%s\n' "${DEPLOY_SHA}" > "${SHARED_DIR}/failed-sha"
}

write_phase "restarting"
if ! compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" up -d --no-deps --no-build "${RUNTIME_SERVICES[@]}"; then
	fail_backend_deployment "backend_start_failed"
	exit 1
fi
if ! start_observability_services "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" "${recreate_alertmanager}" "${recreate_observability_config}"; then
	fail_backend_deployment "observability_start_failed"
	exit 1
fi
if ! runtime_services_hardened; then
	fail_backend_deployment "runtime_hardening_failed"
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
	diagnostic="$(mktemp "${DIAGNOSTICS_DIR}/${DEPLOY_SHA}-observability-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.log")"
	chmod 600 "${diagnostic}"
	compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" --profile observability ps > "${diagnostic}" 2>&1 || true
	compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" --profile observability logs --no-color --tail=200 "${RUNTIME_SERVICES[@]}" "${OBSERVABILITY_SERVICES[@]}" >> "${diagnostic}" 2>&1 || true
	chmod 600 "${diagnostic}"
	fail_backend_deployment "observability_readiness_failed"
	exit 1
fi

ready=0
for _ in $(seq 1 60); do
	if curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:${backend_port}/actuator/health/readiness" >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 5
done

if [[ "${ready}" -ne 1 ]]; then
	diagnostic="$(mktemp "${DIAGNOSTICS_DIR}/${DEPLOY_SHA}-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.log")"
	chmod 600 "${diagnostic}"
	compose "${SHARED_DIR}/current-env/backend.env" "${SHARED_DIR}/current-env/compose.env" "${DEPLOY_SHA}" logs --no-color --tail=200 "${RUNTIME_SERVICES[@]}" > "${diagnostic}" 2>&1 || true
	chmod 600 "${diagnostic}"
	fail_backend_deployment "readiness_failed"
	exit 1
fi

legacy_restore_on_error=0
trap - ERR INT TERM HUP

printf '%s\n' "${DEPLOY_SHA}" > "${SHARED_DIR}/current-sha"
printf '%s\n' "${DEPLOY_IMAGE_DIGEST}" > "${SHARED_DIR}/current-image-digest"
chmod 600 "${SHARED_DIR}/current-sha" "${SHARED_DIR}/current-image-digest"
write_phase "completed"
write_result "success" "backend_ready"
