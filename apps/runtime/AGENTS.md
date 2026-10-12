# Isolated strategy runtime

Own the process wrapper around the shared interpreter, capability transport, run checkpoints, health and graceful stop. Read the implementation-level [agent runtime specification](../../docs/specs/agent-runtime.md), then the platform [runtime](../../docs/specs/runtime.md), [language](../../docs/specs/strategy-language.md), and [security](../../docs/specs/security.md).

The interpreter core belongs in `packages/strategy`. This process gets immutable configuration and short-lived capabilities, never DB/cloud/model/signing credentials. Use approved internal API/executor routes only. No eval, arbitrary scripts, user images, downloaded skills or direct provider access. Respect active-time/step limits and durable waiting for financial effects.

A replay uses the same run/node/iteration identity and recorded observations/model result. Fencing/generation failures stop new work; they do not erase already dispatched effects.

## Checklist

- [ ] RUN-1 / G4: verify manifest/image/config version and start an isolated capability-scoped process.
- [ ] RUN-2 / G4: execute shared interpreter with checkpoint/resume and observed resource limits.
- [ ] RUN-3 / G4: recover from crash after intent without duplicate effects or stale-worker completion.
- [ ] RUN-4 / G6: route bounded AI/read requests through the metered broker.
- [ ] RUN-5 / G4,G8: implement pause/stop/drain and prove no new actions after revocation.
- [ ] RUN-6 / G4: pass isolation, malformed input, resource exhaustion and paper/live separation checks.

Progress 2026-10-07 (G4 Phase 1, local only): [host](src/host.ts), [supervisor](src/supervisor.ts), [assignment verification](src/assignment.ts), option-1 [key mapping](src/keys.ts), [config](src/config.ts), [telemetry](src/telemetry.ts); in-memory [stand-ins](src/local/) and [conformance kits](src/conformance/); `pnpm runtime:demo`. [Host tests](src/host.test.ts) cover RUN-2 (checkpoint/resume, active time), RUN-3 (crash after wait and after dispatch, duplicate assignment, stale lease) and RUN-5 (pause, generation change, drain, refused heartbeat) against the stand-ins, plus malformed assignments/results and paper/live refusal for RUN-6. No box is ticked: real control API/executor/broker integration, observed resource limits, isolation and hosted recovery are still required. Progress 2026-10-08 (branch `feat/runtime-control-api`): [control API HTTP client](src/dispatch/control-api.ts) and the single [error mapping](src/dispatch/errors.ts); the supervisor consumes `assignment-offer/2`. End-to-end over HTTP and PostgreSQL, including crash after dispatch with lease reclaim, in [runtime-control.test.ts](../../tests/runtime-control.test.ts). Not yet written: broker and executor clients and `main.ts` ([build notes](../../docs/integration/runtime-http-clients.md)). Integration guides: [control API](../../docs/integration/control-api.md), [executor](../../docs/integration/executor.md).

Progress 2026-10-12 (branch `feat/lifecycle-executor-integration`): [executor HTTP client](src/dispatch/executor.ts), executor capability exchange in the control client, UUIDv7 request IDs, [`main.ts`](src/main.ts) with endpoint configuration and a synthetic broker ([D41](../../docs/decisions.md)); `pnpm stack:dev` runs it. Not yet written: the broker client (no API Broker service).

Prerequisites: [strategy](../../packages/strategy/AGENTS.md), [API](../api/AGENTS.md), [infra](../../infra/AGENTS.md). Runtime intent integration depends on [executor](../executor/AGENTS.md). Tick after behavior and verification evidence exist.
