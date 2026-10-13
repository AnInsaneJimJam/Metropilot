-- Preserve usage/holds from deployments that ran before allowance enforcement was introduced.
insert into ai_allowance_reservations(tenant_id,operation_key,agent_id,authorized_at,authorized_day,reserved_usd_micros,charged_usd_micros,state,settled_at)
select tenant_id,operation_key,agent_id,authorized_at,(authorized_at at time zone 'UTC')::date,
       reserved_usd_micros,charged_usd_micros,case when state='settled' then 'settled' else 'held' end,settled_at
from ai_metering
on conflict do nothing;

-- Earlier non-metered paper AI operations (explicitly synthetic) still count toward the call limit.
-- A real provider dispatch cannot exist without its durable ai_metering row.
insert into ai_allowance_reservations(tenant_id,operation_key,agent_id,authorized_at,authorized_day,reserved_usd_micros,charged_usd_micros,state,settled_at)
select o.tenant_id,o.operation_key,d.agent_id,t.authorized_at,(t.authorized_at at time zone 'UTC')::date,
       0,case when b.response->>'disposition' in ('completed','refused') then 0 else null end,
       case when b.response->>'disposition' in ('completed','refused') then 'settled' else 'held' end,
       case when b.response->>'disposition' in ('completed','refused') then b.received_at else null end
from broker_operations o
join runs r on r.tenant_id=o.tenant_id and r.run_id=o.run_id
join deployments d on d.tenant_id=r.tenant_id and d.id=r.deployment_id and d.mode='paper'
join broker_results b on b.tenant_id=o.tenant_id and b.id=o.latest_result_id
join lateral (select min(received_at) as authorized_at from broker_results x where x.tenant_id=o.tenant_id and x.operation_key=o.operation_key) t on t.authorized_at is not null
where o.request->>'kind'='ai.decide' and not exists(select 1 from ai_metering m where m.tenant_id=o.tenant_id and m.operation_key=o.operation_key)
on conflict do nothing;
