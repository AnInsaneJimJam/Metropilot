// Atomic reservations and UTC-day counters (ACC-2, ACC-3; funds-and-budgets.md section 4).
// held → dispatched → settled | released | reconciling. One reservation can hold several assets; either every
// hold and counter is taken or nothing is. Lock order: ledger accounts by key, then spend windows by scope key,
// then the reservation row. Callers run each function inside one short transaction with no network call.
import { contentHash } from '@monad-hack/contracts';
import { accountKey, lockAccounts, normalSide } from './accounts.ts';
import type { AccountRef, Mode, Sql } from './accounts.ts';
import { AccountingError, invalid } from './errors.ts';
import { assertOutflowsAllowed, freeze } from './freezes.ts';
import { uuidv7 } from './ids.ts';
import { journalHash, postJournal, refFromKey } from './ledger.ts';
import type { JournalInput } from './ledger.ts';

export type Purpose = 'trade' | 'modelCall' | 'dataCall' | 'hostingSlice' | 'withdrawal' | 'sweep';
export type ReservationState = 'held' | 'dispatched' | 'settled' | 'released' | 'reconciling';

export interface HoldInput {
  readonly account: AccountRef;
  readonly amount: bigint;
}

/** One counter scope: agent:<id>, tenant:<id> or platform. Absent maxima do not constrain. */
export interface WindowLimit {
  readonly scopeKey: string;
  readonly maxActions?: number;
  readonly maxNotionalUsdMicros?: bigint;
}

export interface WindowInput {
  /** Whether this reservation counts as one action in the window. */
  readonly countsAction: boolean;
  readonly notionalUsdMicros: bigint;
  readonly limits: readonly WindowLimit[];
}

export interface ReserveInput {
  readonly operationKey: string;
  readonly mode: Mode;
  readonly tenantId: string;
  readonly agentId: string;
  readonly purpose: Purpose;
  readonly holds: readonly HoldInput[];
  readonly window?: WindowInput;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly quoteRef?: string;
  readonly rateCardVersion?: string;
  readonly policyVersion?: string;
}

export interface Reservation {
  readonly id: string;
  readonly operationKey: string;
  readonly state: ReservationState;
  readonly duplicate: boolean;
}

/** UTC calendar day (YYYY-MM-DD) of an instant; counters reset at UTC midnight. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const reservationHash = (input: ReserveInput): Promise<string> =>
  contentHash({
    operationKey: input.operationKey, mode: input.mode, tenantId: input.tenantId, agentId: input.agentId, purpose: input.purpose,
    holds: input.holds.map((h) => ({ account: accountKey(h.account), amount: h.amount.toString() })).sort((a, b) => (a.account < b.account ? -1 : 1)),
    window: input.window ? { countsAction: input.window.countsAction, notional: input.window.notionalUsdMicros.toString() } : null,
    quoteRef: input.quoteRef ?? null, rateCardVersion: input.rateCardVersion ?? null, policyVersion: input.policyVersion ?? null,
  });

async function find(c: Sql, operationKey: string, lock: boolean) {
  const r = await c.query<{ id: string; request_hash: string; state: ReservationState; mode: Mode; tenant_id: string; agent_id: string; settlement_journal_id: string | null; purpose: Purpose; dispatched_at: Date | null }>(
    `select id, request_hash, state, mode, tenant_id, agent_id, settlement_journal_id, purpose, dispatched_at from reservations where operation_key = $1${lock ? ' for update' : ''}`,
    [operationKey],
  );
  return r.rows[0];
}

async function heldAccounts(c: Sql, reservationId: string, tenantId: string): Promise<{ key: string; ref: AccountRef; amount: bigint }[]> {
  const r = await c.query<{ account_key: string; amount: string }>(
    'select a.account_key, h.amount from reservation_holds h join ledger_accounts a on a.id = h.account_id where h.reservation_id = $1 order by a.account_key',
    [reservationId],
  );
  return r.rows.map((row) => ({ key: row.account_key, ref: refFromKey(row.account_key, tenantId), amount: BigInt(row.amount) }));
}

/**
 * Hold every asset and counter for one operation, or nothing. Throws INSUFFICIENT_BUDGET,
 * DAILY_LIMIT_EXCEEDED or RECONCILIATION_REQUIRED (an open freeze blocks new outflows).
 */
