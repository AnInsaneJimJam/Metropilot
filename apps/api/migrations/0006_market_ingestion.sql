-- Platform-owned public chain data; no tenant credentials or custody.
create table market_cursors (
  feed_ref text primary key,
  block_number numeric(78,0) not null check (block_number >= 0),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);
create table finalized_market_observations (
  feed_ref text not null,
  source_event_key text not null,
  document jsonb not null check (document->>'schemaVersion' = 'price-observation/1' and document->>'finality' = 'finalized'),
  primary key (feed_ref, source_event_key)
);
create trigger finalized_market_observations_immutable before update or delete on finalized_market_observations
  for each row execute function forbid_mutation();
create table finalized_market_logs (
  feed_ref text not null,
  block_hash text not null,
  log_index integer not null check (log_index >= 0),
  document jsonb not null,
  primary key (feed_ref, block_hash, log_index)
);
create trigger finalized_market_logs_immutable before update or delete on finalized_market_logs
  for each row execute function forbid_mutation();
-- An observation read is pinned on first dispatch, even if the runtime dies before recording its result.
create table market_read_results (
  run_id text not null,
  operation_key text not null,
  request_hash text not null,
  document jsonb not null,
  primary key (run_id, operation_key),
  foreign key (run_id, operation_key) references run_operations (run_id, operation_key)
);
create trigger market_read_results_immutable before update or delete on market_read_results
  for each row execute function forbid_mutation();
