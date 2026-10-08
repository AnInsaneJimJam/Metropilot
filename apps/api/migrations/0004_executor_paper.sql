-- G4 paper executor records (docs/specs/executor.md sections 7, 8 and 12). Paper identities only:
-- simulation accounts are disjoint from wallets, and a paper intent can never carry a transaction hash.
-- Live intents, wallets, nonce slots and transaction attempts arrive in a later migration (G5/G8).
-- deployment_id/generation are not yet foreign keys to deployments (0003): the executor reads authority through
-- AuthoritySource until that table carries the fields it needs (docs/integration/executor.md section 3a).

create table simulation_accounts (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  -- A portfolio reset creates a new session with its own history; balances are never edited back.
  session integer not null check (session >= 1),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, agent_id, session),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);

-- Virtual trading inventory. available excludes held, so available + held is the position.
create table simulation_balances (
  tenant_id uuid not null,
  account_id uuid not null,
  asset_ref text not null check (length(asset_ref) <= 128 and asset_ref ~ '^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$'),
  available numeric(78,0) not null check (available >= 0),
  held numeric(78,0) not null default 0 check (held >= 0),
  primary key (tenant_id, account_id, asset_ref),
  foreign key (tenant_id, account_id) references simulation_accounts (tenant_id, id)
);

create table intents (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  deployment_id uuid not null check (uuid_extract_version(deployment_id) = 7),
  generation bigint not null check (generation >= 1),
  mode text not null check (mode = 'paper'),
  simulation_account_id uuid not null,
  run_id text not null check (run_id ~ '^0x[0-9a-f]{64}$'),
  node_id text not null check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  iteration_path jsonb not null check (jsonb_typeof(iteration_path) = 'array'),
  -- intent-key/1: one logical financial effect, recomputed from the authenticated capability.
  logical_key text not null unique check (logical_key ~ '^0x[0-9a-f]{64}$'),
  -- JCS hash of the action-intent/1 body: same key with another body is an idempotency conflict.
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  request jsonb not null,
  -- Frozen intent-result/1 FrozenAction summary.
  action jsonb not null,
  input_atomic numeric(78,0) check (input_atomic > 0),
  state text not null check (state in ('proposed', 'rejected', 'reserved', 'prepared', 'signing', 'signed', 'submitted',
    'included', 'finalized', 'settled', 'reconciling', 'failed', 'cancelled')),
  reason_code text check (reason_code ~ '^EXECUTOR_[A-Z_]+$'),
  reason_message text check (length(reason_message) between 1 and 500),
  paper_fill_id text unique check (paper_fill_id ~ '^0x[0-9a-f]{64}$'),
  settled_input_atomic numeric(78,0) check (settled_input_atomic >= 0),
  settled_output_atomic numeric(78,0) check (settled_output_atomic >= 0),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null check (updated_at >= created_at),
  primary key (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  foreign key (tenant_id, simulation_account_id) references simulation_accounts (tenant_id, id),
  check ((reason_code is null) = (reason_message is null)),
  check (state not in ('rejected', 'failed') or reason_code is not null),
  check ((state = 'settled') = (settled_input_atomic is not null and settled_output_atomic is not null and paper_fill_id is not null)),
  check (state in ('proposed', 'rejected') or input_atomic is not null)
);
create index intents_open on intents (state, updated_at) where state not in ('rejected', 'settled', 'failed', 'cancelled');
create index intents_agent_time on intents (tenant_id, agent_id, created_at);
create index intents_run on intents (deployment_id, run_id);

-- One immutable verdict per evaluation phase; later phases add context and never erase a denial.
create table policy_verdicts (
  tenant_id uuid not null,
  intent_id uuid not null,
  phase text not null check (phase in ('admission', 'dispatch')),
  allow boolean not null,
  denials jsonb not null check (jsonb_typeof(denials) = 'array'),
  policy_version text not null,
  context_hash text not null check (context_hash ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (intent_id, phase),
  foreign key (tenant_id, intent_id) references intents (tenant_id, id),
  check (allow = (jsonb_array_length(denials) = 0))
);
create trigger policy_verdicts_immutable before update or delete on policy_verdicts
  for each row execute function forbid_mutation();

create table simulation_reservations (
  tenant_id uuid not null,
  intent_id uuid not null,
  account_id uuid not null,
  asset_ref text not null,
  amount numeric(78,0) not null check (amount > 0),
  state text not null check (state in ('held', 'settled', 'released')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (intent_id, asset_ref),
  foreign key (tenant_id, intent_id) references intents (tenant_id, id),
  foreign key (tenant_id, account_id, asset_ref) references simulation_balances (tenant_id, account_id, asset_ref)
);
create index simulation_reservations_held on simulation_reservations (account_id) where state = 'held';

create table paper_fills (
  tenant_id uuid not null,
  -- contentHash({schemaVersion: "paper-fill/1", logicalKey, adapter}): a replay yields the same ID.
  id text primary key check (id ~ '^0x[0-9a-f]{64}$'),
  intent_id uuid not null unique,
  account_id uuid not null,
  adapter_version text not null,
  input_asset_ref text not null,
  input_atomic numeric(78,0) not null check (input_atomic > 0),
  output_asset_ref text not null,
  output_atomic numeric(78,0) not null check (output_atomic >= 0),
  -- Recorded quote and declared assumptions the fill used (provenance, never a provider payload).
  basis jsonb not null,
  created_at timestamptz not null,
  foreign key (tenant_id, intent_id) references intents (tenant_id, id),
  foreign key (tenant_id, account_id) references simulation_accounts (tenant_id, id)
);
create trigger paper_fills_immutable before update or delete on paper_fills
  for each row execute function forbid_mutation();

-- Audit/outbox rows committed with each state change. The API worker assigns the tenant stream sequence,
-- publishes audit-event/1 and resumes runs from definitive transaction.stateChanged rows. Only
-- published_at may change.
create table executor_outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  agent_id uuid not null,
  intent_id uuid not null,
  run_id text not null,
  logical_key text not null,
  type text not null check (type in ('policy.denied', 'reservation.changed', 'transaction.stateChanged', 'ledger.settled')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  published_at timestamptz,
  foreign key (tenant_id, intent_id) references intents (tenant_id, id)
);
create index executor_outbox_unpublished on executor_outbox (id) where published_at is null;

create function executor_outbox_publish_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE'
    or (new.id, new.tenant_id, new.agent_id, new.intent_id, new.run_id, new.logical_key, new.type, new.payload, new.occurred_at)
      is distinct from (old.id, old.tenant_id, old.agent_id, old.intent_id, old.run_id, old.logical_key, old.type, old.payload, old.occurred_at)
    or old.published_at is not null then
    raise exception 'executor_outbox rows are append-only; only an unpublished row may be marked published';
  end if;
  return new;
end
$$;
create trigger executor_outbox_publish_only before update or delete on executor_outbox
  for each row execute function executor_outbox_publish_only();
