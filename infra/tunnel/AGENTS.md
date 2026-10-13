# Laptop hosting (Cloudflare Tunnel)

`compose.tunnel.yml` adds cloudflared to the shared stack; `up.sh` creates the tunnel and DNS record, renders the env,
builds, migrates and starts; `down.sh` stops (optionally purging data). Never commit `.env.server` or `cloudflared/`.
Do not touch other tunnels on the operator's Cloudflare account. Guide and teardown: docs/hosting/TUNNEL.md.

## Checklist

- [x] TUN-1: `up.sh` is idempotent (tunnel, DNS record, env, image, migrations) and waits for `/healthz`.
- [x] TUN-2: tunnel credentials are owner-only (directory 0700, file 0600) and cloudflared runs as that owner.
- [x] TUN-3: operator commands go through `stack.sh` (project, env file and both compose files).
- [x] TUN-4: teardown in docs/hosting/TUNNEL.md removes containers, tunnel, DNS record, local credentials and image.
- [ ] TUN-5: rehearse teardown and bring-up from scratch on a second machine.
