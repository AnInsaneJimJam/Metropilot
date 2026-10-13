-- Audit stream retention and the SSE reset floor (API-6, issue #19, decision D57). audit_events stays
-- append-only for every caller except prune_audit_events, which removes an old prefix of one tenant's stream and
-- records how far it went in tenant_streams.retained_after. A client whose cursor is below that floor gets a reset
-- instruction instead of a silent gap. Money records (intent-linked rows and reservation, transaction, ledger
-- and policy-denial events) are never pruned (security.md retention).

alter table tenant_streams
  add column retained_after bigint not null default 0,
  add constraint tenant_streams_retained check (retained_after >= 0 and retained_after <= last_sequence);

create index audit_events_occurred on audit_events (tenant_id, occurred_at);

-- Rows that reconcile money; kept regardless of age.
create function audit_event_is_money(intent_id uuid, type text) returns boolean language sql immutable as $$
  select intent_id is not null or type in ('reservation.changed', 'transaction.stateChanged', 'ledger.settled', 'policy.denied')
$$;

-- Updates are always refused. A delete passes only inside prune_audit_events (transaction-local flag) and never
-- for a money row. The flag guards against accidental mutation; it is not a privilege boundary (database roles
-- are a later security task).
create function audit_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.audit_prune', true) = 'on' and not audit_event_is_money(old.intent_id, old.type) then
    return old;
  end if;
  raise exception '% rows are immutable', tg_table_name;
end
$$;
drop trigger audit_events_immutable on audit_events;
create trigger audit_events_immutable before update or delete on audit_events
  for each row execute function audit_events_guard();

-- Prune one tenant's events older than cutoff; returns the number removed. Only a prefix of the stream in which
-- every event is older than the cutoff is eligible, so a newer event is never removed even where sequence and
-- occurred_at order disagree. Locks the tenant's stream row, which serializes with appends for that tenant only.
create function prune_audit_events(target uuid, cutoff timestamptz) returns bigint language plpgsql as $$
declare
  boundary bigint;
  removed bigint;
  highest bigint;
begin
  if cutoff > now() - interval '1 day' then
    raise exception 'audit retention cutoff must be at least one day in the past';
  end if;
  select last_sequence into boundary from tenant_streams where tenant_id = target for update;
  if not found then
    return 0;
  end if;
  select coalesce(min(sequence) - 1, boundary) into boundary from audit_events where tenant_id = target and occurred_at >= cutoff;
  perform set_config('app.audit_prune', 'on', true);
  with gone as (
    delete from audit_events
    where tenant_id = target and sequence <= boundary and not audit_event_is_money(intent_id, type)
    returning sequence
  )
  select count(*), max(sequence) into removed, highest from gone;
  perform set_config('app.audit_prune', 'off', true);
  if highest is not null then
    update tenant_streams set retained_after = greatest(retained_after, highest) where tenant_id = target;
  end if;
  return removed;
end
$$;
