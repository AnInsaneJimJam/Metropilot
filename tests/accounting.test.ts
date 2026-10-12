// G5 accounting against a real PostgreSQL (packages/accounting ACC-1..ACC-3, ACC-6; verification V09–V11;
// funds-and-budgets.md section 8). Concurrency checks use separate pooled connections, not mocked arithmetic.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AccountingError, agentBalances, allocate, clearFreeze, depositPostings, expireHeld, getReservation, markDispatched, markReconciling,
  postJournal, reconcileWallet, release, reserve, reverseJournal, serviceChargePostings, settle, swapPostings, sweepPostings, user, uuidv7,
  wallet, withdrawalPostings,
} from '../packages/accounting/src/index.ts';
import type { AgentScope } from '../packages/accounting/src/index.ts';
import { databaseSkip, SEED_TENANT, scratchDb } from './scratch-db.ts';
import type { ScratchDb } from './scratch-db.ts';

const skip = await databaseSkip();
const USD = 'test.USD';
const MON = 'test.MON';
const WETH = 'test.WETH';
const now = new Date('2026-10-12T10:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

const code = (fn: () => Promise<unknown>) => fn().then(() => 'ok', (e: unknown) => (e instanceof AccountingError ? e.code : `raw:${(e as Error).message}`));

describe('accounting ledger and reservations', { skip }, () => {
  let db: ScratchDb;
  before(async () => {
    db = await scratchDb('accounting_test');
  });
  after(async () => {
    await db?.drop();
  });

  async function agent(): Promise<AgentScope> {
    const agentId = uuidv7();
    await db.pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'ledger test agent')`, [SEED_TENANT, agentId]);
    return { mode: 'live', tenantId: SEED_TENANT, agentId };
  }

  async function funded(amounts: { trading?: bigint; hosting?: bigint; api?: bigint; mon?: bigint } = {}): Promise<AgentScope> {
    const scope = await agent();
    const usd = (amounts.trading ?? 0n) + (amounts.hosting ?? 0n) + (amounts.api ?? 0n);
    await db.tx(async (c) => {
      if (usd > 0n) {
        await postJournal(c, { operationKey: `deposit:${scope.agentId}:usd`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit', postings: depositPostings(scope, USD, usd), occurredAt: now });
        const targets = { ...(amounts.trading ? { trading: amounts.trading } : {}), ...(amounts.hosting ? { hosting: amounts.hosting } : {}), ...(amounts.api ? { api: amounts.api } : {}) };
        await allocate(c, { scope, assetRef: USD, expectedBudgetVersion: 1, targets, actor: 'test', now });
      }
      if (amounts.mon) {
        await postJournal(c, { operationKey: `deposit:${scope.agentId}:mon`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit', postings: depositPostings(scope, MON, amounts.mon), occurredAt: now });
        const v = (await c.query<{ budget_version: number }>('select budget_version from agents where id = $1', [scope.agentId])).rows[0]!.budget_version;
        await allocate(c, { scope, assetRef: MON, expectedBudgetVersion: v, targets: { trading: amounts.mon }, actor: 'test', now });
      }
    });
    return scope;
  }

  const bal = async (scope: AgentScope, bucket: 'unallocated' | 'hosting' | 'api' | 'trading', asset = USD) =>
    (await agentBalances(db.pool, scope)).find((b) => b.kind === 'user' && b.bucket === bucket && b.assetRef === asset) ?? { balance: 0n, held: 0n, available: 0n };

  test('journals balance per asset; the database refuses an unbalanced or cross-mode journal even without the library check', async () => {
    const scope = await agent();
    await db.tx((c) => postJournal(c, { operationKey: 'k1', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit', postings: depositPostings(scope, USD, 100n), occurredAt: now }));
    assert.equal((await bal(scope, 'unallocated')).balance, 100n);
    assert.equal(await code(() => db.tx((c) => postJournal(c, {
      operationKey: 'k2', mode: 'live', kind: 'deposit', occurredAt: now,
      postings: [{ account: wallet(scope, USD), side: 'debit', amount: 5n }, { account: user(scope, 'unallocated', MON), side: 'credit', amount: 5n }],
    }))), 'INVALID');
    // Raw SQL bypassing the library: deferred trigger rejects the unbalanced journal at commit.
    const raw = await db.pool.connect();
    try {
      await raw.query('begin');
      const accounts = await raw.query<{ id: string }>(`select id from ledger_accounts where account_key = $1`, [`live:${scope.agentId}:wallet:${USD}`]);
      const jid = uuidv7();
      await raw.query(`insert into journals (id, operation_key, request_hash, mode, kind, occurred_at) values ($1, 'raw', $2, 'live', 'deposit', now())`, [jid, `0x${'0'.repeat(64)}`]);
      await raw.query(`insert into postings (journal_id, seq, account_id, asset_ref, side, amount) values ($1, 0, $2, $3, 'debit', 7)`, [jid, accounts.rows[0]!.id, USD]);
      await assert.rejects(raw.query('commit'), /unbalanced/);
    } finally {
      raw.release();
    }
    // Posting into a paper account from a live journal is refused by the posting trigger.
    const paper = { ...scope, mode: 'paper' as const };
    await db.tx((c) => postJournal(c, { operationKey: 'paper-1', mode: 'paper', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit', postings: depositPostings(paper, USD, 3n), occurredAt: now }));
    const raw2 = await db.pool.connect();
    try {
      await raw2.query('begin');
      const paperAccount = await raw2.query<{ id: string }>(`select id from ledger_accounts where account_key = $1`, [`paper:${scope.agentId}:wallet:${USD}`]);
      const jid = uuidv7();
      await raw2.query(`insert into journals (id, operation_key, request_hash, mode, kind, occurred_at) values ($1, 'raw-mode', $2, 'live', 'deposit', now())`, [jid, `0x${'0'.repeat(64)}`]);
      await assert.rejects(raw2.query(`insert into postings (journal_id, seq, account_id, asset_ref, side, amount) values ($1, 0, $2, $3, 'debit', 1)`, [jid, paperAccount.rows[0]!.id, USD]), /mode/);
      await raw2.query('rollback');
    } finally {
      raw2.release();
    }
    // Journals and postings are immutable; balances equal posting sums.
    await assert.rejects(db.pool.query(`update journals set memo = 'x' where operation_key = 'k1'`), /immutable/);
    await assert.rejects(db.pool.query(`delete from postings`), /immutable/);
    const sums = await db.pool.query<{ ok: boolean }>(
      `select bool_and(a.balance = coalesce((select sum(case when p.side = a.normal_side then p.amount else -p.amount end) from postings p where p.account_id = a.id), 0)) as ok from ledger_accounts a`);
    assert.equal(sums.rows[0]!.ok, true);
  });

  test('duplicate deposit or settlement posts once; a changed body conflicts; reversal mirrors without deleting', async () => {
    const scope = await agent();
    const input = { operationKey: 'deposit:143:0xabc:0', mode: 'live' as const, tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit' as const, postings: depositPostings(scope, USD, 50n), occurredAt: now };
    const first = await db.tx((c) => postJournal(c, input));
    const again = await db.tx((c) => postJournal(c, { ...input, occurredAt: later(5000) }));
    assert.equal(again.journalId, first.journalId);
    assert.equal(again.duplicate, true);
    // Concurrent duplicates: exactly one journal.
    const racing = { ...input, operationKey: 'deposit:143:0xdef:1' };
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => db.tx((c) => postJournal(c, racing))));
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    assert.equal(new Set(results.map((r) => (r as PromiseFulfilledResult<{ journalId: string }>).value.journalId)).size, 1);
    assert.equal((await bal(scope, 'unallocated')).balance, 100n);
    assert.equal(await code(() => db.tx((c) => postJournal(c, { ...input, postings: depositPostings(scope, USD, 51n) }))), 'IDEMPOTENCY_CONFLICT');
    await db.tx((c) => reverseJournal(c, first.journalId, `reverse:${first.journalId}`, now, 'test correction'));
    assert.equal((await bal(scope, 'unallocated')).balance, 50n);
    assert.equal((await db.pool.query('select 1 from journals where id = $1', [first.journalId])).rowCount, 1);
  });

  test('two simultaneous reservations cannot overspend (G5 exit), across repeated rounds', async () => {
    for (let round = 0; round < 5; round++) {
      const scope = await funded({ trading: 100n });
      const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => db.tx((c) => reserve(c, {
        operationKey: `trade:${scope.agentId}:${i}`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade',
        holds: [{ account: user(scope, 'trading', USD), amount: 60n }], now, expiresAt: later(60_000),
      }))));
      const ok = attempts.filter((a) => a.status === 'fulfilled');
      assert.equal(ok.length, 1, `round ${round}`);
      for (const a of attempts) if (a.status === 'rejected') assert.equal((a.reason as AccountingError).code, 'INSUFFICIENT_BUDGET');
      const b = await bal(scope, 'trading');
      assert.deepEqual([b.balance, b.held, b.available], [100n, 60n, 40n]);
    }
  });

  test('concurrent retries of one reservation key return the original instead of failing for budget', async () => {
    for (let round = 0; round < 5; round++) {
      const scope = await funded({ trading: 100n });
      const input = { operationKey: `retry:${scope.agentId}`, mode: 'live' as const, tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade' as const, holds: [{ account: user(scope, 'trading', USD), amount: 60n }], now, expiresAt: later(60_000) };
      const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => db.tx((c) => reserve(c, input))));
      assert.ok(attempts.every((a) => a.status === 'fulfilled'), JSON.stringify(attempts.map((a) => a.status === 'rejected' ? (a.reason as Error).message : 'ok')));
      assert.equal(new Set(attempts.map((a) => (a as PromiseFulfilledResult<{ id: string }>).value.id)).size, 1);
      assert.equal((await bal(scope, 'trading')).held, 60n);
    }
  });

  test('a multi-asset reservation is atomic: a short MON gas hold leaves no token-in hold behind', async () => {
    const scope = await funded({ trading: 100n, mon: 5n });
    assert.equal(await code(() => db.tx((c) => reserve(c, {
      operationKey: 'swap-1', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(60_000),
      holds: [{ account: user(scope, 'trading', USD), amount: 50n }, { account: user(scope, 'trading', MON), amount: 9n }],
    }))), 'INSUFFICIENT_BUDGET');
    assert.equal((await bal(scope, 'trading')).held, 0n);
    assert.equal((await db.pool.query(`select 1 from reservations where operation_key = 'swap-1'`)).rowCount, 0);
  });

  test('swap settlement posts actual per-asset effects, returns the unspent remainder and is idempotent; a conflicting completion freezes', async () => {
    const scope = await funded({ trading: 1000n, mon: 10n });
    const key = `swap:${scope.agentId}`;
    await db.tx((c) => reserve(c, {
      operationKey: key, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(60_000),
      holds: [{ account: user(scope, 'trading', USD), amount: 400n }, { account: user(scope, 'trading', MON), amount: 6n }],
    }));
    assert.equal(await code(() => db.tx((c) => settle(c, key, { journal: { kind: 'trade', postings: swapPostings(scope, { assetIn: USD, amountIn: 400n, assetOut: WETH, amountOut: 3n, gasAsset: MON, gasUsed: 2n }), occurredAt: now }, now }))), 'STATE_CONFLICT');
    await db.tx((c) => markDispatched(c, key, now));
    const journal = { kind: 'trade' as const, postings: swapPostings(scope, { assetIn: USD, amountIn: 400n, assetOut: WETH, amountOut: 3n, gasAsset: MON, gasUsed: 2n }), occurredAt: now };
    const s = await db.tx((c) => settle(c, key, { journal, now }));
    assert.deepEqual(s.consumed.get(`live:${scope.agentId}:user:trading:${MON}`), { consumed: 2n, returned: 4n });
    assert.deepEqual([(await bal(scope, 'trading')).balance, (await bal(scope, 'trading')).held], [600n, 0n]);
    assert.equal((await bal(scope, 'trading', MON)).balance, 8n);
    assert.equal((await bal(scope, 'trading', WETH)).balance, 3n);
    const dup = await db.tx((c) => settle(c, key, { journal, now: later(1000) }));
    assert.deepEqual([dup.journalId, dup.duplicate], [s.journalId, true]);
    const conflicting = { ...journal, postings: swapPostings(scope, { assetIn: USD, amountIn: 400n, assetOut: WETH, amountOut: 4n, gasAsset: MON, gasUsed: 2n }) };
    assert.equal((await db.tx((c) => settle(c, key, { journal: conflicting, now }))).outcome, 'conflict');
    assert.equal((await bal(scope, 'trading', WETH)).balance, 3n);
    assert.equal(await code(() => db.tx((c) => reserve(c, {
      operationKey: 'after-freeze', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(1000),
      holds: [{ account: user(scope, 'trading', USD), amount: 1n }],
    }))), 'RECONCILIATION_REQUIRED');
  });

  test('settlement cannot spend beyond its hold or from a bucket it did not reserve', async () => {
    const scope = await funded({ trading: 100n, api: 50n });
    await db.tx(async (c) => {
      await reserve(c, { operationKey: 'model-1', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'modelCall', now, expiresAt: later(1000), holds: [{ account: user(scope, 'api', USD), amount: 10n }] });
      await markDispatched(c, 'model-1', now);
    });
    assert.equal(await code(() => db.tx((c) => settle(c, 'model-1', { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'api', USD, 11n), occurredAt: now }, now }))), 'INSUFFICIENT_BUDGET');
    assert.equal(await code(() => db.tx((c) => settle(c, 'model-1', { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'hosting', USD, 1n), occurredAt: now }, now }))), 'INSUFFICIENT_BUDGET');
    await db.tx((c) => settle(c, 'model-1', { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'api', USD, 7n), occurredAt: now }, now }));
    assert.deepEqual([(await bal(scope, 'api')).balance, (await bal(scope, 'api')).held, (await bal(scope, 'trading')).balance], [43n, 0n, 100n]);
  });

  test('undispatched holds expire; dispatched ones never expire and reconcile instead', async () => {
    const scope = await funded({ trading: 100n });
    const hold = (k: string) => ({ operationKey: k, mode: 'live' as const, tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade' as const, now, expiresAt: later(1000), holds: [{ account: user(scope, 'trading', USD), amount: 30n }] });
    await db.tx((c) => reserve(c, hold('a')));
    await db.tx(async (c) => {
      await reserve(c, hold('b'));
      await markDispatched(c, 'b', now);
    });
    const expired = await db.tx((c) => expireHeld(c, later(5000)));
    assert.ok(expired.includes('a'));
    assert.ok(!expired.includes('b'));
    assert.equal((await getReservation(db.pool, 'b'))!.state, 'dispatched');
    await db.tx((c) => markReconciling(c, 'b', 'Receipt timeout.'));
    assert.equal((await bal(scope, 'trading')).held, 30n);
    await db.tx((c) => release(c, 'b', later(9000), 'Provider confirmed no transaction.'));
    assert.equal((await bal(scope, 'trading')).held, 0n);
  });

  test('daily counters include pending holds, and a new UTC day does not erase an outstanding hold', async () => {
    const scope = await funded({ trading: 1000n });
    const limits = [{ scopeKey: `agent:${scope.agentId}`, maxActions: 2, maxNotionalUsdMicros: 500n }, { scopeKey: 'platform', maxActions: 1_000_000 }];
    const r = (k: string, at: Date, notional = 100n) => db.tx((c) => reserve(c, {
      operationKey: k, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now: at, expiresAt: new Date(at.getTime() + 3_600_000),
      holds: [{ account: user(scope, 'trading', USD), amount: 10n }], window: { countsAction: true, notionalUsdMicros: notional, limits },
    }));
    const lateNight = new Date('2026-10-12T23:59:00Z');
    await r('w1', lateNight);
    await r('w2', lateNight);
    assert.equal(await code(() => r('w3', lateNight)), 'DAILY_LIMIT_EXCEEDED');
    // Settling w1 after midnight attaches usage to its authorization day.
    await db.tx(async (c) => {
      await markDispatched(c, 'w1', lateNight);
      await settle(c, 'w1', { journal: { kind: 'trade', postings: swapPostings(scope, { assetIn: USD, amountIn: 10n, assetOut: WETH, amountOut: 1n, gasAsset: MON, gasUsed: 0n }), occurredAt: new Date('2026-10-13T00:01:00Z') }, now: new Date('2026-10-13T00:01:00Z') });
    });
    const w = await db.pool.query<{ day: string; pending_actions: number; committed_actions: number }>(
      `select to_char(day, 'YYYY-MM-DD') as day, pending_actions, committed_actions from spend_windows where scope_key = $1 order by day`, [`agent:${scope.agentId}`]);
    assert.deepEqual(w.rows, [{ day: '2026-10-12', pending_actions: 1, committed_actions: 1 }]);
    await r('w4', new Date('2026-10-13T00:02:00Z'));
    assert.equal(await code(() => r('w5', new Date('2026-10-13T00:03:00Z'), 401n)), 'DAILY_LIMIT_EXCEEDED');
    assert.equal((await bal(scope, 'trading')).held, 20n);
  });

  test('allocation conserves funds, needs the expected budget version and never moves reserved funds', async () => {
    const scope = await funded({ trading: 70n, hosting: 10n, api: 20n });
    const sum = async () => (await agentBalances(db.pool, scope)).filter((b) => b.kind === 'user' && b.assetRef === USD).reduce((s, b) => s + b.balance, 0n);
    assert.equal(await sum(), 100n);
    assert.equal(await code(() => db.tx((c) => allocate(c, { scope, assetRef: USD, expectedBudgetVersion: 1, targets: { trading: 60n }, actor: 'test', now }))), 'REVISION_CONFLICT');
    await db.tx((c) => reserve(c, { operationKey: `t:${scope.agentId}`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(1000), holds: [{ account: user(scope, 'trading', USD), amount: 65n }] }));
    assert.equal(await code(() => db.tx((c) => allocate(c, { scope, assetRef: USD, expectedBudgetVersion: 2, targets: { trading: 60n, hosting: 20n }, actor: 'test', now }))), 'INSUFFICIENT_BUDGET');
    const moved = await db.tx((c) => allocate(c, { scope, assetRef: USD, expectedBudgetVersion: 2, targets: { trading: 65n, hosting: 15n }, actor: 'test', now }));
    assert.equal(moved.budgetVersion, 3);
    assert.equal(await sum(), 100n);
    assert.deepEqual([(await bal(scope, 'trading')).balance, (await bal(scope, 'hosting')).balance, (await bal(scope, 'unallocated')).balance], [65n, 15n, 0n]);
    assert.equal(await code(() => db.tx((c) => allocate(c, { scope, assetRef: USD, expectedBudgetVersion: 3, targets: { api: 21n }, actor: 'test', now }))), 'INSUFFICIENT_BUDGET');
  });

  test('withdrawal conflicts with a pending trade: reserved funds are unavailable', async () => {
    const scope = await funded({ trading: 100n, mon: 4n });
    await db.tx((c) => reserve(c, { operationKey: 'pending-trade', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(1000), holds: [{ account: user(scope, 'trading', USD), amount: 80n }] }));
    const withdraw = (amount: bigint) => db.tx((c) => reserve(c, {
      operationKey: `withdraw:${amount}`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'withdrawal', now, expiresAt: later(1000),
      holds: [{ account: user(scope, 'trading', USD), amount }, { account: user(scope, 'trading', MON), amount: 1n }],
    }));
    assert.equal(await code(() => withdraw(21n)), 'INSUFFICIENT_BUDGET');
    await withdraw(20n);
    await db.tx(async (c) => {
      await markDispatched(c, 'withdraw:20', now);
      await settle(c, 'withdraw:20', { journal: { kind: 'withdrawal', postings: withdrawalPostings(scope, USD, 20n, MON, 1n), occurredAt: now }, now });
    });
    assert.deepEqual([(await bal(scope, 'trading')).balance, (await bal(scope, 'trading')).held], [80n, 80n]);
  });

  test('a treasury sweep of earned revenue preserves customer liabilities and reconciliation; a mismatch freezes outflows', async () => {
    const scope = await funded({ trading: 70n, api: 30n });
    await db.tx(async (c) => {
      await reserve(c, { operationKey: 'charge', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'modelCall', now, expiresAt: later(1000), holds: [{ account: user(scope, 'api', USD), amount: 5n }] });
      await markDispatched(c, 'charge', now);
      await settle(c, 'charge', { journal: { kind: 'serviceCharge', postings: serviceChargePostings(scope, 'api', USD, 5n), occurredAt: now }, now });
    });
    const before = await reconcileWallet(db.pool, { ...scope, assetRef: USD, onChainAtomic: 100n, unpostedInboundAtomic: 0n, unpostedOutboundAtomic: 0n, observationKey: 'b1', now });
    assert.deepEqual([before.ok, before.liabilitiesAtomic, before.unsweptRevenueAtomic], [true, 95n, 5n]);
    await db.tx((c) => postJournal(c, { operationKey: `sweep:${scope.agentId}:1`, mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'sweep', postings: sweepPostings(scope, USD, 5n), occurredAt: now }));
    const swept = await reconcileWallet(db.pool, { ...scope, assetRef: USD, onChainAtomic: 95n, unpostedInboundAtomic: 0n, unpostedOutboundAtomic: 0n, observationKey: 'b2', now });
    assert.deepEqual([swept.ok, swept.liabilitiesAtomic, swept.unsweptRevenueAtomic, swept.recordedWalletAtomic], [true, 95n, 0n, 95n]);
    // Sweeping more than earned would cut into customer liabilities: reconciliation flags it.
    const deficit = await db.tx((c) => reconcileWallet(c, { ...scope, assetRef: USD, onChainAtomic: 94n, unpostedInboundAtomic: 0n, unpostedOutboundAtomic: 0n, observationKey: 'b3', now }));
    assert.equal(deficit.ok, false);
    assert.equal(deficit.chainDifference, -1n);
    assert.equal(await code(() => db.tx((c) => reserve(c, { operationKey: 'blocked', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(1000), holds: [{ account: user(scope, 'trading', USD), amount: 1n }] }))), 'RECONCILIATION_REQUIRED');
    // Paper outflows of the same agent are not frozen by a live discrepancy.
    await db.tx(async (c) => {
      const paper = { ...scope, mode: 'paper' as const };
      await postJournal(c, { operationKey: `paper-dep:${scope.agentId}`, mode: 'paper', tenantId: scope.tenantId, agentId: scope.agentId, kind: 'deposit', postings: [...depositPostings(paper, USD, 5n)], occurredAt: now });
    });
    await db.tx((c) => clearFreeze(c, deficit.freezeId!, 'Investigated: test discrepancy.', now));
    await db.tx((c) => reserve(c, { operationKey: 'unblocked', mode: 'live', tenantId: scope.tenantId, agentId: scope.agentId, purpose: 'trade', now, expiresAt: later(1000), holds: [{ account: user(scope, 'trading', USD), amount: 1n }] }));
  });
});
