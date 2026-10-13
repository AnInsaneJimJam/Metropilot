# Hosting on Lightsail (one server)

> **Status 2026-10-14:** blocked. The organization's SCP `p-cpy6ql88` also denies Lightsail writes (reads are
> allowed), so `terraform apply` is refused. Use the laptop + Cloudflare Tunnel option ([TUNNEL.md](TUNNEL.md)) until it is lifted.

The platform's backend runs on **one Amazon Lightsail server** with Docker Compose; the studio runs on Vercel
(`https://metropilot.vercel.app`). Lightsail is used because the AWS organization's service control policy denies
EC2, ECS, ECR, ELB and Secrets Manager for this account; the Fargate design in [README.md](README.md) remains in the
repository for when that is lifted. The server is [`infra/lightsail`](../../infra/lightsail); the compose stack it runs is
[`infra/stack`](../../infra/stack) (shared with the laptop + Cloudflare Tunnel option, [TUNNEL.md](TUNNEL.md)).

```
Browser ─https─▶ Vercel (apps/web) ── rewrite /v1/* ──▶ https://<ip-with-dashes>.sslip.io (Lightsail static IP)
                                                        ┌──────────── docker compose ─────────────┐
                                                        │ caddy  (Let's Encrypt, ports 80/443)    │
                                                        │ api    (hosted entry, funds worker)     │ edge + backend + egress
                                                        │ control (runtime control, market data)  │ backend + egress
                                                        │ executor (paper; live off by default)   │ backend + egress
                                                        │ proxy-* + runtime-* (2 paper, 1 live)   │ backend only, no internet
                                                        │ postgres 17 (volume pgdata)             │ backend only
                                                        └─────────────────────────────────────────┘
```

- **Server:** `medium_3_0`: 2 vCPU, 4 GB RAM, 80 GB SSD, 4 TB transfer, USD 24/month, us-east-1, Ubuntu 24.04, 2 GB swap.
  - Measured idle memory for the whole stack is about 0.7 GB.
- **Network:**
  - Ports 80/443 are open to all; SSH only from the configured address.
  - The static IP is free while attached.
- **Isolation:**
  - Runtimes run in their proxy's network namespace on an internal-only network. They can reach control and the executor through the proxy (which adds the workload HMAC proof), and nothing else: no database, no internet.
  - Postgres is on the internal network only.
- **Backups:**
  - Lightsail daily automatic snapshots at 06:00 UTC, kept 7 days.
  - A nightly `pg_dump` to `/opt/metropilot/backups`, keeping 7.
- **Secrets:**
  - They live in `/opt/metropilot/.env` (mode 600), rendered by `infra/stack/render-env.mjs` from the repository `.env` plus generated values.
  - Generated secrets persist in the git-ignored `infra/lightsail/.env.server`, so redeploys don't rotate them.
- **Real-money switches** stay off: `LIVE_LAUNCH=0`, `EXECUTOR_LIVE=0`, `LIVE_OUTFLOWS=0`. Turn them on only for an approved capped trade.

## Bring-up

Prerequisites:
- the AWS CLI profile `monad-hack`;
- Terraform ≥ 1.9 and Docker;
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, `ENVIO_API_TOKEN` and `AI_GATEWAY_API_KEY` in the repository `.env`.

1. **Configure:**
   ```
   cp infra/lightsail/terraform.tfvars.example infra/lightsail/terraform.tfvars
   ```
   Set your SSH public key and your IP as a `/32`.
2. **Create the server:**
   ```
   terraform -chdir=infra/lightsail init
   terraform -chdir=infra/lightsail apply
   ```
   This starts the USD 24/month charge.
3. **Deploy:** from a clean, committed tree, run `infra/lightsail/up.sh`. It:
   - waits for first boot;
   - builds the image;
   - ships it over SSH;
   - renders the env;
   - starts Postgres, runs migrations and the catalog seeds, then starts every service;
   - installs the nightly dump;
   - waits for `https://<api_host>/healthz`.
4. **Studio:** run `infra/scripts/vercel-config.sh https://<api_host>`, commit `apps/web/vercel.json`, then `vercel deploy --prod`.
   - Privy's allowed origins must include `https://metropilot.vercel.app`.
