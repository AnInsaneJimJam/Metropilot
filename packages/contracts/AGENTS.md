# Versioned contracts

Own JSON Schemas and schema-derived transport types for strategies, deployment, events, intents, policies, catalogs and errors. Read [API/data](../../docs/specs/api-and-data.md) and [language](../../docs/specs/strategy-language.md). This package has no network/DB/provider-secret behavior.

Use JSON Schema 2020-12 as source of truth; generated TypeScript types are not a second handwritten schema. Closed executable objects, version rejection, exact money strings and bounded payloads are required. Runtime semantic checks supplement schema validation. Coordinate migration/contract changes before consumers edit shared formats.

## Checklist

- [ ] CON-1 / G1: implement schemas for documented versions and generated types.
- [ ] CON-2 / G1: add complete synthetic fixtures from normative examples and invalid-input cases.
- [ ] CON-3 / G1: define consistent errors, IDs, timestamps, asset identities and event envelopes.
- [ ] CON-4 / G2–G6: validate model/connector outputs and capability/profile references.
- [ ] CON-5 / G1–G8: verify compatibility and consumer generation before changing a contract.

No prerequisite beyond G0. After CON-1/2, strategy, API, accounting and connector work can proceed in parallel with disjoint ownership. Tick only with schema validation evidence; a Markdown table is not an implemented schema.
