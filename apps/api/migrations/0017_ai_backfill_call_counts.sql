-- Correct 0009's legacy count without deleting audit identities or changing charges.
alter table ai_allowance_reservations add column counts_call boolean not null default true;
alter table ai_allowance_reservations disable trigger ai_allowance_protected;
update ai_allowance_reservations a set counts_call=false
from broker_operations o join broker_results b on b.tenant_id=o.tenant_id and b.id=o.latest_result_id
where a.tenant_id=o.tenant_id and a.operation_key=o.operation_key
  and a.state='settled' and a.charged_usd_micros=0
  and b.response->>'disposition'='refused'
  and b.response->'reason'->>'code' in ('BROKER_NOT_ALLOWED','BROKER_CAPABILITY_INVALID','BROKER_BUDGET_EXHAUSTED','BROKER_PROVIDER_UNAVAILABLE')
  and not exists(select 1 from ai_metering m where m.tenant_id=o.tenant_id and m.operation_key=o.operation_key);
alter table ai_allowance_reservations enable trigger ai_allowance_protected;