export async function reserve(c: Sql, input: ReserveInput): Promise<Reservation> {
  if (input.holds.length < 1 || input.holds.length > 8) invalid('A reservation holds between one and eight assets.');
  if (input.expiresAt <= input.now) invalid('A reservation must expire after it is created.');
  const merged = new Map<string, HoldInput>();
  for (const h of input.holds) {
    if (h.amount <= 0n) invalid('Hold amounts are positive atomic integers.');
    if (h.account.mode !== input.mode) invalid('Paper and live accounts never share a reservation.');
    if (h.account.kind !== 'user') invalid('Only user budget buckets can be held.');
    if (h.account.agentId !== input.agentId || h.account.tenantId !== input.tenantId) invalid('A reservation holds only its own agent accounts.');
    const key = accountKey(h.account);
    merged.set(key, { account: h.account, amount: (merged.get(key)?.amount ?? 0n) + h.amount });
  }
  const hash = await reservationHash(input);
  const prior = await find(c, input.operationKey, false);
  if (prior) {
    if (prior.request_hash !== hash) throw new AccountingError('IDEMPOTENCY_CONFLICT', 'This operation was already reserved with different holds.', { operationKey: input.operationKey });
    return { id: prior.id, operationKey: input.operationKey, state: prior.state, duplicate: true };
  }
  await assertOutflowsAllowed(c, input.mode, input.tenantId, input.agentId);

  const accounts = await lockAccounts(c, [...merged.values()].map((h) => h.account));
  // Re-check under the lock: a concurrent duplicate may have committed while this transaction waited.
  const raced = await find(c, input.operationKey, false);
  if (raced) {
    if (raced.request_hash !== hash) throw new AccountingError('IDEMPOTENCY_CONFLICT', 'This operation was already reserved with different holds.', { operationKey: input.operationKey });
    return { id: raced.id, operationKey: input.operationKey, state: raced.state, duplicate: true };
  }
  for (const [key, hold] of merged) {
    const row = accounts.get(key)!;
    if (row.balance - row.held < hold.amount) {
      throw new AccountingError('INSUFFICIENT_BUDGET', 'Not enough unreserved balance for this operation.', { account: key });
    }
  }

  const day = utcDay(input.now);
  const window = input.window;
  const scopes = window ? [...new Set(window.limits.map((l) => l.scopeKey))].sort() : [];
  if (window) {
    if (window.notionalUsdMicros < 0n) invalid('Notional is non-negative.');
    for (const scope of scopes) {
      await c.query('insert into spend_windows (scope_key, mode, day) values ($1, $2, $3) on conflict do nothing', [scope, input.mode, day]);
    }
    const rows = await c.query<{ scope_key: string; pending_actions: number; committed_actions: number; pending_notional_usd_micros: string; committed_notional_usd_micros: string }>(
      'select * from spend_windows where scope_key = any($1) and mode = $2 and day = $3 order by scope_key for update',
      [scopes, input.mode, day],
    );
    const byScope = new Map(rows.rows.map((r) => [r.scope_key, r]));
    for (const limit of window.limits) {
      const w = byScope.get(limit.scopeKey)!;
      const actions = w.pending_actions + w.committed_actions + (window.countsAction ? 1 : 0);
      const notional = BigInt(w.pending_notional_usd_micros) + BigInt(w.committed_notional_usd_micros) + window.notionalUsdMicros;
      if ((limit.maxActions !== undefined && actions > limit.maxActions) || (limit.maxNotionalUsdMicros !== undefined && notional > limit.maxNotionalUsdMicros)) {
        throw new AccountingError('DAILY_LIMIT_EXCEEDED', 'The daily limit would be exceeded, counting pending operations.', { scope: limit.scopeKey });
      }
    }
  }

  const id = uuidv7(input.now.getTime());
  const counts = window ? window.countsAction || window.notionalUsdMicros > 0n : false;
  const inserted = await c.query(
    `insert into reservations (id, operation_key, request_hash, tenant_id, agent_id, mode, purpose, state, quote_ref, rate_card_version,
       policy_version, window_day, counts_action, notional_usd_micros, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'held', $8, $9, $10, $11, $12, $13, $14, $15) on conflict (operation_key) do nothing`,
    [id, input.operationKey, hash, input.tenantId, input.agentId, input.mode, input.purpose, input.quoteRef ?? null, input.rateCardVersion ?? null,
      input.policyVersion ?? null, counts ? day : null, window?.countsAction ?? false, (window?.notionalUsdMicros ?? 0n).toString(), input.now, input.expiresAt],
  );
  if (inserted.rowCount === 0) {
    const raced = (await find(c, input.operationKey, false))!;
    if (raced.request_hash !== hash) throw new AccountingError('IDEMPOTENCY_CONFLICT', 'This operation was already reserved with different holds.');
    return { id: raced.id, operationKey: input.operationKey, state: raced.state, duplicate: true };
  }
  for (const [key, hold] of merged) {
    const accountId = accounts.get(key)!.id;
    await c.query('insert into reservation_holds (reservation_id, account_id, amount) values ($1, $2, $3)', [id, accountId, hold.amount.toString()]);
    await c.query('update ledger_accounts set held = held + $2 where id = $1', [accountId, hold.amount.toString()]);
  }
  if (window && counts) {
    for (const scope of scopes) {
      await c.query('insert into reservation_windows (reservation_id, scope_key, mode, day) values ($1, $2, $3, $4)', [id, scope, input.mode, day]);
      await c.query(
        `update spend_windows set pending_actions = pending_actions + $4, pending_notional_usd_micros = pending_notional_usd_micros + $5
         where scope_key = $1 and mode = $2 and day = $3`,
        [scope, input.mode, day, window.countsAction ? 1 : 0, window.notionalUsdMicros.toString()],
      );
    }
  }
  return { id, operationKey: input.operationKey, state: 'held', duplicate: false };
}

