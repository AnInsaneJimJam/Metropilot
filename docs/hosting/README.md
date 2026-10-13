# Hosting (AWS + Vercel)

The hosted demo runs the backend on AWS ECS Fargate in one region (us-east-1) with a self-hosted Postgres 17 on
EC2, and the studio on Vercel. Everything on AWS is Terraform in [`infra/terraform`](../../infra/terraform); the
operator scripts are in [`infra/scripts`](../../infra/scripts). Teardown: [TEARDOWN.md](TEARDOWN.md).

Nothing in this repository creates resources by itself: every step below is a command you run.

## Architecture

```
 Browser ──https──▶ Vercel (apps/web)  ── rewrite /v1/* ──▶ CloudFront (https, *.cloudfront.net or custom domain)
                                                                   │ http + X-Origin-Verify header
                                                                   ▼
                                      ALB (public subnets; port 80 from CloudFront origin-facing IPs only)
                                                                   │ :3001
 ┌──────────────── VPC 10.40.0.0/16 ───────────────────────────────┼──────────────────────────────────────────┐
 │ public subnets (2 AZ), public IPs, egress HTTPS + Postgres only  ▼                                          │
 │   api (hosted.ts: user API, sessions, funds worker) ──┐                                                     │
 │   control (runtime-control API, workers, market data)─┼──5432──▶ Postgres 17 on EC2 t4g.small             │
 │   executor (paper + live pipeline) ───────────────────┘          (encrypted data volume, SSM only,         │
 │        ▲ :3003                ▲ :3002                              nightly pg_dump → S3)                   │
 │        │ (Cloud Map: executor.monad.internal, control.monad.internal, db.monad.internal)                   │
 │ private subnets (2 AZ), NO internet route                                                                   │
 │   runtime / runtime-live tasks: [workload proxy (holds HMAC secret)] → loopback → [runtime (no secrets)]   │
 │        └─ ECR, logs, Secrets Manager via interface endpoints; image layers via the S3 gateway endpoint     │
 └─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **One image** ([`Dockerfile`](../../Dockerfile)) for every service; the ECS command picks the role through
  [`infra/container/entry.sh`](../../infra/container/entry.sh): `api`, `control`, `executor`, `runtime`, `proxy`,
  `migrate`, `prune`. Non-root, read-only root filesystem, ephemeral `/tmp`.
- **Runtimes** have no route to the internet, no AWS credentials (no task role; `AWS_*` variables are stripped
  because the runtime refuses credential-shaped variables) and no secrets. Each runtime task has a
  [workload proxy](../../infra/sidecar/workload-proxy.mjs) sidecar on loopback: the runtime talks plain http to
  `127.0.0.1:3002/3003` (the only plain-http origins it accepts) and the proxy forwards to the control API and
  executor, adding an HMAC proof of the task-bound workload ID (`runtime-<ECS task id>`) that the hosted control
  API verifies (`HOSTED=1`, `RUNTIME_WORKLOAD_SECRET`). Paper and live runtimes are separate services
  (`runtime`, `runtime-live`) because an assignment for the other mode is refused.
- **Secrets**: one Secrets Manager secret per service (JSON); each execution role reads only its own. Keys are
  listed once in [`infra/secret-keys.json`](../../infra/secret-keys.json) and written by `put-secrets.sh`, so no
  secret value is in Terraform state (exception: the CloudFront→ALB origin-verify token, which grants nothing by
  itself).

| Service | Secret keys |
| --- | --- |
| api | DATABASE_URL, PRIVY_APP_ID, PRIVY_VERIFICATION_KEY, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, ENVIO_API_TOKEN, CUSTODY_RPC, CUSTODY_RPC_SECONDARY |
| control | DATABASE_URL, EXECUTOR_CAPABILITY_SECRET, BROKER_CAPABILITY_SECRET, RUNTIME_WORKLOAD_SECRET, AI_GATEWAY_API_KEY, KIMI_VERIFICATION_JSON |
| executor | EXECUTOR_DATABASE_URL, EXECUTOR_CAPABILITY_SECRET, PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, CUSTODY_RPC, LIVE_RPC |
| runtime, runtime-live (proxy container only) | RUNTIME_WORKLOAD_SECRET |
| migrate | DATABASE_URL |
| db (EC2 instance profile) | POSTGRES_PASSWORD |

Non-secret settings per service come from `service_env` in `terraform.tfvars` (custody chain, `LIVE_OUTFLOWS`,
`EXECUTOR_LIVE`, `DEMO_KIMI`). **Live switches default to off** (`LIVE_OUTFLOWS=0`, `EXECUTOR_LIVE=0`): nothing
signs until you set them.

## Cost estimate (us-east-1, per month, always on)

List prices as remembered on 2026-10-14; check the [AWS pricing calculator](https://calculator.aws/) before
relying on them. Fargate ARM64: $0.03238 per vCPU-hour, $0.00356 per GB-hour; 730 hours.

| Component | Size | ≈ $/month |
| --- | --- | --- |
| api (Fargate) | 0.5 vCPU / 1 GB × 1 | 14 |
| control (Fargate) | 0.5 vCPU / 1 GB × 1 | 14 |
| executor (Fargate) | 0.25 vCPU / 0.5 GB × 1 | 7 |
| runtime paper (Fargate, with proxy) | 0.25 vCPU / 0.5 GB × 2 | 14 |
| runtime-live (Fargate, with proxy) | 0.25 vCPU / 0.5 GB × 1 | 7 |
| Application Load Balancer | base + ~1 LCU | 22 |
| VPC interface endpoints | 4 endpoints × 1 AZ ($0.01/h each) | 29 |
| Public IPv4 addresses | 3 tasks + DB + 2 ALB ($0.005/h each) | 22 |
| Postgres host | EC2 t4g.small + 10 GB root + 20 GB data gp3 | 15 |
| CloudFront | demo traffic (within the free allowance) | 0–1 |
| Secrets Manager | 6 secrets × $0.40 | 2.4 |
| CloudWatch Logs | ~2–5 GB ingested, 14-day retention | 1–3 |
| ECR, S3 backups, Cloud Map | small | 2 |
| **Total** | | **≈ $150–155** |
| Vercel | Hobby plan (non-commercial demo) | 0 |

Levers: scale `runtime`/`runtime-live` to 0 when idle (−$21), stop the stack between demos (scale every service to
0: about $70/month remains for the ALB, endpoints, IPs and the database), or remove the interface endpoints by
running runtimes in public subnets (weaker isolation, not recommended). There is no AWS Budgets alert (Budgets is
not in the enabled service list); check spend weekly with:

```
aws ce get-cost-and-usage --profile monad-hack --time-period Start=$(date -u +%Y-%m-01),End=$(date -u -d tomorrow +%F) \
  --granularity MONTHLY --metrics UnblendedCost
