#!/usr/bin/env bash
# Stop the laptop deployment. Data stays in the metropilot_pgdata volume unless --purge (then the database is gone).
#   infra/tunnel/down.sh            stop containers
#   infra/tunnel/down.sh --purge    stop and delete the database volume
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/infra/tunnel"
args=(down --remove-orphans)
[ "${1:-}" = "--purge" ] && args+=(--volumes)
docker compose -p metropilot --env-file "$dir/.env.server" -f "$root/infra/stack/docker-compose.yml" -f "$dir/compose.tunnel.yml" "${args[@]}"
