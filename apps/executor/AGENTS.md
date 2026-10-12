# Privileged execution gateway

Own policy enforcement, quotes/build/simulation, custody-provider calls, nonce ownership, signed/submitted recovery, settlement, withdrawal and earned-fee sweep execution. Read the authoritative [executor specification](../../docs/specs/executor.md), then [funds](../../docs/specs/funds-and-budgets.md), [runtime](../../docs/specs/runtime.md), [security](../../docs/specs/security.md), and [connectors](../../docs/specs/connectors.md) before editing.

Runtime submits typed intents, never authorized calldata. Recompute identity, check current authority, reserve atomically, serialize per wallet and validate exact transaction effects. Signing and policy-administration credentials are separate. No generic raw signing/message/export endpoint. Provider counters supplement application reservations.

Unknown signing/broadcast outcomes remain reserved and under reconciliation. Monad inclusion is provisional until canonical finalized checks pass. Use separate paper adapter/identities; paper execution must not load live signing credentials.

## Checklist

- [ ] EXE-1 / G4: implement paper intent admission, deterministic synthetic fill and replay identity.
  - Progress 2026-10-08 (vihaan1016): [`src/`](src/) implements the HTTP boundary, capability checks ([D35](../../docs/decisions.md)), logical-key recomputation, canonical-body idempotency, approved-AST/iteration matching, pure policy, atomic virtual holds under an account lock, deterministic paper fills, pause-before-fill cancellation and `reconcile()` restart recovery, on migration `0004_executor_paper.sql`. Evidence: [`tests/executor-paper.test.ts`](../../tests/executor-paper.test.ts) (G4 scenarios of spec §8/§19 on real PostgreSQL), [`tests/executor-conformance.test.ts`](../../tests/executor-conformance.test.ts) (runtime kit 7/7 over HTTP), [`src/executor.test.ts`](src/executor.test.ts); `REQUIRE_DB=1 pnpm check` 421/421 on four consecutive runs; 481/481 on 2026-10-09 after merging the runtime-facing control API (`63d353e`). Remaining before ticking: a real `AuthoritySource` over the control API's `deployments` table (exists since `0003_runtime_control.sql`; missing fields listed in [integration §3a](../../docs/integration/executor.md#3a-capability-and-deployment-authority)), capability issuance by the control API, branch-evidence verification from persisted broker results ([D36](../../docs/decisions.md)), a process entry (`main.ts`) with a restricted DB role, and a periodic `reconcile()` worker.
  - Progress 2026-10-12 (yash, by agreement with the project owner): [`PostgresAuthority`](src/authority.ts) over `deployments` (0005), [`PostgresMarketData`](src/market.ts) over `market_observations`, [`main.ts`](src/main.ts) (`pnpm executor:dev`) with a 1 s `reconcile()` loop, the capability format moved to `packages/contracts` and re-exported from [`capability.ts`](src/capability.ts) ([D38](../../docs/decisions.md)), the intents → deployments FK and a deployment row in the test harness. Evidence: [paper-stack.test.ts](../../tests/paper-stack.test.ts) (real authority, recorded prices, control-API-issued capabilities, outbox resume). Remaining before ticking: D36 branch evidence and the restricted database role for hosted runs.
- [ ] EXE-2 / G5: prove provider wallet ownership, restrictive policies, revocation and signing recovery.
- [ ] EXE-3 / G5,G8: integrate atomic multi-asset holds, spend counters and durable nonce slots.
- [ ] EXE-4 / G8: build/decode/simulate the one approved swap and exact-allowance transactions.
- [ ] EXE-5 / G8: persist signing/send identity; recover uncertain effects without new logical trades.
- [ ] EXE-6 / G8: reconcile canonical finalized receipts and settle actual amounts/gas once.
- [ ] EXE-7 / G8,G10: implement authenticated withdrawals, allowance cleanup and earned-fee sweeps.
- [ ] EXE-8 / G8–G10: pass crash, policy rejection, duplicate delivery, deficit freeze and provider-outage checks.

Dependencies: [accounting](../../packages/accounting/AGENTS.md), [policy](../../packages/policy/AGENTS.md), [connectors](../../packages/connectors/AGENTS.md), [contracts](../../packages/contracts/AGENTS.md). Live remains gated on external evidence in [decisions](../../docs/decisions.md). Tick only with checks and effect evidence.
