# Runtime HTTP clients (not yet written)

**Status 2026-10-07: the runtime has no HTTP clients and no process entry point yet.** It talks to the outside world only through the interfaces in [`apps/runtime/src/ports.ts`](../../apps/runtime/src/ports.ts) (`ControlApi`, `Broker`, `Executor`). Today the only implementations are the in-memory stand-ins in [`src/local/`](../../apps/runtime/src/local/), which is why `pnpm runtime:demo` and the tests need no network. Nothing in this repository can call a real control API, broker or executor yet.

What is missing, and where it goes ([agent runtime §16](../specs/agent-runtime.md#16-suggested-source-layout)):

| File | Implements | Talks to |
| --- | --- | --- |
| `apps/runtime/src/dispatch/control-api.ts` | `ControlApi` | [Control API routes](control-api.md#5-endpoints-the-runtime-calls) |
| `apps/runtime/src/dispatch/broker.ts` | `Broker` | API Broker read / `ai.decide` route |
| `apps/runtime/src/dispatch/executor.ts` | `Executor` | `POST /internal/v1/intents` ([executor guide](executor.md#2-the-request)) |
| `apps/runtime/src/main.ts` | Process entry | `parseConfig(process.env)` → build the three clients → `new Supervisor(...).serve()` → `drain()` on `SIGTERM` |

The host loop, supervisor and tests do not change when these arrive: the clients implement the same ports. The runtime owner writes the clients; the control API and executor owners write the servers. Agree on this page before either side starts, and fix it in the same change if a server needs something different.

## 1. Build order that avoids a big-bang integration

1. **Client against a loopback server first.** Write a tiny `node:http` test server that wraps the stand-ins (`LocalControlPlane`, `ScriptedBroker`, `PaperExecutor`) and serves the routes. Run the [conformance kits](../../apps/runtime/src/conformance/) through the HTTP client against it. This proves the wire format, headers, status mapping and timeouts before any real service exists.
2. **Then swap the base URL to the real service** and run the same kits ([INT-1, INT-2](AGENTS.md)). A failure now is a server behavior difference, not a client bug.
3. **Then `main.ts`** and the end-to-end demo against real services.

Server owners can start the same way: make the loopback-wrapped stand-in pass first, then replace its internals with PostgreSQL.

## 2. Rules for every client

- **One method per route.** No generic `request(url, body)` and no URL taken from a document; routes are a fixed table. Service base URLs come from closed runtime configuration (add them to [`config.ts`](../../apps/runtime/src/config.ts)). Note its credential guard: a variable named `*_TOKEN`, `*_API_KEY`, `RPC_URL*` and similar makes the process refuse to start, so name base URLs e.g. `RUNTIME_CONTROL_API_ORIGIN`.
- **Validate both directions.** Before sending, `validate(kind, body)` from `@monad-hack/contracts`; after receiving, `parse(kind, text)`, which enforces the byte ceiling before `JSON.parse`. A response that fails is `RESULT_INVALID` and is never handed to the host. Never pass raw response JSON onward.
- **Explicit timeouts with `AbortController`.** Suggested starting points: control API writes 5 s; `assignments:poll` `waitSeconds` + 5 s; broker read 10 s; broker `ai.decide` the request's `timeoutSeconds` + 5 s (at most 35 s); executor submit 10 s. Bounds come from [runtime.md](../specs/runtime.md).
- **No redirects, no ambient proxies.** Use `redirect: 'error'`; internal services never redirect. Do not honour `HTTP(S)_PROXY` from the environment.
- **Headers:** `Authorization: Bearer <audience-specific capability>`; `X-Request-ID` a fresh UUIDv7 per attempt (tracing only, never identity); for the executor also `Idempotency-Key: <logicalKey>`. Never log headers or bodies; `RuntimeError` messages stay safe (no tokens, prompts or provider text).

## 3. One error mapping (both sides implement it)

Servers answer failures with an [`error-1`](../../packages/contracts/schemas/error-1.schema.json) body. The client turns status and `code` into the runtime's stable [codes](../../apps/runtime/src/errors.ts); the conformance kits assert these codes, so the mapping must be exact.

| Response | Runtime code | Client behavior |
| --- | --- | --- |
| `200` / `201` / `202` with a valid body | — | Return the document. Executor `202` is a normal `intent-result/1` in a pending state |
| `409 LEASE_FENCED` | `FENCED` | Throw; the process stops writes and dispatch for this run |
| `409 GENERATION_REVOKED` (executor: also its `EXECUTOR_STALE_GENERATION` case) | `REVOKED` | Throw; the process drains |
| `401`, `403` | `REVOKED` | Throw; do not retry with the same token |
| `409 IDEMPOTENCY_CONFLICT` (executor: `EXECUTOR_INTENT_CONFLICT`, key mismatch) | `CONFLICT` | Throw; never retried |
| `400`, `422` | `RESULT_INVALID` | Throw; a runtime defect, never retried |
| `429`, `503`, network error, timeout | `UNAVAILABLE` | Bounded retry (section 4), then throw |
| Any other status, or a body that fails its schema | `RESULT_INVALID` | Throw |

**Agree with the executor owner:** `error-1` has no `EXECUTOR_*` codes. The executor's `409` bodies should use `error-1` `IDEMPOTENCY_CONFLICT` or `GENERATION_REVOKED` as `code` and carry the executor reason in `details` (for example `details.reason = "EXECUTOR_STALE_GENERATION"`). Otherwise the client cannot distinguish "drain" from "conflict".

## 4. Retries and ambiguity (the part that causes duplicate effects if wrong)

- Every runtime call is idempotent by design: same run, same operation key, same body. **Retry only with the identical body and key**, bounded (for example 3 attempts) with jittered backoff. Never build a new body or key for a retry.
- **A timeout is not a failure.** After a timeout on `executor.submit` or broker `ai.decide`, the effect may exist. Retrying the same request is safe because the server deduplicates; if retries are exhausted, throw `UNAVAILABLE` and leave the run waiting. The next assignment re-dispatches under the same key. Never treat a timeout as "no trade happened".
- **Never dispatch after a failed `wait`.** If `POST …/wait` did not return success, the checkpoint may not be durable; the host must not call the broker or executor. The host already enforces this ordering; the client must not swallow a `wait` error.
- `result` after a successful dispatch must eventually succeed or the process gives up the run: the server re-offers the run later and the same key is re-dispatched and deduplicated.

## 5. Things the specs do not define yet (decide before building)

These have no closed schema in `packages/contracts` today. Add them there first (one writer for contracts; see [plan.md](../../plan.md)):

| Gap | Suggestion |
| --- | --- |
| Heartbeat body and answer | `runtime-heartbeat/1`: `{assignmentId, fencingToken}` → `{leaseExpiresAt}` |
| Artifact fetch response | Raw artifact text as the body plus a `Content-Digest`-style hash header, or a small `artifact/1` JSON `{contentHash, text}`; the runtime already re-verifies hashes in [`assignment.ts`](../../apps/runtime/src/assignment.ts) |
| Bootstrap redemption for cold-start tasks | `GET /internal/v1/runtime/assignments/{assignmentId}` returns `runtime-assignment/1`; the single-use bootstrap value arrives out of band, never as an environment variable named `*_TOKEN` |
| Capability issue and refresh | Not implemented in the runtime yet. Needs an audience-scoped capability per service, refresh before expiry with jitter, and refusal → `Authority.revoke` → drain ([agent runtime §6](../specs/agent-runtime.md#6-capability-and-authentication)). The supervisor currently only heartbeats |
| Long-poll semantics | Server holds `assignments:poll` up to `waitSeconds` and answers `none` on timeout; the client loops immediately on `none` and backs off only on errors |

## 6. Checklist

- [ ] Gap schemas from section 5 agreed and added to `packages/contracts`.
- [ ] `dispatch/` clients with validation, timeouts, headers, error mapping and retries as above.
- [ ] Loopback server wrapping the stand-ins; both conformance kits green through the clients.
- [ ] `main.ts` with closed configuration, signal-driven drain and capability refresh.
- [ ] Kits green against the real control API and paper executor ([INT-1, INT-2](AGENTS.md)).
