#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_ROOT="$(cd "${APP_ROOT}/.." && pwd)"
ENV_FILE="${APP_ROOT}/.env"
CONFIG_DIR="/etc/network-control-system"
TLS_DIR="${CONFIG_DIR}/tls"
SYSCTL_FILE="/etc/sysctl.d/99-ayad-network-manager.conf"
MODULES_FILE="/etc/modules-load.d/ayad-network-manager.conf"
DNSMASQ_OVERRIDE_DIR="/etc/systemd/system/dnsmasq.service.d"
SING_BOX_OVERRIDE_DIR="/etc/systemd/system/sing-box.service.d"
DB_NAME="ayad_nm"
DB_USER="ayad_nm"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run this installer as root"
command -v apt-get >/dev/null || die "Ubuntu/Debian apt-get is required"

log "Installing host dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl openssl git build-essential \
  postgresql postgresql-client \
  dnsmasq nftables iproute2 ethtool tcpdump \
  iputils-ping procps util-linux

if ! command -v node >/dev/null; then
  log "Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js >= 20 is required; found $(node --version)"

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

log "Preparing PostgreSQL"
systemctl enable --now postgresql
DB_PASSWORD="$(openssl rand -hex 32)"
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -tAc "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'; ELSE ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'; END IF; END \$\$;"
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  runuser -u postgres -- createdb -O "${DB_USER}" "${DB_NAME}"
else
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};"
fi

log "Generating administrator credentials"
read -r -p "Admin username [admin]: " ADMIN_USERNAME
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
read -r -s -p "Admin password: " ADMIN_PASSWORD
printf '\n'
read -r -s -p "Confirm admin password: " ADMIN_PASSWORD_CONFIRM
printf '\n'
[[ -n "$ADMIN_PASSWORD" ]] || die "admin password cannot be empty"
[[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]] || die "admin passwords do not match"

ADMIN_PASSWORD_SALT="$(openssl rand -hex 16)"
ADMIN_PASSWORD_HASH="$(printf '%s' "$ADMIN_PASSWORD" | ADMIN_PASSWORD_SALT="$ADMIN_PASSWORD_SALT" node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const password=fs.readFileSync(0,"utf8"); const salt=process.env.ADMIN_PASSWORD_SALT; process.stdout.write(crypto.scryptSync(password,salt,32).toString("hex"));')"
unset ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM

log "Preparing TLS"
mkdir -p "$TLS_DIR"
DEFAULT_IFACE="$(ip -4 route show default | awk 'NR==1 {print $5}')"
DEFAULT_IP=""
if [[ -n "$DEFAULT_IFACE" ]]; then
  DEFAULT_IP="$(ip -4 -o addr show dev "$DEFAULT_IFACE" | awk 'NR==1 {split($4,a,"/"); print a[1]}')"
fi
if [[ -z "$DEFAULT_IP" ]]; then DEFAULT_IP="127.0.0.1"; fi
if [[ ! -f "$TLS_DIR/server.key" || ! -f "$TLS_DIR/server.crt" ]]; then
  openssl req -x509 -nodes -newkey rsa:3072 -days 825 \
    -keyout "$TLS_DIR/server.key" \
    -out "$TLS_DIR/server.crt" \
    -subj "/CN=Ayad Network Manager" \
    -addext "subjectAltName=IP:${DEFAULT_IP},DNS:ayad-nm.local,DNS:localhost,IP:127.0.0.1"
  chmod 0600 "$TLS_DIR/server.key"
  chmod 0644 "$TLS_DIR/server.crt"
fi

log "Preparing persistent host networking"
mkdir -p "$CONFIG_DIR" /var/lib/network-control/backups /etc/dnsmasq.d /etc/nftables.d "$DNSMASQ_OVERRIDE_DIR" "$SING_BOX_OVERRIDE_DIR" /etc/sing-box
printf 'net.ipv4.ip_forward=1\n' > "$SYSCTL_FILE"
printf 'ifb\n' > "$MODULES_FILE"
cat > "$DNSMASQ_OVERRIDE_DIR/network-control.conf" <<'EOF'
[Unit]
After=network-online.target
Wants=network-online.target

[Service]
Restart=on-failure
RestartSec=5
EOF
cat > "$SING_BOX_OVERRIDE_DIR/network-control.conf" <<'EOF'
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

# dnsmasq is DHCP-only because systemd-resolved owns the local DNS stub listener.
install -m 0644 "$APP_ROOT/deploy/bare-metal/dnsmasq-dhcp-only.conf" \
  /etc/dnsmasq.d/network-control-dns.conf

# VPN is opt-in. Install the runtime and service, but do not create a TUN
# interface or start sing-box until the operator supplies a VMess/VLESS link.
systemctl disable --now sing-box 2>/dev/null || true

log "Creating persistent first-boot configuration"
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=0.0.0.0
DASHBOARD_PORT=5000
FRONTEND_DIST_PATH=../frontend/dist
TLS_CERT_PATH=${TLS_DIR}/server.crt
TLS_KEY_PATH=${TLS_DIR}/server.key
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}
ADMIN_PASSWORD_SALT=${ADMIN_PASSWORD_SALT}
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
DATABASE_USER=${DB_USER}
DATABASE_PASSWORD=${DB_PASSWORD}
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
SSH_PORT=22
UPLINK_BANDWIDTH_MBPS=100
NETWORK_MODE=single-interface-ifb
VPN_TUN_INTERFACE=tun0
VPN_TUN_ADDRESS=172.19.0.1/30
SING_BOX_CONFIG_PATH=/etc/sing-box/config.json
SING_BOX_STAGE_PATH=/run/network-control/sing-box-config.json
SING_BOX_CONFIG_INSTALL_UNIT=network-control-sing-box-config.service
DHCP_RESERVATIONS_PATH=/var/lib/misc/network-control-reservations.conf
DHCP_LEASES_PATH=/var/lib/misc/dnsmasq.leases
QUOTA_THROTTLE_MBPS=0.5
SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env
DNSMASQ_CONFIG_PATH=/etc/dnsmasq.d/network-control-clients.conf
NFTABLES_CONFIG_PATH=/etc/nftables.d/network-control-system.nft
SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
EOF
chmod 0600 "$ENV_FILE"

log "Installing database schema"
cd "$APP_ROOT"
if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
npx prisma generate
npx prisma migrate deploy

log "Building React frontend"
cd "$REPO_ROOT/frontend"
if [[ -f package-lock.json ]]; then npm ci || npm install; else npm install; fi
npm run build

log "Building backend and installing systemd units"
cd "$APP_ROOT"
npm run build
APP_ROOT="$APP_ROOT" CONFIG_FILE="$ENV_FILE" bash "$APP_ROOT/deploy/systemd/install.sh"

log "Starting Ayad Network Manager"
systemctl enable network-control-enforcement.service network-control-backend.service
systemctl restart network-control-backend.service || systemctl start network-control-backend.service

log "Installation complete"
printf '%s\n' \
  "Backend root: $APP_ROOT" \
  "Setup URL: https://${DEFAULT_IP}:5000/setup" \
  "VPN runtime: $(sing-box version | head -n 1)" \
  "VPN is installed but disabled until a VMess/VLESS link is configured" \
  "The backend is started automatically by this installer" \
  "After setup apply succeeds, the backend may be restarted from the service manager if its environment changed" \
  "Dashboard: https://<gateway-ip>:5000/"
