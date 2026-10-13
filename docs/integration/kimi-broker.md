# Kimi broker integration

The demo adapter targets **Kimi K2.7 Code through Vercel AI Gateway**. The account-level bounded paper demo was verified on 2026-10-14; public billing/production release gates remain separate. Synthetic tests do not verify real billing. Historical metering rows retain their original model/rate snapshot.

## Local key setup

1. Open the [Gateway API Keys page](https://vercel.com/d?title=AI+Gateway+API+Keys&to=/%5Bteam%5D/~/ai-gateway/api-keys). Create a dedicated `monad-kimi-demo` key; set a $5 spend budget with requests blocked at exhaustion. Do not buy credits or enable automatic recharge for this demo. Check the team's remaining free-credit balance and model eligibility in the dashboard.
2. Save `AI_GATEWAY_API_KEY` only in the ignored root `.env`. No `VITE_` prefix. Only the control/broker process receives it; user API, web, runtime and executor exclude it.
3. Run `pnpm kimi:probe` once. It sends synthetic input, caps total completion at 256 tokens and reserves at most 2,000 micro-USD ($0.002) at the published token rates. An exclusive `.secrets/kimi-probe.json` journal is written **before** network I/O. A second run refuses to dispatch; reconcile an unknown result rather than deleting the journal and retrying. This standalone probe is not a strategy run and does not change the catalog or enable trading.
4. Compare the recorded request ID, model, token counts, completion cap and cost with [Gateway generation logs](https://vercel.com/docs/ai-gateway/observability-and-spend/usage). Ensure the selected route consumes free credits. A timeout, unsupported parameter or unverifiable bill leaves enablement gated.

Only after real evidence exists, supply an ignored `KIMI_VERIFICATION_FILE` containing exactly:

- `model`: `moonshotai/kimi-k2.7-code`
- `rateVersion`: `vercel-kimi-k2.7-code-2026-10-14`
- `inputUsdMicrosPerMillion`: `"950000"`
- `cachedInputUsdMicrosPerMillion`: `"190000"`
- `outputUsdMicrosPerMillion`: `"4000000"`
- `boundedBillingVerified`: `true`
- `verifiedAt`: UTC timestamp, at most seven days old
- `evidenceRef`: bounded reference to the observed model/request/billing evidence

The immutable deployment catalog must explicitly pin a paper `kimi` provider profile with this model and version `1.0.0`. Set `DEMO_KIMI=1` for the local stack to register the separate immutable `paper.kimi-vercel@1.0.0` profile and offer it in Blockly. Existing synthetic `paper.kimi` and running deployments are unchanged; a key alone does not enable an agent. The broker still requires current evidence. Run `pnpm stack:dev`, then select the new profile in authored AI blocks, allocate an API budget and save/launch a new paper revision.

## Published evidence — 2026-10-14

The [Gateway model page](https://vercel.com/ai-gateway/models/kimi-k2.7-code) lists input/cache/output prices of $0.95/$0.19/$4 per million tokens. These are published rates, not an observed invoice. [Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions) uses `https://ai-gateway.vercel.sh/v1/chat/completions`, bearer authentication and the namespaced model ID. [Gateway reasoning controls](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning) advertise reasoning effort controls. The final request uses `reasoning.effort: low` with `exclude: true`; neither an off request nor an absent reasoning field proves zero internal reasoning. [Provider routing](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) restricts the route to `moonshotai`; no model fallbacks are requested.

The request excludes reasoning text, tools and streaming; internal reasoning remains billed inside the total completion cap. It asks for one JSON response, caps total completion tokens at the strategy limit and enforces its timeout. Input uses a conservative UTF-8 byte bound plus 512 framing tokens, capped at 8,192; The synthetic account probe used fewer input tokens than this bound; production input/capability coverage remains a release check. Unexpected usage/model identity/cache-write charges or completion bounds keep the bill unknown. Extra Gateway fees, if observed, require a corrected versioned rate card before enabling dispatch. The adapter makes one HTTP attempt; Gateway-internal attempts and account charging must also be checked in the probe evidence. Free credits do not change the virtual paper accounting rate or imply zero provider usage.

## Durable metering and recovery

Migration 0013 records the original operation, rate snapshot, token ceilings and maximum micro-USD hold **before provider I/O**. There is one provider attempt. Valid reported usage settles once, even when model output is rejected. Missing/invalid usage, timeout or interrupted dispatch retains the hold; no automatic retry or refund occurs. An unresolved bill older than 24 hours blocks further calls to that model profile pending operator reconciliation.

`KimiBroker.reconcileUsage()` is a privileged in-process operation requiring original provider identity, independently verified token usage and an evidence reference. It cannot authorize a missing model decision. `recover()` publishes the durable original result after a crash, or a safe refusal after billing-only reconciliation. It never calls the provider. No runtime-accessible reconciliation endpoint exists.

Evidence: [adapter checks](../../apps/api/src/kimi-adapter.test.ts), [PostgreSQL metering/replay/reconciliation scenarios](../../tests/kimi-broker.test.ts), [migration checks](../../apps/api/src/db/db.test.ts). Issue #9 enforces the [paper allowance specification](../specs/funds-and-budgets.md#model-and-paid-data-calls) through [AiAllowance](../../apps/api/src/ai-allowance.ts). Kimi allowance and metering claims commit together before network I/O. Claims serialize on the agent row across runs/deployments. Unknown holds survive midnight against the API allocation; settlement stays in the original authorization window. Synthetic calls count toward the call limit and settle at zero. Migrations 0015 and 0017 preserve legacy usage while excluding known pre-dispatch refusals; apply all migrations before starting services. [PostgreSQL allowance/runtime replay tests](../../tests/ai-allowance.test.ts) prove these boundaries.

## Observed demo evidence — 2026-10-14

Four authorized synthetic-input probes consumed **$0.00185016** of the $5 free balance; **$4.99814984** remained. The dedicated key has a $5 lifetime spend budget and requests fail at exhaustion. Credential values and account evidence stay in ignored `.env` / `.secrets` files. Local startup uses a separate `monad_kimi_demo` database because the older `monad_dev` has pre-renumbering migrations. Its database/history are preserved; `.secrets/env-before-demo.env` preserves the original local configuration.

Gateway accepted the namespaced model and returned the same model identity, served by `moonshotai` using Gateway system credentials. The final low-effort/excluded-reasoning call returned a valid `skip` JSON decision. Its 133 cached input tokens and 94 total completion tokens (70 internal reasoning + 24 answer tokens) cost **$0.00040127**, below the 1,922-micro-USD conservative hold. The account statement had no surcharge or cache-write charge.

The 128-token probe exhausted exactly its total completion ceiling (112 reasoning + 16 answer), returned `finish_reason: length` and was rejected while its known bill remained metered. Both off/none parameter probes still incurred reasoning tokens: **do not claim this route disables internal reasoning**. The final profile requests low effort, discards reasoning text and meters the combined completion total. A single Gateway provider attempt was observed in the captured routing trace. Timeout, invalid usage/model and duplicate dispatch recovery remain covered with synthetic transport and PostgreSQL; this evidence does not establish future pricing or production availability.
