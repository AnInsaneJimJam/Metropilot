# Monad Hack

A managed platform for retail traders to configure, test, and run trading agents on Monad without setting up servers, model accounts, protocol integrations, or a programming environment.

**Status: G1/G2 baseline complete; local strategy studio and control API implemented.** Versioned JSON Schemas, generated types, fixtures, local Postgres migrations with synthetic paper seed data, secret checks, CI, AST validation and resumable synthetic execution exist. The hosted application, deployed infrastructure and production wallet remain pending. Project name is a working title. Research was checked on **1 October 2026**; sponsor eligibility, addresses, pricing, and model availability must be checked again before integration.

## Local strategy studio

The React/Blockly workspace and Fastify control API now support authoritative validation, virtual budget limits and immutable saved revisions. See [setup, contracts and integration boundaries](docs/specs/control-workspace.md). Cloud execution and hosted identity are separate integrations.

## The product

Users choose connectors, assemble a strategy, review operating costs, and launch an agent. Rookie mode offers four editable presets; advanced mode exposes the same underlying strategy language and additional settings. A connector-only distribution supports people operating their own runtime. The block editor includes conditions, market observations, actions, and bounded AI decisions.

The platform supplies hosted isolation and a free, quota-limited paper-trading sandbox. One custodial agent wallet is presented with separate hosting, model/API, and trading budgets. The platform estimates operating runway and enforces limits; it does not promise profitable trading or an optimal allocation. Users retain control of allocation, pause, withdrawal, and permission changes through the application.

## Start reading

| Document | Purpose |
| --- | --- |
| [architecture.md](architecture.md) | Chosen stack, deployment shape, trust boundaries, end-to-end flows, tradeoffs |
| [design.md](design.md) | Repository policy, ownership, interfaces, change and collaboration rules |
| [goals.md](goals.md) | Sequential delivery gates and the root progress checklist |
| [plan.md](plan.md) | Workstreams, dependencies, integration order, release evidence |
| [docs/README.md](docs/README.md) | Detailed product, language, financial, runtime, and interface specifications |
| [docs/decisions.md](docs/decisions.md) | Settled choices and external verification gates |
| [docs/research/sponsors.md](docs/research/sponsors.md) | Sponsor evidence and integration priorities |
| [AGENTS.md](AGENTS.md) | Instructions for contributors and coding agents |

## Repository map

```text
apps/
  web/                 Landing page, onboarding, strategy editor, agent controls
  api/                 Authenticated control plane, lifecycle, metering coordination
  runtime/             Isolated interpreter; cannot sign or directly spend
  executor/            Privileged transaction authorization and reconciliation
  docs/                Public documentation site build; source lives in docs/guide/
packages/
  contracts/           Versioned JSON schemas and transport types
  strategy/            Block definitions, compiler, deterministic interpreter core
  connectors/          Curated protocol tools, market data, MCP distribution
  accounting/          Atomic ledger, reservations, budget and cost arithmetic
  policy/              Deterministic authorization rules and limit evaluation
infra/                 Deployment, secrets, isolation, backup and recovery definitions
tests/                 Cross-module acceptance, recovery, isolation and demo checks
docs/
  specs/               Normative implementation specifications
  research/            Dated primary-source evidence
  guide/               User documentation source and tutorial plan
```

Every directory contains a scoped `AGENTS.md` with implementation tasks. Those files make the directories trackable by Git; `.gitkeep` is only needed if a future directory is genuinely empty.

## First implementation target

Deliver a vertical slice: one user → a preset or editable strategy → hosted paper run → bounded AI decision → proposed swap → spend-policy check → visible result and costs. Then prove a capped Monad transaction using a verified connector and team-controlled funds. Public custodial deposits are a separate release gate, not a condition for demonstrating the product.

The initial stack is a TypeScript pnpm workspace, React/Vite, Blockly, Fastify on Node 24 LTS, PostgreSQL, and separate runtime/executor processes. Start with Kimi, a verified Uniswap route, and Privy wallet infrastructure subject to capability checks. Qwen and sponsor hosting are additional integrations, not prerequisites for the first slice. See the architecture and sponsor research for exact limitations.

## Working together

Read the root and nearest scoped `AGENTS.md`. Claim a workstream in `plan.md` before editing shared contracts. Implement only after the documentation-only phase ends through a new implementation request. Mark tasks complete only with working behavior and linked verification evidence; a design paragraph is not an implemented feature. Do not commit real credentials, private keys, user prompts, or wallet exports.

## Development setup

G1 provides the contracts, a local database with migrations and synthetic paper seed data, and checks; no hosted application process exists yet. Requirements: pnpm 12.8.1 (the `packageManager` pin) and a running Docker daemon. `pnpm install` downloads the exact Node 24.21.0 runtime declared in `devEngines.runtime`; project scripts use that local runtime even if your shell has another Node version. `.node-version` also pins CI. See [pnpm runtime management](https://pnpm.io/package_json#devenginesruntime).

```sh
cp .env.example .env       # then set a new POSTGRES_PASSWORD and the same value in DATABASE_URL
pnpm bootstrap             # install, preflight, start Postgres, migrate, seed, full checks
pnpm strategy:demo         # synthetic threshold-sale execution; no network or wallet
pnpm web:dev               # Blockly strategy editor
```

`pnpm bootstrap` stops at the first failing step. Preflight explains each `.env` mistake without printing secret values. The same steps are available one at a time:

| Command | Effect |
| --- | --- |
| `pnpm db:preflight` | Checks the Node version, `.env`, and the local-only `DATABASE_URL` |
| `pnpm db:up` / `pnpm db:down` | Starts or stops local Postgres 17 on 127.0.0.1 |
| `pnpm db:migrate` | Applies new files from `apps/api/migrations/`; already-applied files are skipped |
| `pnpm db:seed` | Loads the synthetic paper rows used by the spec examples; refuses non-local databases |
| `pnpm check` | Regenerates schema types, strict typecheck and every node:test suite. Database tests skip without a reachable database unless `REQUIRE_DB=1` |
| `pnpm db:reset` | Deletes the local database volume; run `pnpm bootstrap` again afterwards |

Secrets: only `.env` (git-ignored) holds local credentials. `pnpm check` scans tracked and new files for credential-shaped content; committed files only ever hold documented placeholders.

Language entry points and implemented semantics: [strategy specification](docs/specs/strategy-language.md#9-first-local-implementation-2026-10-02).
