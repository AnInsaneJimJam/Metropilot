#!/usr/bin/env bash
# Write apps/web/vercel.json with the /v1 rewrite to the hosted API (Terraform output api_origin, or $1).
# The studio calls /v1 on its own origin, so session cookies stay first-party through the rewrite.
#   infra/scripts/vercel-config.sh [https://api-origin]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
origin="${1:-$(terraform -chdir="$root/infra/terraform" output -raw api_origin)}"
case "$origin" in https://*) ;; *) echo "API origin must be https://..." >&2; exit 1 ;; esac
sed "s#__API_ORIGIN__#${origin%/}#" "$root/infra/vercel/vercel.json.template" > "$root/apps/web/vercel.json"
echo "wrote apps/web/vercel.json -> $origin/v1/*"
