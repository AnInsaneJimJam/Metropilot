# Contract fixtures

Synthetic, secret-free examples under `<kind>/valid/` and `<kind>/invalid/`, where `<kind>` is a key of `contractRefs` in `src/index.ts`. `spec-*.json` files must equal the JSON example in their normative spec byte-for-value; `src/contracts.test.ts` checks this.

A valid fixture is a plain document. An invalid fixture is `{"description", "expect": {"fieldPath", "keyword"}, "document"}`: it must fail with that RFC 6901 field path and Ajv keyword, and every reported issue must sit at or below that path. Strategy fixtures assert only the field path, because the language schema uses undiscriminated `oneOf` and Ajv also reports failed branches. `strategy/semantic/` holds schema-valid documents the language core must reject (for example a calendar-invalid date); [strategy-semantics.test.ts](../../../tests/strategy-semantics.test.ts) checks them. Change one thing per invalid fixture so it proves one rule. Use synthetic UUIDv7s, `paper.*` catalog refs and repeated-byte hashes; never real addresses, keys, prompts or user data.

## Checklist

- [ ] FIX-1 / CON-2: when a spec example or schema rule changes, update the matching fixture in the same change, then run `pnpm check`.
