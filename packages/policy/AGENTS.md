# Deterministic policy

Own pure authorization decisions and stable denial reasons, not signing or ledger mutation. Read [security](../../docs/specs/security.md), [funds](../../docs/specs/funds-and-budgets.md), and intent shapes in [API/data](../../docs/specs/api-and-data.md).

Evaluate immutable intent plus explicit current context. Combine limits using the most restrictive rule. Missing identity, required valuation, freshness, chain/asset/capability or permission denies execution. AI cannot change policy. Enforcement, fresh state and atomic holds remain executor/accounting responsibilities; pure evaluation alone cannot prevent a race.

## Checklist

- [x] POL-1 / G5: define typed context/verdict/reasons for action authorization.
  - Progress 2026-10-08: paper-scope [`evaluateAction`](src/action-policy.ts) with contract reason codes, most-restrictive limit combination and deny-on-missing context; checks in [`action-policy.test.ts`](src/action-policy.test.ts). Remaining for G5/G8: quote/reference deviation, gas, allowance and live wallet context.
- [x] POL-2 / G5: enforce ownership/generation/mode/capability/chain/recipient/amount limits.
  - Done 2026-10-12: `action-policy/2` identity and chain blocks ([live-policy.test.ts](src/live-policy.test.ts)).
- [ ] POL-3 / G8: enforce quote age, reference price deviation, slippage, gas and approval bounds.
  - Progress 2026-10-12: pure checks done and boundary-tested; open until the live executor feeds real quotes (#37).
- [x] POL-4 / G5,G8: combine platform/user/connector/strategy limits and include pending holds.
  - Done 2026-10-12: minima, largest reserve, intersected allowlists; `mergeVerdicts` keeps earlier denials; pending holds come from `packages/accounting` windows.
- [x] POL-5 / G5–G8: pass malicious/missing context, stale revision and limit-boundary checks.
  - Done 2026-10-12: every live block missing denies; at-limit allows, one past denies.

Prerequisite: [contracts](../contracts/AGENTS.md); acceptance context from [accounting](../accounting/AGENTS.md) and [connectors](../connectors/AGENTS.md). Tick with evidence; provider policy setup is separately verified by executor.
