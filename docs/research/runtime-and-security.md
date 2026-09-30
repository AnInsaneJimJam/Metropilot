# Runtime, custody, and security research

Research date: 2026-10-01. Status: primary-source research and proposed engineering decisions; no infrastructure or wallet integration has been deployed or tested. Provider capabilities, prices, credits, and regional availability must be checked again when implementation starts. Statements labeled **Recommendation** are project design judgments, not guarantees made by the cited providers.

## Recommended shape

Build a modular monolith for the control plane, backed by PostgreSQL, with separately deployed strategy workers and a privileged execution process. Keep one repository and shared contracts. Separate deployment boundaries where credentials and untrusted work meet; do not split every business module into a network service.

The worker interprets a restricted, versioned strategy document. It does not execute user JavaScript, shell commands, arbitrary packages, or model-generated code. AI blocks produce schema-checked values or proposed actions. An independent executor validates and constructs each financial action, reserves its budget, signs it through wallet infrastructure, and reconciles its result. Private keys, wallet authorization keys, model API keys, database credentials, and cloud credentials never belong in the strategy document or model context.

For a hosted demonstration, use a small shared control plane and dedicated Fargate task isolation for each concurrently active agent. A shared event ingester keeps subscriptions alive; an agent does not need a permanently allocated VPS merely to wait for a price condition. Keep a task warm during its active session to avoid launching one task for every tick. Preserve the same contracts if sponsor credits make Alibaba Cloud the better deployment choice.

## 1. Sandbox means two different things

| Term | Product behavior | Security implication |
| --- | --- | --- |
| Paper trading | Synthetic balance, simulated fills, explicit data timestamps, no live signing | Prevents real trades through this mode; simulation quality still needs disclosure |
| Execution isolation | Tenant separation, bounded resources, constrained network, restricted filesystem | Needed in both paper and live modes; does not prevent a permitted but bad trade |
| Transaction simulation | An RPC execution preview before signing | Can detect a revert or unexpected effect at the sampled state; cannot guarantee inclusion or price |

**Recommendation:** give users free paper trading within a published quota. Include isolation in every hosted plan rather than selling it as an optional safety feature. A free allowance must cap active agents, runtime, data retention, and AI tokens; it is funded by the platform. No-deposit paper mode must work without creating a real funded wallet. A fake balance and a real wallet must have different identifiers and different execution paths.

## 2. Hosting: choose the isolation boundary before the cheapest instance

AWS describes each Fargate task as an isolated virtual environment. Different tasks do not share their network interface, ephemeral storage, CPU, or memory; containers **within the same task** share resources and Linux network namespace. Fargate does not permit privileged containers or host access. This supports a per-agent task boundary; putting the signer in a sidecar beside an untrusted worker would cross that boundary. [AWS Fargate security considerations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)

