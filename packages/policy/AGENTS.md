# Deterministic policy

Own pure authorization decisions and stable denial reasons, not signing or ledger mutation. Read [security](../../docs/specs/security.md), [funds](../../docs/specs/funds-and-budgets.md), and intent shapes in [API/data](../../docs/specs/api-and-data.md).

Evaluate immutable intent plus explicit current context. Combine limits using the most restrictive rule. Missing identity, required valuation, freshness, chain/asset/capability or permission denies execution. AI cannot change policy. Enforcement, fresh state and atomic holds remain executor/accounting responsibilities; pure evaluation alone cannot prevent a race.

## Checklist

- [ ] POL-1 / G5: define typed context/verdict/reasons for action authorization.
  - Progress 2026-10-08: paper-scope [`evaluateAction`](src/action-policy.ts) with contract reason codes, most-restrictive limit combination and deny-on-missing context; checks in [`action-policy.test.ts`](src/action-policy.test.ts). Remaining for G5/G8: quote/reference deviation, gas, allowance and live wallet context.
- [ ] POL-2 / G5: enforce ownership/generation/mode/capability/chain/recipient/amount limits.
- [ ] POL-3 / G8: enforce quote age, reference price deviation, slippage, gas and approval bounds.
- [ ] POL-4 / G5,G8: combine platform/user/connector/strategy limits and include pending holds.
- [ ] POL-5 / G5–G8: pass malicious/missing context, stale revision and limit-boundary checks.

Prerequisite: [contracts](../contracts/AGENTS.md); acceptance context from [accounting](../accounting/AGENTS.md) and [connectors](../connectors/AGENTS.md). Tick with evidence; provider policy setup is separately verified by executor.