```

## Bring-up

**Prerequisites:** the organisation SCP allows ec2, ecs, ecr, elasticloadbalancing, iam (PassRole,
CreateServiceLinkedRole), secretsmanager, kms, ssm, servicediscovery, cloudwatch, logs, s3, cloudfront, route53,
acm in us-east-1; Terraform ≥ 1.9; Docker with buildx and arm64 emulation (`docker run --privileged --rm
tonistiigi/binfmt --install arm64` once); AWS CLI v2 with profile `monad-hack`; Python 3; Vercel CLI logged in.
All commands run from the repository root with a clean, committed working tree.

1. **Vercel project:** created 2026-10-14 as `metropilot` (team `yash-agrawal-s-projects`, root directory
   `apps/web`, framework Vite, Node 24.x), production URL **`https://metropilot.vercel.app`**, with
   `VITE_PRIVY_APP_ID` set for Production. It has no Git connection: deploy from the repository root with
   `vercel deploy --prod` (the root `.vercelignore` keeps `.env`, `.secrets/`, state and build output out of the
   upload). Until step 8 adds the `/v1` rewrite the site loads but cannot reach an API.
2. **Configure:** `cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars`, set
   `public_origin` to that URL and review `service_env`.
   `cp infra/env.hosting.example .env.hosting` and fill in the Privy values (save the verification PEM under
   `.secrets/`), RPC, Envio and the AI Gateway key. Leave generated values empty.
3. **Bootstrap the registry and secret containers:**
   ```
   terraform -chdir=infra/terraform init
   terraform -chdir=infra/terraform apply -target=aws_ecr_repository.app -target=aws_ecr_lifecycle_policy.app \
     -target=aws_secretsmanager_secret.service -target=aws_service_discovery_private_dns_namespace.internal
   ```
4. **Image and secrets:**
   ```
   infra/scripts/build-push.sh      # pushes <repo>:<git sha>, writes infra/terraform/deploy.auto.tfvars.json
   infra/scripts/put-secrets.sh     # writes every service secret; generates the database password and HMAC/capability secrets
   ```
5. **Everything else, with services at zero first** (the database must be migrated before tasks start):
   ```
   terraform -chdir=infra/terraform plan -var 'desired_counts={api=0,control=0,executor=0,runtime=0,runtime_live=0}'
   terraform -chdir=infra/terraform apply -var 'desired_counts={api=0,control=0,executor=0,runtime=0,runtime_live=0}'
   ```
   The Postgres host installs itself (about 5 minutes; it waits for the password from step 4). Check:
   `aws ssm start-session --profile monad-hack --target $(terraform -chdir=infra/terraform output -raw db_instance_id)`
   then `sudo tail /var/log/monad-db-init.log` → `postgres ready on …`.
