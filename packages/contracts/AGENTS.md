# Versioned contracts

Own JSON Schemas and schema-derived transport types for strategies, deployment, events, intents, policies, catalogs and errors. Read [API/data](../../docs/specs/api-and-data.md) and [language](../../docs/specs/strategy-language.md). This package has no network/DB/provider-secret behavior.

Use JSON Schema 2020-12 as source of truth; generated TypeScript types are not a second handwritten schema. Closed executable objects, version rejection, exact money strings and bounded payloads are required. Runtime semantic checks supplement schema validation. Coordinate migration/contract changes before consumers edit shared formats.

## Checklist

- [x] CON-1 / G1: implement schemas for documented versions and generated types.
  - [strategy.schema.json](src/strategy.schema.json) (language core, `strategy/1` + checkpoint) and [deployment-request-1](schemas/deployment-request-1.schema.json), validated by one strict Ajv 8.20.0 instance with a `uint256` format ([index.ts](src/index.ts) `validate`/`parse`). `pnpm generate` writes the git-ignored `generated.ts` and `generated-contracts.ts` (json-schema-to-typescript 16.0.0). [canonical.ts](src/canonical.ts) adds the RFC 8785/SHA-256 content hash. Not covered: the server-produced DeploymentManifest (spec gives no example); add it with its first producer. Evidence 2026-10-03 (`master`, uncommitted): `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped.
- [x] CON-2 / G1: add complete synthetic fixtures from normative examples and invalid-input cases.
  - [fixtures/](fixtures/): 16 valid and 135 invalid fixtures across 6 kinds, plus a schema-valid semantic case. Both spec examples are byte-for-value fixtures checked against the Markdown. Invalid cases cover versions, float/malformed/zero/overflow amounts, negative prices, unknown and missing fields, oversized fields and bodies, and bad tenant/ID/catalog refs. Operand arity, `-0` and calendar dates are language-core checks in [strategy-semantics.test.ts](../../tests/strategy-semantics.test.ts). Evidence 2026-10-03 (`master`, uncommitted): `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped.
- [x] CON-3 / G1: define consistent errors, IDs, timestamps, asset identities and event envelopes.
  - [common](schemas/common.schema.json) (UUIDv7, refs, timestamps, uint256 amounts, decimals, hashes, asset identity), [error-1](schemas/error-1.schema.json), [event-1](schemas/event-1.schema.json), [audit-event-1](schemas/audit-event-1.schema.json). Choices are recorded in [API/data section 9](../../docs/specs/api-and-data.md). Evidence 2026-10-03 (`master`, uncommitted): `pnpm bootstrap` (Node 24.21.0, pnpm 12.8.1, Postgres 17.11) → 244/244 node:test pass, 0 skipped.
- [ ] CON-4 / G2–G6: validate model/connector outputs and capability/profile references.
- [ ] CON-5 / G1–G8: verify compatibility and consumer generation before changing a contract.

No prerequisite beyond G0. After CON-1/2, strategy, API, accounting and connector work can proceed in parallel with disjoint ownership. Tick only with schema validation evidence; a Markdown table is not an implemented schema.

Progress 2026-10-02: closed `strategy/1` grammar and `strategy-run/1` checkpoint definitions, Ajv validators and schema-derived types exist. `pnpm generate` regenerates ignored types; the normative threshold fixture passes the [language checks](../strategy/src/strategy.test.ts). Progress 2026-10-03: the other domain schemas and fixtures were merged in; `strategy.schema.json` now rejects zero fixed swap amounts, amounts above uint256 and negative prices at the schema level (the compiler already rejected the first two).
