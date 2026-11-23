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
  2|docker)
    ;;
  *)
    die "Unknown mode. Use 1/native or 2/docker."
    ;;
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
  host_setup_completed || die "Host setup wizard returned but required Host config is incomplete; Docker backend will not be installed"
fi

say "Verifying host enforcement, TLS, and installer-owned configuration"
systemctl is-active --quiet network-control-enforcement.service || die "Host enforcement service is not active"
[[ -S /run/network-control/enforcement.sock ]] || die "Enforcement socket is missing"
[[ -r /etc/network-control-system/config.env ]] || die "Host runtime configuration is missing"
[[ -r /etc/network-control-system/tls/server.crt && -r /etc/network-control-system/tls/server.key ]] || die "TLS certificate/key files are missing"
grep -q '^SETUP_COMPLETED=true$' /etc/network-control-system/config.env || die "Gateway setup is not complete"
grep -Eq '^ADMIN_PASSWORD_HASH=.+$' "$ROOT/backend/.env" || die "Admin password hash is missing from backend .env"
grep -Eq '^ADMIN_PASSWORD_SALT=.+$' "$ROOT/backend/.env" || die "Admin password salt is missing from backend .env"
grep -Eq '^DATABASE_URL=.+$' "$ROOT/backend/.env" || die "Database URL is missing from backend .env"

socket_gid="$(stat -c '%g' /run/network-control/enforcement.sock)"
if grep -q '^ENFORCEMENT_SOCKET_GID=' "$ROOT/backend/.env"; then
  sed -i "s/^ENFORCEMENT_SOCKET_GID=.*/ENFORCEMENT_SOCKET_GID=${socket_gid}/" "$ROOT/backend/.env"
else
  printf '\nENFORCEMENT_SOCKET_GID=%s\n' "$socket_gid" >> "$ROOT/backend/.env"
fi
chmod 0600 "$ROOT/backend/.env"

dashboard_port="$(grep -E '^DASHBOARD_PORT=' /etc/network-control-system/config.env | tail -n1 | cut -d= -f2)"
dashboard_port="${dashboard_port:-5000}"
compose_env="$ROOT/.env"
touch "$compose_env"
set_compose_env() {
  local key="$1" value="$2"
  if grep -qE "^$key=" "$compose_env"; then
    sed -i "s|^$key=.*|$key=$value|" "$compose_env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$compose_env"
  fi
}
set_compose_env DASHBOARD_PORT "$dashboard_port"
set_compose_env ENFORCEMENT_SOCKET_GID "$socket_gid"
chmod 0600 "$compose_env"

docker_root="$(docker info --format '{{.DockerRootDir}}')" || die "Unable to determine Docker storage root"
available_kb="$(df -Pk "$docker_root" | awk 'NR==2 {print $4}')"
[[ "$available_kb" =~ ^[0-9]+$ ]] || die "Unable to determine free space for Docker storage"
if (( available_kb < 4194304 )); then
  die "Docker storage has less than 4 GiB free; free space before building images"
fi
say "Docker storage has $(awk -v kb="$available_kb" 'BEGIN {printf "%.1f",kb/1048576}') GiB free"

say "Validating Compose configuration"
docker compose config >/dev/null || die "Compose configuration validation failed"

say "Building Docker backend"
docker compose build backend

say "Switching backend from native systemd to Docker"
systemctl stop network-control-backend.service || true
systemctl disable network-control-backend.service || true

SERVICE_FILE="/etc/systemd/system/ayadnm-docker.service"
sed "s|@APP_ROOT@|$ROOT|g" "$ROOT/backend/deploy/systemd/ayadnm-docker.service" > "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable ayadnm-docker.service
systemctl restart ayadnm-docker.service

say "Waiting for backend HTTPS health (up to 120 seconds)"
port="$(grep -E '^DASHBOARD_PORT=' /etc/network-control-system/config.env | tail -n1 | cut -d= -f2 || true)"
port="${port:-5000}"
healthy=0
for _ in $(seq 1 60); do
  if curl -kfsS --connect-timeout 2 --max-time 5 "https://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != 1 ]]; then
  docker compose logs --tail=100 backend >&2 || true
  say "Docker backend failed health check; attempting rollback to native backend"
  systemctl disable --now ayadnm-docker.service || true
  systemctl enable --now network-control-backend.service || true
  die "Docker backend health check failed. Native backend rollback was attempted."
fi

say "Removing unused host-side development dependencies"
if [[ -d "$ROOT/backend/node_modules" ]]; then
  (cd "$ROOT/backend" && npm prune --omit=dev) || say "WARNING: backend dependency pruning failed; deployment remains running"
fi
rm -rf "$ROOT/frontend/node_modules"
npm cache clean --force >/dev/null 2>&1 || true

echo
echo "AyadNM installation complete"
echo "Deployment: Docker backend + Host-native enforcement"
echo "Dashboard: https://<gateway-ip>:$port/"
echo "Setup: Host provisioning/setup verified"
echo "Enforcement: network-control-enforcement.service (Host)"
echo "Backend: ayadnm-docker.service (Docker)"
echo "Rollback: systemctl disable --now ayadnm-docker.service && systemctl enable --now network-control-backend.service"
