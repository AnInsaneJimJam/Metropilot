# Strategy language specification

Version: `strategy/1`. Owners: `packages/strategy` and contract owner. This defines a restricted workflow language, not a general programming language. The examples are design fixtures inside Markdown; no executable schema/compiler is included in this scaffold.

## 1. Representations and compilation

Store two linked artifacts per revision: **editor workspace JSON** containing Blockly layout/fields and **canonical execution JSON** containing only behavior. Blockly recommends JSON for new work; XML is a legacy import concern, not our execution format. [Blockly serialization](https://developers.google.com/blockly/guides/configure/web/serialization)

The browser compiler produces a preview. The server runs the same compiler/validator against the submitted workspace and compares the canonical AST hash to the submitted preview. API imports may submit an AST without a workspace; render a generated layout when opened. Workspace comments, disabled blocks, visual coordinates and viewport state are excluded from the behavior hash. A disconnected enabled executable block is an error, not silently ignored.

Compilation steps: enforce byte/depth limits → recognize block types → resolve references → construct a typed abstract syntax tree (AST) → validate connector/model capabilities → check cost/step bounds → canonicalize → hash. This is a data traversal, never JavaScript generation followed by `eval`. The server resolves pinned catalog versions at deployment; the AST names connector/asset/feed/model **references**, not private keys or arbitrary destinations.

Canonicalization uses RFC 8785 JCS and SHA-256 over UTF-8 JSON. Reject duplicate object keys, non-finite numeric values, and invalid Unicode before hashing. Financial and decimal literals are strings; bounded integer counters remain JSON numbers. A maintained JCS implementation is acceptable during implementation rather than reimplementing a subtle standard. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

## 2. Root grammar and identifiers

Root fields are exactly `schemaVersion`, `id`, `name`, `triggers`, and `limits`. A revision wrapper in the API carries author, workspace, content hash, timestamps, and version history. Unknown fields are errors unless in a separately versioned non-executable metadata wrapper.

`id` and node IDs match `[A-Za-z][A-Za-z0-9_-]{0,63}`; IDs are unique within the document and stable through edits where the logical block remains. Names are 1–120 characters. `triggers` contains 1–3 entries. Each trigger has `id`, `type`, trigger-specific fields, and ordered `body` statements. The document is a tree; there are no backward edges, recursive functions, arbitrary expressions, dynamic property paths, or network instructions.

Each statement has `id` and `type`. Each expression has `kind` and the fields listed below. `if` contains `condition`, `then`, and `else` arrays; empty branches are valid. `repeat` contains a literal `count` and `body`, never a market-controlled loop bound. Trigger handlers run separately in declaration order when one event matches several triggers, under the same per-agent scheduler. They are not parallel financial operations.

## 3. Types and units

| Type | Representation and operations |
| --- | --- |
| Boolean | Literal `true`/`false`; logical and comparison results |
| Integer | Safe bounded JSON integer for count, bps, duration; no monetary role |
| Decimal | Canonical decimal string, no exponent, no leading `+`, max 18 fractional digits; exact scaled-integer arithmetic |
| Money | `{assetRef, atomic}`; nonnegative base-10 integer string, max uint256 for chain assets; compare/add only same asset |
| Price | `{baseAssetRef, quoteUnit, decimal}`; unit is explicit, e.g. USD per WETH; only compatible-unit comparisons |
| Timestamp | UTC RFC 3339 with milliseconds |
| Enum | One of schema-declared constant strings; AI cannot add values |
| Observation | Typed value plus source, observed time, received time, and optional block/hash/finality |

Use integer basis points for percentages: 1,000 bps = 10%. Token amount conversion floors to atomic units for spending. Reserve ceilings round up. Division by zero, overflow, negative spend, excessive precision, wrong units, or a zero result after rounding produces a typed error/no intent. Comparisons never coerce strings, tokens, currencies, or missing values.

## 4. Block vocabulary

### Triggers

| `type` | Required fields beyond `id/body` | Meaning |
| --- | --- | --- |
| `schedule` | `intervalSeconds`, `anchorAt` | UTC slots at anchor + integer intervals; min 60 seconds live/rookie; missed slots coalesce to newest fresh slot |
| `price.crossesAbove` / `price.crossesBelow` | `feedRef`, `threshold` Price, `maxAgeSeconds`, `cooldownSeconds` | Adjacent accepted fresh observations straddle threshold; first sample initializes only |
| `connector.event` | `connectorRef`, `eventType`, `filters` | Only catalog events and exact typed equality filters; finalized chain events by default |

Cross-above is previous ≤ threshold and current > threshold; cross-below is previous ≥ and current <. Equality alone does not fire. Keep trigger state per deployment revision, trigger ID and feed identity. Out-of-order samples cannot roll state backward. A stale gap resets the baseline; the next fresh sample initializes it. A crossing during cooldown updates the baseline but is not queued for later execution. Cooldown starts when a trigger run is accepted, including if its action later fails; retries keep the same run identity. Switching revisions resets crossing state and requires a fresh baseline.

### Expressions

| `kind` | Fields | Result / constraint |
| --- | --- | --- |
| `literal` | `valueType`, `value` | Typed constant from the types table |
| `ref` | `name` | Earlier lexical binding; no arbitrary object traversal |
| `field` | `name`, `field` | Field on a bound schema-defined record; field is a compile-time name |
| `compare` | `operator`, `left`, `right` | `eq/ne/lt/lte/gt/gte`; compatible units/types required |
| `logical` | `operator`, `operands` | `and/or` with 2–8 Boolean operands, or `not` with one |
| `arithmetic` | `operator`, `left`, `right` | `add/subtract` same unit; `multiply/divide` with dimensionless Decimal only |

Lexical bindings are immutable. A branch binding does not escape its branch; repeat-local bindings reset each iteration. `logical` short-circuits left to right; evaluating skipped expressions has no side effects. Expressions cannot perform reads or model calls. No implicit time/randomness: the execution context supplies time and recorded observations.

### Statements

| `type` | Fields | Semantics |
| --- | --- | --- |
| `read` | `connectorRef`, `operation`, `arguments`, `bind` | Allowlisted read; arguments are schema-typed expressions; bind an Observation or record |
| `ai.decide` | `modelProfileRef`, `prompt`, `inputs`, `outputSchemaRef`, `timeoutSeconds`, `maxOutputTokens`, `bind` | One metered request; returns a validated typed record; no model-driven recursive tool loop |
| `if` | `condition`, `then`, `else` | Evaluate Boolean and execute selected ordered branch |
| `repeat` | `count`, `body` | Literal count 1–10; compiler expands worst-case limits; nesting at most two repeats |
| `swap.exactInput` | `connectorRef`, `tokenInRef`, `tokenOutRef`, `amount`, `maxSlippageBps` | Produce one typed intent; fixed amount or position fraction; executor owns quote/build/sign |
| `notify` | `message`, `inputs` | Append an in-app timeline entry, not an external email/webhook |
| `stop` | `reason` | Finish this run without further statements; does not globally pause agent |

Amount is a tagged object: `{kind:"fixed", atomic:"..."}` or `{kind:"positionBps", bps:1000}`. `positionBps` resolves to floor(bps × **available trading inventory of tokenIn at authorization time** / 10,000), excluding operational reserves, gas reserve where applicable, and pending reservations. It never means 10% of total account net worth. Runtime previews are advisory; executor resolves and freezes the actual atomic amount once per intent. Output returns to the same agent wallet. Transfer/withdraw, borrow, leverage, liquidity provision, arbitrary calldata, shell, HTTP, and arbitrary MCP execution are not v1 blocks.

Statements execute sequentially. A financial statement suspends the run until its intent is definitively settled/rejected/failed; later statements see a new recorded observation snapshot only through explicit reads. If the effect is uncertain, the run waits for reconciliation and does not fall through. The 60-second active interpreter budget excludes durable waiting but data is refreshed and policy reevaluated before later effects.

## 5. Complete synthetic paper example

This fixture uses catalog entries `paper.WETH`, `paper.USD`, `paper.weth-usd`, and `paper.uniswap`. They describe synthetic paper assets and a paper connector, not deployable contract addresses. It sells 10% of available paper WETH once on a fresh upward crossing, then records a notification.

```json
{
  "schemaVersion": "strategy/1",
  "id": "threshold_sale",
  "name": "Paper threshold partial sale",
  "triggers": [
    {
      "id": "crossing",
      "type": "price.crossesAbove",
      "feedRef": "paper.weth-usd",
      "threshold": {
        "baseAssetRef": "paper.WETH",
        "quoteUnit": "USD",
        "decimal": "2500"
      },
      "maxAgeSeconds": 30,
      "cooldownSeconds": 3600,
      "body": [
        {
          "id": "sell_tenth",
          "type": "swap.exactInput",
          "connectorRef": "paper.uniswap",
          "tokenInRef": "paper.WETH",
          "tokenOutRef": "paper.USD",
          "amount": {"kind": "positionBps", "bps": 1000},
          "maxSlippageBps": 50
        },
        {
          "id": "record_result",
          "type": "notify",
          "message": "Threshold sale settled in paper mode.",
          "inputs": {}
        }
      ]
    }
  ],
  "limits": {
    "maxStepsPerRun": 100,
    "maxAiCallsPerRun": 1,
    "maxIntentsPerRun": 1,
    "maxActiveSecondsPerRun": 60
  }
}
```

## 6. AI block contract

AI is an optional typed transformation inside a workflow. Its prompt cannot invoke a signer or redefine constraints. `inputs` maps 1–16 safe names to typed expressions; untrusted observations are separately labeled data. `prompt` is plain text ≤ 4,000 characters, may refer to those input names, and uses no executable template expressions. The broker assembles system policy and data envelope; user text never overwrites those controls.

`modelProfileRef` resolves at deployment to provider, exact model ID, endpoint region/workspace, allowed reasoning/thinking settings, output and context limits, and a rate-card version. Advanced users can create supported profile settings through the catalog-backed form. Provider capabilities determine whether a reasoning level exists; unsupported settings are validation errors. Model replacement or fallback requires a new explicit profile/revision; never silently change it after a failed call.

MVP output schema `decision/1` has exactly `decision` (`allow` or `skip`) and `summary` (1–500 characters). `summary/1` has a single bounded `summary` field. These are the initial `outputSchemaRef` choices. Advanced custom schemas later permit bounded objects of scalar/enumeration fields only after schema-complexity validation; v1 rejects unknown schema references. A `decision` value is used by an explicit `if` block, never auto-interpreted as a trade.

Each request has a maximum input token budget measured using the chosen provider's tokenizer or conservative documented upper bound. Reserve worst-case input/output/reasoning cost before the network call. All billed reasoning tokens must fit a provider-enforced limit whose billing semantics are verified; otherwise that model/profile is disabled for bounded-budget use. One attempt per AI node in v1; timeout/refusal/budget exhaustion/schema failure ends the run without new financial intents. Already settled earlier effects remain settled and visible. There is no implicit JSON-repair call or free retry.

Record request ID, model/version/parameters, input hashes, redacted inputs where needed, usage, parsed output, elapsed time, and policy-visible summary. Replays reuse the recorded AI result, not a fresh model response. New model runs are new evaluations and cannot reuse an old financial idempotency key. No hidden chain-of-thought is required or promised.

## 7. Limits, validation, and errors

Platform maxima for v1: 256 KiB AST bytes; 1 MiB editor workspace; 100 total AST statements/expressions/triggers; depth 12; 3 triggers; 10 repeat count; 2 repeat nesting; 1,000 expanded steps; 3 AI calls; 3 financial intents; 60 active seconds per run. User document limits may lower platform maxima, not raise them. Runtime enforces both static worst-case and observed consumption. Rookie defaults use one AI call and one intent. Queues/timeouts are specified in [runtime](runtime.md).

Validation also proves all references exist and are in scope; action/read capabilities are selected; assets share the deployment chain/mode; prompts and output schemas are bounded; rates and feed ages can be checked; and every path respects limits. Disabled workspace blocks are retained only as editor metadata and are excluded from the executable AST and cost estimate.

Errors contain stable code, node ID, field path, and readable remediation. Required codes: `UNKNOWN_BLOCK`, `TYPE_MISMATCH`, `UNKNOWN_REFERENCE`, `UNSUPPORTED_CAPABILITY`, `LIMIT_EXCEEDED`, `STALE_DATA`, `INVALID_AMOUNT`, `MODEL_OUTPUT_INVALID`, `MODEL_UNAVAILABLE`, `BUDGET_EXHAUSTED`, `POLICY_DENIED`, `EFFECT_PENDING`. Fail closed on missing/stale price; do not treat it as zero or `false` followed by an unsafe else branch.

## 8. Replay and effect identity

The interpreter returns steps and intents through a small host interface: read observation, request AI result, submit intent, await intent status, append timeline, persist checkpoint. It does not own transport or credentials. Pure expression evaluation takes an explicit context and returns a typed result/error. Expose that same pure evaluation to the executor so it can verify a proposed action's authored fields, legal iteration path, and branch prerequisites against authoritative recorded broker results without repeating external reads or model calls.

Run identity derives from `(deploymentRevision, triggerId, sourceEventKey)` or the schedule slot. Intent identity derives from `(runId, nodeId, iterationPath)`. Loop iterations therefore produce separate intended effects while retries of an iteration preserve identity. Persist checkpoints and node results before acknowledging progress. A replay must preserve branch decisions, input records, AI results, and resolved effect parameters. Runtime nondeterminism cannot create a new transaction.

Acceptance: Blockly save/load preserves executable hash; reordered object keys do not change it; workspace layout edits do not change it; unknown blocks and integer-overflow inputs fail; stale prices and bad AI outputs stop safely; a crossing sequence `2499,2501,2502` fires once; the same source event after restart produces the same run and intent; two intentional repeat iterations produce two distinct bounded intents.
