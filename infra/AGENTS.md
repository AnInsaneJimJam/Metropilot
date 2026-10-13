# Infrastructure and operations

Own future deployment definitions, network/IAM/secrets, runtime resource profiles, monitoring, backup and recovery configuration. Read [architecture](../architecture.md), [runtime research](../docs/research/runtime-and-security.md), [runtime](../docs/specs/runtime.md), and [security](../docs/specs/security.md).

No infrastructure is provisioned during the scaffold task. Reference deployment is one AWS region with separate control, runtime tasks and executor, plus managed Postgres. Verify actual credits and full networking/database costs. Alibaba is an alternative after equivalent isolation/cost checks, not simultaneous multi-cloud scope.

Runtime gets no signing/model/cloud secrets or DB role; allow only internal gateways. Pin images, use non-root/read-only/bounded resources, and test metadata/peer egress denial. API/executor identities and policy administration remain separate. Alerts alone are not spending caps.

## Checklist

- [ ] INF-1 / G1,G4: define local paper environment and reproducible pinned process/image builds.
  - Progress 2026-10-02 (`master`): [compose.yaml](compose.yaml) runs local-only Postgres 17.11, pinned by digest, bound to 127.0.0.1, with a healthcheck and the password required from `.env`. `docker compose config` passes, and fails when no password is set. Node 24.21.0 is pinned in `.node-version`/`engines`. `pnpm db:up` observed 2026-10-02 on Docker 29.6.1 (container healthy) as part of `pnpm bootstrap`. Remaining: pinned runtime/API/executor process images (G4).
  - G1 portion done 2026-10-03 (commit `5d94ea3`, green hosted CI): local paper environment = digest-pinned Postgres via `pnpm db:up`/`pnpm bootstrap`. Remaining (G4): pinned process images.
- [ ] INF-2 / G4: verify selected cloud account/region/credits/quotas and complete cost estimate.
- [ ] INF-3 / G4: implement isolated tasks, IAM/secret separation, network restrictions and resource teardown.
- [ ] INF-4 / G4,G6: implement global admission limits, usage tags, expiry enforcement and leak detection.
  - Progress 2026-10-13 (branch `feat/g3-control-plane-hardening`, issue #17): paper sandbox admission and usage in the control plane: global cap of active paper deployments, per-user running-agent, session and UTC-day limits from `platform_limits`, usage intervals, pause on exhaustion ([D58](../docs/decisions.md), [quota.ts](../apps/api/src/quota.ts), [migration 0015](../apps/api/migrations/0015_paper_usage.sql)). Evidence: quota tests in [paper-stack.test.ts](../tests/paper-stack.test.ts) (racing launches admit one; removing the admission lock makes it fail), the 0015 check in [db.test.ts](../apps/api/src/db/db.test.ts), per-user `GET /v1/quota` in [hosted-auth.test.ts](../tests/hosted-auth.test.ts). Remaining: cloud usage tags, resource expiry and leak detection (needs INF-3), AI-call quotas (G6).
- [ ] INF-5 / G8–G10: implement metrics/alerts, encrypted backups, restore and signer revocation drills.
- [ ] INF-6 / G9: deploy approved web/docs/demo artifacts only after explicit deployment authorization.
- [ ] INF-7 / G10: document named operational owners and measured recovery evidence.

Dependencies: [API](../apps/api/AGENTS.md), [runtime](../apps/runtime/AGENTS.md), [executor](../apps/executor/AGENTS.md), and [verification](../docs/specs/verification.md). Tick only after observed infrastructure checks; templates alone do not establish isolation.