6. **Migrate, then start the services:**
   ```
   infra/scripts/migrate.sh         # migrations + paper catalog + live catalog (exits 0)
   infra/scripts/deploy.sh          # terraform apply with the default counts, waits until services are stable
   ```
7. **Studio on Vercel:**
   ```
   infra/scripts/vercel-config.sh   # writes apps/web/vercel.json with /v1/* → <api_origin>/v1/*
   ```
   Commit `apps/web/vercel.json`. In Vercel → Settings → Environment Variables add `VITE_PRIVY_APP_ID` (the
   public Privy app ID, for the login screen). Deploy (`vercel --prod` from `apps/web`, or push to the production
   branch).
8. **Privy dashboard:** add the Vercel origin (and custom domain, if any) to the app's allowed origins.
9. **Smoke checks:**
   ```
   API=$(terraform -chdir=infra/terraform output -raw api_origin)
   curl -s "$API/healthz"                                                      # {"status":"ok"} = API and database up
   curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/session"                 # 401 (no session) = auth wired
   curl -s -o /dev/null -w '%{http_code}\n' https://<vercel-url>/v1/session   # 401 through the rewrite
   aws logs tail /monad-hack/demo/runtime --profile monad-hack --since 10m     # "Runtime runtime-… serving"
   aws logs tail /monad-hack/demo/control --profile monad-hack --since 10m     # market.ingestion.tick lines
   ```
   Sign in on the Vercel URL and launch a paper preset.

**Updating:** commit, then `infra/scripts/build-push.sh && infra/scripts/migrate.sh && infra/scripts/deploy.sh`.
`migrate.sh` first registers the migrate task with the new image, so a release's migrations run before services
roll. An ordinary release keeps the runtime digest that deployments pinned, so running agents keep running on the new
workers (runtimes claim only runs of their own mode and pinned digest). When runtime behaviour changes, use
`build-push.sh --new-runtime`, then stop and relaunch running agents so they pin the new runtime.

**Custom domain (optional):** set `custom_domain` (e.g. `api.example.com`) and `route53_zone_id` (a public hosted
zone for the domain in this account) and apply; CloudFront gets an ACM certificate and the output `api_origin`
changes; rerun `vercel-config.sh`.

**Shared state (optional):** create a private, versioned S3 bucket, copy
`infra/terraform/backend.s3.tf.example` to `backend.tf`, and `terraform init -migrate-state`.

## Operations

- **Logs:** `aws logs tail /monad-hack/demo/<api|control|executor|runtime|proxy|migrate> --follow --profile monad-hack`
  (14-day retention).
- **Database shell:** `aws ssm start-session --target <db_instance_id>` then `sudo -u postgres psql monad`.
- **Backups:** nightly `pg_dump` (custom format) at 03:17 UTC to `s3://<backup_bucket>/pg/`, kept
  `backup_retention_days` (14). On demand: `sudo /usr/local/bin/monad-pg-backup` on the host.
- **Restore drill:** on the host, `aws s3 cp s3://<bucket>/pg/<file>.dump /tmp/r.dump`, then
  `sudo -u postgres createdb monad_restore && sudo -u postgres pg_restore -d monad_restore /tmp/r.dump` and compare
  row counts (`select count(*) from journals`); drop `monad_restore` afterwards. Record the date in decisions.
- **Scale:** change `desired_counts` and `terraform apply`, or
  `aws ecs update-service --cluster monad-hack-demo --service runtime --desired-count 0`.
- **Audit retention:** run the prune task when needed:
  `aws ecs run-task` with the `migrate` task definition and command override `["prune"]`.

## Known limitations (state them in the demo)

- **Workload identity (gate E02)** is an HMAC proof added by the task's loopback proxy over the private network,
  not a cloud-native workload identity. Runtimes still send the development workload header (to loopback only).
- **One Postgres instance in one AZ**; recovery is from the nightly dump (up to a day of data). All services use one
  database role (restricted roles, issue #25, are not done).
- **Secrets are environment variables** inside the tasks (from Secrets Manager); the CloudFront origin-verify
  token is in Terraform state.
- **One-time codes (step-up) go to the API log** (`stepUp.code` lines in CloudWatch `/monad-hack/demo/api`): MFA or
  email delivery is not built, so codes reach the team operating the demo, not outside users.
- **Live launch** needs `LIVE_LAUNCH=1` in `service_env.api`, and signing additionally needs `EXECUTOR_LIVE=1` and
  `LIVE_OUTFLOWS=1` on the executor. Live v1 runs schedule triggers and swaps only (D61).
- **Event streams** pass through Vercel and CloudFront (60 s origin read timeout; the stream sends a keep-alive
  about every 15 s). If a proxy cuts long streams, the studio reconnects with `Last-Event-ID`.
- No WAF, autoscaling, cost budget alert or multi-region recovery.
