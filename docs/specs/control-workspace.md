# Local control workspace

Implemented slice: React + Blockly user app and Fastify AST/budget validation. The strategy language remains `strategy/1`; this adds transport contracts without changing its semantics.

## Start

Install the pinned dependencies and follow the root database setup (`pnpm db:up`, `pnpm db:migrate`, `pnpm db:seed`). Add `LOCAL_WORKSPACE=1` to your ignored `.env`. In separate terminals, from the repository root:

```sh
pnpm api:dev
pnpm web:dev
```

Open http://127.0.0.1:5173/. The development API listens on 127.0.0.1:3001 and Vite proxies `/v1`. Both `http://127.0.0.1:5173` and `http://localhost:5173` are accepted for local development. The cookie is HTTP-only and SameSite Strict; foreign origins and rebinding hosts are rejected. This entry point refuses production and requires the explicit local flag. It represents one local developer workspace, **not production authentication**. The hosted entry point is `pnpm api:hosted` ([hosted.ts](../../apps/api/src/hosted.ts), [D43](../decisions.md)): it requires `NODE_ENV=production`, an `https://` `PUBLIC_ORIGIN`, `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`, `RUNTIME_IMAGE_DIGEST` and `DATABASE_URL`, refuses `LOCAL_WORKSPACE=1`, and signs users in only through `POST /v1/auth/session` with a verified Privy token. TLS terminates at the ingress. The web app has no hosted login screen yet.

## User flow

Build with blocks or the keyboard rule inspector. Rehearse against clearly labeled synthetic scenarios; the chart and outcome derive from the real interpreter. Rehearsal uses fixed fixture holdings, independent of saved budget settings. AI answers are scripted; no model is called. Review virtual trading, hosting, data/AI and MON limits. Save a revision, then reopen it from Saved strategies (available on small screens too). Unsaved replacement and navigation prompt before losing edits.

The workbench uses one graphite/citron visual system across Blockly, parameters and rehearsal. Compiled scope shows the actual market, trigger and worst-case run bounds. Selected parameters precede safety checks; phone-sized screens initially use readable rule forms, with Blocks available. Motion respects reduced-motion preferences.

The API reruns conversion, compilation and paper-profile checks against the paper catalog resolved from `catalog_versions` (D42); the browser editor and rehearsal keep the strategy package's synthetic catalog, which the seeded `1.1.0` rows reproduce. It stores the workspace and immutable AST revision in one transaction with the current draft pointer and replayable response. Compiler errors identify blocks. Transport failures reuse the same request key while content and version remain unchanged. New edits made during a save remain unsaved. Stale versions return a conflict; reopening the saved strategy requires confirmation before discarding local edits.

## Wire contracts

[control-workspace-1.schema.json](../../packages/contracts/schemas/control-workspace-1.schema.json) defines the closed request and response shapes; generated types are consumed by both apps.

| Route | Behavior |
| --- | --- |
| GET `/v1/session` | Explicit local-only cookie bootstrap; `401` on the hosted factory |
| POST/DELETE `/v1/auth/session` | Hosted only: `{token}` (Privy access token) → `{mode: "hosted", expiresAt}` plus the session cookie; DELETE revokes it (`204`). `404` on the local entry point |
| GET `/v1/catalog` | Paper catalog resolved from `catalog_versions` (synthetic data, labelled), newest usable versions and truthful capabilities |
| GET `/v1/agents` | Authenticated drafts; limit 1–100 (default 25), UUIDv7 cursor |
| POST `/v1/strategies/validate` | Ephemeral authoritative AST and budget checks |
| POST `/v1/agents` | Create a draft with its first immutable revision; Idempotency-Key required |
| POST `/v1/agents/:id/strategy-revisions` | Save another revision; Idempotency-Key and quoted numeric If-Match required |

The session is resolved once per request; the verified tenant is carried to its route. Scope comes only from the authenticated tenant. Unknown owned IDs return 404. A reused request key with different content returns 409 IDEMPOTENCY_CONFLICT; stale If-Match returns 409 REVISION_CONFLICT. Errors use the existing `error/1` contract (versioned by route), with request IDs, safe messages and source locations. Unexpected application faults return 500 `INTERNAL_ERROR`, not retryable. Recognized database connection/availability failures return 503 `PROVIDER_UNAVAILABLE`, retryable with the same request key. Raw exception messages are never exposed. Bodies are capped at 512 KiB; conversion applies its narrower workspace bound. Basic per-process throttling caps an IP at 120 requests/minute; The map tracks at most 1,000 IPs per minute and refuses new IPs at capacity; this is a local safeguard. Hosted scale needs a shared ingress limiter.

Paper budget units: `tradingUsdMicros`, `hostingUsdMicros`, `dataAndAiUsdMicros` are integer strings with six decimal places per virtual USD; `monReserveAtomic` uses 18 decimal places. Trading and hosting must be positive; total virtual USD ≤ 10,000; reserve > 0 and ≤ 100 virtual MON. An AST containing AI calls requires a positive data/AI limit. These settings are validated configuration, **not financial allocations, billing quotes or ledger reservations**. The reserve is a separate virtual-token bound; no token/USD conversion is invented.

## Remaining integrations

Since 2026-10-12 the Operate stage launches a saved revision on the local paper stack (`pnpm stack:dev`), pauses, resumes and stops it, and shows runs and a live activity stream; routes are listed in [control API guide §11](../integration/control-api.md#11-user-lifecycle-and-history). Still outside this slice: cloud hosting, a real API Broker and model provider (reads and AI are synthetic), wallet funding, ledger enforcement, billable estimates, hosted identity and live trading. Sell and withdrawal remain separate operations.

The browser still carries Blockly and the compiler; the production bundle is roughly 351 KiB gzipped plus locally bundled fonts. Future loading and compiler-worker work should be measured against real devices rather than hiding the bundle warning.

## Verification

The API test suite uses throwaway PostgreSQL databases. It covers concurrent same-key replay, distinct-key revision conflicts, cross-tenant access and database references, immutable revisions, exact budget caps, schema/body limits, reload, pagination, suspended tenants and development-host restrictions. Run `REQUIRE_DB=1 pnpm check` against a real database; do not count skipped database suites as evidence. Web build and browser verification are recorded in [plan](../../plan.md).

Framework reference: [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) and [server limits](https://fastify.dev/docs/latest/Reference/Server/). Route schemas are application-owned; user strategies are data passed to the restricted compiler.
