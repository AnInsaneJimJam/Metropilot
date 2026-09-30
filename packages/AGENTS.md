# Shared modules

Packages exist for real app consumers or connector distribution. Read [design policy](../design.md) before adding a package. Apps depend on packages; packages never import app source. Maintain browser-safe exports separately from DB/network/signing-related code.

`contracts` owns shapes; `strategy` owns language; `accounting` owns conservation/holds; `policy` owns deterministic decisions; `connectors` owns protocol capabilities. Avoid generic shared/utils modules and speculative factories.

## Checklist

- [ ] PKG-1 / G1: establish dependency direction, exports and schema-derived types.
- [ ] PKG-2 / G2–G6: verify pure modules through their public interfaces and money modules against Postgres.
- [ ] PKG-3 / G7–G8: prove browser bundles exclude secrets/server dependencies and consumers use one contract version.

Child checklists own feature status. Tick integration tasks only with evidence and notify the integration owner for root gates.
