-- G5 accounting (docs/specs/funds-and-budgets.md sections 2–4; packages/accounting ACC-1..ACC-3).
-- Per-asset double-entry ledger, atomic multi-asset reservations, UTC-day spend counters, conserved allocations
-- and reconciliation freezes. Amounts are atomic integer units of one asset; no row mixes assets.
-- Balances are maintained only by the posting trigger, so a balance always equals the sum of its postings.

create table ledger_accounts (
  id uuid primary key check (uuid_extract_version(id) = 7),
  -- Canonical identity, e.g. live:<agent>:liability:user:trading:<asset>; the lock order is by this key.
  account_key text not null unique check (length(account_key) <= 400),
  mode text not null check (mode in ('paper', 'live')),
  -- Platform accounts (treasury, platform expense) carry no tenant.
  tenant_id uuid references tenants (id),
  agent_id uuid,
  class text not null check (class in ('asset', 'liability', 'revenue', 'expense')),
  holder text not null check (holder in ('agentWallet', 'treasury', 'user', 'service', 'platform')),
  bucket text check (bucket in ('unallocated', 'hosting', 'api', 'trading')),
  asset_ref text not null check (length(asset_ref) <= 128 and asset_ref ~ '^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$'),
  normal_side text not null check (normal_side in ('debit', 'credit')),
  -- Balance on the normal side. Never negative: an application action cannot overdraw an account.
  balance numeric(78,0) not null default 0 check (balance >= 0),
  -- Active reservations against this account; available = balance - held.
  held numeric(78,0) not null default 0 check (held >= 0 and held <= balance),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check ((class in ('asset', 'expense')) = (normal_side = 'debit')),
  check ((holder = 'user') = (bucket is not null)),
  check ((holder = 'user') = (class = 'liability')),
  check (holder <> 'service' or (class = 'revenue' and bucket is null)),
  check (holder <> 'agentWallet' or class = 'asset'),
  check (holder in ('treasury', 'platform') or (tenant_id is not null and agent_id is not null)),
  check (holder not in ('treasury', 'platform') or (tenant_id is null and agent_id is null))
);
create index ledger_accounts_agent on ledger_accounts (tenant_id, agent_id, mode);

create table journals (
  id uuid primary key check (uuid_extract_version(id) = 7),
  -- One financial effect, one journal: a retry with the same key and body returns this row.
  operation_key text not null unique check (length(operation_key) between 1 and 300),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  mode text not null check (mode in ('paper', 'live')),
  tenant_id uuid references tenants (id),
  agent_id uuid,
  kind text not null check (kind in ('deposit', 'allocation', 'trade', 'gas', 'serviceCharge', 'sweep', 'withdrawal',
    'refund', 'reversal', 'platformAbsorb')),
  -- Corrections are reversing journals; history is never edited.
  reverses_journal_id uuid unique references journals (id),
  memo text check (length(memo) between 1 and 300),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check ((kind = 'reversal') = (reverses_journal_id is not null))
);
create index journals_agent_time on journals (tenant_id, agent_id, occurred_at);
create trigger journals_immutable before update or delete on journals
  for each row execute function forbid_mutation();

create table postings (
  journal_id uuid not null references journals (id),
  seq integer not null check (seq >= 0 and seq < 64),
  account_id uuid not null references ledger_accounts (id),
  asset_ref text not null,
  side text not null check (side in ('debit', 'credit')),
  amount numeric(78,0) not null check (amount > 0),
  primary key (journal_id, seq)
);
create index postings_account on postings (account_id);
create trigger postings_immutable before update or delete on postings
  for each row execute function forbid_mutation();

-- Applies a posting to its account: same asset and mode as the journal, balance moves on the normal side.
create function apply_posting() returns trigger language plpgsql as $$
declare
  acct ledger_accounts%rowtype;
  jmode text;
begin
  select * into acct from ledger_accounts where id = new.account_id for update;
  select mode into jmode from journals where id = new.journal_id;
  if acct.asset_ref <> new.asset_ref then
    raise exception 'posting asset % does not match account asset %', new.asset_ref, acct.asset_ref;
  end if;
  if acct.mode <> jmode then
    raise exception 'posting account mode % does not match journal mode %', acct.mode, jmode;
  end if;
  update ledger_accounts
    set balance = balance + case when new.side = acct.normal_side then new.amount else -new.amount end
    where id = new.account_id;
  return new;
end
$$;
create trigger postings_apply after insert on postings
  for each row execute function apply_posting();

-- At commit every journal has postings and balances debits against credits within each asset.
create function check_journal_balanced() returns trigger language plpgsql as $$
declare
  unbalanced text;
begin
  if not exists (select 1 from postings where journal_id = new.id) then
    raise exception 'journal % has no postings', new.id;
  end if;
  select asset_ref into unbalanced from postings where journal_id = new.id group by asset_ref
    having sum(case when side = 'debit' then amount else -amount end) <> 0 limit 1;
  if unbalanced is not null then
    raise exception 'journal % is unbalanced in asset %', new.id, unbalanced;
  end if;
  return null;
