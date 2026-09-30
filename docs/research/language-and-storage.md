# Language and storage research

Checked: 2026-10-01. Findings are from primary sources; project choices are labeled separately. This note supports the [strategy specification](../specs/strategy-language.md), [API/data specification](../specs/api-and-data.md), and [architecture](../../architecture.md).

## Blockly and JSON

Blockly recommends its JSON serializer for new projects and describes XML as the legacy format that will not receive new features. JSON covers workspace state and supports custom serializers. [Official serialization guide](https://developers.google.com/blockly/guides/configure/web/serialization)

Custom Blockly blocks define appearance/connections and integrate with a toolbox and generation path. A trading language still needs domain blocks and their semantics; adopting the editor does not create a safe execution engine. [Custom block overview](https://developers.google.com/blockly/guides/create-custom-blocks/overview)

**Decision:** use Blockly for visual editing, retain its workspace JSON, and compile domain blocks into our own typed JSON tree. Execute that tree with a bounded interpreter. Do not execute Blockly-generated JavaScript or trust visual connection checks as server authorization. This adds a small, justified compiler seam so editor upgrades and layout metadata cannot alter trading behavior.

## Contract validation and hashes

JSON Schema Draft 2020-12 defines validation and related vocabularies. A schema can describe structure, but business rules such as scope, units, selected connector capabilities, and financial limits require additional semantic validation. [JSON Schema standard](https://json-schema.org/draft/2020-12)

RFC 8785 defines JSON Canonicalization Scheme, including deterministic property ordering and serialization rules. Its number handling is a reason to encode financial integers/decimals as strings rather than imprecise JavaScript numbers. [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)

**Decision:** schemas are authoritative transport contracts, generated types are a convenience, and server semantic validation is mandatory. Hash canonical executable documents, not raw editor text. Immutable revision IDs and content hashes solve different problems: identity/history versus integrity/equality.

## PostgreSQL jobs and tenancy

PostgreSQL documents `SKIP LOCKED` as useful for consumers of a queue-like table, while warning it produces an inconsistent view unsuitable for general-purpose querying. It can form the claim step of a durable queue; it does not supply external side-effect idempotency. [SELECT locking clauses](https://www.postgresql.org/docs/current/sql-select.html)

Row-level security can restrict rows per role/policy. Table owners and roles with bypass privileges can bypass normal policies unless appropriately constrained; tests need actual application roles rather than only a superuser connection. [Row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

**Decision:** one Postgres database with tenant-scoped relations, explicit tenant checks plus tested RLS where used, a durable job table, immutable audit events, and append-only ledger postings. Claim work briefly, commit, then make external calls. Leases and fencing prevent stale worker completion; unique logical effect IDs and reconciliation handle retries. This is sufficient for the initial concurrency target without Redis/Kafka.

## Runtime baseline

The Node project recommends production applications use Active or Maintenance LTS releases; Node 24 is listed as LTS at research time. [Official release table](https://nodejs.org/en/about/previous-releases)

**Decision:** Node 24 LTS and TypeScript for the initial workspace, with exact dependency patches and runtime image digests pinned during implementation. The architecture does not rely on undocumented preview runtimes. PostgreSQL 17 is a compatibility choice for managed hosting, not a claim that it is the newest available version.

## Deliberately avoided work

No new general-purpose language parser, graphical editor engine, distributed workflow platform, proprietary schema format, or code sandbox for arbitrary scripts is needed to validate this product. Revisit them only when a concrete requirement exceeds the bounded language or measured queue capacity. The security and accounting complexity that protects real funds remains necessary.
