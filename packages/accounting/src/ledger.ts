// Balanced immutable journals (ACC-1). One operation key is one financial effect: a retry with the same body
// returns the original journal, a different body is an idempotency conflict. The database re-checks balance per
// asset at commit (journals_balanced) and moves balances in the posting trigger; this module checks first so a
// caller gets a clear error instead of a failed commit.
import { contentHash } from '@monad-hack/contracts';
import { accountKey, lockAccounts, normalSide } from './accounts.ts';
import type { AccountRef, Mode, Side, Sql } from './accounts.ts';
import { AccountingError, invalid } from './errors.ts';
import { uuidv7 } from './ids.ts';

export type JournalKind = 'deposit' | 'allocation' | 'trade' | 'gas' | 'serviceCharge' | 'sweep' | 'withdrawal' | 'refund' | 'reversal' | 'platformAbsorb';

export interface PostingInput {
  readonly account: AccountRef;
  readonly side: Side;
  readonly amount: bigint;
}

export interface JournalInput {
  readonly operationKey: string;
  readonly mode: Mode;
  readonly tenantId?: string;
  readonly agentId?: string;
  readonly kind: JournalKind;
  readonly memo?: string;
  readonly reversesJournalId?: string;
  readonly postings: readonly PostingInput[];
  readonly occurredAt: Date;
}

