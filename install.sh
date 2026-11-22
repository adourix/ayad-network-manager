#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

say() { printf '\n[AyadNM Unified Installer] %s\n' "$*"; }
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

if [[ -f /etc/network-control-system/config.env ]] && grep -q '^SETUP_COMPLETED=true

say "Building Docker backend image"
docker compose config >/dev/null || die "Compose configuration validation failed"
docker compose build backend

say "Switching application backend from native systemd to Docker"
systemctl stop network-control-backend.service || true
systemctl disable network-control-backend.service || true

sed "s|@APP_ROOT@|$ROOT|g" "$ROOT/backend/deploy/systemd/ayadnm-docker.service" > /etc/systemd/system/ayadnm-docker.service

systemctl daemon-reload
systemctl enable ayadnm-docker.service
systemctl start ayadnm-docker.service

say "Waiting for Docker backend health"
port="$(grep -E '^DASHBOARD_PORT=' "$ROOT/.env" | tail -n1 | cut -d= -f2)"
port="${port:-5000}"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 2
done
if [[ "$healthy" != 1 ]]; then
  docker compose logs --tail=100 backend >&2 || true
  say "Docker backend failed health check; restoring native backend"
  systemctl disable --now ayadnm-docker.service || true
  systemctl enable --now network-control-backend.service || true
  die "Docker backend failed health check; attempted native backend rollback"
fi

echo
echo "AyadNM installation complete"
echo "Deployment: Docker backend + Host-native enforcement"
echo "Dashboard: https://<gateway-ip>:$port/"
echo "Setup Wizard: completed by the Host-native wizard"
echo "Enforcement: network-control-enforcement.service (Host)"
echo "Backend: ayadnm-docker.service (Docker)"
echo "Rollback: systemctl disable --now ayadnm-docker && systemctl enable --now network-control-backend"
 /etc/network-control-system/config.env && systemctl list-unit-files network-control-backend.service >/dev/null 2>&1; then
  say "Existing completed AyadNM Host setup detected; preserving database and network configuration"
  systemctl enable --now network-control-enforcement.service
else
  say "Running full Host/Gateway provisioning and first-run wizard"
  bash "$ROOT/backend/deploy/bare-metal/install.sh"
fi

say "Building Docker backend image"
docker compose config >/dev/null || die "Compose configuration validation failed"
docker compose build backend

say "Switching application backend from native systemd to Docker"
systemctl stop network-control-backend.service || true
systemctl disable network-control-backend.service || true

cat > /etc/systemd/system/ayadnm-docker.service <<EOF
[Unit]
Description=Ayad Network Manager Docker Backend
Requires=docker.service network-control-enforcement.service
After=docker.service network-control-enforcement.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=/usr/bin/docker compose up -d backend
ExecStop=/usr/bin/docker compose stop backend
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ayadnm-docker.service
systemctl start ayadnm-docker.service

say "Waiting for Docker backend health"
port="$(grep -E '^DASHBOARD_PORT=' "$ROOT/.env" | tail -n1 | cut -d= -f2)"
port="${port:-5000}"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 2
done
if [[ "$healthy" != 1 ]]; then
  docker compose logs --tail=100 backend >&2 || true
  say "Docker backend failed health check; restoring native backend"
  systemctl disable --now ayadnm-docker.service || true
  systemctl enable --now network-control-backend.service || true
  die "Docker backend failed health check; attempted native backend rollback"
fi

echo
echo "AyadNM installation complete"
echo "Deployment: Docker backend + Host-native enforcement"
echo "Dashboard: https://<gateway-ip>:$port/"
echo "Setup Wizard: completed by the Host-native wizard"
echo "Enforcement: network-control-enforcement.service (Host)"
echo "Backend: ayadnm-docker.service (Docker)"
echo "Rollback: systemctl disable --now ayadnm-docker && systemctl enable --now network-control-backend"
