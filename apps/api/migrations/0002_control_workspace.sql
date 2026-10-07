-- Control workspace: drafts and durable, transactionally replayable saves. No financial ledger.
alter table agents add column experience text not null default 'rookie' check (experience in ('rookie', 'advanced'));
alter table agents add column paper_budget jsonb;
alter table agents add column updated_at timestamptz not null default now();
create table control_requests (
  tenant_id uuid not null references tenants(id),
  scope text not null check (length(scope) <= 200),
  key text not null check (length(key) between 8 and 128),
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, scope, key)
);
-- New drafts always have a saved revision; baseline fixtures may have no selected revision.
alter table agents add column revision_id uuid;
alter table agents add constraint selected_revision_owned foreign key (tenant_id, id, revision_id)
  references strategy_revisions(tenant_id, agent_id, id);