export interface Posted {
  readonly journalId: string;
  readonly duplicate: boolean;
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** Throws INVALID unless every asset's debits equal its credits and every amount is a positive uint256. */
export function assertBalanced(postings: readonly PostingInput[], mode: Mode): void {
  if (postings.length < 2 || postings.length > 64) invalid('A journal needs between 2 and 64 postings.');
  const net = new Map<string, bigint>();
  for (const p of postings) {
    if (p.amount <= 0n || p.amount > MAX_UINT256) invalid('Posting amounts are positive atomic integers.');
    if (p.account.mode !== mode) invalid('Paper and live accounts never share a journal.');
    net.set(p.account.assetRef, (net.get(p.account.assetRef) ?? 0n) + (p.side === 'debit' ? p.amount : -p.amount));
  }
  for (const [asset, value] of net) if (value !== 0n) invalid(`Journal is unbalanced in ${asset}.`);
}

/** Hash of everything that defines the effect; the clock is excluded so a retry later is still a duplicate. */
export async function journalHash(input: JournalInput): Promise<string> {
  return contentHash({
    operationKey: input.operationKey, mode: input.mode, tenantId: input.tenantId ?? null, agentId: input.agentId ?? null,
    kind: input.kind, reverses: input.reversesJournalId ?? null,
    postings: input.postings.map((p) => ({ account: accountKey(p.account), side: p.side, amount: p.amount.toString() })),
  });
}

async function existing(c: Sql, operationKey: string, hash: string): Promise<Posted | undefined> {
  const found = await c.query<{ id: string; request_hash: string }>('select id, request_hash from journals where operation_key = $1', [operationKey]);
  const row = found.rows[0];
  if (!row) return undefined;
  if (row.request_hash !== hash) throw new AccountingError('IDEMPOTENCY_CONFLICT', 'This financial operation was already posted with different amounts.', { operationKey });
  return { journalId: row.id, duplicate: true };
}

/**
 * Post a balanced journal inside the caller's transaction. Accounts are created as needed and locked in
 * canonical order. A posting that would overdraw an account or its holds fails the transaction.
 */
export async function postJournal(c: Sql, input: JournalInput): Promise<Posted> {
  assertBalanced(input.postings, input.mode);
  if (input.operationKey.length < 1 || input.operationKey.length > 300) invalid('Operation keys are 1–300 characters.');
  const hash = await journalHash(input);
  const prior = await existing(c, input.operationKey, hash);
  if (prior) return prior;
  const accounts = await lockAccounts(c, input.postings.map((p) => p.account));
  // Re-check under the lock: a concurrent duplicate may have committed while this transaction waited.
  const raced = await existing(c, input.operationKey, hash);
  if (raced) return raced;
  // Fail with a clear reason before the row check fires: decreases may not cut into available.
  const delta = new Map<string, bigint>();
  for (const p of input.postings) {
    const key = accountKey(p.account);
    delta.set(key, (delta.get(key) ?? 0n) + (p.side === normalSide(p.account) ? p.amount : -p.amount));
  }
  for (const [key, change] of delta) {
    const row = accounts.get(key)!;
    if (row.balance + change < row.held) {
      throw new AccountingError('INSUFFICIENT_BUDGET', 'The account does not have enough unreserved balance.', { account: key });
    }
  }
  const id = uuidv7(input.occurredAt.getTime());
  const inserted = await c.query(
    `insert into journals (id, operation_key, request_hash, mode, tenant_id, agent_id, kind, reverses_journal_id, memo, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (operation_key) do nothing`,
    [id, input.operationKey, hash, input.mode, input.tenantId ?? null, input.agentId ?? null, input.kind, input.reversesJournalId ?? null, input.memo ?? null, input.occurredAt],
  );
  if (inserted.rowCount === 0) return (await existing(c, input.operationKey, hash))!;
  let seq = 0;
  for (const p of input.postings) {
    await c.query('insert into postings (journal_id, seq, account_id, asset_ref, side, amount) values ($1, $2, $3, $4, $5, $6)', [
      id, seq++, accounts.get(accountKey(p.account))!.id, p.account.assetRef, p.side, p.amount.toString(),
    ]);
  }
  return { journalId: id, duplicate: false };
}

/** Reverse a posted journal with mirrored postings; the original stays. One reversal per journal. */
export async function reverseJournal(c: Sql, journalId: string, operationKey: string, occurredAt: Date, memo?: string): Promise<Posted> {
  const j = await c.query<{ mode: Mode; tenant_id: string | null; agent_id: string | null }>('select mode, tenant_id, agent_id from journals where id = $1', [journalId]);
  const row = j.rows[0];
  if (!row) throw new AccountingError('NOT_FOUND', 'Journal not found.');
  const p = await c.query<{ account_key: string; side: Side; amount: string }>(
    `select a.account_key, p.side, p.amount from postings p join ledger_accounts a on a.id = p.account_id where p.journal_id = $1 order by p.seq`,
    [journalId],
  );
  const postings = p.rows.map((r) => ({ account: refFromKey(r.account_key, row.tenant_id), side: (r.side === 'debit' ? 'credit' : 'debit') as Side, amount: BigInt(r.amount) }));
  return postJournal(c, {
    operationKey, mode: row.mode, kind: 'reversal', reversesJournalId: journalId, postings, occurredAt,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}), ...(row.agent_id ? { agentId: row.agent_id } : {}), ...(memo ? { memo } : {}),
  });
}

/** Parse a canonical account key back to its reference (the inverse of accountKey). */
export function refFromKey(key: string, tenantId: string | null): AccountRef {
  const parts = key.split(':');
  const mode = parts[0] as Mode;
  if (parts[1] === 'platform') {
    const assetRef = parts.slice(3).join(':');
    return parts[2] === 'treasury' ? { kind: 'treasury', mode, assetRef } : { kind: 'platformExpense', mode, assetRef };
  }
  if (!tenantId) invalid('Agent accounts need a tenant.');
  const scope = { mode, tenantId: tenantId!, agentId: parts[1]! };
  if (parts[2] === 'wallet') return { kind: 'wallet', ...scope, assetRef: parts.slice(3).join(':') };
  if (parts[2] === 'user') return { kind: 'user', ...scope, bucket: parts[3] as 'trading', assetRef: parts.slice(4).join(':') };
  return { kind: 'revenue', ...scope, line: parts[3] as 'api', assetRef: parts.slice(4).join(':') };
}
