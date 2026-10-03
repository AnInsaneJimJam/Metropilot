# web rehearse

The synthetic Rehearse panel (editor plan Phase 7). Follow [web source AGENTS](../AGENTS.md) and the [language spec](../../../../docs/specs/strategy-language.md). `simulate.ts` is pure and deterministic: it plays finalized-block pool prices at the catalog's block cadence (`Catalog.networks`), computes TWAP observations and drives the real engine (`transitionPrice`, `scheduleSlot`, `startRun`, `advanceRun`) with a synthetic paper host. `RehearsePanel.tsx` only plays the trace back and highlights blocks by node ID.

Everything here is labelled **"Synthetic rehearsal — not a paper or live fill"**. Never present it as a paper fill or an on-chain transaction, and never hard-code block time or finality.

- [x] Phase 7: scenarios crosses once / oscillates / stale gap / pending fill; block highlighting; non-actions shown; evidence: `rehearse.test.ts` (6 tests) under `pnpm check`, web `typecheck` and `build` green.
- [x] Phase 8: reads return the latest synthetic TWAP; AI blocks get a scripted answer (allow / skip / out-of-schema / timeout) and no model is called; evidence: `rehearse.test.ts` (8 tests) under `pnpm check`.
