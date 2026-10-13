# Shared compose stack

The single-machine stack used by both the Lightsail server (Caddy profile) and the laptop + Cloudflare Tunnel option:
`docker-compose.yml` (services, isolated runtime networks), `Caddyfile`, and `render-env.mjs` (renders the env file
without printing values; generated secrets persist across runs). Keep services, env names and isolation identical for
both modes; mode-specific pieces live in infra/lightsail and infra/tunnel.