/** Record that the external effect is about to be sent. After this the hold cannot expire, only resolve. */
export async function markDispatched(c: Sql, operationKey: string, now: Date): Promise<ReservationState> {
  const r = await find(c, operationKey, true);
  if (!r) throw new AccountingError('NOT_FOUND', 'Reservation not found.');
  if (r.state === 'dispatched' || r.state === 'reconciling') return r.state;
  if (r.state !== 'held') throw new AccountingError('STATE_CONFLICT', `A ${r.state} reservation cannot be dispatched.`);
  await c.query(`update reservations set state = 'dispatched', dispatched_at = $2 where id = $1`, [r.id, now]);
  return 'dispatched';
}

/** A dispatched effect whose outcome is unknown (timeout, missing receipt) keeps its hold until resolved. */
export async function markReconciling(c: Sql, operationKey: string, reason: string): Promise<ReservationState> {
  const r = await find(c, operationKey, true);
  if (!r) throw new AccountingError('NOT_FOUND', 'Reservation not found.');
  if (r.state === 'reconciling') return r.state;
  if (r.state !== 'dispatched') throw new AccountingError('STATE_CONFLICT', `A ${r.state} reservation cannot move to reconciling.`);
  await c.query(`update reservations set state = 'reconciling', reason = $2 where id = $1`, [r.id, reason.slice(0, 300)]);
  return 'reconciling';
}

async function moveWindows(c: Sql, reservationId: string, mode: Mode, commit: boolean): Promise<void> {
  const r = await c.query<{ counts_action: boolean; notional_usd_micros: string }>('select counts_action, notional_usd_micros from reservations where id = $1', [reservationId]);
  const res = r.rows[0]!;
  const windows = await c.query<{ scope_key: string; day: string }>(
    `select w.scope_key, to_char(w.day, 'YYYY-MM-DD') as day from reservation_windows w where w.reservation_id = $1 order by w.scope_key`, [reservationId]);
  const actions = res.counts_action ? 1 : 0;
  for (const w of windows.rows) {
    // The window of authorization, not today's: a new UTC day never erases an outstanding hold.
    await c.query('select 1 from spend_windows where scope_key = $1 and mode = $2 and day = $3 for update', [w.scope_key, mode, w.day]);
    await c.query(
      `update spend_windows set pending_actions = pending_actions - $4, pending_notional_usd_micros = pending_notional_usd_micros - $5,
         committed_actions = committed_actions + $6, committed_notional_usd_micros = committed_notional_usd_micros + $7
       where scope_key = $1 and mode = $2 and day = $3`,
      [w.scope_key, mode, w.day, actions, res.notional_usd_micros, commit ? actions : 0, commit ? res.notional_usd_micros : '0'],
    );
  }
}

