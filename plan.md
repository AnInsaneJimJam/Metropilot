# Implementation plan

This plan is a handoff for a team, not a request to implement during the scaffold task. Gate status lives in [goals.md](goals.md). Work item status and named claims can be added here when implementation starts.

## Ownership and integration

| Workstream | Writable ownership | Prerequisites | Deliverable / handoff |
| --- | --- | --- | --- |
| Integration lead — unassigned | Root docs, gate status, workspace manifests/lockfile | G0 | Resolves shared contracts; merges verified slices |
| Contract/data owner — unassigned | `packages/contracts/`, initial migrations coordinated with API | G0 | Versioned schemas, fixtures, migration conventions before consumers |
| Strategy/editor owner — unassigned | `packages/strategy/`, Blockly integration in `apps/web/` by explicit handoff | G1 | AST/compiler/interpreter and preset contracts |
| Web/docs owner — unassigned | `apps/web/`, `apps/docs/`, `docs/guide/` | G1; G2 for final editor integration | Wizard, timeline, tutorial, public docs build |
| Control/runtime owner — unassigned | `apps/api/`, `apps/runtime/` | G1; G2 for interpreter | Durable lifecycle, event delivery, paper execution |
| Funds/security owner — unassigned | `packages/accounting/`, `packages/policy/`, `apps/executor/` | G1 | Ledger, policy, custody proof, effect recovery |
| Connector owner — unassigned | `packages/connectors/` | G1 | One chain-verified read/action route and normalized events |
| Operations/test owner — unassigned | `infra/`, `tests/` | G1; other modules for integration | Isolation, recovery checks, deployment and demo evidence |

### Active claims