end
$$;
create constraint trigger journals_balanced after insert on journals
  deferrable initially deferred for each row execute function check_journal_balanced();

-- A held liability may only move through the reservation functions; posting reduces balance, never held.
create table reservations (
  id uuid primary key check (uuid_extract_version(id) = 7),
  operation_key text not null unique check (length(operation_key) between 1 and 300),
  request_hash text not null check (request_hash ~ '^0x[0-9a-f]{64}$'),
  tenant_id uuid not null,
  agent_id uuid not null,
  mode text not null check (mode in ('paper', 'live')),
  purpose text not null check (purpose in ('trade', 'modelCall', 'dataCall', 'hostingSlice', 'withdrawal', 'sweep')),
  state text not null check (state in ('held', 'dispatched', 'settled', 'released', 'reconciling')),
  quote_ref text check (length(quote_ref) <= 200),
  rate_card_version text check (length(rate_card_version) <= 200),
  policy_version text check (length(policy_version) <= 200),
  -- UTC day whose counters this reservation was authorized in; settlement attaches usage there.
  window_day date,
  counts_action boolean not null default false,
  notional_usd_micros numeric(78,0) not null default 0 check (notional_usd_micros >= 0),
  created_at timestamptz not null,
  -- Undispatched holds may expire; dispatched ones only settle, release or reconcile.
  expires_at timestamptz not null check (expires_at > created_at),
  dispatched_at timestamptz,
  resolved_at timestamptz,
  settlement_journal_id uuid unique references journals (id),
  reason text check (length(reason) between 1 and 300),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check (state <> 'held' or (dispatched_at is null and resolved_at is null)),
  check (state <> 'dispatched' or (dispatched_at is not null and resolved_at is null)),
  check (state <> 'reconciling' or dispatched_at is not null),
  check ((state = 'settled') = (settlement_journal_id is not null)),
  check (state not in ('settled', 'released') or resolved_at is not null),
  check ((window_day is null) = (not counts_action and notional_usd_micros = 0))
);
create index reservations_open on reservations (tenant_id, agent_id, state) where state in ('held', 'dispatched', 'reconciling');
create index reservations_expiry on reservations (expires_at) where state = 'held';

create table reservation_holds (
  reservation_id uuid not null references reservations (id),
  account_id uuid not null references ledger_accounts (id),
  amount numeric(78,0) not null check (amount > 0),
  -- Amount actually consumed at settlement; the remainder returned to available.
  consumed numeric(78,0) check (consumed >= 0 and consumed <= amount),
  primary key (reservation_id, account_id)
);
create trigger reservation_holds_no_delete before delete on reservation_holds
  for each row execute function forbid_mutation();

-- Pending plus committed usage per UTC day. scope_key is agent:<id>, tenant:<id> or platform, per mode.
create table spend_windows (
  scope_key text not null check (length(scope_key) <= 100),
  mode text not null check (mode in ('paper', 'live')),
  day date not null,
  pending_actions integer not null default 0 check (pending_actions >= 0),
  committed_actions integer not null default 0 check (committed_actions >= 0),
  pending_notional_usd_micros numeric(78,0) not null default 0 check (pending_notional_usd_micros >= 0),
  committed_notional_usd_micros numeric(78,0) not null default 0 check (committed_notional_usd_micros >= 0),
  primary key (scope_key, mode, day)
);

create table reservation_windows (
  reservation_id uuid not null references reservations (id),
  scope_key text not null,
  mode text not null,
  day date not null,
  primary key (reservation_id, scope_key),
  foreign key (scope_key, mode, day) references spend_windows (scope_key, mode, day)
);

-- Unexplained differences freeze new outflows for the scope until an operator clears them with a reason.
create table reconciliation_freezes (
  id uuid primary key check (uuid_extract_version(id) = 7),
  mode text not null check (mode in ('paper', 'live')),
  tenant_id uuid references tenants (id),
  agent_id uuid,
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z_]{2,60}$'),
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  -- Deduplicates repeated detection of the same discrepancy.
  source_key text not null unique check (length(source_key) <= 300),
  created_at timestamptz not null,
  cleared_at timestamptz,
  cleared_reason text check (length(cleared_reason) between 1 and 300),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id),
  check ((cleared_at is null) = (cleared_reason is null)),
  check (agent_id is null or tenant_id is not null)
);
create index reconciliation_freezes_open on reconciliation_freezes (mode, tenant_id, agent_id) where cleared_at is null;

-- Each allocation is a user command against an expected budget version; the journal moves liabilities.
create table allocations (
  tenant_id uuid not null,
  agent_id uuid not null,
  mode text not null check (mode in ('paper', 'live')),
  budget_version integer not null check (budget_version >= 2),
  asset_ref text not null,
  journal_id uuid not null unique references journals (id),
  actor text not null check (length(actor) between 1 and 200),
  created_at timestamptz not null,
  primary key (tenant_id, agent_id, budget_version),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);
create trigger allocations_immutable before update or delete on allocations
  for each row execute function forbid_mutation();
