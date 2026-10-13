-- Latest native observation lookups must not scan the full growing history.
create index finalized_market_observations_latest
  on finalized_market_observations (feed_ref, (document->>'observedAt') desc);

-- Keep replayed broker reads explicitly tenant-owned, consistent with runs/operations.
alter table market_read_results add column tenant_id uuid;
alter table market_read_results disable trigger market_read_results_immutable;
update market_read_results m set tenant_id = r.tenant_id from runs r where r.run_id = m.run_id;
alter table market_read_results enable trigger market_read_results_immutable;
alter table market_read_results alter column tenant_id set not null;
alter table market_read_results add foreign key (tenant_id, run_id) references runs (tenant_id, run_id);
