# Privileged execution gateway

Own policy enforcement, quotes/build/simulation, custody-provider calls, nonce ownership, signed/submitted recovery, settlement, withdrawal and earned-fee sweep execution. Read [funds](../../docs/specs/funds-and-budgets.md), [runtime](../../docs/specs/runtime.md), [security](../../docs/specs/security.md), and [connectors](../../docs/specs/connectors.md) before editing.

Runtime submits typed intents, never authorized calldata. Recompute identity, check current authority, reserve atomically, serialize per wallet and validate exact transaction effects. Signing and policy-administration credentials are separate. No generic raw signing/message/export endpoint. Provider counters supplement application reservations.

Unknown signing/broadcast outcomes remain reserved and under reconciliation. Monad inclusion is provisional until canonical finalized checks pass. Use separate paper adapter/identities; paper execution must not load live signing credentials.

## Checklist

- [ ] EXE-1 / G4: implement paper intent admission, deterministic synthetic fill and replay identity.
- [ ] EXE-2 / G5: prove provider wallet ownership, restrictive policies, revocation and signing recovery.
- [ ] EXE-3 / G5,G8: integrate atomic multi-asset holds, spend counters and durable nonce slots.
- [ ] EXE-4 / G8: build/decode/simulate the one approved swap and exact-allowance transactions.
- [ ] EXE-5 / G8: persist signing/send identity; recover uncertain effects without new logical trades.
- [ ] EXE-6 / G8: reconcile canonical finalized receipts and settle actual amounts/gas once.
- [ ] EXE-7 / G8,G10: implement authenticated withdrawals, allowance cleanup and earned-fee sweeps.
- [ ] EXE-8 / G8–G10: pass crash, policy rejection, duplicate delivery, deficit freeze and provider-outage checks.

Dependencies: [accounting](../../packages/accounting/AGENTS.md), [policy](../../packages/policy/AGENTS.md), [connectors](../../packages/connectors/AGENTS.md), [contracts](../../packages/contracts/AGENTS.md). Live remains gated on external evidence in [decisions](../../docs/decisions.md). Tick only with checks and effect evidence.
