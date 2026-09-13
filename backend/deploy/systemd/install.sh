#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_ROOT="${REPO_ROOT:-$(cd "${APP_ROOT}/.." && pwd)}"
CONFIG_FILE="${CONFIG_FILE:-/etc/network-control-system/config.env}"
ENV_FILE="${APP_ROOT}/.env"
SYSTEMD_DIR="/etc/systemd/system"
SYSTEMD_HELPER_DIR="/usr/local/lib/network-control"
TEMPLATE_DIR="${APP_ROOT}/deploy/systemd"
BACKUP_DIR="/var/lib/network-control/backups"
SETUP_LOG="/var/log/network-control-setup.log"
SETUP_PID=""

log() { echo "[ayad-install] $*"; }
fail() { echo "[ayad-install] ERROR: $*" >&2; exit 1; }

cleanup() {
  if [[ -n "${SETUP_PID}" ]] && kill -0 "${SETUP_PID}" 2>/dev/null; then
    kill "${SETUP_PID}" 2>/dev/null || true
    wait "${SETUP_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

require_root() {
  [[ "$(id -u)" -eq 0 ]] || fail "root privileges are required; run: sudo bash deploy/systemd/install.sh"
}

check_os() {
  [[ -r /etc/os-release ]] || fail "/etc/os-release not found"
  # The implementation spec targets Ubuntu/Debian bare-metal installs.
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "unsupported OS: ${ID:-unknown}. Ubuntu/Debian is required for the bare-metal installer" ;;
  esac
}

install_packages() {
  log "Installing OS prerequisites..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl git openssl build-essential \
    dnsmasq nftables iproute2 ethtool \
    postgresql postgresql-contrib
}

install_node() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi

  if [[ "${major}" != "22" ]]; then
    log "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  command -v node >/dev/null 2>&1 || fail "Node.js installation failed"
  command -v npm >/dev/null 2>&1 || fail "npm installation failed"
  log "Node.js $(node --version), npm $(npm --version)"
}

prepare_directories() {
  install -d -m 0755 /etc/network-control-system
  install -d -m 0755 "${BACKUP_DIR}"
  install -d -m 0755 "${SYSTEMD_HELPER_DIR}"
  install -d -m 0755 /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d
  chown root:root "${BACKUP_DIR}"
  chmod 0755 "${BACKUP_DIR}"
}

create_database() {
  systemctl enable --now postgresql

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='ayad_nm'" | grep -q 1; then
    local password
    password="$(openssl rand -hex 24)"
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE ayad_nm LOGIN PASSWORD '${password}';"
  fi

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='ayad_nm'" | grep -q 1; then
    sudo -u postgres createdb -O ayad_nm ayad_nm
  fi

  # Read the existing role password only from our .env when it was previously
  # provisioned. New installs create a fresh password below.
  if [[ ! -f "${ENV_FILE}" ]]; then
    local password
    password="$(openssl rand -hex 24)"
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ayad_nm PASSWORD '${password}';"
    printf '%s\n' "${password}" > /run/network-control-db-password
    chmod 0600 /run/network-control-db-password
  fi
}

