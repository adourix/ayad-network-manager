#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-/etc/network-control-system/config.env}"
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
# The backend runs as root but intentionally has a restricted capability set.
# Keep setup storage root-writable so CAP_NET_RAW does not need to be expanded
# with CAP_DAC_OVERRIDE just to create setup snapshots.
chown root:root "${BACKUP_DIR}"
chmod 0755 "${BACKUP_DIR}"
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
# for explicit ReadWritePaths. Keep every path used by setup's atomic writes
# writable, including nftables config, DHCP reservations and lease state.
BACKEND_UNIT="${SYSTEMD_DIR}/network-control-backend.service"
if grep -q '^ReadWritePaths=' "${BACKEND_UNIT}"; then
  sed -i "s|^ReadWritePaths=.*$|ReadWritePaths=${APP_ROOT} /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /var/lib/network-control /var/lib/misc|" "${BACKEND_UNIT}"
else
  printf '\nReadWritePaths=%s /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /var/lib/network-control /var/lib/misc\n' "${APP_ROOT}" >> "${BACKEND_UNIT}"
fi

if ! grep -qE '^ReadWritePaths=.*(^|[[:space:]])/var/lib/network-control([[:space:]]|$)' "${BACKEND_UNIT}"; then
  echo "backend systemd unit is missing writable setup backup path" >&2
  exit 1
fi

if ! grep -qE '^ReadWritePaths=.*(^|[[:space:]])/etc/nftables\.d([[:space:]]|$)' "${BACKEND_UNIT}"; then
  echo "backend systemd unit is missing writable nftables config path" >&2
  exit 1
fi

if ! grep -qE '^ReadWritePaths=.*(^|[[:space:]])/var/lib/misc([[:space:]]|$)' "${BACKEND_UNIT}"; then
  echo "backend systemd unit is missing writable DHCP state path" >&2
  exit 1
fi

# The privileged enforcement agent must receive the same runtime network
# configuration selected by setup. Never fall back to .env for this value:
# .env is installer-owned and intentionally contains empty network placeholders.
ENFORCEMENT_UNIT="${SYSTEMD_DIR}/network-control-enforcement.service"
if ! grep -qF "EnvironmentFile=-${CONFIG_FILE}" "${ENFORCEMENT_UNIT}"; then
  echo "enforcement systemd unit is missing runtime config: ${CONFIG_FILE}" >&2
  exit 1
fi
if grep -qF "EnvironmentFile=-${APP_ROOT}/.env" "${ENFORCEMENT_UNIT}"; then
  :
else
  echo "enforcement systemd unit is missing installer environment file" >&2
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
systemctl start network-control-backend.service

echo "Built backend, installed network-control services, provisioned setup storage, and started backend"
