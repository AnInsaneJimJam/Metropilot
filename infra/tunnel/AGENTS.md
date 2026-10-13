# Laptop hosting (Cloudflare Tunnel)

`compose.tunnel.yml` adds cloudflared to the shared stack; `up.sh` creates the tunnel and DNS record, renders the env,
builds, migrates and starts; `down.sh` stops (optionally purging data). Never commit `.env.server` or `cloudflared/`.
Do not touch other tunnels on the operator's Cloudflare account. Guide and teardown: docs/hosting/TUNNEL.md.
