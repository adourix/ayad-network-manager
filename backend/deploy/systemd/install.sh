#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-${APP_ROOT}/.env}"
SYSTEMD_DIR="/etc/systemd/system"
SYSTEMD_HELPER_DIR="/usr/local/lib/network-control"
TEMPLATE_DIR="${APP_ROOT}/deploy/systemd"

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
