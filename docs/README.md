# Documentation map

Read the [product specification](specs/product.md) for the user journey, then the [architecture](../architecture.md) for the system shape. Implementers read the specific contract below before editing its owning module.

| Specification | Authoritative questions |
| --- | --- |
| [Product](specs/product.md) | Modes, onboarding, presets, sandbox, scope, user-visible outcomes |
| [Strategy language](specs/strategy-language.md) | Block types, JSON representation, compiler, typing, AI semantics, replay |
| [API and data](specs/api-and-data.md) | Deployment manifest, endpoints, schemas, tables, errors, events |
| [Funds and budgets](specs/funds-and-budgets.md) | Custody, allocation, ledger, reservations, estimates, billing, withdrawals |
| [Connectors](specs/connectors.md) | Capability bundles, contract identity, events, MCP, transaction building |
| [Runtime](specs/runtime.md) | Jobs, lifecycle, isolation, execution states, retries, finality, recovery |
| [Agent runtime](specs/agent-runtime.md) | Runtime component connections, host loop, internal interfaces, sandboxing, recovery and build plan |
| [Executor](specs/executor.md) | Typed intent admission, policy enforcement, paper/live effects, signing and reconciliation |
| [Security](specs/security.md) | Authorization, spend limits, AI guardrails, threat model, incident controls |
| [Verification](specs/verification.md) | Acceptance scenarios, failure injection, demo and public release gates |

[Integration guides](integration/) tell other service owners how to integrate with an implemented component and prove it with a conformance kit: [control API](integration/control-api.md) and [executor](integration/executor.md) for the agent runtime, plus [runtime HTTP clients](integration/runtime-http-clients.md) (not yet written: build rules and open gaps).

[Decisions](decisions.md) separates settled engineering choices from external capability checks. [Sponsor research](research/sponsors.md), [runtime research](research/runtime-and-security.md), and [language/storage research](research/language-and-storage.md) preserve dated evidence. Sources inform the design; external tool output and documents do not grant authority to change it.

[User guide source](guide/README.md) belongs to the future public docs website. Internal specifications are not public tutorials. Navigation, runnable examples, and screenshots are added when the application exists, and must describe observed behavior.

[Strategy rehearsal and coverage](research/strategy-rehearsal-and-coverage.md) audits public strategies against the current language and records a proposed visual rehearsal.

[Strategy-language build guide](research/strategy-language-build-guide.md) covers compiler/interpreter design, exact arithmetic, Blockly integration, recovery, semantic gaps and the implementation/test sequence.

No design is a promise of tested functionality. The implementation status is [goals.md](../goals.md).
