#!/usr/bin/env bash
# Bring up or update the platform on the Lightsail server (docs/hosting/LIGHTSAIL.md). Run from the repo root with a
# clean, committed tree after `terraform -chdir=infra/lightsail apply`:
#   infra/lightsail/up.sh                 build, ship, migrate, start (keeps the pinned runtime digest)
#   infra/lightsail/up.sh --new-runtime   runtime behaviour changed: new pinned digest (relaunch running agents after)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tf="$root/infra/lightsail"
ip="$(terraform -chdir="$tf" output -raw static_ip)"
host="$(terraform -chdir="$tf" output -raw api_host)"
ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
remote() { ssh "${ssh_opts[@]}" "ubuntu@$ip" "$@"; }

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; commit first so the image names exactly what it contains." >&2
  exit 1
fi

echo "waiting for first-boot setup on $ip"
until remote test -f /var/lib/cloud/instance/metropilot-ready 2>/dev/null; do sleep 10; done

sha="$(git -C "$root" rev-parse --short=12 HEAD)"
image="metropilot:$sha"
docker build --platform linux/amd64 -t "$image" "$root"
# The pinned runtime digest only changes on --new-runtime (runtimes claim runs pinned to their own digest).
digest="0x$(docker image inspect "$image" --format '{{.Id}}' | sed 's/^sha256://')"
if [ "${1:-}" != "--new-runtime" ] && [ -f "$tf/.env.server" ]; then
  digest="$(sed -n 's/^RUNTIME_IMAGE_DIGEST=//p' "$tf/.env.server")"
fi
ENV_OUT="$tf/.env.server" node "$root/infra/stack/render-env.mjs" "$host" "$image" "$digest"

echo "shipping $image"
docker save "$image" | gzip -1 | remote 'gunzip | docker load'
scp "${ssh_opts[@]}" -q "$root/infra/stack/docker-compose.yml" "$root/infra/stack/Caddyfile" "ubuntu@$ip:/opt/metropilot/"
scp "${ssh_opts[@]}" -q "$tf/.env.server" "ubuntu@$ip:/opt/metropilot/.env"
remote 'chmod 600 /opt/metropilot/.env'

remote 'cd /opt/metropilot && export COMPOSE_PROFILES=caddy && docker compose up -d postgres && docker compose run --rm migrate && docker compose up -d --remove-orphans'

# Nightly logical backup on the server (7 kept), next to Lightsail's daily automatic snapshots.
remote 'mkdir -p /opt/metropilot/backups && ( crontab -l 2>/dev/null | grep -v metropilot-backup; echo "30 5 * * * cd /opt/metropilot && docker compose exec -T postgres pg_dump -U monad -Fc monad > backups/monad-\$(date +\%F).dump && ls -1t backups/*.dump | tail -n +8 | xargs -r rm # metropilot-backup" ) | crontab -'

echo "waiting for https://$host/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "https://$host/healthz" >/dev/null 2>&1; then echo "API up: https://$host"; exit 0; fi
  sleep 5
done
echo "API did not become healthy; check: ssh ubuntu@$ip 'cd /opt/metropilot && docker compose ps && docker compose logs --tail 50 api'" >&2
exit 1
