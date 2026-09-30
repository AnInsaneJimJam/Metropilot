# Verification and release evidence

Status: test plan, not passing test results. Owner: `tests/` plus each module owner. Runtime commands will be defined in the G1 workspace manifests; this scaffold contains no fictional install/test scripts.

## Test layers

Use Node's built-in test runner for pure language/policy/arithmetic and server contract checks; a real disposable PostgreSQL instance for isolation/concurrency/migrations; Playwright for critical browser paths; provider sandboxes and chain forks/testnets for integration; capped team-owned funds only for the explicitly authorized final live proof. Unit checks live beside implementation; cross-module scenarios live in `tests/`.

Record mode, network, provider versions, commit, environment, command and observed result. Paper, mocked, fork, testnet and mainnet evidence are different categories. A simulated receipt is not evidence that an on-chain transaction occurred. Provider probes do not run by default in CI with paid credentials.

## Acceptance matrix

| ID | Scenario | Required observation | Gate / owner |
| --- | --- | --- | --- |
| V01 | Parse examples and malformed strategy/config inputs | Valid fixtures pass; unknown versions/fields, overflow, bad units/references and excessive depth fail | G1–2 / contracts, strategy |
| V02 | Editor save/load, layout edit, AST import | Behavior hash and semantics preserved; layout alone cannot alter execution | G2 / web, strategy |
| V03 | Crossing sequence, stale gap and cooldown | `2499,2501,2502` fires once; first/recovery sample establishes baseline; no stale/duplicate trigger | G2 / strategy |
| V04 | Branch/repeat/AI determinism | Bounded paths; unique loop effects; replay uses recorded AI and inputs | G2/G6 / strategy, runtime |
| V05 | Two users exchange guessed IDs and stream cursors | No cross-tenant read/write/event leak under actual non-superuser roles | G3 / API |
| V06 | Duplicate launch and cloud timeout after resource creation | One active generation, one resource lease, failed resources cleaned | G3–4 / API, infra |
| V07 | Runtime crash after accepted intent, duplicate event/backfill | Same run/effect recovered without duplicate fill or lost financial event | G4 / runtime, executor |
| V08 | Runtime requests metadata/peer DB/signer secrets, shell/upload, excess resources | Access denied; abusive run stops; other tenant remains unaffected | G4 / infra, security |
| V09 | Concurrent model/trade/withdrawal reservations | No negative available bucket, partial multi-asset hold, or cap overshoot | G5 / accounting |
| V10 | Deposit speculative/duplicate/canonical conflict | Only one finalized canonical credit; disagreement freezes settlement | G5/G8 / executor |
| V11 | Journal balance, refund, sweep and unsupported token | Per-asset conservation; sweep preserves liabilities; unsupported transfers quarantined | G5 / accounting |
| V12 | Timeout after model dispatch and malformed/refused/expensive response | Hold reconciled once; no unbounded retry/repair or trade; user cap respected | G6 / API, accounting |
| V13 | Provider-specific unsupported reasoning setting | Validation error; no silent parameter drop/model change | G6 / API, contracts |
| V14 | Prompt injection in tool/token metadata requests new recipient/tool/limit | Schema/policy reject; raw signing route unavailable | G6/G8 / security |
| V15 | Beginner onboarding with keyboard-only input and reload | Draft persists, errors are accessible, paper agent launches, no keys required | G7 / web |
| V16 | Expired estimate, insufficient MON, budget exhaustion | Clear blocking state, refreshed consent where needed, no cross-bucket spending | G7/G8 / API, web |
| V17 | Wrong AST node/branch/iteration, chain/router/spender/recipient, infinite approval, malformed multicall | Forged runtime intent rejected against approved strategy; application and provider policies independently reject expected transaction cases | G8 / executor, connectors |
| V18 | Price moves/stales, simulation reverts or gas exceeds ceiling | No new signature; holds released only when safe; reason visible | G8 / executor |
| V19 | Crash after signing/broadcast with RPC/provider timeout | Same nonce/effect reconciles; no fresh trade; ambiguous state retains hold | G8 / executor |
| V20 | Finalized reverted/successful trade with approval gas | Actual input/output/gas journaled once; failed swap retains approval fee/history | G8 / accounting, executor |
| V21 | Pause/stop during run, signing and pending transaction | New operations blocked within target; pending effect still reconciles; resources cleaned | G4/G8 / all runtime owners |
| V22 | Withdrawal with pending holds and provider outage | Free amount only, step-up/destination checks, pending status truthful, no lost funds/history | G8/G10 / funds |
| V23 | Backup restore and signer rotation | Reconstruct chain/provider effects before enabling signatures; old tokens fail | G10 / operations |
| V24 | Free quota, expensive model and cloud teardown overrun | Admission is bounded, paid work stops, sponsored and customer charges stay separate | G4/G6 / operations, accounting |
| V25 | Connector export and local MCP use | No platform secrets/hosted authority; unsupported capabilities fail | G11 / connectors |

## Hackathon demonstration

1. Use a fresh account to choose rookie mode, a supported connector and threshold preset.
2. Show/edit blocks, including the optional AI-gated preset, and explain the canonical strategy version.
3. Review budget assumptions and sandbox allowance; launch without provider credentials.
4. Feed recorded synthetic crossing observations with an explicit paper label; show one fill and one policy-denied attempt.
5. Show AI usage and separate operating/trading accounting; exhaust a quota and demonstrate pause.
6. Restart the runtime and replay an event; show no duplicate effect.
7. If G8 passed, separately show a capped team-fund Monad swap with its explorer link, canonical finality and settled costs. If it has not passed, state that live execution is unavailable.
8. Include sponsor-specific request/resource evidence without exposing API keys or customer data. Confirm exact bounty rules before claiming an integration.

## Public custodial release gate

In addition to V01–V24: verified vendor terms and geographic scope; custody and account recovery disclosures; named treasury and incident owners; checked fee/refund policy; controls for compromised executor/admin; reproducible deployment/image versions; tested backups/PITR; measured alert delivery and restore time; withdrawal and allowance-revocation procedures; platform insolvency/ledger mismatch escalation; data retention and deletion policy; independent review of money/signing paths. Close external gates E02–E07 with linked evidence. Public launch is not automatic at hackathon completion.

## Documentation scaffold checks

For this task only: inspect Git status, validate local Markdown links and referenced paths, parse JSON examples, check every non-Git directory has `AGENTS.md` and a checklist, confirm all application implementation tasks remain unchecked, confirm no application/config/code files or secrets were introduced, and check whitespace. These checks prove document consistency, not product behavior. Later CI should automate the checks once implementation tooling exists.
