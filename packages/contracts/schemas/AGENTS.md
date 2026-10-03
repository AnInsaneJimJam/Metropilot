# Contract schemas

JSON Schema 2020-12 files here are the source of truth for wire contracts. `src/generated-contracts.ts` is derived from them by `pnpm generate` ([generate.mjs](../src/generate.mjs)) and is git-ignored; never edit generated output by hand. The strategy schema is [`src/strategy.schema.json`](../src/strategy.schema.json), owned with the language core. Read [API/data](../../../docs/specs/api-and-data.md) and [language](../../../docs/specs/strategy-language.md) before changing a schema.

Rules: closed objects (`additionalProperties: false`) except declared untrusted payloads and bounded maps; `schemaVersion` is a required `const`; money is a decimal-string pattern, never a number; every string, array and map is bounded; no secret, credential, calldata or executable field. A breaking change is a new file and version (`deployment-request-2.schema.json`), not an edit to a released one. `$id` hosts under `monad-hack.example` are names only and are never fetched.

## Checklist

- [ ] SCH-1 / CON-1: after any schema edit, run `pnpm check` (it regenerates types first). Add a valid and an invalid fixture for the changed rule, and record any new choice in the owning spec.
