#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_ROOT="$(cd "${APP_ROOT}/.." && pwd)"
ENV_FILE="${APP_ROOT}/.env"
CONFIG_DIR="/etc/network-control-system"
CONFIG_FILE="${CONFIG_DIR}/config.env"
TLS_DIR="${CONFIG_DIR}/tls"
SYSCTL_FILE="/etc/sysctl.d/99-ayad-network-manager.conf"
MODULES_FILE="/etc/modules-load.d/ayad-network-manager.conf"
DNSMASQ_OVERRIDE_DIR="/etc/systemd/system/dnsmasq.service.d"
SING_BOX_OVERRIDE_DIR="/etc/systemd/system/sing-box.service.d"
SYSTEMD_DIR="/etc/systemd/system"
SYSTEMD_HELPER_DIR="/usr/local/lib/network-control"
TEMPLATE_DIR="${APP_ROOT}/deploy/systemd"
BACKUP_DIR="/var/lib/network-control/backups"
SETUP_LOG="/var/log/network-control-setup.log"
SETUP_PID=""
DB_NAME="ayad_nm"
DB_USER="ayad_nm"
SETUP_RESPONSE_GRACE_SECONDS="${SETUP_RESPONSE_GRACE_SECONDS:-3}"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  if [[ -n "${SETUP_PID}" ]] && kill -0 "${SETUP_PID}" 2>/dev/null; then
    kill "${SETUP_PID}" 2>/dev/null || true
    wait "${SETUP_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run this installer as root: sudo bash backend/deploy/bare-metal/install.sh"
}

check_os() {
  [[ -r /etc/os-release ]] || die "/etc/os-release not found"
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "unsupported OS: ${ID:-unknown}. Ubuntu/Debian is required for the bare-metal installer" ;;
  esac
}

install_packages() {
  log "Installing host dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl openssl git build-essential \
    postgresql postgresql-client postgresql-contrib \
    dnsmasq nftables iproute2 ethtool tcpdump \
    kmod \
    iputils-ping procps util-linux
}

install_node() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  fi

  if [[ "${major}" != "22" ]]; then
    log "Installing Node.js 22 LTS"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  command -v node >/dev/null 2>&1 || die "Node.js installation failed"
  command -v npm >/dev/null 2>&1 || die "npm installation failed"
  local installed_major
  installed_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${installed_major}" -ge 20 ]] || die "Node.js >= 20 is required; found $(node --version)"
  log "Node.js $(node --version), npm $(npm --version)"
}

install_sing_box() {
  log "Installing sing-box from the official APT repository"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
  chmod a+r /etc/apt/keyrings/sagernet.asc
  cat > /etc/apt/sources.list.d/sagernet.sources <<'EOF'
Types: deb
URIs: https://deb.sagernet.org/
Suites: *
Components: *
Enabled: yes
Signed-By: /etc/apt/keyrings/sagernet.asc
EOF
  apt-get update
  apt-get install -y --no-install-recommends sing-box
  command -v sing-box >/dev/null || die "sing-box installation failed"
}

prepare_directories() {
  log "Preparing persistent directories and kernel prerequisites"
  install -d -m 0755 "${CONFIG_DIR}" "${BACKUP_DIR}" "${SYSTEMD_HELPER_DIR}"
  install -d -m 0755 /etc/modules-load.d /etc/dnsmasq.d /etc/nftables.d \
    "${DNSMASQ_OVERRIDE_DIR}" "${SING_BOX_OVERRIDE_DIR}" /etc/sing-box
  chown root:root "${BACKUP_DIR}"
  chmod 0755 "${BACKUP_DIR}"

  printf 'net.ipv4.ip_forward=1\n' > "${SYSCTL_FILE}"
  printf 'ifb\n' > "${MODULES_FILE}"

  cat > "${DNSMASQ_OVERRIDE_DIR}/network-control.conf" <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=on-failure
RestartSec=5
EOF

  cat > "${SING_BOX_OVERRIDE_DIR}/network-control.conf" <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=on-failure
RestartSec=5
EOF

  modprobe ifb
  sysctl --system >/dev/null
  systemctl daemon-reload

  install -m 0644 "${APP_ROOT}/deploy/bare-metal/dnsmasq-dhcp-only.conf" \
    /etc/dnsmasq.d/network-control-dns.conf

  systemctl disable --now sing-box 2>/dev/null || true
}