write_env() {
  if [[ -f "${ENV_FILE}" ]]; then
    log "Keeping existing ${ENV_FILE}"
    return
  fi

  local db_password
  if [[ -f /run/network-control-db-password ]]; then
    db_password="$(cat /run/network-control-db-password)"
  else
    db_password="$(openssl rand -hex 24)"
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ayad_nm PASSWORD '${db_password}';"
  fi

  local admin_password admin_salt admin_hash
  admin_password="${ADMIN_PASSWORD:-}"
  if [[ -z "${admin_password}" ]]; then
    read -r -s -p "Admin password (minimum 12 characters): " admin_password
    echo
  fi
  [[ "${#admin_password}" -ge 12 ]] || fail "admin password must be at least 12 characters"

  admin_salt="$(openssl rand -hex 16)"
  admin_hash="$(node -e 'const crypto=require("crypto"); const [p,s]=process.argv.slice(1); process.stdout.write(crypto.scryptSync(p, Buffer.from(s,"hex"), 64).toString("hex"));' "${admin_password}" "${admin_salt}")"

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
HOST=0.0.0.0
DASHBOARD_PORT=${DASHBOARD_PORT:-5000}
FRONTEND_DIST_PATH=../frontend/dist
TLS_CERT_PATH=/etc/network-control-system/tls/server.crt
TLS_KEY_PATH=/etc/network-control-system/tls/server.key
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
ADMIN_PASSWORD_HASH=${admin_hash}
ADMIN_PASSWORD_SALT=${admin_salt}
DATABASE_URL=postgresql://ayad_nm:${db_password}@127.0.0.1:5432/ayad_nm
DATABASE_USER=ayad_nm
DATABASE_PASSWORD=${db_password}
DATABASE_NAME=ayad_nm
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
CLIENT_INTERFACE=
UPLINK_INTERFACE=
CLIENT_GATEWAY_IP=
CLIENT_SUBNET=
DHCP_RANGE_START=
DHCP_RANGE_END=
DNS_SERVERS=1.1.1.1,8.8.8.8
SSH_PORT=${SSH_PORT:-22}
UPLINK_BANDWIDTH_MBPS=100
NETWORK_MODE=single-interface-ifb
VPN_TUN_INTERFACE=tun0
VPN_TUN_ADDRESS=172.19.0.1/30
SING_BOX_CONFIG_PATH=/etc/sing-box/config.json
DHCP_RESERVATIONS_PATH=/var/lib/misc/network-control-reservations.conf
DHCP_LEASES_PATH=/var/lib/misc/dnsmasq.leases
QUOTA_THROTTLE_MBPS=0.5
SYSTEM_CONFIG_PATH=${CONFIG_FILE}
DNSMASQ_CONFIG_PATH=/etc/dnsmasq.d/network-control-clients.conf
NFTABLES_CONFIG_PATH=/etc/nftables.d/network-control-system.nft
SETUP_SNAPSHOT_DIR=${BACKUP_DIR}
EOF
  chmod 0600 "${ENV_FILE}"
}

install_node_dependencies() {
  log "Installing backend dependencies..."
  cd "${APP_ROOT}"
  npm ci

  if [[ -f "${REPO_ROOT}/frontend/package.json" ]]; then
    log "Installing frontend dependencies..."
    cd "${REPO_ROOT}/frontend"
    npm ci
    log "Building frontend..."
    npm run build
  fi
}

run_database_migrations() {
  cd "${APP_ROOT}"
  log "Running Prisma migrations..."
  npx prisma migrate deploy
}

render_and_install() {
  local template="$1"
  local unit="$2"

  sed \
    -e "s|@APP_ROOT@|${APP_ROOT}|g" \
    -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
    -e "s|@SYSTEMD_HELPER_DIR@|${SYSTEMD_HELPER_DIR}|g" \
    "${TEMPLATE_DIR}/${template}" > "${SYSTEMD_DIR}/${unit}"
}

