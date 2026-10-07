-- Runtime-facing control plane (G4, docs/integration/control-api.md): a minimal deployments table until the
-- API-2 lifecycle owner extends it, immutable artifacts, trigger_state for fan-out, runs with fenced leases,
-- host operations and timeline entries. Every run mutation happens in one transaction holding the run row lock.

create table deployments (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  strategy_revision_id uuid not null,
  mode text not null check (mode in ('paper', 'live')),
  generation integer not null default 1 check (generation >= 1),
  desired_state text not null default 'running' check (desired_state in ('running', 'paused', 'stopped')),
  strategy_hash text not null check (strategy_hash ~ '^0x[0-9a-f]{64}$'),
  catalog_hash text not null check (catalog_hash ~ '^0x[0-9a-f]{64}$'),
  -- Manifest pins copied into each ActionIntent: {"connectorRef": "MAJOR.MINOR.PATCH"}.
  connector_versions jsonb not null check (jsonb_typeof(connector_versions) = 'object'),
  runtime_image_digest text not null check (runtime_image_digest ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  -- The deployed revision must belong to the same agent, not merely the same tenant.
  foreign key (tenant_id, agent_id, strategy_revision_id) references strategy_revisions (tenant_id, agent_id, id)
);

create table artifacts (
  ref text primary key check (length(ref) between 1 and 1024 and ref ~ '^[!-~]+$'),
  tenant_id uuid not null,
  deployment_id uuid not null,
  kind text not null check (kind in ('strategy', 'catalog')),
  content_hash text not null check (content_hash ~ '^0x[0-9a-f]{64}$'),
  body text not null check (length(body) between 2 and 1000000),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, deployment_id) references deployments (tenant_id, id)
);
create trigger artifacts_immutable before update or delete on artifacts
  for each row execute function forbid_mutation();

-- One row per (deployment, trigger). feed_ref is copied out of the AST at deploy time so fan-out is an index scan.
create table trigger_state (
  tenant_id uuid not null,
  deployment_id uuid not null,
  trigger_id text not null check (trigger_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  trigger_type text not null check (trigger_type in ('schedule', 'price.crossesAbove', 'price.crossesBelow', 'connector.event')),
  feed_ref text check (length(feed_ref) <= 128),
  generation integer not null check (generation >= 1),
  active boolean not null default true,
  crossing jsonb not null default '{}' check (jsonb_typeof(crossing) = 'object'),
  last_slot timestamptz,
  primary key (deployment_id, trigger_id),
  foreign key (tenant_id, deployment_id) references deployments (tenant_id, id)
);
create index trigger_state_feed on trigger_state (feed_ref) where active;
create index trigger_state_schedule on trigger_state (deployment_id) where active and trigger_type = 'schedule';

create table runs (
  tenant_id uuid not null,
  run_id text not null unique check (run_id ~ '^0x[0-9a-f]{64}$'),
  deployment_id uuid not null,
  generation integer not null check (generation >= 1),
  deployment_revision text not null check (length(deployment_revision) between 1 and 120),
  trigger_id text not null check (trigger_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  source_event_key text not null check (length(source_event_key) between 1 and 1024),
  -- Recorded trigger context and stage times (decision D34), copied into every assignment.
  trigger jsonb not null check (jsonb_typeof(trigger) = 'object'),
  -- revoked: the generation was superseded before the run finished; it is never offered again.
  status text not null default 'queued' check (status in ('queued', 'assigned', 'waiting', 'completed', 'failed', 'revoked')),
  checkpoint jsonb check (checkpoint is null or checkpoint ->> 'schemaVersion' = 'strategy-run/2'),
  recorded jsonb,
  observation_refs uuid[] not null default '{}' check (cardinality(observation_refs) <= 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  foreign key (tenant_id, deployment_id) references deployments (tenant_id, id)
);

-- Each lease of a run. The highest fencing_token is the current owner; older tokens can never write.
create table run_assignments (
  assignment_id uuid primary key check (uuid_extract_version(assignment_id) = 7),
  tenant_id uuid not null,
  run_id text not null,
  fencing_token bigint not null check (fencing_token >= 1),
  state text not null default 'queued' check (state in ('queued', 'offered')),
  runtime_id text check (length(runtime_id) between 1 and 128),
  -- SHA-256 of the current bearer capability; the bearer itself is never stored.
  capability_hash text check (capability_hash ~ '^0x[0-9a-f]{64}$'),
  capability_expires_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, fencing_token),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id)
);
create index run_assignments_queued on run_assignments (created_at) where state = 'queued';
create unique index run_assignments_capability on run_assignments (capability_hash) where capability_hash is not null;

create table run_operations (
  tenant_id uuid not null,
  run_id text not null,
  operation_key text not null check (operation_key ~ '^0x[0-9a-f]{64}$'),
  kind text not null check (kind in ('read', 'ai.decide', 'swap.exactInput', 'notify')),
  node_id text not null check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  iteration_path jsonb not null check (jsonb_typeof(iteration_path) = 'array'),
  outcome text check (outcome in ('pending', 'settled', 'rejected', 'failed', 'acknowledged', 'recorded', 'timeout', 'refused')),
  result_ref uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, operation_key),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id)
);

create table timeline_entries (
  tenant_id uuid not null,
  operation_key text primary key check (operation_key ~ '^0x[0-9a-f]{64}$'),
  run_id text not null,
  node_id text not null check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  message text not null check (length(message) between 1 and 500),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, run_id) references runs (tenant_id, run_id)
);
create trigger timeline_entries_immutable before update or delete on timeline_entries
  for each row execute function forbid_mutation();

-- Runtime workers known to the control plane; drain is the operator signal answered on the next poll.
create table runtime_workers (
  runtime_id text primary key check (length(runtime_id) between 1 and 128),
  drain boolean not null default false,
  last_poll_at timestamptz not null default now()
);
