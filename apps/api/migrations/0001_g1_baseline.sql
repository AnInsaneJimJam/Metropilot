-- G1 baseline: the catalog plus the minimal tenant-owned rows that the deployment/1 example in
-- docs/specs/api-and-data.md references. Later gates add tables in new numbered files.
-- Tenant-owned rows use composite (tenant_id, id) keys so a reference cannot cross tenants.

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end
$$;

-- One user per tenant in the MVP, so the external auth subject lives on the tenant.
create table tenants (
  id uuid primary key check (uuid_extract_version(id) = 7),
  auth_subject text not null unique check (length(auth_subject) between 1 and 300),
  state text not null default 'active' check (state in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table agents (
  tenant_id uuid not null references tenants (id),
  id uuid not null unique check (uuid_extract_version(id) = 7),
  name text not null check (length(name) between 1 and 120),
  -- Bumped by each allocation (funds-and-budgets.md section 3); deployment requests name it.
  budget_version integer not null default 1 check (budget_version >= 1),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table strategy_revisions (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  language_version text not null check (language_version = 'strategy/1'),
  content_hash text not null check (content_hash ~ '^0x[0-9a-f]{64}$'),
  ast jsonb not null check (ast ->> 'schemaVersion' = language_version),
  workspace jsonb,
  validation jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, agent_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);
create trigger strategy_revisions_immutable before update or delete on strategy_revisions
  for each row execute function forbid_mutation();

-- Approved policy snapshots; the current, stricter policy is still checked at action time.
create table policies (
  tenant_id uuid not null,
  agent_id uuid not null,
  version integer not null check (version >= 1),
  limits jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, agent_id, version),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);
create trigger policies_immutable before update or delete on policies
  for each row execute function forbid_mutation();

create table estimates (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  agent_id uuid not null,
  strategy_revision_id uuid not null,
  assumptions jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  primary key (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  -- The estimate's revision must belong to the same agent, not merely the same tenant.
  foreign key (tenant_id, agent_id, strategy_revision_id) references strategy_revisions (tenant_id, agent_id, id)
);
create trigger estimates_immutable before update or delete on estimates
  for each row execute function forbid_mutation();

-- Immutable catalog versions. Only disabled_reason may change, to withdraw a version.
create table catalog_versions (
  kind text not null check (kind in ('network', 'connector', 'asset', 'feed', 'modelProfile', 'resourceProfile')),
  ref text not null check (length(ref) <= 128 and ref ~ '^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$'),
  version text not null check (version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
  -- Paper and live registries stay distinct: a version declares which modes may resolve it.
  modes text[] not null check (cardinality(modes) >= 1 and modes <@ array['paper', 'live']),
  content_hash text not null check (content_hash ~ '^0x[0-9a-f]{64}$'),
  definition jsonb not null,
  disabled_reason text check (length(disabled_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  primary key (ref, version)
);

create function catalog_versions_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE'
    or (new.kind, new.ref, new.version, new.modes, new.content_hash, new.definition, new.created_at)
      is distinct from (old.kind, old.ref, old.version, old.modes, old.content_hash, old.definition, old.created_at) then
    raise exception 'catalog versions are immutable; publish a new version';
  end if;
  return new;
end
$$;
create trigger catalog_versions_immutable before update or delete on catalog_versions
  for each row execute function catalog_versions_immutable();
