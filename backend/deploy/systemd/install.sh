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

render_and_install \
  "network-control-enforcement.service.template" \
  "network-control-enforcement.service"

render_and_install \
  "network-control-backend.service.template" \
  "network-control-backend.service"

systemctl daemon-reload
systemctl enable network-control-enforcement.service network-control-backend.service

echo "Installed network-control-enforcement.service and network-control-backend.service"
