# Shared compose stack

The single-machine stack used by both the Lightsail server (Caddy profile) and the laptop + Cloudflare Tunnel option:
`docker-compose.yml` (services, isolated runtime networks), `Caddyfile`, and `render-env.mjs` (renders the env file
without printing values; generated secrets persist across runs). Keep services, env names and isolation identical for
both modes; mode-specific pieces live in infra/lightsail and infra/tunnel.

## Checklist

- [x] STACK-1: bring-up from a clean tree renders the env (no values printed), migrates, seeds and starts every service.
  - Done 2026-10-14: `infra/tunnel/up.sh monad.yash-agrawal.dev`, `/healthz` ok; mainnet trades `0x7569…2c60` and `0x94f6…3890` settled through this stack.
- [x] STACK-2: runtimes reach only their proxy: one internal network per runtime/proxy pair, loopback forwarder, no Postgres or internet.
- [x] STACK-3: every service has memory, CPU and process limits.
- [x] STACK-4: secrets never in git: `.env.server` mode 0600, git-ignored; values with quotes (Kimi evidence) pass base64-encoded.
- [ ] STACK-5: verify isolation after each change to networks: from a runtime, Postgres and the internet are unreachable.
