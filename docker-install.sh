#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
say() { echo "[AyadNM Docker Installer] $*"; }
die() { echo "[AyadNM Docker Installer] ERROR: $*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die "Run as root: sudo bash docker-install.sh"
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || die "Debian/Ubuntu required (found $ID)"
export DEBIAN_FRONTEND=noninteractive
say "Installing Docker/Compose and helper tools"
apt-get update
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
fi
apt-get install -y curl ca-certificates openssl postgresql-client iproute2
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing"
systemctl enable --now docker
say "Configure Host PostgreSQL connection"
read -r -p "DATABASE_URL [postgresql://ayad_nm@127.0.0.1:5432/ayad_nm]: " db_url
db_url="${db_url:-postgresql://ayad_nm@127.0.0.1:5432/ayad_nm}"
[[ "$db_url" == postgresql://* || "$db_url" == postgres://* ]] || die "DATABASE_URL must be a PostgreSQL URI"
export DATABASE_URL="$db_url"
say "Checking database connectivity/authentication"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user;" >/dev/null || die "Database connection failed. Ensure database/role exists and local authentication allows this connection."
say "Writing .env (existing file backed up)"
[[ ! -f .env ]] || cp -a .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
cat > .env <<EOF
DASHBOARD_PORT=5000
HOST=0.0.0.0
NODE_ENV=production
DATABASE_URL=$DATABASE_URL
AUDIT_RETENTION_DAYS=90
SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env
ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock
ENFORCEMENT_SOCKET_GID=1000
SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
TLS_CERT_PATH=/etc/network-control-system/tls/server.crt
TLS_KEY_PATH=/etc/network-control-system/tls/server.key
CLIENT_INTERFACE=
UPLINK_INTERFACE=
CLIENT_SUBNET=
CLIENT_GATEWAY_IP=
DHCP_RANGE_START=
DHCP_RANGE_END=
DNS_SERVERS=1.1.1.1,8.8.8.8
SSH_PORT=22
UPLINK_BANDWIDTH_MBPS=
NETWORK_MODE=single-interface-ifb
VPN_TUN_INTERFACE=tun0
EOF
read -r -p "Dashboard port [5000]: " dashboard_port
 dashboard_port="${dashboard_port:-5000}"
 [[ "$dashboard_port" =~ ^[0-9]+$ ]] && (( dashboard_port >= 1 && dashboard_port <= 65535 )) || die "Invalid dashboard port"
sed -i "s/^DASHBOARD_PORT=.*/DASHBOARD_PORT=$dashboard_port/" .env
chmod 600 .env
say "Checking dashboard port 5000"
ss -ltn "( sport = :$dashboard_port )" | grep -q LISTEN && die "Port $dashboard_port is in use; choose another port and rerun"
say "Preparing self-signed TLS certificate"
mkdir -p certs && chmod 700 certs
if [[ ! -s certs/server.key || ! -s certs/server.crt ]]; then
  host_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  host_ip="${host_ip:-127.0.0.1}"
  openssl req -x509 -newkey rsa:3072 -nodes -days 825 -keyout certs/server.key -out certs/server.crt -subj "/CN=Ayad Network Manager" -addext "subjectAltName=IP:$host_ip,IP:127.0.0.1,DNS:ayad-nm.local,DNS:localhost"
  chmod 600 certs/server.key && chmod 644 certs/server.crt
fi
say "Validating Compose and building images"
docker compose config >/dev/null || die "Compose validation failed"
docker compose build backend enforcement
say "Starting enforcement and backend"
docker compose up -d enforcement backend
docker compose ps
say "Waiting for API health"
healthy=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:$dashboard_port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { docker compose logs --tail=100 backend >&2; die "Backend health check failed"; }
echo
echo "Install/startup complete"
echo "Dashboard: https://<server-ip>:$dashboard_port/"
echo "Setup Wizard: https://<server-ip>:$dashboard_port/setup"
echo "TLS certificate: $ROOT/certs/server.crt"
echo "Host PostgreSQL: configured (no database container)"
echo "Migrations: intentionally skipped"
echo "WARNING: Docker host setup for DHCP/NAT/firewall/tc/services is not production-ready yet."
