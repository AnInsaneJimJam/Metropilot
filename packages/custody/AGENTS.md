# Custody and chain access

Own the wallet-provider port (Privy server wallets and a local development stand-in), the JSON-RPC chain reader
used for finality and balances, the deposit scanner and the withdrawal transaction gateway. Read
[funds](../../docs/specs/funds-and-budgets.md), [security](../../docs/specs/security.md) and
[executor](../../docs/specs/executor.md).

No private key is stored or logged. Provider calls never run inside a database transaction: record the dispatch,
commit, call, then record the outcome. An ambiguous send reconciles from the chain; it is never resent as a new
transfer. Provider policies are defense in depth; atomic holds in `packages/accounting` stay authoritative.
Live outflows stay disabled until the E03 proof (`pnpm custody:proof`) has dated evidence in `docs/decisions.md`.

## Checklist

- [ ] EXE-2 / G5: Privy capability proof (ownership, policy/admin separation, signing method, export denial, idempotency, recovery) — harness ready, evidence pending credentials.
- [ ] G5: wallet mapping and finalized deposit crediting against a real Monad RPC (E04/E06).
  - Progress 2026-10-12: one wallet per agent, observed/finalized scanner passes (reorg, duplicate, quarantine) on the local chain ([custody.test.ts](../../tests/custody.test.ts)).
- [ ] EXE-7 / G5: withdrawal gateway against a provider sandbox.
  - Progress 2026-10-12: reserve, send, finalize, revert-gas and never-resend-ambiguous on the local provider; API with step-up in [funds-api.test.ts](../../tests/funds-api.test.ts).
