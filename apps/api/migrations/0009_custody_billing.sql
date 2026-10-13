-- G5 custody mapping, finalized deposits, rate cards, metering, funding quotes and withdrawals
-- (docs/specs/funds-and-budgets.md sections 1, 3, 5–7; api-and-data.md tables wallets, usage_records).
-- Live identities only: paper agents keep simulation accounts (0004). No private key is ever stored.

-- One custodial wallet per agent and chain. The provider holds the key; we hold the provider wallet ID.
create table wallets (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  network_ref text not null check (length(network_ref) <= 128),
  chain_id integer not null check (chain_id > 0),
  provider text not null check (provider in ('privy', 'local')),
  provider_wallet_id text not null check (length(provider_wallet_id) between 1 and 128),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  -- Provider policy attached at creation (defense in depth; atomic holds stay authoritative).
  provider_policy_id text check (length(provider_policy_id) <= 128),
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null,
  primary key (tenant_id, id),
  unique (agent_id, chain_id),
  unique (chain_id, address),
  unique (provider, provider_wallet_id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);

-- Provider idempotency keys for wallet creation. Privy replays a cached 5xx for the same key, so an
-- unavailable attempt moves to a new key; at most one wallet row per agent and chain is ever recorded.
create table wallet_provisioning (
  agent_id uuid not null,
  chain_id integer not null check (chain_id > 0),
  attempt integer not null default 1 check (attempt between 1 and 100),
  primary key (agent_id, chain_id)
);

-- First observation creates a pending, unspendable record. Credit happens once, after canonical finality.
create table deposits (
  id uuid primary key check (uuid_extract_version(id) = 7),
  chain_id integer not null,
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  -- Null when the token is not the accepted funding asset: quarantined, never credited at an invented price.
  asset_ref text,
  sender text not null check (sender ~ '^0x[0-9a-f]{40}$'),
  destination text not null check (destination ~ '^0x[0-9a-f]{40}$'),
  tenant_id uuid,
  agent_id uuid,
  amount numeric(78,0) not null check (amount > 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  block_number numeric(20,0) not null check (block_number >= 0),
  state text not null check (state in ('pending', 'finalized', 'quarantined', 'abandoned')),
  journal_id uuid unique references journals (id),
  reason text check (length(reason) between 1 and 300),
  first_seen_at timestamptz not null,
  resolved_at timestamptz,
  unique (chain_id, tx_hash, log_index),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check ((state = 'finalized') = (journal_id is not null)),
  check (state <> 'finalized' or (asset_ref is not null and agent_id is not null)),
  check ((tenant_id is null) = (agent_id is null))
);
create index deposits_pending on deposits (chain_id, block_number) where state = 'pending';
create index deposits_agent on deposits (tenant_id, agent_id, first_seen_at);

-- Versioned, immutable prices in the accepted token's atomic units. A new price is a new version.
create table rate_cards (
  version text primary key check (length(version) between 1 and 200),
  kind text not null check (kind in ('hosting', 'model', 'data')),
  mode text not null check (mode in ('paper', 'live')),
  profile_ref text not null check (length(profile_ref) <= 128),
  asset_ref text not null check (length(asset_ref) <= 128),
  slice_seconds integer check (slice_seconds between 1 and 3600),
  atomic_per_slice numeric(78,0) check (atomic_per_slice >= 0),
  input_atomic_per_million numeric(78,0) check (input_atomic_per_million >= 0),
  output_atomic_per_million numeric(78,0) check (output_atomic_per_million >= 0),
  atomic_per_request numeric(78,0) check (atomic_per_request >= 0),
  margin_bps integer not null check (margin_bps between 0 and 10000),
  effective_from timestamptz not null,
  expires_at timestamptz check (expires_at > effective_from),
  -- Provenance: where the price came from (provider page and date, or "placeholder").
  source text not null check (length(source) between 1 and 300),
  created_at timestamptz not null default now(),
  check (kind <> 'hosting' or (slice_seconds is not null and atomic_per_slice is not null)),
  check (kind <> 'model' or (input_atomic_per_million is not null and output_atomic_per_million is not null))
);
create trigger rate_cards_immutable before update or delete on rate_cards
  for each row execute function forbid_mutation();

-- One row per billable hosting slice or provider request; unique logical keys prevent double charges.
create table usage_records (
  id uuid primary key check (uuid_extract_version(id) = 7),
  tenant_id uuid not null,
  agent_id uuid not null,
  mode text not null check (mode in ('paper', 'live')),
  kind text not null check (kind in ('hosting', 'model', 'data')),
  logical_key text not null unique check (length(logical_key) between 1 and 300),
  reservation_key text not null unique references reservations (operation_key),
  rate_card_version text not null references rate_cards (version),
  profile_ref text not null check (length(profile_ref) <= 128),
  deployment_id uuid,
  -- Monotonic slice index since the deployment's activation; unique per deployment.
  slice_index bigint check (slice_index >= 0),
  state text not null check (state in ('reserved', 'dispatched', 'unknown', 'escalated', 'settled', 'released')),
  provider_request_id text check (length(provider_request_id) <= 200),
  held_atomic numeric(78,0) not null check (held_atomic >= 0),
  charged_atomic numeric(78,0) check (charged_atomic >= 0 and charged_atomic <= held_atomic),
  usage jsonb check (jsonb_typeof(usage) = 'object'),
  created_at timestamptz not null,
  dispatched_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  unique (deployment_id, slice_index),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check ((kind = 'hosting') = (slice_index is not null and deployment_id is not null)),
  check ((state = 'settled') = (charged_atomic is not null))
);
create index usage_records_unknown on usage_records (dispatched_at) where state in ('unknown', 'escalated');

-- Runway recommendations as shown: rate cards, assumptions, expiry and rounded allocations.
create table funding_quotes (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  mode text not null check (mode in ('paper', 'live')),
  asset_ref text not null,
  rate_card_versions text[] not null,
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  primary key (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);
create trigger funding_quotes_immutable before update or delete on funding_quotes
  for each row execute function forbid_mutation();

-- Step-up verification bound to one action hash. Only a hash of the one-time code is stored.
create table step_up_challenges (
  tenant_id uuid not null references tenants (id),
  id uuid not null unique check (uuid_extract_version(id) = 7),
  purpose text not null check (purpose in ('withdrawal', 'destination', 'allocation')),
  action_hash text not null check (action_hash ~ '^0x[0-9a-f]{64}$'),
  code_hash text not null check (code_hash ~ '^0x[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  verified_at timestamptz,
  consumed_at timestamptz,
  primary key (tenant_id, id),
  check (consumed_at is null or verified_at is not null)
);

create table withdrawal_destinations (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  chain_id integer not null check (chain_id > 0),
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  label text not null check (length(label) between 1 and 80),
  step_up_id uuid not null unique,
  verified_at timestamptz not null,
  revoked_at timestamptz,
  primary key (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  foreign key (tenant_id, step_up_id) references step_up_challenges (tenant_id, id)
);
create unique index withdrawal_destinations_active on withdrawal_destinations (agent_id, chain_id, address) where revoked_at is null;

-- A typed financial operation, never a strategy action. Executed by the transaction gateway, not the runtime.
create table withdrawals (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  wallet_id uuid not null,
  destination_id uuid not null,
  asset_ref text not null,
  amount numeric(78,0) not null check (amount > 0),
  gas_asset_ref text not null,
  gas_ceiling numeric(78,0) not null check (gas_ceiling > 0),
  step_up_id uuid not null unique,
  reservation_key text not null unique references reservations (operation_key),
  state text not null check (state in ('reserved', 'submitted', 'finalized', 'failed', 'reconciling', 'cancelled')),
  tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  gas_used numeric(78,0) check (gas_used >= 0),
  failure_reason text check (length(failure_reason) between 1 and 300),
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at),
  primary key (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  foreign key (tenant_id, wallet_id) references wallets (tenant_id, id),
  foreign key (tenant_id, destination_id) references withdrawal_destinations (tenant_id, id),
  foreign key (tenant_id, step_up_id) references step_up_challenges (tenant_id, id),
  check (state <> 'finalized' or (tx_hash is not null and gas_used is not null)),
  check (state <> 'failed' or failure_reason is not null)
);
create index withdrawals_open on withdrawals (state, updated_at) where state in ('reserved', 'submitted', 'reconciling');

-- Budget exhaustion pauses execution with a visible reason (not a silent stop).
alter table deployments add column pause_reason text check (length(pause_reason) between 1 and 300);

-- Scanner progress per chain: observed (latest head, pending records only) and finalized (credits).
create table chain_cursors (
  chain_id integer not null check (chain_id > 0),
  name text not null check (name in ('observed', 'finalized')),
  height numeric(20,0) not null check (height >= 0),
  updated_at timestamptz not null,
  primary key (chain_id, name)
);