AWS distinguishes task IAM roles from the execution role used by ECS to pull images and publish logs. Ordinary EC2-hosted containers are not equivalent to isolated Fargate tasks, and co-located workloads can expose instance metadata or credentials if not correctly restricted. [ECS task IAM roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [ECS IAM role types](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-iam-role-overview.html)

| Option | Fit | Cost or operational tradeoff |
| --- | --- | --- |
| AWS Fargate | Preferred managed isolation for the hosted hackathon path | Per-task memory/CPU minimums and networking costs reduce density; startup is not instantaneous |
| Alibaba Cloud Elastic Container Instance | Viable sponsor-aligned alternative | Provider describes a CIPU sandbox with VM-class isolation; validate region, networking, secret delivery, and tenancy guarantees before treating it as equivalent |
| EC2/Alibaba ECS VM with ordinary Docker | Team development or a controlled paper demo | Simple and cheap; do not claim robust hostile-tenant isolation from Docker alone |
| VM plus gVisor | A later cost-density experiment | Extra syscall isolation, but the team owns host patching, runtime integration, resource controls, compatibility, and network enforcement |
| Self-managed Firecracker | Defer | MicroVM and jailer primitives exist; fleet scheduling, guest images, networking, patching, and recovery are additional platform work |

Alibaba ECI is a managed container service and documents its sandbox architecture. gVisor explicitly leaves resource-exhaustion and network policy enforcement to surrounding controls. Firecracker provides a small virtual machine monitor and an additional jailer boundary, not a complete hosted-agent platform. [Alibaba ECI overview](https://www.alibabacloud.com/help/en/eci/product-overview/what-is-elastic-container-instance), [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/), [Firecracker](https://firecracker-microvm.github.io/)

### Required worker deployment contract

These are project requirements to verify, not claims that the cloud enables them automatically:

- Run a fixed, reviewed image pinned by digest; non-root user, read-only root filesystem, bounded temporary storage, no host mounts or container socket, and dropped unnecessary capabilities.
- Set memory, CPU, payload size, wall-clock deadline, concurrent-run, and output limits. The supervisor terminates over-budget work; the interpreter independently bounds steps and collection sizes.
- Give the worker no cloud task role unless a precise requirement is demonstrated. Keep image-pull/logging permissions in the ECS execution role.
- Permit outbound requests only to the internal capability gateway. The gateway authenticates the agent/run, validates the method, and contacts approved providers. The worker has no direct RPC, model-provider, arbitrary HTTP, database, or signing access.
- Network rules must deny lateral traffic to other workers, the database, signer, metadata addresses, and private infrastructure. Security groups are network controls; application-layer hostname and method restrictions belong in the gateway. Test IPv4, IPv6, redirects, and DNS rebinding.
- Keep the privileged executor in a separate task/service with a different identity and restricted secret access. The control API may enqueue intents but may not provide an unvalidated transaction to a raw signing endpoint.
- Expose no public inbound port on agent workers. Disallow interactive production shells by default; privileged troubleshooting is audited and time-limited.
- Persist state before terminating a worker. Never rely on its ephemeral filesystem for reservations, decisions, or transaction status.

Fargate networking supports per-task network interfaces and security groups; private deployment also needs explicit paths for image pulls and required dependencies. On EC2, AWS documents separate metadata-blocking configuration. These are deployment checks, not a reason to grant broad outbound access. [ECS networking security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-network.html), [Fargate task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html), [EC2 container security](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ec2-security-considerations.html)

## 3. Credits and costs

For new customers, the published AWS program provides $100 on signup and up to $100 through qualifying activities. The free account plan ends after six months or credit exhaustion, whichever occurs first. Eligibility and service restrictions matter; do not budget against the older assumption that opening an account guarantees twelve months of the required infrastructure. [AWS program announcement](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/), [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/)

Alibaba trials are product- and eligibility-dependent. Its documentation requires an eligible account and supported linked payment method, and limits repeated trials. Neither event sponsorship nor the public trial page proves that this team has usable credits in a desired region. Record written event benefits separately before selecting cloud based on them. [Alibaba free-trial rules](https://www.alibabacloud.com/help/en/user-center/product-overview/learn-about-free-trials)

Fargate charges for requested resources and duration. Linux tasks have a one-minute billing minimum, and billing starts during image download. Public IPv4, logs, transfer, and other AWS services can add cost. Exact regional rates are intentionally not copied into a permanent budget promise. [Fargate pricing](https://aws.amazon.com/fargate/pricing/)

**Recommendation:** compare one concrete regional bill of materials before deployment: control plane, PostgreSQL, active worker count/hours, gateway, load balancer, networking/NAT or endpoints, IPv4, log retention, storage, backups, RPC/data APIs, wallet service, and model usage. Credits reduce the platform's invoice; they must not silently reduce the user's recorded gross usage or inflate runtime estimates.

Maintain two distinct concepts: (1) estimated/contractual customer charges at a versioned published rate and (2) actual provider costs reconciled after the fact. Usage records include agent/run, billing category, quantity/unit, rate version, reservation reference, and provider request/resource identifier. Shared infrastructure overhead requires a disclosed allocation rule; it cannot be measured by an agent's process CPU alone. Resource tags help invoice attribution after activation. [AWS cost allocation tags](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)

Cloud budget notifications are delayed and can arrive after spend crosses the threshold. Therefore platform admission limits and prepaid application reservations enforce user-facing caps; cloud alerts are a second operational control. [AWS Budgets behavior](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)

## 4. One deposit experience, three budgets, one financial authority

**Recommendation:** start with one segregated service-controlled wallet per agent and ledger partitions for AI, hosting, and trading. Do not pool all users' funds in one shared omnibus account. A single wallet cannot hold separate on-chain token balances for each budget; the partition is an application accounting rule. Native gas is additionally reserved inside the trading allocation and shown explicitly. Users should see one funding flow while accounting remains precise.

A platform-controlled authorization key makes the service able to transact. Privy's documentation supports configurations ranging from user-owned wallets to service-controlled ownership and key quorums. Calling the provider's technology “non-custodial” does not establish that this application's service-controlled product is legally non-custodial. Public real-money availability requires a separate review of operational custody, provider terms, jurisdictions, recovery, withdrawals, and responsibility for charges. This research does not resolve those questions. [Privy wallet ownership and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls), [programmable ownership](https://docs.privy.io/controls/authorization-keys/owners/configuration/programmable)

The platform pays hosting and model providers through its business accounts. Crypto budget balances are not automatically accepted as API or cloud payment. The initial design should use platform-funded provider accounts and an explicit service-credit ledger, with real conversion/settlement introduced only when a supported route and terms are verified. Paper mode uses sponsored credits; no hidden conversion is required for the demonstration.

### Guardrails belong outside the model

Privy policies can restrict methods, chains, recipients, contracts, calldata, signing, and export. Unmatched methods are denied when a policy applies, and deny rules take precedence. Configure narrowly allowed methods rather than an allow-all fallback. Monetary fields are evaluated in their supplied base units. Verify the chosen transaction method and router calldata against the actual policy evaluator. [Privy policy semantics](https://docs.privy.io/controls/policies/overview)

Privy stateful policies are explicitly not strict real-time spend enforcement: concurrent requests may pass before aggregation updates. The documented default maximum is ten aggregations per application, windows span one to 72 hours, and unmatched metric extraction may contribute zero. Therefore they provide a backup limit, not the user's budget ledger. [Privy stateful policies](https://docs.privy.io/controls/policies/stateful-policies)

**Required project controls:**

1. Validate tenant, wallet, strategy version, connector version, chain, token, recipient, amount, quote expiry, freshness, slippage, maximum gas, and action type before authorization.
2. Atomically reserve funds in PostgreSQL before starting a billable model call, compute lease, or transaction. Available funds exclude other reservations, operating reserves, and unresolved transactions.
3. Serialize signing per wallet/chain, including approval transactions. Persist nonce assignment and intent before contacting the wallet provider. A database uniqueness constraint prevents two logical intents owning the same wallet nonce.
4. Restrict token approvals to the needed spender and amount; reject unlimited approvals, arbitrary typed-data permits, unexpected router commands, and unreviewed contract addresses.
5. Revalidate policy and cancellation state immediately before signing. An emergency stop prevents new work and signatures; it cannot retract a broadcast transaction.
6. Keep signed/submitted/unknown outcomes reserved until reconciliation establishes their fate. A timeout alone never proves failure and never authorizes a fresh financial retry.
7. Apply exact integer/base-unit arithmetic to assets and fixed precision to billing. Never use JavaScript floating-point values for token quantities or ledger balances.
8. Separate ordinary usage, trading losses, gas spent, and service fees. An estimated runtime concerns operating funds, not guaranteed survival of trading capital.

The wallet provider authorization key stays in the executor's secret store, never in a worker. Policy-administration credentials should be separated from normal transaction credentials so a compromised runtime cannot relax its own limits. Withdrawal and recovery operations need explicit authenticated user flows outside strategy blocks.

## 5. Monad settlement and transaction lifecycle

The current documentation maps `latest` to `Proposed`, `safe` to `Voted`, and `finalized` to `Finalized`. `Verified` is a later execution-root assurance state. Proposed results can be superseded before finalization; a short advertised finality interval is not an application settlement timer. [Monad block states](https://docs.monad.xyz/monad-arch/consensus/block-states)

The RPC overview documents asynchronous nonce/balance validation, `pending` behaving like `latest`, and `eth_getTransactionByHash` returning null for a transaction still in the mempool. Receipts can describe an unfinalized block and change. Standard WebSocket logs are speculative, while Monad subscriptions expose commitment updates. Abandonment may be inferred from a different finalized proposal at the same height rather than a dedicated removal event. [Monad RPC behavior](https://docs.monad.xyz/reference/json-rpc/overview)

**Recommendation:** use finalized events for rookie strategies and all deposit crediting. A separate provisional event stream may update the dashboard, but must not create spendable balance. Store chain ID, block number/hash, transaction hash, and log index with every chain-derived record. Before settlement, verify a receipt succeeded, its height is at or below the observed finalized height, and its block hash matches the canonical block at that height. Pause on provider disagreement and backfill from the last durable finalized cursor after a disconnect. This is the project's conservative reconciliation design, not a claim of additional Monad protocol requirements.

Use the executor's durable nonce record plus chain reconciliation; never infer that the RPC `pending` count covers every in-flight local intent. Persist the signed transaction hash before broadcasting where the provider workflow allows it, and rebroadcast the same bytes for an uncertain submission rather than inventing a new nonce. If the signing/broadcast provider owns nonce selection, prove its idempotency and recovery semantics before choosing that integration path. The researched RPC specification provides transaction count, receipt, and raw submission operations; the application still owns recovery. [Monad RPC API](https://docs.monad.xyz/reference/json-rpc/api)

Every signed transaction includes the intended chain ID. Monad accepts EVM transaction types including EIP-1559; its documentation warns that replayable pre-EIP-155 transactions remain protocol-valid. They are outside this product's allowed signing methods. [Monad transaction format](https://docs.monad.xyz/developer-essentials/transactions)

## 6. MCP and connector security

MCP describes tool inputs with JSON Schema and supports an output schema for structured results. Tool annotations are not authority unless their source is trusted. Register reviewed tool definitions in the connector catalog, pin their versions, and validate both arguments and results. A protocol's existence does not mean Uniswap, Aave, or another named protocol operates an official MCP server or webhook service. A connector may need to supply its own reviewed adapter. [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

For HTTP MCP authorization, follow the negotiated version's OAuth rules, resource audience validation, secure token storage, and distinct downstream credentials. Never forward a client token unchanged to an unrelated downstream API. Use a maintained SDK rather than hand-writing an OAuth system. Local stdio and remote HTTP authentication differ; a connector-only user's local credentials should stay local. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

MCP's security guide identifies OAuth discovery SSRF, token confusion, session attacks, and unsafe local-server execution. Discovery and redirects must not reach private or metadata networks; session IDs do not authenticate users. [MCP security best practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices)

**Recommendation:** the first hosted release accepts catalog connector IDs, not arbitrary MCP URLs, startup commands, downloaded skills, or executable uploads. A connector catalog entry declares the supported network, addresses, methods, data sources, permissions, version, and owner. Selecting a connector assembles approved capabilities; it never gives the agent unrestricted control of a protocol.

All token metadata, websites, prices, tool descriptions/results, and model text remain data. They cannot modify budgets, register a new tool, change system instructions, or select a new destination. AI outputs fail closed when malformed, timed out, or outside the schema. Return a concise decision explanation and evidence references; do not require or store hidden model reasoning. Runtime model calls go through the budgeted gateway, and only the deterministic executor can approve an intent.

For inbound webhooks, verify the provider's documented signature against raw bytes, enforce timestamp/replay limits, deduplicate the event, and persist before acknowledging. Where no authenticated webhook exists, ingest chain logs or poll the provider rather than inventing a signature scheme. Treat each provider's authenticity and retry behavior as an integration acceptance test.

## 7. Durable jobs without a distributed workflow platform

PostgreSQL documents `FOR UPDATE SKIP LOCKED` as useful for queue-like consumers. `LISTEN` registrations disappear when the session ends, so notifications should only wake workers; durable job rows remain the source of work. [PostgreSQL row locking](https://www.postgresql.org/docs/current/sql-select.html), [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html)

**Recommendation:** one transactional job/outbox table suffices initially. Store tenant/run, unique logical work key, payload version, status, attempt, available time, lease expiry, lease owner, and monotonic fencing token. Claim and commit quickly; do not hold a database transaction open across a model call or cloud task. Heartbeats extend leases, expired work can be reclaimed, and result writes must compare the fencing token. A stale worker cannot complete someone else's reclaimed run.

Assume at-least-once execution. Idempotent database writes do not make an external trade exactly once. Use durable action intents, provider idempotency where available, and the nonce/reconciliation rules above. Add bounded retries for transient reads; permanent validation failures go to a visible failed state. A financial action with an unknown outcome enters reconciliation, not an automatic fresh-action retry.

Revisit a dedicated workflow engine when measured concurrency, long-lived workflow migrations, or operational recovery make this table difficult to operate. Avoid adding Redis, Kafka, Kubernetes, a service mesh, or a custom microVM scheduler to the hackathon before that evidence exists.

## 8. Required implementation proofs

These are future acceptance checks; none has been run in this research task.

- [ ] A worker cannot obtain a wallet/model/cloud secret, reach metadata/private infrastructure, or access another agent's records.
- [ ] Worker memory exhaustion, a step-limit violation, and malformed input terminate the run without affecting other tenants.
- [ ] Two simultaneous budget reservations cannot exceed a category balance, including AI usage and native gas reserves.
- [ ] Two simultaneous wallet intents cannot acquire the same nonce or bypass a daily cap.
- [ ] Crash after signing, timeout after broadcasting, and duplicate job delivery recover without a duplicate trade.
- [ ] A speculative deposit/log does not become spendable or trigger a rookie trade before canonical finalization.
- [ ] Disconnected event feeds backfill without duplicate actions; provider disagreement pauses settlement.
- [ ] Prompt injection in a connector result cannot change a recipient, enable a connector, raise a limit, or execute code.
- [ ] The actual chosen Privy transaction method and router calldata are covered by policies, including approvals and malformed ABI cases.
- [ ] Cloud cost estimates include shared resources and pricing versions; provider invoices reconcile to usage without retroactively inventing user authorization.
- [ ] Paper mode cannot call the live signer, and live mode cannot silently consume a paper balance.
- [ ] Stop, withdraw, policy rotation, backup restoration, and account recovery have observable failure behavior.

Tick a check only after linking a passing test or review record in the implementation area. A document describing a guardrail is not evidence that the guardrail exists.
