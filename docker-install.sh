#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
[[ "$(id -u)" == 0 ]] || { echo "Run with sudo"; exit 1; }
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || { echo "Debian/Ubuntu required"; exit 1; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin
fi
systemctl enable --now docker
if [[ ! -f .env ]]; then cp .env.docker.example .env; chmod 600 .env; fi
if grep -q "^POSTGRES_PASSWORD=replace-with-a-long-random-password$" .env; then
  pw="$(openssl rand -hex 32)"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pw|" .env
fi
mkdir -p certs && chmod 700 certs
if [[ ! -s certs/server.key || ! -s certs/server.crt ]]; then
  ipaddr="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  ipaddr="${ipaddr:-127.0.0.1}"
  openssl req -x509 -newkey rsa:3072 -nodes -days 825 -keyout certs/server.key -out certs/server.crt -subj "/CN=Ayad Network Manager" -addext "subjectAltName=IP:$ipaddr,IP:127.0.0.1,DNS:ayad-nm.local,DNS:localhost"
  chmod 600 certs/server.key && chmod 644 certs/server.crt
fi
echo "Building images..."
docker compose build backend enforcement
echo "Starting DB and enforcement..."
docker compose up -d db enforcement
docker compose ps
echo "Starting backend (migrations are intentionally skipped)..."
docker compose up -d backend
sleep 5
docker compose ps
echo
echo "Dashboard: https://<server-ip>:$(grep -E "^DASHBOARD_PORT=" .env | cut -d= -f2 | tail -n1)/"
echo "Setup wizard: /setup"
echo "Note: this uses the compose PostgreSQL container, not host PostgreSQL."
echo "Docker host network setup is not production-ready until host-setup broker work is complete."
echo "Migrations were skipped. Backend requires an already-compatible schema."