create_database() {
  log "Preparing PostgreSQL"
  systemctl enable --now postgresql

  local db_password
  db_password="$(openssl rand -hex 32)"

  if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${db_password}';"
  else
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${db_password}';"
  fi

  if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    runuser -u postgres -- createdb -O "${DB_USER}" "${DB_NAME}"
  else
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
      -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};"
  fi

  printf '%s\n' "${db_password}" > /run/network-control-db-password
  chmod 0600 /run/network-control-db-password
}

write_admin_env() {
  log "Generating administrator credentials"
  local admin_username admin_password admin_password_confirm admin_salt admin_hash db_password

  read -r -p "Admin username [admin]: " admin_username
  admin_username="${admin_username:-admin}"

  read -r -s -p "Admin password: " admin_password
  printf '\n'
  read -r -s -p "Confirm admin password: " admin_password_confirm
  printf '\n'

  [[ -n "${admin_password}" ]] || die "admin password cannot be empty"
  [[ "${admin_password}" == "${admin_password_confirm}" ]] || die "admin passwords do not match"

  admin_salt="$(openssl rand -hex 16)"
  admin_hash="$(printf '%s' "${admin_password}" | ADMIN_PASSWORD_SALT="${admin_salt}" node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const password=fs.readFileSync(0,"utf8"); const salt=process.env.ADMIN_PASSWORD_SALT; process.stdout.write(crypto.scryptSync(password,salt,32).toString("hex"));')"
  unset admin_password admin_password_confirm

  db_password="$(cat /run/network-control-db-password)"

  cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
HOST=0.0.0.0
DASHBOARD_PORT=${DASHBOARD_PORT:-5000}
FRONTEND_DIST_PATH=../frontend/dist
TLS_CERT_PATH=${TLS_DIR}/server.crt
TLS_KEY_PATH=${TLS_DIR}/server.key
ADMIN_USERNAME=${admin_username}
ADMIN_PASSWORD_HASH=${admin_hash}
ADMIN_PASSWORD_SALT=${admin_salt}
DATABASE_URL=postgresql://${DB_USER}:${db_password}@127.0.0.1:5432/${DB_NAME}
DATABASE_USER=${DB_USER}
DATABASE_PASSWORD=${db_password}
DATABASE_NAME=${DB_NAME}
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

prepare_tls() {
  log "Preparing TLS certificate"
  install -d -m 0755 "${TLS_DIR}"

  local default_iface default_ip tls_config
  default_iface="$(ip -4 route show default | awk 'NR==1 {print $5}')"
  default_ip=""
  if [[ -n "${default_iface}" ]]; then
    default_ip="$(ip -4 -o addr show dev "${default_iface}" | awk 'NR==1 {split($4,a,"/"); print a[1]}')"
  fi
  [[ -n "${default_ip}" ]] || default_ip="127.0.0.1"

  if [[ ! -f "${TLS_DIR}/server.key" || ! -f "${TLS_DIR}/server.crt" ]]; then
    tls_config="$(mktemp)"
    chmod 0600 "${tls_config}"
    trap 'rm -f "${tls_config}"' RETURN
    cat > "${tls_config}" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = Ayad Network Manager

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = ${default_ip}
DNS.1 = ayad-nm.local
DNS.2 = localhost
IP.2 = 127.0.0.1
EOF

    openssl req -x509 -nodes -newkey rsa:3072 -days 825 \
      -keyout "${TLS_DIR}/server.key" \
      -out "${TLS_DIR}/server.crt" \
      -config "${tls_config}"
    rm -f "${tls_config}"
    trap - RETURN
    chmod 0600 "${TLS_DIR}/server.key"
    chmod 0644 "${TLS_DIR}/server.crt"
  fi
}

install_dependencies() {
  log "Installing backend dependencies"
  cd "${APP_ROOT}"
  npm ci

  [[ -f "${REPO_ROOT}/frontend/package.json" ]] || die "frontend/package.json not found"
  log "Installing frontend dependencies"
  cd "${REPO_ROOT}/frontend"
  npm ci

  log "Building frontend"
  npm run build
}

run_database_migrations() {
  cd "${APP_ROOT}"
  log "Running Prisma migrations"
  npx prisma migrate deploy
}

build_backend() {
  cd "${APP_ROOT}"
  log "Building backend"
  rm -rf dist
  npm run build

  for required in \
    "dist/bootstrap.js" \
    "dist/server.js" \
    "dist/infrastructure/enforcement/EnforcementAgent.js" \
    "dist/infrastructure/enforcement/NftEnforcer.js"; do
    [[ -f "${APP_ROOT}/${required}" ]] || die "build did not produce required artifact: ${required}"
  done

  if ! grep -q 'ayad_nm_input' "${APP_ROOT}/dist/infrastructure/enforcement/NftEnforcer.js"; then
    die "compiled NftEnforcer.js is missing the current management-chain implementation"
  fi
}

render_and_install_unit() {
  local template="$1"
  local unit="$2"

  sed \
    -e "s|@APP_ROOT@|${APP_ROOT}|g" \
    -e "s|@CONFIG_FILE@|${CONFIG_FILE}|g" \
    -e "s|@SYSTEMD_HELPER_DIR@|${SYSTEMD_HELPER_DIR}|g" \
    "${TEMPLATE_DIR}/${template}" > "${SYSTEMD_DIR}/${unit}"
}

install_production_services() {
  [[ -f "${CONFIG_FILE}" ]] || die "setup did not create ${CONFIG_FILE}"
  grep -q '^SETUP_COMPLETED=true$' "${CONFIG_FILE}" || die "setup did not complete successfully"

  install -m 0750 -o root -g root \
    "${TEMPLATE_DIR}/install-sing-box-config.sh" \
    "${SYSTEMD_HELPER_DIR}/install-sing-box-config.sh"

  render_and_install_unit "network-control-enforcement.service.template" "network-control-enforcement.service"
  render_and_install_unit "network-control-backend.service.template" "network-control-backend.service"
  render_and_install_unit "network-control-sing-box-config.service.template" "network-control-sing-box-config.service"

  local backend_unit="${SYSTEMD_DIR}/network-control-backend.service"
  if grep -q '^ReadWritePaths=' "${backend_unit}"; then
    sed -i "s|^ReadWritePaths=.*$|ReadWritePaths=${APP_ROOT} /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc|" "${backend_unit}"
  else
    printf '\nReadWritePaths=%s /run/network-control /etc/dnsmasq.d /etc/nftables.d /etc/network-control-system /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d /var/lib/network-control /var/lib/misc\n' "${APP_ROOT}" >> "${backend_unit}"
  fi

  for path in /var/lib/network-control /etc/nftables.d /var/lib/misc /etc/modules-load.d /etc/systemd/system/dnsmasq.service.d; do
    grep -qE "^ReadWritePaths=.*(^|[[:space:]])${path//./\\.}([[:space:]]|$)" "${backend_unit}" || die "backend systemd unit is missing writable setup path: ${path}"
  done

  local enforcement_unit="${SYSTEMD_DIR}/network-control-enforcement.service"
  grep -qF "EnvironmentFile=-${CONFIG_FILE}" "${enforcement_unit}" || die "enforcement unit is missing runtime config"
  grep -qF "EnvironmentFile=-${APP_ROOT}/.env" "${enforcement_unit}" || die "enforcement unit is missing installer environment"

  if grep -qE '@APP_ROOT@|@CONFIG_FILE@|@SYSTEMD_HELPER_DIR@' \
    "${SYSTEMD_DIR}/network-control-enforcement.service" \
    "${SYSTEMD_DIR}/network-control-backend.service" \
    "${SYSTEMD_DIR}/network-control-sing-box-config.service"; then
    die "rendered systemd unit still contains template placeholders"
  fi

  systemctl daemon-reload
  systemctl enable network-control-enforcement.service network-control-backend.service
  systemctl restart network-control-enforcement.service
  systemctl restart network-control-backend.service
}

setup_port_owner() {
  local port="$1"
  # fuser returns exit status 1 when the port has no owner. Because this
  # installer uses `set -euo pipefail`, that expected "no process" result
  # must not terminate the installer during command substitution.
  fuser -n tcp "${port}" 2>/dev/null \
    | awk '{for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i; exit }}' \
    || true
}

is_setup_server_process() {
  local pid="$1"
  [[ -n "${pid}" ]] || return 1
  [[ -r "/proc/${pid}/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/${pid}/cmdline" | grep -q 'dist/bootstrap.js'
}

probe_setup_server() {
  local port="$1"
  curl -fsS --connect-timeout 1 --max-time 2 \
    "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
}

start_setup_mode() {
  if [[ -f "${CONFIG_FILE}" ]] && grep -q '^SETUP_COMPLETED=true$' "${CONFIG_FILE}"; then
    log "Setup is already complete; skipping setup wizard bootstrap"
    return 0
  fi

  cd "${APP_ROOT}"
  local port="${DASHBOARD_PORT:-5000}"
  local existing_pid

  existing_pid="$(setup_port_owner "${port}")"
  if [[ -n "${existing_pid}" ]]; then
    if is_setup_server_process "${existing_pid}" && probe_setup_server "${port}"; then
      log "Temporary setup server is already running on port ${port}; reusing PID ${existing_pid}"
      SETUP_PID="${existing_pid}"
    elif is_setup_server_process "${existing_pid}"; then
      log "Found stale temporary setup server PID ${existing_pid}; stopping it"
      kill "${existing_pid}" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "${existing_pid}" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "${existing_pid}" 2>/dev/null; then
        kill -9 "${existing_pid}" 2>/dev/null || true
      fi
    else
      die "setup port ${port} is already occupied by another process (PID ${existing_pid}); choose another DASHBOARD_PORT"
    fi
  fi

  if [[ -z "${SETUP_PID}" ]]; then
    log "Starting temporary setup server"
    : > "${SETUP_LOG}"
    chmod 0600 "${SETUP_LOG}"
    env NODE_ENV=development node dist/bootstrap.js >>"${SETUP_LOG}" 2>&1 &
    SETUP_PID="$!"
  fi

  local ready=0
  for _ in $(seq 1 30); do
    if probe_setup_server "${port}"; then
      ready=1
      break
    fi
    if ! kill -0 "${SETUP_PID}" 2>/dev/null; then
      tail -n 80 "${SETUP_LOG}" >&2 || true
      die "temporary setup server exited unexpectedly"
    fi
    sleep 1
  done

  [[ "${ready}" -eq 1 ]] || {
    tail -n 80 "${SETUP_LOG}" >&2 || true
    die "temporary setup server did not become ready on port ${port}"
  }

  cat <<EOF

======================================================================
Ayad Network Manager - Network Setup Wizard

Open from a browser on the LAN:
  http://<SERVER-IP>:${port}/setup

The wizard will:
  - detect and confirm the network interfaces
  - detect subnet conflicts
  - configure single-interface + IFB
  - configure DHCP and NAT
  - run preflight and post-setup health checks
  - persist the environment-specific configuration

This installer will continue automatically after SETUP_COMPLETED=true.
Setup log: ${SETUP_LOG}
======================================================================
EOF

  while true; do
    if [[ -f "${CONFIG_FILE}" ]] && grep -q '^SETUP_COMPLETED=true$' "${CONFIG_FILE}"; then
      log "Setup wizard completed"
      log "Waiting ${SETUP_RESPONSE_GRACE_SECONDS}s for the final setup response to reach the browser"
      sleep "${SETUP_RESPONSE_GRACE_SECONDS}"
      break
    fi
    if ! kill -0 "${SETUP_PID}" 2>/dev/null; then
      tail -n 80 "${SETUP_LOG}" >&2 || true
      die "temporary setup server stopped before setup completed"
    fi
    sleep 2
  done
}

main() {
  require_root
  check_os

  log "[1/9] Installing OS prerequisites"
  install_packages

  log "[2/9] Installing Node.js"
  install_node

  log "[3/9] Installing sing-box"
  install_sing_box

  log "[4/9] Preparing host networking"
  prepare_directories

  log "[5/9] Preparing PostgreSQL"
  create_database

  log "[6/9] Creating application configuration"
  write_admin_env
  prepare_tls
  install -m 0600 /dev/null "${CONFIG_FILE}"

  log "[7/9] Installing application dependencies and database schema"
  install_dependencies
  run_database_migrations
  build_backend

  log "[8/9] Running Network Setup Wizard"
  start_setup_mode
  cleanup
  SETUP_PID=""

  log "[9/9] Installing and starting production services"
  install_production_services

  log "Installation complete"
  printf '%s\n' \
    "Dashboard: https://<gateway-ip>:${DASHBOARD_PORT:-5000}/" \
    "Setup URL: http://<server-ip>:${DASHBOARD_PORT:-5000}/setup" \
    "VPN runtime: $(sing-box version | head -n 1)" \
    "VPN is installed but disabled until a VMess/VLESS link is configured"
}

main "$@"