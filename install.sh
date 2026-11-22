#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

say() { printf "\n[AyadNM Unified Installer] %s\n" "$*"; }
die() { echo "[AyadNM Unified Installer] ERROR: $*" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die "Run as root: sudo bash install.sh"
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || die "Debian/Ubuntu required (found $ID)"

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo
  echo "Ayad Network Manager deployment"
  echo "  1) Native / Bare-metal (systemd backend + enforcement)"
  echo "  2) Docker backend (Host provisioning + native enforcement + Docker app)"
  read -r -p "Choose deployment [1/2]: " MODE
fi
case "$MODE" in
  1|native|bare-metal)
    say "Starting original Bare-metal installer"
    exec bash "$ROOT/backend/deploy/bare-metal/install.sh"
    ;;
  2|docker) ;;
  *) die "Unknown mode. Use 1/native or 2/docker." ;;
esac

say "Installing Docker Engine and Compose"
export DEBIAN_FRONTEND=noninteractive
apt-get update
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing"
systemctl enable --now docker

host_setup_completed() {
  local config="/etc/network-control-system/config.env"
  [[ -f "$config" ]] || return 1
  grep -q '^SETUP_COMPLETED=true$' "$config" || return 1
  for key in CLIENT_INTERFACE UPLINK_INTERFACE CLIENT_GATEWAY_IP CLIENT_SUBNET UPLINK_BANDWIDTH_MBPS DASHBOARD_PORT SSH_PORT DNS_SERVERS; do
    grep -Eq "^${key}=.+$" "$config" || return 1
  done
  [[ -f /etc/systemd/system/network-control-enforcement.service ]] || return 1
  [[ -f /etc/systemd/system/network-control-backend.service ]] || return 1
}

if host_setup_completed; then
  say "Existing completed Host setup detected; preserving PostgreSQL, admin credentials, and network configuration"
  systemctl enable --now network-control-enforcement.service
else
  say "Host setup is incomplete; running Native Host/Gateway provisioning and wizard first"
  bash "$ROOT/backend/deploy/bare-metal/install.sh"
  host_setup_completed || die "Host setup wizard returned but required config is incomplete; Docker backend will not be installed"
fi

say "Validating Compose and building Docker backend"
docker compose config >/dev/null || die "Compose configuration validation failed"
docker compose build backend

say "Switching backend from native systemd to Docker"
systemctl stop network-control-backend.service || true
systemctl disable network-control-backend.service || true

sed "s|@APP_ROOT@|$ROOT|g" "$ROOT/backend/deploy/systemd/ayadnm-docker.service" > /etc/systemd/system/ayadnm-docker.service
systemctl daemon-reload
systemctl enable ayadnm-docker.service
systemctl restart ayadnm-docker.service

say "Waiting for production backend health (up to 120 seconds)"
port="$(grep -E '^DASHBOARD_PORT=' "$ROOT/.env" | tail -n1 | cut -d= -f2)"
port="${port:-5000}"
healthy=0
health_body=""
for _ in $(seq 1 60); do
  health_body="$(curl -fsS --connect-timeout 2 --max-time 5 "http://127.0.0.1:$port/api/health" 2>/dev/null || true)"
  if [[ "$health_body" == *'"status":"ok"'* || "$health_body" == *'"status": "ok"'* ]]; then
    healthy=1
    break
  fi
  sleep 2
done
if [[ "$healthy" != 1 ]]; then
  docker compose logs --tail=100 backend >&2 || true
  say "Docker backend failed health check; restoring native backend"
  systemctl disable --now ayadnm-docker.service || true
  systemctl enable --now network-control-backend.service || true
  die "Docker backend health failed; native backend restoration was attempted"
fi

echo
echo "AyadNM installation complete"
echo "Deployment: Docker backend + Host-native enforcement"
echo "Dashboard: https://<gateway-ip>:$port/"
echo "Setup: Host provisioning/wizard verified complete"
echo "Enforcement: network-control-enforcement.service (Host)"
echo "Backend: ayadnm-docker.service (Docker)"
echo "Rollback: systemctl disable --now ayadnm-docker.service && systemctl enable --now network-control-backend.service"
