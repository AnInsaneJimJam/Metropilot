-- One allowance claim per durable broker operation. Unknown calls retain their original-day hold.
create table ai_allowance_reservations (
  tenant_id uuid not null,
  operation_key text not null,
  agent_id uuid not null,
  authorized_at timestamptz not null,
  authorized_day date not null,
  reserved_usd_micros numeric(78,0) not null check (reserved_usd_micros between 0 and 100000),
  charged_usd_micros numeric(78,0) check (charged_usd_micros between 0 and reserved_usd_micros),
  state text not null check (state in ('held','settled')),
  settled_at timestamptz,
  primary key (tenant_id,operation_key),
  foreign key (tenant_id,operation_key) references broker_operations(tenant_id,operation_key),
  foreign key (tenant_id,agent_id) references agents(tenant_id,id),
  check (authorized_day=(authorized_at at time zone 'UTC')::date),
  check ((state='settled')=(charged_usd_micros is not null and settled_at is not null))
);
create index ai_allowance_agent_day on ai_allowance_reservations(tenant_id,agent_id,authorized_day);
create function protect_ai_allowance() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'AI allowance claims cannot be deleted'; end if;
  if old.state='settled' or new.state<>'settled' or
     (to_jsonb(old)-array['state','charged_usd_micros','settled_at']) is distinct from
     (to_jsonb(new)-array['state','charged_usd_micros','settled_at']) then
    raise exception 'AI allowance identity and terminal charges are immutable';
  end if;
  return new;
end $$;
create trigger ai_allowance_protected before update or delete on ai_allowance_reservations for each row execute function protect_ai_allowance();
