#!/usr/bin/env bash
# Run the platform on this machine behind a Cloudflare Tunnel (docs/hosting/TUNNEL.md). From the repo root:
#   infra/tunnel/up.sh api.example.com                 build, migrate, start; tunnel + DNS created on first run
#   infra/tunnel/up.sh api.example.com --new-runtime   runtime behaviour changed (relaunch running agents after)
# Needs: Docker, cloudflared logged in to the Cloudflare account that holds the hostname's zone
# (CLOUDFLARED_CERT to pick a cert other than ~/.cloudflared/cert.pem).
set -euo pipefail
host="${1:?usage: up.sh <api hostname> [--new-runtime]}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/infra/tunnel"
cert="${CLOUDFLARED_CERT:-$HOME/.cloudflared/cert.pem}"
name="${TUNNEL_NAME:-metropilot}"
cf() { cloudflared tunnel --origincert "$cert" "$@"; }

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; commit first so the image names exactly what it contains." >&2
  exit 1
fi

# Tunnel and DNS (idempotent): one named tunnel, its credentials kept in a git-ignored directory the container reads.
mkdir -p -m 700 "$dir/cloudflared" && chmod 700 "$dir/cloudflared"
if ! cf info "$name" >/dev/null 2>&1; then cf create "$name"; fi
id="$(cf list --name "$name" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].id))')"
creds="$HOME/.cloudflared/$id.json"
[ -f "$creds" ] || { echo "Missing $creds (tunnel created on another machine?). Recreate the tunnel or copy its credentials." >&2; exit 1; }
# Owner-only: cloudflared runs as the operator's user (compose.tunnel.yml), so nothing needs to be world-readable.
install -m 0600 "$creds" "$dir/cloudflared/$id.json"
cat > "$dir/cloudflared/config.yml" <<CFG
tunnel: $id
credentials-file: /etc/cloudflared/$id.json
ingress:
  - hostname: $host
    service: http://api:3001
  - service: http_status:404
CFG
cf route dns --overwrite-dns "$name" "$host"

sha="$(git -C "$root" rev-parse --short=12 HEAD)"
image="metropilot:$sha"
docker build -t "$image" "$root"
digest="0x$(docker image inspect "$image" --format '{{.Id}}' | sed 's/^sha256://')"
if [ "${2:-}" != "--new-runtime" ] && [ -f "$dir/.env.server" ]; then
  digest="$(sed -n 's/^RUNTIME_IMAGE_DIGEST=//p' "$dir/.env.server")"
fi
ENV_OUT="$dir/.env.server" node "$root/infra/stack/render-env.mjs" "$host" "$image" "$digest"
# Vercel rewrite → Cloudflare edge → cloudflared → api: three hops in front of the client address.
grep -q '^TRUSTED_PROXY_HOPS=' "$dir/.env.server" || echo 'TRUSTED_PROXY_HOPS=3' >> "$dir/.env.server"
grep -q '^TUNNEL_CONFIG_DIR=' "$dir/.env.server" || echo "TUNNEL_CONFIG_DIR=$dir/cloudflared" >> "$dir/.env.server"
grep -q '^TUNNEL_UID=' "$dir/.env.server" || echo "TUNNEL_UID=$(id -u):$(id -g)" >> "$dir/.env.server"

compose() { docker compose -p metropilot --env-file "$dir/.env.server" -f "$root/infra/stack/docker-compose.yml" -f "$dir/compose.tunnel.yml" "$@"; }
compose up -d postgres
compose run --rm migrate
compose up -d --remove-orphans

echo "waiting for https://$host/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "https://$host/healthz" >/dev/null 2>&1; then echo "API up: https://$host"; exit 0; fi
  sleep 5
done
echo "API did not become healthy; check: docker compose -p metropilot logs --tail 50 api cloudflared" >&2
exit 1
