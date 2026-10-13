// Conserved budget allocation (ACC-3; funds-and-budgets.md section 3). A user command against an expected budget
// version: one short transaction locks the agent row and the bucket accounts in canonical order, checks that no
// reserved amount moves, transfers liabilities, bumps the version and records the allocation. Committed charges
// and in-flight reservations are untouched; trading funds move only by this explicit command.
import { accountKey, lockAccounts, user } from './accounts.ts';
import type { AgentScope, Bucket, Sql } from './accounts.ts';
import { AccountingError, invalid } from './errors.ts';
import { postJournal } from './ledger.ts';
import type { PostingInput } from './ledger.ts';

export type Targets = Readonly<Partial<Record<Exclude<Bucket, 'unallocated'>, bigint>>>;

export interface AllocateInput {
  readonly scope: AgentScope;
  readonly assetRef: string;
  readonly expectedBudgetVersion: number;
  /** Desired total balance per bucket; omitted buckets keep their balance. Unallocated absorbs the difference. */
  readonly targets: Targets;
  readonly actor: string;
  readonly now: Date;
}

export interface Allocated {
  readonly budgetVersion: number;
  readonly journalId: string | undefined;
  readonly balances: Readonly<Record<Bucket, bigint>>;
}

export async function allocate(c: Sql, input: AllocateInput): Promise<Allocated> {
  const { scope, assetRef } = input;
  const agent = await c.query<{ budget_version: number }>('select budget_version from agents where tenant_id = $1 and id = $2 for update', [scope.tenantId, scope.agentId]);
  const current = agent.rows[0];
  if (!current) throw new AccountingError('NOT_FOUND', 'Agent not found.');
  if (current.budget_version !== input.expectedBudgetVersion) {
    throw new AccountingError('REVISION_CONFLICT', 'The budget changed since you loaded it.', { budgetVersion: String(current.budget_version) });
  }
  const buckets: Bucket[] = ['unallocated', 'hosting', 'api', 'trading'];
  const accounts = await lockAccounts(c, buckets.map((b) => user(scope, b, assetRef)));
  const row = (b: Bucket) => accounts.get(accountKey(user(scope, b, assetRef)))!;

  const postings: PostingInput[] = [];
  let unallocatedChange = 0n;
  // Decreases post before increases: postings apply in order and the unallocated pool must never dip below zero
  // midway through a transfer whose final totals balance.
  const ordered = (Object.entries(input.targets) as [Exclude<Bucket, 'unallocated'>, bigint][])
    .sort(([a, ta], [b, tb]) => Number((ta - row(a).balance) - (tb - row(b).balance)));
  for (const [bucket, target] of ordered) {
    if (target < 0n) invalid('Bucket targets are non-negative.');
    const r = row(bucket);
    const delta = target - r.balance;
    if (delta === 0n) continue;
    if (delta < 0n && r.balance - r.held < -delta) {
      throw new AccountingError('INSUFFICIENT_BUDGET', `Reserved ${bucket} funds cannot be reallocated.`, { bucket });
    }
    const account = user(scope, bucket, assetRef);
    const pool = user(scope, 'unallocated', assetRef);
    if (delta > 0n) postings.push({ account: pool, side: 'debit', amount: delta }, { account, side: 'credit', amount: delta });
    else postings.push({ account, side: 'debit', amount: -delta }, { account: pool, side: 'credit', amount: -delta });
    unallocatedChange -= delta;
  }
  const pool = row('unallocated');
  if (pool.balance - pool.held + unallocatedChange < 0n) {
    throw new AccountingError('INSUFFICIENT_BUDGET', 'The allocation needs more unallocated funds than are available.');
  }
  const balances = Object.fromEntries(buckets.map((b) => [b, row(b).balance])) as Record<Bucket, bigint>;
  if (!postings.length) return { budgetVersion: current.budget_version, journalId: undefined, balances };

  const next = current.budget_version + 1;
  const posted = await postJournal(c, {
    operationKey: `allocation:${scope.mode}:${scope.agentId}:${next}`, mode: scope.mode, tenantId: scope.tenantId, agentId: scope.agentId,
    kind: 'allocation', postings, occurredAt: input.now,
  });
  await c.query('update agents set budget_version = $3 where tenant_id = $1 and id = $2', [scope.tenantId, scope.agentId, next]);
  await c.query(
    `insert into allocations (tenant_id, agent_id, mode, budget_version, asset_ref, journal_id, actor, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [scope.tenantId, scope.agentId, scope.mode, next, assetRef, posted.journalId, input.actor.slice(0, 200), input.now],
  );
  for (const [bucket, target] of Object.entries(input.targets) as [Bucket, bigint][]) balances[bucket] = target;
  balances.unallocated = pool.balance + unallocatedChange;
  return { budgetVersion: next, journalId: posted.journalId, balances };
}
