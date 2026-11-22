#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail 'Docker is not installed.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required to resolve the Compose project name.'

confirm_exact() {
  local prompt="$1" expected="$2" answer
  printf '\n%s\nType exactly "%s" to continue: ' "$prompt" "$expected"
  read -r answer
  [[ "$answer" == "$expected" ]] || fail 'Confirmation did not match; no destructive action was taken.'
}

PROJECT_NAME="$(docker compose config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("name", ""))')"
[[ -n "$PROJECT_NAME" ]] || fail 'Could not determine the Compose project name.'

volume_for() {
  local logical="$1" expected="${PROJECT_NAME}_${logical}" found
  found="$(docker volume ls --format '{{.Name}}' | awk -v expected="$expected" '$0 == expected { print; exit }')"
  [[ -n "$found" ]] || return 1
  printf '%s\n' "$found"
}

reset_database() {
  local db_volume
  db_volume="$(volume_for db-data)" || fail 'Could not identify the exact Compose db-data volume; no volume was deleted.'
  docker compose stop backend db
  docker compose rm -f backend db
  docker volume rm "$db_volume"
  docker compose up -d db
  docker compose --profile migrate run --rm migrate
  docker image rm ayad-network-manager:migrate >/dev/null 2>&1 || true
}

MODE="${1:-}"
case "$MODE" in
  --db-only)
    confirm_exact 'This permanently deletes all PostgreSQL data. Setup configuration will be preserved.' 'DELETE AYADNM DATABASE'
    reset_database
    docker compose up -d backend
    printf '\nDatabase recreated and migrations applied. Existing setup configuration was preserved.\n'
    ;;
  --full-state)
    confirm_exact 'This permanently deletes DB, setup config, setup snapshots and runtime socket state.' 'DELETE ALL AYADNM STATE'
    VOLUMES=()
    for suffix in db-data config-data setup-state runtime-socket; do
      volume="$(volume_for "$suffix")" || fail "Could not identify the exact ${PROJECT_NAME}_${suffix} volume; nothing was deleted."
      VOLUMES+=("$volume")
    done
    docker compose down --remove-orphans
    docker volume rm "${VOLUMES[@]}"
    docker compose up -d db enforcement
    docker compose --profile migrate run --rm migrate
    printf '\nDatabase is initialized. Full-state reset intentionally does NOT start the backend.\n'
    printf 'Complete the missing host-setup integration before starting backend; see docs/DOCKER-DEPLOYMENT.md.\n'
    ;;
  *)
    cat <<'EOF'
Usage:
  ./scripts/docker-reset.sh --db-only
      Deletes only PostgreSQL data, reapplies migrations and restarts the existing deployment.

  ./scripts/docker-reset.sh --full-state
      Deletes PostgreSQL data plus config-data, setup-state and runtime-socket.
      Stops after migrations so first-run setup cannot be skipped accidentally.

Neither mode deletes source code, .env, ./certs or Docker images.
EOF
    exit 2
    ;;
esac

docker compose ps