5. **Smoke checks:**
   - `curl https://<api_host>/healthz` returns `{"status":"ok"}`;
   - `curl -o /dev/null -w '%{http_code}' https://metropilot.vercel.app/v1/session` returns 401.

**Updating:** commit, then `infra/lightsail/up.sh`.
- Ordinary releases keep the runtime digest deployments pinned, so running agents keep running.
- If runtime behaviour changed, use `up.sh --new-runtime`, then stop and relaunch running agents.

## Operations

- **Shell:** `ssh ubuntu@<static_ip>`, then `cd /opt/metropilot`.
- **Status and logs:** `docker compose ps`, `docker compose logs -f api` (or `control`, `executor`, `runtime-paper-1`, …).
- **Step-up codes:** `docker compose logs api | grep stepUp.code`. They go to the log because MFA or email delivery isn't built, so they reach operators only.
- **Database shell:** `docker compose exec postgres psql -U monad monad`.
- **Restore a dump:**
  ```
  docker compose exec -T postgres pg_restore -U monad -d monad --clean < backups/monad-<date>.dump
  ```
  Stop `api`, `control` and `executor` first.
- **Resize:**
  1. Create a snapshot in the Lightsail console.
  2. Create a new instance from it on a bigger plan.
  3. Move the static IP to the new instance.
  4. Change `bundle_id` in `terraform.tfvars` to match.
- **CPU:** Lightsail CPUs are burstable. Watch "CPU utilization" and "Burst capacity" in the Lightsail console.
- **Cost:**
  ```
  aws ce get-cost-and-usage --profile monad-hack --time-period Start=$(date -u +%Y-%m-01),End=$(date -u -d tomorrow +%F) --granularity MONTHLY --metrics UnblendedCost
  ```

## Known limitations

- **One server:** no failover. Recovery is from a snapshot (up to a day old) or the nightly dump.
- **Shared host:** agent runtimes share it as network-isolated containers, not separate VMs or tasks.
- **Secrets:** they are in an env file on the server, not a secrets manager.
- **Step-up codes:** they reach operators via the log only.
- **Live v1:** runs schedule triggers and swaps only (D61).
- **API address:** it's an `sslip.io` name. A custom domain only needs a DNS A record to the static IP and `API_HOST` set to that name.

## Teardown

Run these in order. Each step says how to verify it. Nothing here is reversible except by restoring a snapshot you
choose to keep.

1. **(Optional) keep data:**
   ```
   ssh ubuntu@<ip> 'cd /opt/metropilot && docker compose exec -T postgres pg_dump -U monad -Fc monad' > metropilot-final.dump
   ```
2. **Stop the services:**
   ```
   ssh ubuntu@<ip> 'cd /opt/metropilot && docker compose down'
   ```
3. **Destroy the infrastructure:**
   ```
   terraform -chdir=infra/lightsail destroy
   ```
   This removes the instance, the static IP and its attachment, the firewall rules and the SSH key pair.
4. **Delete automatic snapshots:** Terraform doesn't remove them, and they keep billing per GB.
   ```
   aws lightsail get-auto-snapshots --resource-name metropilot --profile monad-hack
   aws lightsail delete-auto-snapshot --resource-name metropilot --date <yyyy-mm-dd> --profile monad-hack
   ```
   Also delete any manual snapshots: `aws lightsail get-instance-snapshots`, then `delete-instance-snapshot`.
5. **Verify nothing is left:**
   ```
   aws lightsail get-instances --profile monad-hack
   aws lightsail get-static-ips --profile monad-hack
   aws lightsail get-instance-snapshots --profile monad-hack
   ```
   All three should be empty. Then check Cost Explorer after a day.
6. **Vercel:** `vercel project remove metropilot`, or keep it and redeploy without the rewrite.
7. **Keys:**
   - Rotate the Privy app secret and authorization key, the Envio token and the AI Gateway key if the server or its env file may have been exposed.
   - Remove `infra/lightsail/.env.server` and `terraform.tfstate*` locally once nothing references them.
