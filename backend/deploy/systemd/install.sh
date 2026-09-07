#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-${APP_ROOT}/.env}"
SYSTEMD_DIR="/etc/systemd/system"
TEMPLATE_DIR="${APP_ROOT}/deploy/systemd"

render_and_install() {
  local template="$1"
  local unit="$2"

  sed \
    -e "s|@APP_ROOT@|${APP_ROOT}|g" \
    -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
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

render_and_install \
  "network-control-enforcement.service.template" \
  "network-control-enforcement.service"

render_and_install \
  "network-control-backend.service.template" \
  "network-control-backend.service"

if grep -qE '@APP_ROOT@|@CONFIG_FILE@' \
  "${SYSTEMD_DIR}/network-control-enforcement.service" \
  "${SYSTEMD_DIR}/network-control-backend.service"; then
  echo "rendered systemd unit still contains template placeholders" >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable network-control-enforcement.service network-control-backend.service

echo "Built backend and installed network-control-enforcement.service and network-control-backend.service"
