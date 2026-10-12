-- Paper AI metering is a separate USD estimate ledger, never trading/hosting inventory.
-- The dispatch record commits before provider I/O. An unknown charge retains its ceiling.
create table ai_metering (
  tenant_id uuid not null,
  operation_key text not null,
  agent_id uuid not null,
  model_id text not null check (length(model_id) between 1 and 120),
  rate_version text not null check (length(rate_version) between 1 and 120),
  input_rate numeric(78,0) not null check (input_rate >= 0),
  cached_input_rate numeric(78,0) not null check (cached_input_rate >= 0 and cached_input_rate <= input_rate),
  output_rate numeric(78,0) not null check (output_rate >= 0),
  max_input_tokens integer not null check (max_input_tokens between 1 and 8192),
  max_output_tokens integer not null check (max_output_tokens between 1 and 1024),
  reserved_usd_micros numeric(78,0) not null check (reserved_usd_micros between 1 and 100000),
  state text not null check (state in ('dispatched','reconciling','settled')),
  provider_request_id text check (length(provider_request_id) between 1 and 200),
  usage jsonb check (usage is null or jsonb_typeof(usage)='object'),
  charged_usd_micros numeric(78,0) check (charged_usd_micros >= 0 and charged_usd_micros <= reserved_usd_micros),
  result jsonb check (result is null or result->>'schemaVersion'='broker-result/1'),
  reconciliation_evidence text check (length(reconciliation_evidence) between 1 and 500),
  authorized_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (tenant_id,operation_key),
  foreign key (tenant_id,operation_key) references broker_operations(tenant_id,operation_key),
  foreign key (tenant_id,agent_id) references agents(tenant_id,id),
  check ((state='settled') = (charged_usd_micros is not null and usage is not null and result is not null and settled_at is not null))
);
create function protect_ai_metering() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'AI dispatch records cannot be deleted'; end if;
  if old.state='settled' or
     (to_jsonb(old) - array['state','provider_request_id','usage','charged_usd_micros','result','reconciliation_evidence','settled_at']) is distinct from
     (to_jsonb(new) - array['state','provider_request_id','usage','charged_usd_micros','result','reconciliation_evidence','settled_at']) then
    raise exception 'AI identity, rate and terminal records are immutable';
  end if;
  if new.state='dispatched' then raise exception 'AI dispatch cannot be reset'; end if;
  return new;
end $$;
create trigger ai_metering_protected before update or delete on ai_metering for each row execute function protect_ai_metering();
create index ai_metering_unknown on ai_metering(authorized_at) where state in ('dispatched','reconciling');
