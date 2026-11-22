#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail 'Docker is not installed.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'

confirm_exact() {
  local prompt="$1" expected="$2" answer
  printf '\n%s\nType exactly "%s" to continue: ' "$prompt" "$expected"
  read -r answer
  [[ "$answer" == "$expected" ]] || fail 'Confirmation did not match; no destructive action was taken.'
}

volume_for() {
  local logical="$1"
  docker volume ls --format '{{.Name}}' | awk -v suffix="_${logical}" '$0 == logical || substr($0, length($0)-length(suffix)+1) == suffix { print; exit }'
}

MODE="${1:-}"
case "$MODE" in
  --db-only)
    confirm_exact 'This permanently deletes all PostgreSQL data in the Compose db-data volume.' 'DELETE AYADNM DATABASE'
    DB_VOLUME="$(volume_for db-data)"
    [[ -n "$DB_VOLUME" ]] || fail 'Could not identify the db-data volume; nothing was deleted.'
    docker compose stop backend migrate db enforcement
    docker compose rm -f backend migrate db enforcement
    docker volume rm "$DB_VOLUME"
    docker compose up -d db enforcement
    docker compose --profile migrate run --rm migrate
    docker compose up -d backend
    ;;
  --full-state)
    confirm_exact 'This permanently deletes DB, setup config, setup snapshots and runtime socket state.' 'DELETE ALL AYADNM STATE'
    mapfile -t VOLUMES < <(for suffix in db-data config-data setup-state runtime-socket; do volume_for "$suffix"; done | awk 'NF && !seen[$0]++')
    [[ "${#VOLUMES[@]}" -eq 4 ]] || fail 'Could not identify all four expected Compose volumes; nothing was deleted.'
    docker compose down --remove-orphans
    docker volume rm "${VOLUMES[@]}"
    docker compose up -d db enforcement
    docker compose --profile migrate run --rm migrate
    docker compose up -d backend
    ;;
  *)
    cat <<'EOF'
Usage:
  ./scripts/docker-reset.sh --db-only
      Deletes only PostgreSQL data. Keeps setup config, snapshots and runtime state.

  ./scripts/docker-reset.sh --full-state
      Deletes PostgreSQL data plus config-data, setup-state and runtime-socket.

Neither mode deletes source code, .env, ./certs or Docker images.
EOF
    exit 2
    ;;
esac

docker compose ps
printf '\nContainer reset sequence completed. Verify the setup wizard and gateway health before relying on enforcement.\n'
