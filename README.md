# Monad Hack

A managed platform for retail traders to configure, test, and run trading agents on Monad without setting up servers, model accounts, protocol integrations, or a programming environment.

**Status: local paper stack with real Monad mainnet observations.** The selected connectors are **Aave, Uniswap, and Curve**. Uniswap and Curve provide native prices for reviewed markets and simulated swaps; Aave provides native USD prices and reserve supply/variable-borrow rates. No live signing or lending action is enabled. Hosted infrastructure, identity, model providers and production wallets remain separate work. Run `pnpm market:probe` for a read-only finalized source check. See [domain context](CONTEXT.md), [connector scope](docs/specs/connectors.md#selected-connectors-2026-10-12) and [source evidence](docs/research/market-data-sources.md).

## Local strategy studio

The React/Blockly workspace and Fastify control API support authoritative validation, virtual budget limits and immutable saved revisions. See [setup, contracts and integration boundaries](docs/specs/control-workspace.md). The runtime reads finalized observations through the control API and sends permitted paper swaps to the separate executor. Hosted execution and identity remain separate integrations.

## The product

Users choose connectors, assemble a strategy, review operating costs, and launch an agent. Rookie mode offers editable market presets; advanced mode exposes the same underlying strategy language and additional settings. A connector-only distribution supports people operating their own runtime. The block editor includes conditions, market observations, actions, and bounded AI decisions.

The platform supplies hosted isolation and a free, quota-limited paper-trading sandbox. One custodial agent wallet is presented with separate hosting, model/API, and trading budgets. The platform estimates operating runway and enforces limits; it does not promise profitable trading or an optimal allocation. Users retain control of allocation, pause, withdrawal, and permission changes through the application.

## Start reading

| Document | Purpose |
| --- | --- |
| [architecture.md](architecture.md) | Chosen stack, deployment shape, trust boundaries, end-to-end flows, tradeoffs |
| [design.md](design.md) | Repository policy, ownership, interfaces, change and collaboration rules |
| [goals.md](goals.md) | Sequential delivery gates and the root progress checklist |
| [plan.md](plan.md) | Workstreams, dependencies, integration order, release evidence |
| [docs/README.md](docs/README.md) | Detailed product, language, financial, runtime, and interface specifications |
| [docs/specs/agent-runtime.md](docs/specs/agent-runtime.md) | Agent-runtime role, component boundaries, contracts, sandboxing, recovery and implementation plan |
| [docs/specs/executor.md](docs/specs/executor.md) | Executor HTTP contract, intent identity, paper/live state machines, signing and recovery |
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

The initial stack is a TypeScript pnpm workspace, React/Vite, Blockly, Fastify on Node 24 LTS, PostgreSQL, and separate runtime/executor processes. The current connector scope is Aave, Uniswap, and Curve. Kimi and Privy remain subject to their separate integration and capability checks. Qwen and sponsor hosting are additional integrations, not prerequisites for the first slice. See the architecture and sponsor research for exact limitations.

## Working together

Read the root and nearest scoped `AGENTS.md`. Claim a workstream in `plan.md` before editing shared contracts. Implement only after the documentation-only phase ends through a new implementation request. Mark tasks complete only with working behavior and linked verification evidence; a design paragraph is not an implemented feature. Do not commit real credentials, private keys, user prompts, or wallet exports.

## Development setup

G1 provides the contracts, a local database with migrations and synthetic paper seed data, and checks; no hosted application process exists yet. Requirements: pnpm 12.8.1 (the `packageManager` pin) and a running Docker daemon. `pnpm install` downloads the exact Node 24.21.0 runtime declared in `devEngines.runtime`; project scripts use that local runtime even if your shell has another Node version. `.node-version` also pins CI. See [pnpm runtime management](https://pnpm.io/package_json#devenginesruntime).

```sh
cp .env.example .env       # then set a new POSTGRES_PASSWORD and the same value in DATABASE_URL
pnpm bootstrap             # install, preflight, start Postgres, migrate, seed, full checks
pnpm strategy:demo         # synthetic threshold-sale execution; no network or wallet
pnpm runtime:demo          # synthetic paper runtime: triggers, host loop, crash recovery, fencing, pause
pnpm api:runtime           # local runtime-facing control API on 127.0.0.1:3002 (after pnpm db:migrate)
pnpm stack:dev             # whole local paper stack: user API, control API + worker, executor, runtime, studio
pnpm web:dev               # Blockly strategy editor
```

`pnpm bootstrap` stops at the first failing step. Preflight explains each `.env` mistake without printing secret values. The same steps are available one at a time:

| Command | Effect |
| --- | --- |
| `pnpm db:preflight` | Checks the Node version, `.env`, and the local-only `DATABASE_URL` |
| `pnpm db:up` / `pnpm db:down` | Starts or stops local Postgres 17 on 127.0.0.1 |
| `pnpm db:migrate` | Applies new files from `apps/api/migrations/`; already-applied files are skipped |
| `pnpm db:seed` | Loads deterministic spec fixtures plus the reviewed mainnet-data/paper-effect registry; refuses non-local databases |
| `pnpm check` | Regenerates schema types, strict typecheck and every node:test suite. Database tests skip without a reachable database unless `REQUIRE_DB=1` |
| `pnpm db:reset` | Deletes the local database volume; run `pnpm bootstrap` again afterwards |

Secrets: only `.env` (git-ignored) holds local credentials. `pnpm check` scans tracked and new files for credential-shaped content; committed files only ever hold documented placeholders.

Language entry points and implemented semantics: [strategy specification](docs/specs/strategy-language.md#9-first-local-implementation-2026-10-02).

## Market data in the local stack

`pnpm stack:dev` starts the studio on 5173, user API on 3001, control/ingestion on 3002, paper executor on 3003 and a warm runtime. PostgreSQL uses 5432. RPC access belongs to the API worker; the runtime receives no RPC endpoint or database credential.

The worker uses `https://rpc.monad.xyz` and `wss://rpc.monad.xyz`; optional `MARKET_RPC_URL`/`MARKET_WS_URL` overrides (Alchemy is recommended, see below) belong only in your ignored local environment. HTTPS/WSS are required. New-head notifications are hints; finalized heads, canonical hashes and bounded 100-block recovery determine acceptance. A 5-second watchdog handles disconnects and quiet markets. No Envio account is required and no synthetic market fallback is enabled.

Trading budget values become virtual USDC units on launch, with six decimals; this is an explicit simulation denomination, not a USD/USDC conversion. Operating budget limits remain USD-denominated. Example thresholds are editable examples, not current quotes. Scenario playback for native oracle methods is unavailable; legacy synthetic rehearsal remains a test fixture.

Live transaction builders and signing belong to issues #38–42, the complete broker service to #5, and connector-selection onboarding to #44. The market-read route here implements only authenticated, replayable observation reads.

## Sponsor integrations

### Alchemy

Alchemy is the second witness for money and can carry market data ([D60](docs/decisions.md)):

- **Custody cross-check.** With `CUSTODY_RPC_SECONDARY` set to an Alchemy Monad endpoint, a deposit credits and a withdrawal settles only when the public Monad RPC and Alchemy agree on the finalized height, block hashes, receipts and balances. If they disagree, settlement pauses. One lying or lagging provider cannot cause a credit.
- **Market transport.** `MARKET_RPC_URL` and `MARKET_WS_URL` on Alchemy's Monad mainnet endpoints carry finalized pool reads and `eth_subscribe newHeads` wakeups. For the free tier also set `MARKET_LOG_SPAN=10`, `MARKET_RPC_MAX_RPS=15` and `MARKET_PUSH_MIN_MILLIS=2500` ([funds guide](docs/integration/funds.md#second-rpc-alchemy-d60)).
- **Probe.** `pnpm alchemy:check` compares Alchemy with the public RPC (chain, finality and block hashes, recorded testnet receipts, current and historical balances, mainnet market RPC, WSS heads) and prints PASS/FAIL with host names only.

The Alchemy key is part of the URL, so it belongs only in `.env` or a hosting secret store; errors and logs never include the endpoint. Gas Manager and Webhooks were reviewed and deferred ([sponsor research](docs/research/sponsors.md#rpc-provider-alchemy)).
