# Hosting on this laptop (Cloudflare Tunnel)

The backend runs in Docker on this machine; a **Cloudflare Tunnel** carries `https://<api hostname>` to it, so no
port is opened and no public IP is needed. The studio stays on Vercel (`https://metropilot.vercel.app`), which
rewrites `/v1/*` to the API hostname. It is the same compose stack as the Lightsail server
([`infra/stack`](../../infra/stack/docker-compose.yml)) with `cloudflared` in place of Caddy.

```
Browser ─https─▶ Vercel ── /v1/* ──▶ Cloudflare edge (TLS) ══ tunnel ══▶ cloudflared ─▶ api:3001
                                                                         (laptop: control, executor, runtimes, postgres)
```

## Bring-up

1. **The domain must be on Cloudflare.** Add it in the Cloudflare dashboard and set the registrar's nameservers to
   the two Cloudflare nameservers it shows. The zone becomes "Active" once DNS propagates.
2. **Log cloudflared in to that zone.** Login writes `~/.cloudflared/cert.pem`, which already belongs to another
   zone on this laptop, so keep both certificates:
   ```
   mv ~/.cloudflared/cert.pem ~/.cloudflared/cert-yash-agrawal.pem
   cloudflared tunnel login                     # pick the new domain in the browser
   mv ~/.cloudflared/cert.pem ~/.cloudflared/cert-<domain>.pem
   mv ~/.cloudflared/cert-yash-agrawal.pem ~/.cloudflared/cert.pem
   ```
3. **Start everything:** from a clean, committed tree, run:
   ```
   CLOUDFLARED_CERT=~/.cloudflared/cert-<domain>.pem infra/tunnel/up.sh api.<domain>
   ```
   The script then:
   - creates the `metropilot` tunnel and its DNS record (first run only);
   - builds the image and renders `infra/tunnel/.env.server`;
   - migrates and seeds the catalog;
   - starts every container and waits for `https://api.<domain>/healthz`.
4. **Studio:** run `infra/scripts/vercel-config.sh https://api.<domain>`, commit `apps/web/vercel.json`, then
   `vercel deploy --prod`.
5. **Smoke checks:**
   - `curl https://api.<domain>/healthz` returns `{"status":"ok"}`;
   - `curl -o /dev/null -w '%{http_code}' https://metropilot.vercel.app/v1/session` returns 401.

**Updating:** commit, then re-run `infra/tunnel/up.sh api.<domain>`. Add `--new-runtime` only when runtime behaviour
changed, then relaunch running agents.

## Keeping it up

- **The platform is only online while the laptop is awake and connected.**
  - Disable sleep on lid close while hosting: on Ubuntu, `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`.
  - Keep it on power.
- **After a restart:** containers restart with Docker (`restart: unless-stopped`). Make sure Docker starts on boot with `sudo systemctl enable docker`.
- **Status and logs:**
  ```
  infra/tunnel/stack.sh ps
  infra/tunnel/stack.sh logs -f api cloudflared
  ```
- **Step-up codes:** `infra/tunnel/stack.sh logs api | grep stepUp.code` (operators only).
- **Backup:**
  ```
  infra/tunnel/stack.sh exec -T postgres pg_dump -U monad -Fc monad > metropilot-$(date +%F).dump
  ```
- **Resources:** the whole stack uses about 0.7 GB of memory when idle. It doesn't touch the development database.
  - It runs in its own volume, `metropilot_pgdata`, under project `metropilot`.
  - It publishes no ports.

## Known limitations

- **Laptop availability:** uptime equals the laptop's. No redundancy and no remote recovery.
- **Secrets:** they live in `infra/tunnel/.env.server` and `infra/tunnel/cloudflared/`, both git-ignored, on this disk.
- **Step-up codes:** they reach operators via the log only. Live v1 runs schedule triggers and swaps only (D61).
- **Real-money switches** stay off: `LIVE_LAUNCH`, `EXECUTOR_LIVE` and `LIVE_OUTFLOWS` are all 0.

## Teardown

1. **Stop:** `infra/tunnel/down.sh`. Keep the data, or add `--purge` to delete the database volume. Take a dump first if needed.
2. **Delete the tunnel and its DNS record:**
   ```
   cloudflared tunnel --origincert ~/.cloudflared/cert-<domain>.pem delete metropilot
   ```
   Then remove the `api` CNAME in the Cloudflare DNS dashboard. The tunnel delete does not remove DNS records.
3. **Local files:**
   ```
   rm -rf infra/tunnel/cloudflared infra/tunnel/.env.server ~/.cloudflared/<tunnel-id>.json
   docker image rm $(docker image ls -q metropilot)
   ```
4. **Vercel:** redeploy without the rewrite, or `vercel project remove metropilot`.
5. **Keys:** rotate the Privy app secret and authorization key, the Envio token and the AI Gateway key if this machine may have been exposed.
6. **Verify:**
   - `cloudflared tunnel list` no longer shows `metropilot`;
   - `docker ps -a --filter label=com.docker.compose.project=metropilot` is empty;
   - `docker volume ls | grep metropilot` is empty (after `--purge`).