/** Return every hold to available. Allowed from held, dispatched (provider confirmed no effect) or reconciling. */
export async function release(c: Sql, operationKey: string, now: Date, reason: string): Promise<ReservationState> {
  const r = await find(c, operationKey, false);
  if (!r) throw new AccountingError('NOT_FOUND', 'Reservation not found.');
  const holds = await heldAccounts(c, r.id, r.tenant_id);
  const accounts = await lockAccounts(c, holds.map((h) => h.ref));
  const locked = (await find(c, operationKey, true))!;
  if (locked.state === 'released') return 'released';
  if (locked.state === 'settled') throw new AccountingError('STATE_CONFLICT', 'A settled reservation cannot be released.');
  for (const h of holds) await c.query('update ledger_accounts set held = held - $2 where id = $1', [accounts.get(h.key)!.id, h.amount.toString()]);
  await c.query(`update reservation_holds set consumed = 0 where reservation_id = $1`, [r.id]);
  await moveWindows(c, r.id, r.mode, false);
  await c.query(`update reservations set state = 'released', resolved_at = $2, reason = $3 where id = $1`, [r.id, now, reason.slice(0, 300)]);
  return 'released';
}

export interface SettleInput {
  readonly journal: Omit<JournalInput, 'operationKey' | 'mode' | 'tenantId' | 'agentId'>;
  readonly now: Date;
}

export interface Settled {
  /** conflict: a different completion was reported for a settled operation; nothing posted, outflows frozen. */
  readonly outcome: 'settled' | 'duplicate' | 'conflict';
  readonly journalId: string;
  readonly duplicate: boolean;
  /** Per held account key: consumed and returned amounts. */
  readonly consumed: ReadonlyMap<string, { consumed: bigint; returned: bigint }>;
}

/**
 * Post the actual effect and return the unspent remainder, once. A duplicate completion with the same journal
 * returns the original; a conflicting one returns outcome 'conflict' and freezes the agent's outflows instead of
 * posting twice (the caller commits so the freeze persists). Settlement
 * may only reduce user buckets that this reservation holds, and by no more than the hold.
 */
