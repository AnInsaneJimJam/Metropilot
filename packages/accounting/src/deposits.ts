// Deposit records and finalized credit (ACC-5; funds-and-budgets.md section 3). First observation creates a
// pending, unspendable record. Credit posts once, only after the receipt succeeded, the block is canonical and
// finalized, the token is the accepted asset and the destination maps to an agent wallet. A unique event key
// (chain, tx, log index) absorbs webhook and backfill duplicates. A finalized key reported with a different
// block freezes the agent's outflows instead of posting.
import type { Mode, Sql } from './accounts.ts';
import { AccountingError } from './errors.ts';
import { freeze } from './freezes.ts';
import { uuidv7 } from './ids.ts';
import { postJournal } from './ledger.ts';
import { depositPostings } from './operations.ts';

export interface AcceptedAsset {
  readonly chainId: number;
  /** Lower-case token contract address. */
  readonly tokenAddress: string;
  readonly assetRef: string;
  readonly decimals: number;
}

export interface TransferObservation {
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenAddress: string;
  readonly sender: string;
  readonly destination: string;
  readonly amount: bigint;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly observedAt: Date;
}

export type DepositState = 'pending' | 'finalized' | 'quarantined' | 'abandoned';

export interface DepositRecord {
  readonly id: string;
  readonly state: DepositState;
  readonly agentId: string | undefined;
  readonly assetRef: string | undefined;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly logIndex: number;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Record a transfer into a mapped wallet as pending; an unaccepted token is quarantined at once. Returns
 * undefined for a transfer to an address we do not custody. Re-observation with a new block (a reorg before
 * finality) updates the pending coordinates; it never credits.
 */
export async function observeDeposit(c: Sql, t: TransferObservation, accepted: readonly AcceptedAsset[]): Promise<DepositRecord | undefined> {
  const w = await c.query<{ tenant_id: string; agent_id: string }>(`select tenant_id, agent_id from wallets where chain_id = $1 and address = $2 and status = 'active'`, [t.chainId, lower(t.destination)]);
  const owner = w.rows[0];
  if (!owner) return undefined;
  const asset = accepted.find((a) => a.chainId === t.chainId && lower(a.tokenAddress) === lower(t.tokenAddress));
  if (t.amount <= 0n) return undefined;
  await c.query(
    `insert into deposits (id, chain_id, tx_hash, log_index, token_address, asset_ref, sender, destination, tenant_id, agent_id, amount, block_hash, block_number, state, reason, first_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) on conflict (chain_id, tx_hash, log_index) do nothing`,
    [uuidv7(t.observedAt.getTime()), t.chainId, lower(t.txHash), t.logIndex, lower(t.tokenAddress), asset?.assetRef ?? null, lower(t.sender), lower(t.destination),
      owner.tenant_id, owner.agent_id, t.amount.toString(), lower(t.blockHash), t.blockNumber.toString(), asset ? 'pending' : 'quarantined',
      asset ? null : 'Unsupported token: held for manual recovery, never credited.', t.observedAt],
  );
  // An uncredited record takes every field from the newest canonical observation: after a reorg the same event key
  // can carry another amount, token or destination, and a transfer abandoned on a discarded block can be re-included.
  // Finalized records never change (finalizeDeposit compares them instead).
  await c.query(
    `update deposits set token_address = $4, asset_ref = $5, sender = $6, destination = $7, tenant_id = $8, agent_id = $9, amount = $10,
       block_hash = $11, block_number = $12, state = $13, reason = $14, resolved_at = null
     where chain_id = $1 and tx_hash = $2 and log_index = $3 and state in ('pending', 'abandoned', 'quarantined')
       and (block_hash <> $11 or amount <> $10 or token_address <> $4 or destination <> $7 or state = 'abandoned')`,
    [t.chainId, lower(t.txHash), t.logIndex, lower(t.tokenAddress), asset?.assetRef ?? null, lower(t.sender), lower(t.destination), owner.tenant_id, owner.agent_id,
      t.amount.toString(), lower(t.blockHash), t.blockNumber.toString(), asset ? 'pending' : 'quarantined', asset ? null : 'Unsupported token: held for manual recovery, never credited.']);
  return depositByKey(c, t.chainId, t.txHash, t.logIndex);
}

export async function depositByKey(c: Sql, chainId: number, txHash: string, logIndex: number): Promise<DepositRecord | undefined> {
  const r = await c.query<{ id: string; state: DepositState; agent_id: string | null; asset_ref: string | null; amount: string; block_number: string; tx_hash: string; log_index: number }>(
    'select id, state, agent_id, asset_ref, amount, block_number, tx_hash, log_index from deposits where chain_id = $1 and tx_hash = $2 and log_index = $3',
    [chainId, lower(txHash), logIndex]);
  const row = r.rows[0];
  return row ? {
    id: row.id, state: row.state, agentId: row.agent_id ?? undefined, assetRef: row.asset_ref ?? undefined, amount: BigInt(row.amount),
    blockNumber: BigInt(row.block_number), txHash: row.tx_hash, logIndex: row.log_index,
  } : undefined;
}

export interface FinalityEvidence {
  /** The receipt succeeded and still contains this exact transfer log. */
  readonly receiptSucceeded: boolean;
  /** Canonical block hash at the deposit's height, read at or below the finalized head. */
  readonly canonicalBlockHash: string | undefined;
  readonly finalizedHeight: bigint;
  readonly at: Date;
}

export type FinalizeOutcome = 'credited' | 'alreadyCredited' | 'stillPending' | 'abandoned' | 'quarantined' | 'conflict';

/** Credit a pending deposit once, from finalized canonical evidence only. */
export async function finalizeDeposit(c: Sql, chainId: number, txHash: string, logIndex: number, evidence: FinalityEvidence): Promise<FinalizeOutcome> {
  const r = await c.query<{ id: string; state: DepositState; tenant_id: string; agent_id: string; asset_ref: string | null; amount: string; block_hash: string; block_number: string }>(
    'select id, state, tenant_id, agent_id, asset_ref, amount, block_hash, block_number from deposits where chain_id = $1 and tx_hash = $2 and log_index = $3 for update',
    [chainId, lower(txHash), logIndex]);
  const d = r.rows[0];
  if (!d) throw new AccountingError('NOT_FOUND', 'No deposit with this event key.');
  const mode: Mode = 'live';
  const height = BigInt(d.block_number);
  const canonical = evidence.canonicalBlockHash?.toLowerCase();
  if (d.state === 'quarantined') return 'quarantined';
  if (d.state === 'abandoned') return 'abandoned';
  if (d.state === 'finalized') {
    if (canonical !== undefined && height <= evidence.finalizedHeight && canonical !== d.block_hash) {
      await freeze(c, { mode, tenantId: d.tenant_id, agentId: d.agent_id, reasonCode: 'CANONICAL_CONFLICT', detail: { txHash: lower(txHash), logIndex: String(logIndex) },
        sourceKey: `deposit-conflict:${chainId}:${lower(txHash)}:${logIndex}`, now: evidence.at });
      return 'conflict';
    }
    return 'alreadyCredited';
  }
  if (height > evidence.finalizedHeight) return 'stillPending';
  if (!evidence.receiptSucceeded || canonical === undefined || canonical !== d.block_hash) {
    // Not in the canonical finalized chain at its recorded block: the speculative deposit is abandoned, never credited.
    await c.query(`update deposits set state = 'abandoned', reason = 'Not in the finalized canonical chain.', resolved_at = $2 where id = $1`, [d.id, evidence.at]);
    return 'abandoned';
  }
  const scope = { mode, tenantId: d.tenant_id, agentId: d.agent_id };
  const posted = await postJournal(c, {
    operationKey: `deposit:${chainId}:${lower(txHash)}:${logIndex}`, mode, tenantId: d.tenant_id, agentId: d.agent_id, kind: 'deposit',
    postings: depositPostings(scope, d.asset_ref!, BigInt(d.amount)), occurredAt: evidence.at,
  });
  await c.query(`update deposits set state = 'finalized', journal_id = $2, resolved_at = $3 where id = $1`, [d.id, posted.journalId, evidence.at]);
  return 'credited';
}

/** Pending deposits of an agent (shown as pending, never spendable). */
export async function pendingDeposits(c: Sql, tenantId: string, agentId: string): Promise<DepositRecord[]> {
  const r = await c.query<{ id: string; state: DepositState; agent_id: string; asset_ref: string | null; amount: string; block_number: string; tx_hash: string; log_index: number }>(
    `select id, state, agent_id, asset_ref, amount, block_number, tx_hash, log_index from deposits where tenant_id = $1 and agent_id = $2 and state in ('pending', 'quarantined') order by first_seen_at`,
    [tenantId, agentId]);
  return r.rows.map((row) => ({ id: row.id, state: row.state, agentId: row.agent_id, assetRef: row.asset_ref ?? undefined, amount: BigInt(row.amount), blockNumber: BigInt(row.block_number), txHash: row.tx_hash, logIndex: row.log_index }));
}
