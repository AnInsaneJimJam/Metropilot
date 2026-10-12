// Reconciliation freezes and checks (ACC-6; funds-and-budgets.md section 2). An unexplained difference between
// on-chain assets, recorded wallet assets and customer liabilities freezes new outflows for the agent until an
// operator clears it with a reason. Freezes never block inflows, reads or reconciliation of pending effects.
import type { Mode, Sql } from './accounts.ts';
import { AccountingError } from './errors.ts';
import { uuidv7 } from './ids.ts';

export interface FreezeInput {
  readonly mode: Mode;
  /** Absent tenant: a platform-wide freeze. Absent agent: every agent of the tenant. */
  readonly tenantId?: string;
  readonly agentId?: string;
  readonly reasonCode: string;
  readonly detail: Record<string, string>;
  /** Same discrepancy detected again is the same freeze. */
  readonly sourceKey: string;
  readonly now: Date;
}

export async function freeze(c: Sql, input: FreezeInput): Promise<string> {
  const id = uuidv7(input.now.getTime());
  await c.query(
    `insert into reconciliation_freezes (id, mode, tenant_id, agent_id, reason_code, detail, source_key, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (source_key) do nothing`,
    [id, input.mode, input.tenantId ?? null, input.agentId ?? null, input.reasonCode, input.detail, input.sourceKey, input.now],
  );
  const row = await c.query<{ id: string }>('select id from reconciliation_freezes where source_key = $1', [input.sourceKey]);
  return row.rows[0]!.id;
}

export interface OpenFreeze {
  readonly id: string;
  readonly reasonCode: string;
  readonly createdAt: Date;
}

export async function openFreezes(c: Sql, mode: Mode, tenantId: string, agentId: string): Promise<OpenFreeze[]> {
  const rows = await c.query<{ id: string; reason_code: string; created_at: Date }>(
    `select id, reason_code, created_at from reconciliation_freezes
     where cleared_at is null and mode = $1
       and (tenant_id is null or (tenant_id = $2 and (agent_id is null or agent_id = $3)))
     order by created_at`,
    [mode, tenantId, agentId],
  );
  return rows.rows.map((r) => ({ id: r.id, reasonCode: r.reason_code, createdAt: r.created_at }));
}

export async function assertOutflowsAllowed(c: Sql, mode: Mode, tenantId: string, agentId: string): Promise<void> {
  const open = await openFreezes(c, mode, tenantId, agentId);
  if (open.length) {
    throw new AccountingError('RECONCILIATION_REQUIRED', 'Outflows are frozen until a balance difference is investigated.', { reason: open[0]!.reasonCode });
  }
}

export async function clearFreeze(c: Sql, id: string, reason: string, now: Date): Promise<void> {
  const r = await c.query(`update reconciliation_freezes set cleared_at = $2, cleared_reason = $3 where id = $1 and cleared_at is null`, [id, now, reason.slice(0, 300)]);
  if (r.rowCount === 0) throw new AccountingError('NOT_FOUND', 'No open freeze with this ID.');
}

export interface WalletObservation {
  readonly mode: Mode;
  readonly tenantId: string;
  readonly agentId: string;
  readonly assetRef: string;
  /** Finalized on-chain balance of the agent wallet. */
  readonly onChainAtomic: bigint;
  /** Finalized effects already on chain but not yet posted (e.g. a finalized deposit awaiting credit). */
  readonly unpostedInboundAtomic: bigint;
  readonly unpostedOutboundAtomic: bigint;
  /** Identifies this observation, e.g. the finalized block it was read at. */
  readonly observationKey: string;
  readonly now: Date;
}

export interface ReconcileReport {
  readonly ok: boolean;
  readonly recordedWalletAtomic: bigint;
  readonly liabilitiesAtomic: bigint;
  readonly unsweptRevenueAtomic: bigint;
  /** On-chain minus expected; negative is a deficit. */
  readonly chainDifference: bigint;
  /** Recorded wallet minus (liabilities + unswept revenue); must be zero. */
  readonly ledgerDifference: bigint;
  readonly freezeId: string | undefined;
}

/**
 * Two checks: finalized on-chain assets equal recorded wallet assets adjusted by pending effects, and recorded
 * wallet assets equal customer liabilities plus earned revenue not yet swept. Any difference (deficit or
 * unexplained surplus) freezes new outflows.
 */
export async function reconcileWallet(c: Sql, o: WalletObservation): Promise<ReconcileReport> {
  const sums = await c.query<{ wallet: string; liabilities: string; revenue: string; swept: string }>(
    `select
       coalesce(sum(balance) filter (where holder = 'agentWallet'), 0) as wallet,
       coalesce(sum(balance) filter (where holder = 'user'), 0) as liabilities,
       coalesce(sum(balance) filter (where holder = 'service'), 0) as revenue,
       coalesce((select sum(p.amount) from postings p join journals j on j.id = p.journal_id join ledger_accounts a on a.id = p.account_id
                 where j.kind = 'sweep' and a.holder = 'agentWallet' and a.tenant_id = $1 and a.agent_id = $2 and a.mode = $3 and a.asset_ref = $4
                   and p.side = 'credit'), 0) as swept
     from ledger_accounts where tenant_id = $1 and agent_id = $2 and mode = $3 and asset_ref = $4`,
    [o.tenantId, o.agentId, o.mode, o.assetRef],
  );
  const s = sums.rows[0]!;
  const recordedWallet = BigInt(s.wallet);
  const liabilities = BigInt(s.liabilities);
  const unswept = BigInt(s.revenue) - BigInt(s.swept);
  const chainDifference = o.onChainAtomic - (recordedWallet + o.unpostedInboundAtomic - o.unpostedOutboundAtomic);
  const ledgerDifference = recordedWallet - (liabilities + unswept);
  let freezeId: string | undefined;
  if (chainDifference !== 0n || ledgerDifference !== 0n) {
    freezeId = await freeze(c, {
      mode: o.mode, tenantId: o.tenantId, agentId: o.agentId,
      reasonCode: chainDifference < 0n || ledgerDifference !== 0n ? 'BALANCE_DEFICIT' : 'UNEXPLAINED_SURPLUS',
      detail: { assetRef: o.assetRef, chainDifference: chainDifference.toString(), ledgerDifference: ledgerDifference.toString(), observation: o.observationKey.slice(0, 200) },
      sourceKey: `reconcile:${o.mode}:${o.agentId}:${o.assetRef}:${o.observationKey}`.slice(0, 300), now: o.now,
    });
  }
  return { ok: freezeId === undefined, recordedWalletAtomic: recordedWallet, liabilitiesAtomic: liabilities, unsweptRevenueAtomic: unswept, chainDifference, ledgerDifference, freezeId };
}
