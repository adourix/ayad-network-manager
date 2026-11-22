#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_docker() {
  command -v docker >/dev/null 2>&1 || fail 'Docker is not installed.'
  docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
}

confirm_exact() {
  local prompt="$1" expected="$2" answer
  printf '\n%s\nType exactly "%s" to continue: ' "$prompt" "$expected"
  read -r answer
  [[ "$answer" == "$expected" ]] || fail 'Confirmation did not match; no destructive action was taken.'
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/docker-reset.sh --db-only
      Recreate only PostgreSQL data. Keeps config-data, setup-state, certificates and images.

  ./scripts/docker-reset.sh --full-state
      Recreate PostgreSQL data and setup-owned configuration/runtime state.
      This also removes saved setup/network configuration in the named volumes.

Neither mode deletes source code, .env, ./certs, or Docker images.
EOF
}

require_docker
MODE="${1:-}"
case "$MODE" in
  --db-only)
    confirm_exact 'This permanently deletes all AyadNM PostgreSQL data in the db-data volume.' 'DELETE AYADNM DATABASE'
    docker compose stop backend migrate db enforcement
    docker compose rm -f backend migrate db enforcement
    docker volume rm "${COMPOSE_PROJECT_NAME:-ayad-network-manager}_db-data" 2>/dev/null || {
      VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E '(^|_)db-data$' | head -n1 || true)"
      [[ -n "$VOLUME" ]] && docker volume rm "$VOLUME" || true
    }
    docker compose up -d db enforcement
    docker compose --profile migrate run --rm migrate
    docker compose up -d backend
    ;;
  --full-state)
    confirm_exact 'This permanently deletes DB data and all saved setup/configuration/runtime state volumes.' 'DELETE ALL AYADNM STATE'
    docker compose down --remove-orphans
    for suffix in db-data config-data setup-state runtime-socket; do
      VOLUME="$(docker volume ls --format '{{.Name}}' | grep -E "(^|_)${suffix}$" | head -n1 || true)"
      [[ -z "$VOLUME" ]] || docker volume rm "$VOLUME"
    done
    docker compose up -d db enforcement
    docker compose --profile migrate run --rm migrate
    docker compose up -d backend
    ;;
  *) usage; exit 2 ;;
esac

docker compose ps
printf '\nReset/deployment command sequence completed. Verify setup wizard and gateway health before relying on enforcement.\n'
