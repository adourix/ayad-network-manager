#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-${APP_ROOT}/.env}"
SYSTEMD_DIR="/etc/systemd/system"
SYSTEMD_HELPER_DIR="/usr/local/lib/network-control"
TEMPLATE_DIR="${APP_ROOT}/deploy/systemd"
BACKUP_DIR="/var/lib/network-control/backups"

render_and_install() {
  local template="$1"
  local unit="$2"

  sed \
    -e "s|@APP_ROOT@|${APP_ROOT}|g" \
    -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
    -e "s|@SYSTEMD_HELPER_DIR@|${SYSTEMD_HELPER_DIR}|g" \
    "${TEMPLATE_DIR}/${template}" > "${SYSTEMD_DIR}/${unit}"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "root privileges are required" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "config file not found: ${CONFIG_FILE}" >&2
  exit 1
fi

if [[ ! -f "${APP_ROOT}/package.json" ]]; then
  echo "backend package.json not found: ${APP_ROOT}/package.json" >&2
  exit 1
fi

# systemd executes the compiled backend/enforcement agent from dist/. Always
# rebuild before installing units so a git pull cannot leave dist/ stale.
cd "${APP_ROOT}"
npm run build

install -d -m 0755 "${SYSTEMD_HELPER_DIR}"
install -d -m 0755 "${BACKUP_DIR}"
install -m 0750 -o root -g root \
  "${TEMPLATE_DIR}/install-sing-box-config.sh" \
  "${SYSTEMD_HELPER_DIR}/install-sing-box-config.sh"

render_and_install \
  "network-control-enforcement.service.template" \
  "network-control-enforcement.service"

render_and_install \
  "network-control-backend.service.template" \
  "network-control-backend.service"

render_and_install \
  "network-control-sing-box-config.service.template" \
  "network-control-sing-box-config.service"

# ProtectSystem=strict makes the filesystem read-only to the service except
# for explicit ReadWritePaths. Keep the setup snapshot directory writable
# even if an older or locally modified template omitted it.
BACKEND_UNIT="${SYSTEMD_DIR}/network-control-backend.service"
if grep -q '^ReadWritePaths=' "${BACKEND_UNIT}"; then
  sed -i "s|^ReadWritePaths=.*$|ReadWritePaths=${APP_ROOT} /run/network-control /etc/dnsmasq.d /etc/network-control-system /var/lib/network-control|" "${BACKEND_UNIT}"
else
  printf '\nReadWritePaths=%s /run/network-control /etc/dnsmasq.d /etc/network-control-system /var/lib/network-control\n' "${APP_ROOT}" >> "${BACKEND_UNIT}"
fi

if ! grep -qE '^ReadWritePaths=.*(^|[[:space:]])/var/lib/network-control([[:space:]]|$)' "${BACKEND_UNIT}"; then
  echo "backend systemd unit is missing writable setup backup path" >&2
  exit 1
fi

if grep -qE '@APP_ROOT@|@CONFIG_FILE@|@SYSTEMD_HELPER_DIR@' \
  "${SYSTEMD_DIR}/network-control-enforcement.service" \
  "${SYSTEMD_DIR}/network-control-backend.service" \
  "${SYSTEMD_DIR}/network-control-sing-box-config.service"; then
  echo "rendered systemd unit still contains template placeholders" >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable network-control-enforcement.service network-control-backend.service

echo "Built backend and installed network-control services and sing-box config helper"