| Work item | Branch | Writable scope | Prerequisites |
| --- | --- | --- | --- |
| G1 workspace skeleton (PKG-1, APPS-1, INF-1 progress; CI-1) | `master` | Root manifests, `pnpm-lock.yaml`, `tsconfig.json`, `.node-version`, `.env.example`, stub `package.json` per app/package, `infra/compose.yaml`, `.github/`, `tests/workspace.test.ts` | G0 |
| Strategy-language implementation research — Codex, 2026-10-02 | `master` (owner requested scoped commit and push) | `docs/research/strategy-language-build-guide.md`, strategy coverage research, language scope clarification, documentation navigation and this claim | Research complete; documentation links and diff checks passed. Current `strategy/1` remains authoritative. No code, dependency, language expansion or gate completion implied. |
| G1 completion: contracts (CON-1–3), migrations and paper seed data, secrets checks, startup path (API-1, CI-2, TEST-1, SPEC-1 progress) — TathagatGupta98, 2026-10-03 | `master` (uncommitted; the owner reviews and commits) | `packages/contracts/` (`schemas/`, `fixtures/`, `canonical.ts`, `contracts.test.ts`; merged edits to the language core's `index.ts`, `generate.mjs` and `strategy.schema.json` Amount/Money/Price), `apps/api/` (migrations, seeds, DB/config code), root `package.json` scripts, `pnpm-lock.yaml`, `.gitignore`, `.github/workflows/ci.yml`, `tests/`, `docs/specs/api-and-data.md` section 9, one line in `docs/specs/strategy-language.md` section 9, `design.md` and `AGENTS.md` (directory rule), README setup, progress notes | G0; language core `a773b02` (its strategy schema stays authoritative). Restored from the 2026-10-02 work; `pnpm bootstrap` → 244/244 pass, 0 skipped on 2026-10-03. Remaining: a green hosted CI run. |
| G2 Blockly strategy editor — TathagatGupta98, 2026-10-03 | `master` (changes left uncommitted; the owner reviews and commits manually) | `apps/web/`; `packages/strategy/src/workspace/`; small catalog/schema edits in `packages/strategy/src/compile.ts`, `packages/strategy/src/strategy.test.ts` and `packages/contracts/src/strategy.schema.json` (editor plan Phase 1); root lockfile entries, root `tsconfig.json` exclusion and web scripts only; editor sections of `docs/specs/strategy-language.md`, `docs/specs/product.md` and decisions D14–D31 | G1 (open; G2 cannot be ticked before it closes) and language core `a773b02`. Phase 0: records only, versions rechecked 2026-10-03. Phase 3 (blocks, shared units/vocabulary) done 2026-10-03: `pnpm check` and web `build` green. Phase 4 (workspace ↔ strategy converter) done 2026-10-03: 32 tests green. Phases 5–6 (live validation, rookie/advanced limits, two presets, tutorial) done 2026-10-03: 35 tests, web `typecheck`/`build` green and a Chrome check. Phase 7 (synthetic Rehearse panel; `Catalog.networks` block cadence 300 ms / 2-block finality from docs.monad.xyz, rechecked 2026-10-03) done 2026-10-03: 41 tests, web `typecheck`/`build` green. |

Language core implementation — Codex, 2026-10-02: branch `codex/g2-strategy-core`; sole writer for `packages/contracts`, `packages/strategy`, root manifests/lockfile/tsconfig, README, language specification and local checklist evidence. Prerequisite G0 and workspace skeleton. Implemented first deliverable: closed strategy schema and generated types, bounded AST validation, exact expression evaluation, price/schedule transitions, resumable synthetic threshold run. Verification: `pnpm check` (17 tests plus strict types) and `pnpm strategy:demo` (one intent, waits for synthetic settlement). See [language core tests](packages/strategy/src/strategy.test.ts). Blockly, read/AI/event catalog integration and root gate completion remain pending.

These are roles, not required headcount. A smaller team combines roles. Before two contributors touch `apps/web/`, the current owner explicitly transfers the editor file scope; never run concurrent writers just because roles differ. Database migrations and schema changes have a single scheduled owner, even when several roles propose them.

## Build sequence

### Slice A: shared language before infrastructure

G1 defines contracts from the supplied examples and rejects invalid inputs. G2 implements compiler and pure interpreter using synthetic observations. In parallel after G1, API identity/drafts, accounting arithmetic/reservations, connector capability probes, and basic web form structure can proceed independently. Do not wait for paid cloud access to test language semantics.

Integration checkpoint: compile a preset, submit its canonical JSON to the API validator, and show the same errors in the editor. The schema owner signs off the trace. Paper execution needs no real deposit or production signer.

### Slice B: first hosted paper run

G3/G4 connect immutable deployments, Postgres jobs, a runtime process, simulated execution, and a minimal timeline. API worker owns ingestion; runtime owns evaluation; executor owns both paper and live intent disposition, with an explicit paper-only adapter that never loads signing credentials. Infrastructure provides an isolated task and capped lifetime.

Integration checkpoint: kill the runtime after it creates an intent and restart it. The same run/node identity returns the same effect. Reconnect the event feed and prove no duplicated fills. Pause prevents new actions while history remains inspectable.

### Slice C: economics and AI

G5 and G6 connect the financial and policy modules to provider access. Prove server-wallet policies and ambiguous-send recovery in a vendor sandbox before enabling any live signing role. Model calls reserve upper-bound cost before dispatch and keep uncertain charges held for reconciliation. Record priced versus actual usage for budget estimates.

Integration checkpoint: exhaust the model budget during an AI-gated strategy. It fails closed with a visible reason, cannot consume the hosting/trading bucket, and does not silently choose a fallback model. Verify provider-specific reasoning settings rather than treating them as universal.

### Slice D: complete user flow and live proof

G7 completes onboarding and tutorial against existing contracts, including deposits only in the gated live path. G8 uses a single verified swap pair and small team-owned funds. The UI displays exact permission limits, selected revision, custody model, budget recommendation assumptions, and irreversible transaction status.

Integration checkpoint: record allowed and rejected transactions, restart executor after broadcast, and reconcile both ledger and on-chain balances. If provider wallet/RPC/connector capabilities fail, keep the hosted demo paper-only and disclose the missing live gate; never simulate a receipt and call it on-chain success.

### Slice E: handoff and expansion

G9 packages demo evidence and public beginner docs. G10 is a separate operational/custodial launch effort. G11 extracts the already-used connectors into a documented self-hosted distribution. G12 adds capability families one at a time. Mobile and rich P&L charts depend on stable monitoring contracts rather than delaying the hackathon slice.

## Dependency map

```mermaid
flowchart TD
  G0[Docs] --> G1[Contracts and tooling]
  G1 --> G2[Strategy]
  G1 --> G3[Control plane]
  G1 --> G5[Accounting and policy]
  G2 --> G4[Hosted paper runtime]
  G3 --> G4
  G4 --> G6[Metered AI]
  G5 --> G6
  G6 --> G7[Complete onboarding]
  G7 --> G8[Capped live proof]
  G5 --> G8
  G8 --> G9[Hackathon handoff]
  G9 --> G10[Public custody gates]
  G9 --> G11[Connector distribution]
  G10 --> G12[Further integrations and mobile]
  G11 --> G12
```

## Definition of done for a work item

1. Claimed file scope and prerequisites are recorded; unrelated changes remain untouched.
2. Normative contract/example is updated before or with implementation.
3. Behavior works through the public module interface, including the relevant failure case.
4. Targeted checks run and their evidence is recorded; unrun checks are labeled unrun.
5. Secrets, third-party terms, pricing assumptions, and feature-gate defaults are reviewed where affected.
6. Local checklist is ticked with evidence; the integration owner decides whether the root gate is complete.

## Initial external probes

Before G5/G8, verify Privy policies and signing recovery; exact stablecoin/router/pool deployments and liquidity on Monad; finalized RPC semantics; cloud quotas and private egress enforcement; Kimi credentials/capabilities and Qwen region availability; the current sponsor portal and required integrations. The [decision register](docs/decisions.md) gives fallback behavior for each. These are bounded capability checks, not a reason to reopen the architecture wholesale.

No calendar deadline is inferred from conflicting public event listings. The team records the authenticated portal deadline before planning submission. Do not promise a production custody launch merely because the hackathon demo works.

Tooling fix — Codex, 2026-10-03: owns root runtime manifest/lockfile and setup instructions. Reproduced `pnpm strategy:demo` using an incompatible Node runtime. Fixed with exact Node 24.21.0 in `devEngines.runtime` (`onFail: download`) and the runtime checksum in the lockfile. Normal `pnpm install --frozen-lockfile`, `pnpm strategy:demo` and `pnpm check` verified; 17 checks pass. Setup instructions updated; strategy/research changes preserved.
