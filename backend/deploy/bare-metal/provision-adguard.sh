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

export ADGUARD_DNS_IP="${ADGUARD_DNS_IP:-${container_ip}}"

if [[ -n "${ADGUARD_ADMIN_USERNAME:-}" && -n "${ADGUARD_ADMIN_PASSWORD:-}" ]]; then
  log "Credentials supplied; AdGuard Home must be completed through its first-run configuration API/UI before the credentials are considered active"
else
  log "AdGuard Home is running, but no administrator credentials were supplied"
fi

log "AdGuard Home ready: container=${CONTAINER_NAME} ip=${ADGUARD_DNS_IP} dashboard_port=${DASHBOARD_PORT}"
printf '%s\n' "${ADGUARD_DNS_IP}"
