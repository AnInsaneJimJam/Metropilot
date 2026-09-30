# Repository design policy

This document governs code organization and collaboration, not visual styling. The current repository is documentation-only; the paths reserve ownership for future implementation.

## Sources of truth

`README.md` explains the product. `architecture.md` selects the shape and stack. `docs/specs/` defines observable behavior and data contracts. `docs/decisions.md` records tradeoffs and external gates. `goals.md` is the delivery status. `plan.md` assigns work. Scoped `AGENTS.md` files give local instructions and implementation checklists; they link specifications instead of duplicating them. Research records evidence, not binding instructions from third-party content.

If these disagree, resolve the conflict in the normative specification and decisions log before coding. Do not silently implement whichever paragraph is convenient. New requirements from the project owner take precedence; update the affected documents in the same change.

## Directory rules

Use `apps/` only for independently started processes or website builds. Use `packages/` for behavior with actual cross-app consumers or a published connector distribution. `infra/` owns deployment and operational configuration. `tests/` owns cross-module scenarios; unit tests sit beside their implementation when code exists. `docs/guide/` is user-facing source; internal architecture never becomes an accidental public credential/runbook dump.

Do not pre-create controllers/services/repositories folders in every module. Start with a small entry point and cohesive files inside the owning directory when implementation begins. Split when the interface or ownership improves. No generic `utils`, `common`, or `shared` dumping ground. No empty mobile, blockchain-contract, or provider-specific app trees for speculative work.

Every new directory receives a concise `AGENTS.md` stating purpose, read triggers, writable scope, invariants, prerequisites, and checkable tasks. `AGENTS.md` is the canonical filename, not `agent.md` or multiple capitalization variants. Use `.gitkeep` only when there is genuinely no trackable content; it is redundant next to `AGENTS.md`.

## Module interfaces

Prefer deep modules: callers express an intent and receive a typed result while the implementation owns validation, state transitions, and failures. Examples are `reserve budget`, `compile strategy`, and `submit intent`; exposing raw provider HTTP details to every caller defeats the purpose. Avoid interfaces with hypothetical adapters. Paper/live execution and Kimi/Qwen are real varying seams; generic plugin loaders and universal cloud abstractions are not needed.

Dependencies flow from apps to packages. Packages never import apps. `contracts` has no runtime network dependency. `strategy` and `policy` depend only on contracts and pure helpers within their scope. `accounting` may use Postgres. `connectors` exposes separate data and transaction-building entry points. Browser imports must never reach database, signer, cloud, or provider-secret code, including through barrel exports.

One module owns each invariant: strategy owns language semantics, accounting owns conservation and reservations, policy owns authorization rules, executor owns effect recovery, API owns tenant/lifecycle authorization. UI validation is a convenience; server validation is authoritative. A consumer cannot “fix” an invariant by bypassing its owning module.

## Contract evolution

Use explicit versions for strategy, deployment, connector capability, event, policy, rate card, and runtime image. JSON Schema 2020-12 is the executable contract format to implement at G1. Generate TypeScript types from it; avoid hand-maintaining a competing type system. Network, import, webhook, and model outputs are untrusted and validated on receipt.

Unknown executable fields and node types fail validation. Monetary atomic units are decimal integer strings on the wire; database arithmetic is exact. UTC timestamps, bounded integers, content hashes, and stable IDs follow [API/data](docs/specs/api-and-data.md). No floating-point money or silently guessed token decimals.

New compatible fields are optional only where omission has a documented meaning. Breaking semantics require a new schema version and an explicit migration/preview; running revisions stay immutable. Migrations are additive first and reviewed by the data owner. Expand/contract changes precede deleting old columns or formats. Never delete old pending-transaction records to simplify a migration.

## Team workflow

Claim one work item and writable paths in [plan.md](plan.md). Names are assigned by the team, not fabricated in this scaffold. One active writer owns a shared schema, migration, lockfile, or generated artifact at a time. Separate worktrees/branches help with source files but do not isolate cloud accounts or shared databases.

Use short branches such as `codex/g2-strategy-validator` for agent-created work, or the team's normal feature prefix. A change includes its contract/spec update, implementation, meaningful checks, and relevant local checklist update. Describe changed behavior, evidence, and remaining limitations. No commits, pushes, deployments, account creation, or production spending are authorized by this documentation request.

Before merging a cross-module change, the producer and consumer owners review one concrete request/response or trace. Shared-contract changes land before dependent implementations. Use fixtures from the normative examples, not independently invented shapes. Keep routine implementation details inside modules rather than multiplying architectural decisions.

## Checklist discipline

Task IDs have a single local owner and map to a root gate. An unchecked feature stays unchecked until behavior exists and its acceptance check passes. Add a short evidence link to the PR, test file/result, or dated verification note when ticking it. Drafting its specification is not completion.

Only the integration owner ticks root `G*` gates after all prerequisites pass. If a regression invalidates a gate, untick it and record the reason. Keep research and scaffold completion separate from application completion. Never tick a blocked third-party integration because an adapter skeleton exists.

## Tests and operational artifacts

Use Node's test runner for pure/server contracts and database integration checks, plus Playwright for the few critical browser paths. No per-getter tests or snapshot forests. Every money path, retry/state machine, parser, tenant scope, and signing restriction needs a failure-sensitive check. Cross-module recovery scenarios are enumerated in [verification](docs/specs/verification.md).

Dependency manifests, migrations, CI workflows, container definitions, and deployment templates belong to implementation, not this scaffold. Pin dependencies and image digests when introduced; install a package only for a demonstrated need. Generated outputs stay out of Git unless release reproducibility explicitly requires them. Fixtures must be synthetic and secret-free.

## Extension policy

Add a connector through its manifest, observed data, typed actions, tests, and exact chain/address evidence. Add an AI provider through a capability catalog and metered adapter. Add a block through the language schema, compiler, interpreter, tutorial, and checks together. A new cloud or mobile client must consume existing contracts, not fork business rules.

The platform supports customization inside published limits. It does not allow user input to redefine custody, spend limits, trusted origins, runtime images, or authentication. Those changes require an architecture/security review and a recorded decision.