install_production_services() {
  [[ -f "${CONFIG_FILE}" ]] || fail "setup did not create ${CONFIG_FILE}"

  cd "${APP_ROOT}"
  log "Building backend production artifacts..."
  rm -rf dist
  npm run build

  for required in \
    "dist/bootstrap.js" \
    "dist/server.js" \
    "dist/infrastructure/enforcement/EnforcementAgent.js" \
    "dist/infrastructure/enforcement/NftEnforcer.js"; do
    [[ -f "${APP_ROOT}/${required}" ]] || fail "build did not produce required artifact: ${required}"
  done

  if ! grep -q 'ayad_nm_input' "${APP_ROOT}/dist/infrastructure/enforcement/NftEnforcer.js"; then
    fail "compiled NftEnforcer.js is missing the current management-chain implementation"
  fi

  install -m 0750 -o root -g root \
    "${TEMPLATE_DIR}/install-sing-box-config.sh" \
    "${SYSTEMD_HELPER_DIR}/install-sing-box-config.sh"

  render_and_install "network-control-enforcement.service.template" "network-control-enforcement.service"
  render_and_install "network-control-backend.service.template" "network-control-backend.service"
  render_and_install "network-control-sing-box-config.service.template" "network-control-sing-box-config.service"

  local backend_unit="${SYSTEMD_DIR}/network-control-backend.service"
  if grep -q '^ReadWritePaths=' "${backend_unit}"; then
    sed -i "s|^ReadWritePaths=.*$|ReadWritePaths=${APP_ROOT} /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc|" "${backend_unit}"
  else
    printf '\nReadWritePaths=%s /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc\n' "${APP_ROOT}" >> "${backend_unit}"
  fi

  for path in /var/lib/network-control /etc/nftables.d /var/lib/misc /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d; do
    grep -qE "^ReadWritePaths=.*(^|[[:space:]])${path//./\\.}([[:space:]]|$)" "${backend_unit}" || fail "backend systemd unit is missing writable setup path: ${path}"
  done

  local enforcement_unit="${SYSTEMD_DIR}/network-control-enforcement.service"
  grep -qF "EnvironmentFile=-${CONFIG_FILE}" "${enforcement_unit}" || fail "enforcement unit is missing runtime config"
  grep -qF "EnvironmentFile=-${APP_ROOT}/.env" "${enforcement_unit}" || fail "enforcement unit is missing installer environment"

  if grep -qE '@APP_ROOT@|@CONFIG_FILE@|@SYSTEMD_HELPER_DIR@' \
    "${SYSTEMD_DIR}/network-control-enforcement.service" \
    "${SYSTEMD_DIR}/network-control-backend.service" \
    "${SYSTEMD_DIR}/network-control-sing-box-config.service"; then
    fail "rendered systemd unit still contains template placeholders"
  fi

  systemctl daemon-reload
  systemctl enable network-control-enforcement.service network-control-backend.service
  systemctl restart network-control-enforcement.service
  systemctl restart network-control-backend.service
}

start_setup_mode() {
  if [[ -f "${CONFIG_FILE}" ]] && grep -q '^SETUP_COMPLETED=true$' "${CONFIG_FILE}"; then
    log "Setup is already complete; skipping setup wizard bootstrap."
    return
  fi

  cd "${APP_ROOT}"
  log "Starting temporary setup server..."
  : > "${SETUP_LOG}"
  chmod 0600 "${SETUP_LOG}"
  env NODE_ENV=development node dist/bootstrap.js >>"${SETUP_LOG}" 2>&1 &
  SETUP_PID="$!"

  local port="${DASHBOARD_PORT:-5000}"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${SETUP_PID}" 2>/dev/null; then
      tail -n 80 "${SETUP_LOG}" >&2 || true
      fail "temporary setup server exited unexpectedly"
    fi
    sleep 1
  done

  curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 || {
    tail -n 80 "${SETUP_LOG}" >&2 || true
    fail "temporary setup server did not become ready on port ${port}"
  }

  cat <<EOF

======================================================================
Ayad Network Manager is ready for the Network Setup Wizard.

Open from a browser on the LAN:
  http://<SERVER-IP>:${port}/setup

Complete the wizard. It will detect interfaces, choose a non-overlapping
client subnet, configure DHCP/NAT/IFB, run health checks, and write:
  ${CONFIG_FILE}

This installer is waiting for SETUP_COMPLETED=true.
Setup log: ${SETUP_LOG}
======================================================================
EOF

  while true; do
    if [[ -f "${CONFIG_FILE}" ]] && grep -q '^SETUP_COMPLETED=true$' "${CONFIG_FILE}"; then
      log "Setup wizard completed."
      break
    fi
    if ! kill -0 "${SETUP_PID}" 2>/dev/null; then
      tail -n 80 "${SETUP_LOG}" >&2 || true
      fail "temporary setup server stopped before setup completed"
    fi
    sleep 2
  done
}

main() {
  require_root
  check_os
  prepare_directories
  install_packages
  install_node
  create_database
  write_env
  install_node_dependencies
  run_database_migrations

  # Build once before the wizard so the wizard itself can be served by the
  # backend. Production systemd services are intentionally not started until
  # the wizard has persisted and health-checked the environment-specific config.
  cd "${APP_ROOT}"
  rm -rf dist
  npm run build

  start_setup_mode
  cleanup
  SETUP_PID=""
  install_production_services

  log "Installation complete. Backend and enforcement services are running."
  systemctl --no-pager --full status network-control-backend.service network-control-enforcement.service || true
}

main "$@"
