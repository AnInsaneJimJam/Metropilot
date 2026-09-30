# Isolated strategy runtime

Own the process wrapper around the shared interpreter, capability transport, run checkpoints, health and graceful stop. Read [runtime](../../docs/specs/runtime.md), [language](../../docs/specs/strategy-language.md), and [security](../../docs/specs/security.md).

The interpreter core belongs in `packages/strategy`. This process gets immutable configuration and short-lived capabilities, never DB/cloud/model/signing credentials. Use approved internal API/executor routes only. No eval, arbitrary scripts, user images, downloaded skills or direct provider access. Respect active-time/step limits and durable waiting for financial effects.

A replay uses the same run/node/iteration identity and recorded observations/model result. Fencing/generation failures stop new work; they do not erase already dispatched effects.

## Checklist

- [ ] RUN-1 / G4: verify manifest/image/config version and start an isolated capability-scoped process.
- [ ] RUN-2 / G4: execute shared interpreter with checkpoint/resume and observed resource limits.
- [ ] RUN-3 / G4: recover from crash after intent without duplicate effects or stale-worker completion.
- [ ] RUN-4 / G6: route bounded AI/read requests through the metered broker.
- [ ] RUN-5 / G4,G8: implement pause/stop/drain and prove no new actions after revocation.
- [ ] RUN-6 / G4: pass isolation, malformed input, resource exhaustion and paper/live separation checks.

Prerequisites: [strategy](../../packages/strategy/AGENTS.md), [API](../api/AGENTS.md), [infra](../../infra/AGENTS.md). Runtime intent integration depends on [executor](../executor/AGENTS.md). Tick after behavior and verification evidence exist.
