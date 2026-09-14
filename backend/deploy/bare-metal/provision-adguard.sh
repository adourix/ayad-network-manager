#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

CONTAINER_NAME="${ADGUARD_CONTAINER_NAME:-adguardhome}"
DASHBOARD_PORT="${ADGUARD_DASHBOARD_PORT:-3000}"
DATA_ROOT="${ADGUARD_DATA_ROOT:-/var/lib/adguardhome}"
WORK_DIR="${DATA_ROOT}/work"
CONF_DIR="${DATA_ROOT}/conf"
IMAGE="adguard/adguardhome"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die "run as root"
[[ "${INSTALL_ADGUARD:-false}" == "true" ]] || { log "AdGuard installation disabled by INSTALL_ADGUARD=false"; exit 0; }
command -v docker >/dev/null 2>&1 || die "Docker is required when AdGuard Home installation is enabled"
command -v curl >/dev/null 2>&1 || die "curl is required"

if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  log "Existing AdGuard Home container found: ${CONTAINER_NAME}"
  running="$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}")"
  if [[ "${running}" != "true" ]]; then
    log "Existing AdGuard Home container is stopped; starting it"
    docker start "${CONTAINER_NAME}" >/dev/null
  fi
else
  log "No AdGuard Home container found; creating ${CONTAINER_NAME}"
  mkdir -p "${WORK_DIR}" "${CONF_DIR}"
  docker pull "${IMAGE}"
  docker run -d --name "${CONTAINER_NAME}" --restart unless-stopped \
    -v "${WORK_DIR}:/opt/adguardhome/work" \
    -v "${CONF_DIR}:/opt/adguardhome/conf" \
    -p "53:53/tcp" -p "53:53/udp" -p "${DASHBOARD_PORT}:3000/tcp" \
    "${IMAGE}" >/dev/null
fi

log "Waiting for AdGuard Home"
for _ in $(seq 1 60); do
  if docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q true; then break; fi
  sleep 1
done
docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" | grep -q true || die "AdGuard Home container is not running"

container_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${CONTAINER_NAME}")"
[[ -n "${container_ip}" ]] || die "Unable to determine AdGuard Home container IP"
ADGUARD_DNS_IP="${ADGUARD_DNS_IP:-${container_ip}}"

config_file="${CONF_DIR}/AdGuardHome.yaml"
if [[ ! -s "${config_file}" ]]; then
  [[ -n "${ADGUARD_ADMIN_USERNAME:-}" ]] || die "ADGUARD_ADMIN_USERNAME is required for a fresh AdGuard Home installation"
  [[ -n "${ADGUARD_ADMIN_PASSWORD:-}" ]] || die "ADGUARD_ADMIN_PASSWORD is required for a fresh AdGuard Home installation"
  [[ "${DASHBOARD_PORT}" =~ ^[0-9]+$ ]] || die "ADGUARD_DASHBOARD_PORT must be numeric"
  (( DASHBOARD_PORT >= 1 && DASHBOARD_PORT <= 65535 )) || die "ADGUARD_DASHBOARD_PORT is out of range"

  log "Waiting for AdGuard Home first-run API"
  ready=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 1 "http://127.0.0.1:${DASHBOARD_PORT}/control/install/get_addresses" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  (( ready == 1 )) || die "AdGuard Home first-run API did not become ready"

  payload="$(ADGUARD_USER="${ADGUARD_ADMIN_USERNAME}" ADGUARD_PASS="${ADGUARD_ADMIN_PASSWORD}" ADGUARD_PORT="${DASHBOARD_PORT}" python3 - <<'PY'
import json, os
print(json.dumps({
  "web": {"ip": "0.0.0.0", "port": int(os.environ["ADGUARD_PORT"])},
  "dns": {"ip": "0.0.0.0", "port": 53},
  "username": os.environ["ADGUARD_USER"],
  "password": os.environ["ADGUARD_PASS"],
}))
PY
)"
  curl -fsS --max-time 10 -X POST "http://127.0.0.1:${DASHBOARD_PORT}/control/install/configure" \
    -H 'Content-Type: application/json' -d "${payload}" >/dev/null
  unset payload
  log "AdGuard Home first-run configuration completed"
fi

log "Validating AdGuard DNS and dashboard"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${DASHBOARD_PORT}/control/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:${DASHBOARD_PORT}/control/status" >/dev/null || die "AdGuard dashboard health check failed"

log "AdGuard Home ready: container=${CONTAINER_NAME} ip=${ADGUARD_DNS_IP} dashboard_port=${DASHBOARD_PORT}"
printf '%s\n' "${ADGUARD_DNS_IP}"
