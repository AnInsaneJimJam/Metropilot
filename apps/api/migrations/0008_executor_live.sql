-- Live intents on the funds ledger (docs/specs/executor.md sections 5, 7, 9 and 12; funds-and-budgets.md section 4).
-- A live intent spends from the agent's custodial wallet: its holds are an accounting reservation (token-in plus
-- the native gas ceiling, counted in the UTC-day windows) and its settlement is a balanced journal. Paper intents
-- keep their simulation account, holds and fills (0004); the two never share a row shape.

alter table intents drop constraint intents_mode_check;
alter table intents add constraint intents_mode_check check (mode in ('paper', 'live'));
alter table intents alter column simulation_account_id drop not null;
alter table intents
  add column wallet_id uuid,
  add column reservation_key text unique references reservations (operation_key),
  add column settlement_journal_id uuid unique references journals (id),
  add column tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  add column settled_gas_atomic numeric(78,0) check (settled_gas_atomic >= 0),
  add constraint intents_wallet foreign key (tenant_id, wallet_id) references wallets (tenant_id, id),
  add constraint intents_funding_identity check (
    (mode = 'paper' and simulation_account_id is not null and wallet_id is null and reservation_key is null and tx_hash is null and settlement_journal_id is null)
    or (mode = 'live' and simulation_account_id is null and wallet_id is not null and paper_fill_id is null));

-- Settled means actual amounts are recorded: a paper fill for paper, a settlement journal and transaction for live.
alter table intents drop constraint intents_check3;
alter table intents add constraint intents_settled_evidence check (
  (state = 'settled') = (settled_input_atomic is not null and settled_output_atomic is not null
    and (paper_fill_id is not null or (settlement_journal_id is not null and tx_hash is not null))));
-- A live intent past admission owns a reservation.
alter table intents add constraint intents_live_reservation check (mode <> 'live' or state in ('proposed', 'rejected') or reservation_key is not null);
