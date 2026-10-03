# Normative specifications

Own product, language, API/data, funds, connectors, runtime, security and verification contracts. Read the affected document in full before changing its behavior; read [decisions](../decisions.md) for settled choices. Coordinate changes with the owning package/app and update examples/tests together.

Specifications use explicit units, states, failure behavior and acceptance criteria. Unknown external facts stay gated rather than invented. Keep all code examples illustrative and secret-free. A schema migration or language semantic change needs versioning and stored-data consequences.

## Checklist

- [x] SPEC-1 / G1: prove normative examples validate against implemented schemas.
  - Done 2026-10-02: both JSON examples are byte-for-value fixtures that parse and validate, and their referenced rows/catalog entries exist in the paper seed ([contracts.test.ts](../../packages/contracts/src/contracts.test.ts), [db.test.ts](../../apps/api/src/db/db.test.ts)). Evidence: `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped, re-run 2026-10-03 after merging with the language core.
- [ ] SPEC-2 / G2–G8: resolve producer/consumer contract changes with named owners.
- [ ] SPEC-3 / G8: verify financial/recovery implementation against specified invariants.
- [ ] SPEC-4 / G9–G10: replace unverified implementation assumptions with linked release evidence.

Tick after corresponding implementation/review evidence exists. Do not relabel planned safeguards as implemented.
