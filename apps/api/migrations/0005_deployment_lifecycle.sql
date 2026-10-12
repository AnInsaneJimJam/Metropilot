-- Deployment lifecycle (API-2), executor authority fields, persisted price observations and the audit stream
-- (API-6). One deployment vocabulary for control API and executor (decision D37): active / paused / stopping /
-- stopped. Paper deployments trade in a simulation account; the manifest pins every input (deployment-manifest/1).

alter table deployments drop constraint deployments_desired_state_check;
update deployments set desired_state = 'active' where desired_state = 'running';
alter table deployments alter column desired_state set default 'active';
alter table deployments add constraint deployments_desired_state_check
  check (desired_state in ('active', 'paused', 'stopping', 'stopped'));

-- Defaults only carry rows created before this migration (development databases); new rows always supply values.
alter table deployments
  add column network_ref text not null default 'paper-monad'
    check (length(network_ref) <= 128 and network_ref ~ '^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$'),
  add column policy_version integer not null default 1 check (policy_version >= 1),
  add column budget_version integer not null default 1 check (budget_version >= 1),
  add column resource_profile_ref text not null default 'paper-small-v1' check (length(resource_profile_ref) <= 128),
  add column model_profiles jsonb not null default '{}' check (jsonb_typeof(model_profiles) = 'object'),
  add column estimate_id uuid,
  add column simulation_account_id uuid,
  add column manifest jsonb check (manifest is null or manifest ->> 'schemaVersion' = 'deployment-manifest/1'),
  add column manifest_hash text check (manifest_hash ~ '^0x[0-9a-f]{64}$');
alter table deployments
  alter column network_ref drop default,
  alter column policy_version drop default,
  alter column budget_version drop default,
  alter column resource_profile_ref drop default;
alter table deployments
  add constraint deployments_policy foreign key (tenant_id, agent_id, policy_version) references policies (tenant_id, agent_id, version),
  add constraint deployments_estimate foreign key (tenant_id, estimate_id) references estimates (tenant_id, id),
  add constraint deployments_simulation_account foreign key (tenant_id, simulation_account_id) references simulation_accounts (tenant_id, id),
  -- A paper deployment always trades in a simulation account; a live one never does.
  add constraint deployments_paper_account check ((mode = 'paper') = (simulation_account_id is not null));
-- At most one deployment per agent that can still act or be resumed.
create unique index deployments_one_open_per_agent on deployments (tenant_id, agent_id) where desired_state <> 'stopped';

-- Executor intents belong to a real deployment (deferred in 0004 until this table carried authority fields).
alter table intents add constraint intents_deployment foreign key (tenant_id, deployment_id) references deployments (tenant_id, id);

-- Asynchronous user lifecycle operations (GET /v1/operations/{id}); idempotency rows live in control_requests.
create table deployment_operations (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  deployment_id uuid,
  kind text not null check (kind in ('deploy', 'pause', 'resume', 'stop')),
  state text not null check (state in ('pending', 'succeeded', 'failed')),
  error_code text check (length(error_code) between 1 and 64),
  error_message text check (length(error_message) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  foreign key (tenant_id, deployment_id) references deployments (tenant_id, id),
  check ((state = 'failed') = (error_code is not null and error_message is not null))
);

-- Finalized price observations accepted by ingestion: the recorded market the paper executor fills against
-- until broker results are persisted. Platform data, not tenant-owned.
create table market_observations (
  feed_ref text not null check (length(feed_ref) <= 128),
  source_event_key text not null check (length(source_event_key) between 1 and 1024),
  base_asset_ref text not null check (length(base_asset_ref) <= 128),
  quote_unit text not null check (length(quote_unit) <= 128),
  price numeric(78, 18) not null check (price > 0),
  observed_at timestamptz not null,
  received_at timestamptz not null check (received_at >= observed_at),
  primary key (feed_ref, source_event_key)
);
create index market_observations_latest on market_observations (feed_ref, observed_at desc);

-- Per-tenant audit stream (audit-event/2): the SSE Last-Event-ID is the sequence.
create table tenant_streams (
  tenant_id uuid primary key references tenants (id),
  last_sequence bigint not null default 0 check (last_sequence >= 0)
);
create table audit_events (
  tenant_id uuid not null,
  sequence bigint not null check (sequence >= 1),
  agent_id uuid,
  deployment_id uuid,
  run_id text check (run_id ~ '^0x[0-9a-f]{64}$'),
  intent_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'operator', 'controlPlane', 'runtime', 'executor', 'system')),
  actor_id uuid,
  trace_id text not null check (trace_id ~ '^[0-9a-f]{32}$'),
  type text not null check (type in ('deployment.stateChanged', 'observation.accepted', 'observation.skipped', 'run.step', 'model.usage',
    'policy.denied', 'reservation.changed', 'transaction.stateChanged', 'ledger.settled', 'resource.health', 'run.stateChanged', 'timeline.entry')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz not null,
  -- Source row this event was published from, so a republish is a no-op.
  source text not null check (length(source) between 1 and 200),
  primary key (tenant_id, sequence),
  unique (source),
  foreign key (tenant_id) references tenants (id),
  check ((actor_kind in ('user', 'operator')) = (actor_id is not null))
);
create index audit_events_agent on audit_events (tenant_id, agent_id, sequence);
create trigger audit_events_immutable before update or delete on audit_events
  for each row execute function forbid_mutation();
