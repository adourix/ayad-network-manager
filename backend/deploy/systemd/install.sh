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

# systemd executes compiled artifacts from dist/. Never retain old generated
# JavaScript when installing a new source revision: a stale dist tree can make
# systemd execute code that no longer exists in src/ and is extremely difficult
# to diagnose from the journal.
cd "${APP_ROOT}"
rm -rf dist
npm run build

for required in \
  "dist/bootstrap.js" \
  "dist/server.js" \
  "dist/infrastructure/enforcement/EnforcementAgent.js" \
  "dist/infrastructure/enforcement/NftEnforcer.js"; do
  if [[ ! -f "${APP_ROOT}/${required}" ]]; then
    echo "build did not produce required artifact: ${required}" >&2
    exit 1
  fi
done

# The current source owns management access through the dedicated management
# chain. This guard catches accidental installation of an obsolete build before
# systemd is restarted.
if ! grep -q 'ayad_nm_input' "${APP_ROOT}/dist/infrastructure/enforcement/NftEnforcer.js"; then
  echo "compiled NftEnforcer.js is missing the current management-chain implementation" >&2
  exit 1
fi

install -d -m 0755 "${SYSTEMD_HELPER_DIR}"
install -d -m 0755 "${BACKUP_DIR}"
install -d -m 0755 /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d
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

BACKEND_UNIT="${SYSTEMD_DIR}/network-control-backend.service"
if grep -q '^ReadWritePaths=' "${BACKEND_UNIT}"; then
  sed -i "s|^ReadWritePaths=.*$|ReadWritePaths=${APP_ROOT} /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc|" "${BACKEND_UNIT}"
else
  printf '\nReadWritePaths=%s /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc\n' "${APP_ROOT}" >> "${BACKEND_UNIT}"
fi

for path in /var/lib/network-control /etc/nftables.d /var/lib/misc /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d; do
  if ! grep -qE "^ReadWritePaths=.*(^|[[:space:]])${path//./\\.}([[:space:]]|$)" "${BACKEND_UNIT}"; then
    echo "backend systemd unit is missing writable setup path: ${path}" >&2
    exit 1
  fi
done

ENFORCEMENT_UNIT="${SYSTEMD_DIR}/network-control-enforcement.service"
if ! grep -qF "EnvironmentFile=-${CONFIG_FILE}" "${ENFORCEMENT_UNIT}"; then
  echo "enforcement systemd unit is missing runtime config: ${CONFIG_FILE}" >&2
  exit 1
fi
if ! grep -qF "EnvironmentFile=-${APP_ROOT}/.env" "${ENFORCEMENT_UNIT}"; then
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
systemctl restart network-control-enforcement.service
systemctl restart network-control-backend.service

echo "Built backend, installed network-control services, provisioned setup storage, and restarted backend/enforcement"
