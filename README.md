# Monad Hack

A managed platform for retail traders to configure, test, and run trading agents on Monad without setting up servers, model accounts, protocol integrations, or a programming environment.

**Status: architecture and repository scaffold only.** There is no application, executable configuration, installed dependency, deployed infrastructure, or production wallet yet. Project name is a working title. Research was checked on **1 October 2026**; sponsor eligibility, addresses, pricing, and model availability must be checked again before integration.

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

There are intentionally no install or start commands yet. Dependency manifests and runnable checks are the first implementation gate, not pretend setup steps in this scaffold.
