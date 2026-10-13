-- Durable dispatch claims and append-only broker answers. Runtime wait must exist first.
alter table run_operations add constraint run_operations_tenant_identity unique (tenant_id, run_id, operation_key);
create table broker_operations (
  tenant_id uuid not null,
  operation_key text not null,
  run_id text not null,
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  request jsonb not null check (octet_length(request::text) <= 32768),
  latest_result_id uuid,
  primary key (tenant_id, operation_key),
  foreign key (tenant_id, run_id, operation_key) references run_operations (tenant_id, run_id, operation_key)
);
create table broker_results (
  tenant_id uuid not null,
  id uuid not null unique check (uuid_extract_version(id) = 7),
  operation_key text not null,
  run_id text not null,
  node_id text not null check (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  kind text not null check (kind in ('read', 'ai.decide')),
  response jsonb not null check (octet_length(response::text) <= 65536),
  value jsonb check (value is null or jsonb_typeof(value) = 'object'),
  observed_at timestamptz,
  received_at timestamptz not null,
  provenance jsonb not null check (octet_length(provenance::text) <= 4096),
  primary key (tenant_id, id),
  unique (tenant_id, operation_key, id),
  foreign key (tenant_id, run_id, operation_key) references run_operations (tenant_id, run_id, operation_key),
  foreign key (tenant_id, operation_key) references broker_operations (tenant_id, operation_key),
  check ((response ->> 'disposition' = 'completed') = (value is not null)),
  check (response ->> 'operationKey' = operation_key),
  check (response ->> 'disposition' <> 'completed' or response ->> 'resultId' = id::text)
);
create trigger broker_results_immutable before update or delete on broker_results
  for each row execute function forbid_mutation();
alter table broker_operations add constraint broker_operations_latest_result
  foreign key (tenant_id, operation_key, latest_result_id) references broker_results (tenant_id, operation_key, id);
