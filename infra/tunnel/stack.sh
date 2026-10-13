#!/usr/bin/env bash
# docker compose for the laptop deployment, with its project, env file and both compose files (docs/hosting/TUNNEL.md):
#   infra/tunnel/stack.sh ps | logs -f api | exec -T postgres pg_dump -U monad -Fc monad > backup.dump
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/infra/tunnel"
exec docker compose -p metropilot --env-file "$dir/.env.server" -f "$root/infra/stack/docker-compose.yml" -f "$dir/compose.tunnel.yml" "$@"