export async function settle(c: Sql, operationKey: string, input: SettleInput): Promise<Settled> {
  const r = await find(c, operationKey, false);
  if (!r) throw new AccountingError('NOT_FOUND', 'Reservation not found.');
  const journal: JournalInput = { ...input.journal, operationKey: `settle:${operationKey}`, mode: r.mode, tenantId: r.tenant_id, agentId: r.agent_id };
  const holds = await heldAccounts(c, r.id, r.tenant_id);
  const accounts = await lockAccounts(c, [...holds.map((h) => h.ref), ...journal.postings.map((p) => p.account)]);
  const locked = (await find(c, operationKey, true))!;
  if (locked.state === 'settled') {
    const original = await c.query<{ request_hash: string }>('select request_hash from journals where id = $1', [locked.settlement_journal_id]);
    if (original.rows[0]!.request_hash === (await journalHash(journal))) {
      return { outcome: 'duplicate', journalId: locked.settlement_journal_id!, duplicate: true, consumed: await consumedOf(c, r.id) };
    }
    // Commit the freeze with the caller's transaction: returning (not throwing) keeps it.
    await freeze(c, { mode: r.mode, tenantId: r.tenant_id, agentId: r.agent_id, reasonCode: 'SETTLEMENT_CONFLICT', detail: { operationKey }, sourceKey: `settlement-conflict:${operationKey}`, now: input.now });
    return { outcome: 'conflict', journalId: locked.settlement_journal_id!, duplicate: false, consumed: await consumedOf(c, r.id) };
  }
  if (locked.state === 'released') throw new AccountingError('STATE_CONFLICT', 'A released reservation cannot be settled.');
  if (locked.state === 'held') throw new AccountingError('STATE_CONFLICT', 'A reservation must be dispatched before it settles.');

  const holdByKey = new Map(holds.map((h) => [h.key, h.amount]));
  const decrease = new Map<string, bigint>();
  for (const p of journal.postings) {
    if (p.account.kind !== 'user' && p.account.kind !== 'wallet') continue;
    const key = accountKey(p.account);
    const change = p.side === normalSide(p.account) ? -p.amount : p.amount;
    decrease.set(key, (decrease.get(key) ?? 0n) + change);
  }
  for (const [key, net] of decrease) {
    if (net <= 0n) continue;
    const accountRef = accounts.get(key)!.ref;
    if (accountRef.kind !== 'user') continue;
    const hold = holdByKey.get(key);
    if (hold === undefined || net > hold) {
      throw new AccountingError('INSUFFICIENT_BUDGET', 'Settlement spends more than this operation reserved.', { account: key });
    }
  }
  const consumed = new Map<string, { consumed: bigint; returned: bigint }>();
  for (const h of holds) {
    const used = decrease.get(h.key) ?? 0n;
    const spent = used > 0n ? (used > h.amount ? h.amount : used) : 0n;
    consumed.set(h.key, { consumed: spent, returned: h.amount - spent });
    await c.query('update ledger_accounts set held = held - $2 where id = $1', [accounts.get(h.key)!.id, h.amount.toString()]);
    await c.query('update reservation_holds set consumed = $3 where reservation_id = $1 and account_id = $2', [r.id, accounts.get(h.key)!.id, spent.toString()]);
  }
  const posted = await postJournal(c, journal);
  await moveWindows(c, r.id, r.mode, true);
  await c.query(`update reservations set state = 'settled', resolved_at = $2, settlement_journal_id = $3 where id = $1`, [r.id, input.now, posted.journalId]);
  return { outcome: 'settled', journalId: posted.journalId, duplicate: false, consumed };
}

async function consumedOf(c: Sql, reservationId: string): Promise<Map<string, { consumed: bigint; returned: bigint }>> {
  const r = await c.query<{ account_key: string; amount: string; consumed: string | null }>(
    'select a.account_key, h.amount, h.consumed from reservation_holds h join ledger_accounts a on a.id = h.account_id where h.reservation_id = $1', [reservationId]);
  return new Map(r.rows.map((row) => {
    const used = BigInt(row.consumed ?? '0');
    return [row.account_key, { consumed: used, returned: BigInt(row.amount) - used }];
  }));
}

/**
 * Release undispatched holds past their expiry. A dispatched or reconciling hold never expires: its external
 * effect may exist. Returns the released operation keys.
 */
export async function expireHeld(c: Sql, now: Date, limit = 100): Promise<string[]> {
  const due = await c.query<{ operation_key: string }>(
    `select operation_key from reservations where state = 'held' and dispatched_at is null and expires_at <= $1 order by expires_at limit $2`, [now, limit]);
  const released: string[] = [];
  for (const row of due.rows) {
    const current = await find(c, row.operation_key, false);
    if (current?.state !== 'held') continue;
    await release(c, row.operation_key, now, 'Expired before dispatch.');
    released.push(row.operation_key);
  }
  return released;
}

export interface ReservationView {
  readonly id: string;
  readonly operationKey: string;
  readonly purpose: Purpose;
  readonly state: ReservationState;
  readonly holds: readonly { readonly account: string; readonly amount: bigint; readonly consumed: bigint | undefined }[];
}

export async function getReservation(c: Sql, operationKey: string): Promise<ReservationView | undefined> {
  const r = await find(c, operationKey, false);
  if (!r) return undefined;
  const holds = await c.query<{ account_key: string; amount: string; consumed: string | null }>(
    'select a.account_key, h.amount, h.consumed from reservation_holds h join ledger_accounts a on a.id = h.account_id where h.reservation_id = $1 order by a.account_key', [r.id]);
  return {
    id: r.id, operationKey, purpose: r.purpose, state: r.state,
    holds: holds.rows.map((h) => ({ account: h.account_key, amount: BigInt(h.amount), consumed: h.consumed === null ? undefined : BigInt(h.consumed) })),
  };
}
