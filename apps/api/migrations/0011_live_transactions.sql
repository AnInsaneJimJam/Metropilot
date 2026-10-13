-- Transaction attempts for live intents (docs/specs/executor.md sections 7, 9, 11–13). A live intent owns at most one
-- approval child and one swap transaction. Each attempt is recorded before the provider is called, under a provider
-- idempotency key that never changes: an ambiguous send is recovered by asking again with the same key, never by a new
-- trade. The swap's prepared quote is frozen here so recovery and settlement compare against what was authorized.

create table transaction_attempts (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  intent_id uuid not null,
  kind text not null check (kind in ('approve', 'swap')),
  wallet_id uuid not null,
  chain_id integer not null check (chain_id > 0),
  -- Provider request key: `intent:<intentId>:<kind>`; the provider deduplicates on it.
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 200),
  to_address text not null check (to_address ~ '^0x[0-9a-f]{40}$'),
  data text not null check (data ~ '^0x([0-9a-f]{2})*$'),
  value_atomic numeric(78,0) not null check (value_atomic >= 0),
  -- Signed gas limit (Monad charges the full limit); recovery re-sends exactly this transaction.
  gas_limit numeric(78,0) not null check (gas_limit > 0),
  -- prepared: recorded, provider not yet called. sent: provider returned a hash. ambiguous: outcome unknown.
  -- refused: the provider definitively did not broadcast. finalized / reverted: canonical receipt at or below the
  -- finalized height.
  state text not null check (state in ('prepared', 'sent', 'ambiguous', 'refused', 'finalized', 'reverted')),
  tx_hash text unique check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(78,0) check (block_number >= 0),
  block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
  fee_atomic numeric(78,0) check (fee_atomic >= 0),
  -- Swap only: the frozen quote and bounds this transaction was authorized for.
  quote jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at),
  primary key (tenant_id, id),
  unique (intent_id, kind),
  foreign key (tenant_id, intent_id) references intents (tenant_id, id),
  foreign key (tenant_id, wallet_id) references wallets (tenant_id, id),
  check (state in ('prepared', 'ambiguous', 'refused') or tx_hash is not null),
  check ((state in ('finalized', 'reverted')) = (block_hash is not null and block_number is not null and fee_atomic is not null)),
  check ((kind = 'swap') = (quote is not null))
);
create index transaction_attempts_open on transaction_attempts (wallet_id, state) where state in ('prepared', 'sent', 'ambiguous');
