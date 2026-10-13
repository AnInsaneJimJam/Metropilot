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

- [x] EXE-2 / G5: Privy capability proof (ownership, policy/admin separation, signing method, export denial, idempotency, recovery).
  - Done 2026-10-13: `pnpm custody:proof` PASS 9/9 against the project's Privy app; evidence under E03 in [decisions](../../docs/decisions.md).
- [ ] G5: wallet mapping and finalized deposit crediting against a real Monad RPC (E04/E06).
  - Progress 2026-10-12: one wallet per agent, observed/finalized scanner passes (reorg, duplicate, quarantine) on the local chain ([custody.test.ts](../../tests/custody.test.ts)).
  - Progress 2026-10-13: real Monad testnet deposit (contract-forwarded MON, found via call traces) credited once after finality, withdrawn and reconciled exactly (evidence in decisions). Open: scanner throughput (indexer, E10).
  - Progress 2026-10-13: `HyperSyncChain` deposit index (D50) with balance-bisection for forwarded MON; `pnpm custody:hypersync` PASS 5/5 on Monad testnet; the scanner caught up ~149k blocks through it and automated reconciliation passed (evidence under E10 in decisions).
- [ ] EXE-7 / G5: withdrawal gateway against a provider sandbox.
  - Progress 2026-10-12: reserve, send, finalize, revert-gas and never-resend-ambiguous on the local provider; API with step-up in [funds-api.test.ts](../../tests/funds-api.test.ts).
  - Progress 2026-10-13: native MON withdrawal through Privy on Monad testnet finalized and settled with actual gas.
