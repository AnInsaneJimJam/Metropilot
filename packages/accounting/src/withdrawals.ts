// Withdrawal ledger operations (ACC-5; funds-and-budgets.md section 7). A withdrawal reserves the amount and a
// gas ceiling through the same reservation path as trades, so funds held by a pending trade are unavailable.
// It is a typed operation executed by the transaction gateway; no strategy action can create one, and it does
// not need a healthy runtime or an active deployment.
import type { Sql } from './accounts.ts';
import { user } from './accounts.ts';
import { AccountingError } from './errors.ts';
import { uuidv7 } from './ids.ts';
import { gasPostings, withdrawalPostings } from './operations.ts';
import { markDispatched, markReconciling, release, reserve, settle } from './reservations.ts';

export type WithdrawalState = 'reserved' | 'submitted' | 'finalized' | 'failed' | 'reconciling' | 'cancelled';

export interface WithdrawalInput {
  readonly tenantId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly walletId: string;
  readonly destinationId: string;
  readonly assetRef: string;
  readonly amount: bigint;
  readonly gasAssetRef: string;
  readonly gasCeiling: bigint;
  readonly stepUpId: string;
  readonly now: Date;
}

export interface WithdrawalRow {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly destinationId: string;
  readonly assetRef: string;
  readonly amount: bigint;
  readonly gasAssetRef: string;
  readonly gasCeiling: bigint;
  readonly state: WithdrawalState;
  readonly reservationKey: string;
  readonly txHash: string | undefined;
  readonly gasUsed: bigint | undefined;
  readonly failureReason: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type Row = {
  id: string; tenant_id: string; agent_id: string; wallet_id: string; destination_id: string; asset_ref: string; amount: string; gas_asset_ref: string; gas_ceiling: string;
  state: WithdrawalState; reservation_key: string; tx_hash: string | null; gas_used: string | null; failure_reason: string | null; request_hash: string; created_at: Date; updated_at: Date;
};

const toRow = (r: Row): WithdrawalRow => ({
  id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, walletId: r.wallet_id, destinationId: r.destination_id, assetRef: r.asset_ref, amount: BigInt(r.amount),
  gasAssetRef: r.gas_asset_ref, gasCeiling: BigInt(r.gas_ceiling), state: r.state, reservationKey: r.reservation_key, txHash: r.tx_hash ?? undefined,
  gasUsed: r.gas_used === null ? undefined : BigInt(r.gas_used), failureReason: r.failure_reason ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function withdrawalById(c: Sql, tenantId: string, id: string, lock = false): Promise<WithdrawalRow | undefined> {
  const r = await c.query<Row>(`select * from withdrawals where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`, [tenantId, id]);
  return r.rows[0] ? toRow(r.rows[0]) : undefined;
}

/** Reserve amount plus gas and record the withdrawal; the same idempotency key and body returns the original. */
export async function requestWithdrawal(c: Sql, input: WithdrawalInput): Promise<{ withdrawal: WithdrawalRow; duplicate: boolean }> {
  const prior = await c.query<Row>('select * from withdrawals where tenant_id = $1 and idempotency_key = $2', [input.tenantId, input.idempotencyKey]);
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== input.requestHash) throw new AccountingError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different withdrawal.');
    return { withdrawal: toRow(prior.rows[0]), duplicate: true };
  }
  const scope = { mode: 'live' as const, tenantId: input.tenantId, agentId: input.agentId };
  const id = uuidv7(input.now.getTime());
  const key = `withdrawal:${id}`;
  const holds = input.assetRef === input.gasAssetRef
    ? [{ account: user(scope, 'trading', input.assetRef), amount: input.amount + input.gasCeiling }]
    : [{ account: user(scope, 'trading', input.assetRef), amount: input.amount }, { account: user(scope, 'trading', input.gasAssetRef), amount: input.gasCeiling }];
  await reserve(c, { operationKey: key, ...scope, purpose: 'withdrawal', holds, now: input.now, expiresAt: new Date(input.now.getTime() + 15 * 60_000) });
  const inserted = await c.query<Row>(
    `insert into withdrawals (tenant_id, id, agent_id, idempotency_key, request_hash, wallet_id, destination_id, asset_ref, amount, gas_asset_ref, gas_ceiling,
       step_up_id, reservation_key, state, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'reserved', $14, $14) returning *`,
    [input.tenantId, id, input.agentId, input.idempotencyKey, input.requestHash, input.walletId, input.destinationId, input.assetRef, input.amount.toString(),
      input.gasAssetRef, input.gasCeiling.toString(), input.stepUpId, key, input.now],
  );
  return { withdrawal: toRow(inserted.rows[0]!), duplicate: false };
}

async function setState(c: Sql, w: WithdrawalRow, state: WithdrawalState, now: Date, extra: { txHash?: string; gasUsed?: bigint; failureReason?: string } = {}): Promise<WithdrawalRow> {
  const r = await c.query<Row>(
    `update withdrawals set state = $3, tx_hash = coalesce($4, tx_hash), gas_used = coalesce($5, gas_used), failure_reason = coalesce($6, failure_reason), updated_at = $7
     where tenant_id = $1 and id = $2 returning *`,
    [w.tenantId, w.id, state, extra.txHash ?? null, extra.gasUsed?.toString() ?? null, extra.failureReason ?? null, now]);
  return toRow(r.rows[0]!);
}

/** Before the provider call: the hold can no longer expire. Returns undefined when it is not ready to send. */
export async function claimWithdrawalForDispatch(c: Sql, tenantId: string, id: string, now: Date): Promise<WithdrawalRow | undefined> {
  const w = await withdrawalById(c, tenantId, id, true);
  if (!w || w.state !== 'reserved') return undefined;
  await markDispatched(c, w.reservationKey, now);
  return w;
}

export async function recordWithdrawalSubmitted(c: Sql, tenantId: string, id: string, txHash: string, now: Date): Promise<WithdrawalRow> {
  const w = (await withdrawalById(c, tenantId, id, true))!;
  if (w.state === 'submitted' && w.txHash === txHash.toLowerCase()) return w;
  if (w.state !== 'reserved' && w.state !== 'reconciling') throw new AccountingError('STATE_CONFLICT', `A ${w.state} withdrawal cannot be submitted.`);
  return setState(c, w, 'submitted', now, { txHash: txHash.toLowerCase() });
}

/** Provider timeout or missing receipt after send: keep every hold and reconcile, never resend a new transfer. */
export async function markWithdrawalReconciling(c: Sql, tenantId: string, id: string, reason: string, now: Date): Promise<WithdrawalRow> {
  const w = (await withdrawalById(c, tenantId, id, true))!;
  if (w.state === 'reconciling') return w;
  await markReconciling(c, w.reservationKey, reason);
  return setState(c, w, 'reconciling', now, { failureReason: reason.slice(0, 300) });
}

/** A finalized receipt: success posts amount plus actual gas; a revert charges gas only and releases the rest. */
export async function finalizeWithdrawal(c: Sql, tenantId: string, id: string, receipt: { succeeded: boolean; gasUsed: bigint; txHash: string }, now: Date): Promise<WithdrawalRow> {
  const w = (await withdrawalById(c, tenantId, id, true))!;
  if (w.state === 'finalized' || w.state === 'failed') return w;
  if (receipt.gasUsed > w.gasCeiling) throw new AccountingError('RECONCILIATION_REQUIRED', 'Gas used exceeds the reserved ceiling.');
  const scope = { mode: 'live' as const, tenantId, agentId: w.agentId };
  if (receipt.succeeded) {
    await settle(c, w.reservationKey, { journal: { kind: 'withdrawal', postings: withdrawalPostings(scope, w.assetRef, w.amount, w.gasAssetRef, receipt.gasUsed), occurredAt: now }, now });
    return setState(c, w, 'finalized', now, { txHash: receipt.txHash.toLowerCase(), gasUsed: receipt.gasUsed });
  }
  if (receipt.gasUsed > 0n) await settle(c, w.reservationKey, { journal: { kind: 'gas', postings: gasPostings(scope, w.gasAssetRef, receipt.gasUsed), occurredAt: now }, now });
  else await release(c, w.reservationKey, now, 'Withdrawal reverted without gas.');
  return setState(c, w, 'failed', now, { txHash: receipt.txHash.toLowerCase(), gasUsed: receipt.gasUsed, failureReason: 'The withdrawal transaction reverted.' });
}

/** Provider refused before broadcast (definitively not sent): release everything. */
export async function failWithdrawalBeforeSend(c: Sql, tenantId: string, id: string, reason: string, now: Date): Promise<WithdrawalRow> {
  const w = (await withdrawalById(c, tenantId, id, true))!;
  if (w.state === 'failed' || w.state === 'cancelled') return w;
  if (w.txHash) throw new AccountingError('STATE_CONFLICT', 'A broadcast withdrawal reconciles from its receipt.');
  await release(c, w.reservationKey, now, reason);
  return setState(c, w, 'failed', now, { failureReason: reason.slice(0, 300) });
}

export async function openWithdrawals(c: Sql, limit = 50): Promise<WithdrawalRow[]> {
  const r = await c.query<Row>(`select * from withdrawals where state in ('reserved', 'submitted', 'reconciling') order by updated_at limit $1`, [limit]);
  return r.rows.map(toRow);
}
