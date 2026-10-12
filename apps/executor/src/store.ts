// Executor SQL (docs/specs/executor.md section 12). Every financial change is one short transaction with its
// audit/outbox rows; no provider or network call happens inside a transaction. Lock order: simulation
// account row, then balance rows by asset ref.
import type pg from 'pg';
import { verifyBranchEvidence } from './branch-evidence.ts';
import type { DeploymentAuthority } from './authorization.ts';
import type { ActionIntent, Strategy } from '@monad-hack/contracts';
import type { Denial, Verdict } from '@monad-hack/policy';

export type IntentState =
  | 'proposed' | 'rejected' | 'reserved' | 'prepared' | 'signing' | 'signed' | 'submitted'
  | 'included' | 'finalized' | 'settled' | 'reconciling' | 'failed' | 'cancelled';

export const TERMINAL_STATES: ReadonlySet<IntentState> = new Set(['rejected', 'settled', 'failed', 'cancelled']);

export interface FrozenAction {
  connectorRef: string;
  connectorVersion: string;
  tokenInRef: string;
  tokenOutRef: string;
  maxSlippageBps: number;
}

export interface IntentRow {
  tenantId: string;
  id: string;
  agentId: string;
  deploymentId: string;
  generation: string;
  simulationAccountId: string;
  runId: string;
  logicalKey: string;
  requestHash: string;
  action: FrozenAction;
  inputAtomic: bigint | undefined;
  state: IntentState;
  reason: Denial | undefined;
  paperFillId: string | undefined;
  settledInputAtomic: bigint | undefined;
  settledOutputAtomic: bigint | undefined;
  createdAt: Date;
  updatedAt: Date;
}

interface IntentRecord {
  tenant_id: string;
  id: string;
  agent_id: string;
  deployment_id: string;
  generation: string;
  simulation_account_id: string;
  run_id: string;
  logical_key: string;
  request_hash: string;
  action: FrozenAction;
  input_atomic: string | null;
  state: IntentState;
  reason_code: Denial['code'] | null;
  reason_message: string | null;
  paper_fill_id: string | null;
  settled_input_atomic: string | null;
  settled_output_atomic: string | null;
  created_at: Date;
  updated_at: Date;
}

const big = (value: string | null): bigint | undefined => (value === null ? undefined : BigInt(value));

const toRow = (r: IntentRecord): IntentRow => ({
  tenantId: r.tenant_id,
  id: r.id,
  agentId: r.agent_id,
  deploymentId: r.deployment_id,
  generation: String(r.generation),
  simulationAccountId: r.simulation_account_id,
  runId: r.run_id,
  logicalKey: r.logical_key,
  requestHash: r.request_hash,
  action: r.action,
  inputAtomic: big(r.input_atomic),
  state: r.state,
  reason: r.reason_code && r.reason_message ? { code: r.reason_code, message: r.reason_message } : undefined,
  paperFillId: r.paper_fill_id ?? undefined,
  settledInputAtomic: big(r.settled_input_atomic),
  settledOutputAtomic: big(r.settled_output_atomic),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** What admission sees under the account lock. */
export interface AdmissionSnapshot {
  readonly availableInputAtomic: bigint;
  /** Agent actions in the current UTC day that hold or used funds (pending included). */
  readonly actionsInWindow: number;
  readonly intentsInRun: number;
}

export interface AdmissionDecision {
  readonly resolvedInputAtomic: bigint | undefined;
  readonly verdict: Verdict;
  readonly contextHash: string;
}

export interface AdmitInput {
  readonly intentId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly generation: string;
  readonly simulationAccountId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly iterationPath: readonly number[];
  readonly logicalKey: string;
  readonly requestHash: string;
  readonly request: unknown;
  readonly action: FrozenAction;
  readonly maxIntentsPerRun: number;
  readonly now: Date;
}

export type AdmitOutcome =
  | { readonly kind: 'existing'; readonly row: IntentRow }
  | { readonly kind: 'created'; readonly row: IntentRow }
  | { readonly kind: 'runLimit' }
  | { readonly kind: 'noAccount' };

export interface SettleInput {
  readonly paperFillId: string;
  readonly adapterVersion: string;
  readonly outputAtomic: bigint;
  readonly basis: unknown;
  readonly verdict: Verdict;
  readonly contextHash: string;
  readonly now: Date;
}

const COUNTED_STATES = ['reserved', 'prepared', 'signing', 'signed', 'submitted', 'included', 'finalized', 'settled', 'reconciling'];

export class ExecutorStore {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async #tx<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findByKey(logicalKey: string): Promise<IntentRow | undefined> {
    const { rows } = await this.#pool.query<IntentRecord>('select * from intents where logical_key = $1', [logicalKey]);
    return rows[0] && toRow(rows[0]);
  }

  async findById(intentId: string): Promise<IntentRow | undefined> {
    const { rows } = await this.#pool.query<IntentRecord>('select * from intents where id = $1', [intentId]);
    return rows[0] && toRow(rows[0]);
  }

  /** Paper intents admitted but not yet filled, oldest first (restart recovery). */
  async reservedIntents(limit = 100): Promise<IntentRow[]> {
    const { rows } = await this.#pool.query<IntentRecord>(
      `select * from intents where state = 'reserved' order by updated_at, id limit $1`,
      [limit],
    );
    return rows.map(toRow);
  }

  async verifyBranch(authority: DeploymentAuthority, intent: ActionIntent, now: Date): Promise<boolean> {
    return verifyBranchEvidence(this.#pool, authority, intent, now);
  }

  async loadStrategy(tenantId: string, revisionId: string): Promise<Strategy | undefined> {
    const { rows } = await this.#pool.query<{ ast: Strategy }>('select ast from strategy_revisions where tenant_id = $1 and id = $2', [tenantId, revisionId]);
    return rows[0]?.ast;
  }

  async loadPolicyLimits(tenantId: string, agentId: string, version: number): Promise<Record<string, unknown> | undefined> {
    const { rows } = await this.#pool.query<{ limits: Record<string, unknown> }>(
      'select limits from policies where tenant_id = $1 and agent_id = $2 and version = $3',
      [tenantId, agentId, version],
    );
    return rows[0]?.limits;
  }

  /** Connector version is enabled for paper and offers the action; both assets exist for paper on the network. */
  async catalogAllows(connectorRef: string, connectorVersion: string, action: string, networkRef: string, assetRefs: readonly string[]): Promise<{ connector: boolean; assets: boolean }> {
    const connector = await this.#pool.query(
      `select 1 from catalog_versions where kind = 'connector' and ref = $1 and version = $2 and 'paper' = any(modes)
         and disabled_reason is null and definition ->> 'networkRef' = $3 and definition -> 'capabilities' ? $4`,
      [connectorRef, connectorVersion, networkRef, action],
    );
    const assets = await this.#pool.query<{ ref: string }>(
      `select distinct ref from catalog_versions where kind = 'asset' and ref = any($1) and 'paper' = any(modes)
         and disabled_reason is null and definition -> 'identity' ->> 'kind' = 'paper' and definition -> 'identity' ->> 'networkRef' = $2`,
      [assetRefs, networkRef],
    );
    return { connector: connector.rowCount === 1, assets: assets.rowCount === new Set(assetRefs).size };
  }

  /**
   * Atomic admission: under the account lock, recheck the logical key, read balances and counters, decide,
   * then create the intent, verdict, hold and outbox rows together.
   */
  async admit(input: AdmitInput, decide: (snapshot: AdmissionSnapshot) => Promise<AdmissionDecision>): Promise<AdmitOutcome> {
    return this.#tx(async (db) => {
      const account = await db.query(
        'select 1 from simulation_accounts where tenant_id = $1 and id = $2 and agent_id = $3 for update',
        [input.tenantId, input.simulationAccountId, input.agentId],
      );
      if (account.rowCount !== 1) return { kind: 'noAccount' } as const;
      // A concurrent submission of the same key committed while we waited for the lock.
      const existing = await db.query<IntentRecord>('select * from intents where logical_key = $1', [input.logicalKey]);
      if (existing.rows[0]) return { kind: 'existing', row: toRow(existing.rows[0]) } as const;

      const runCount = await db.query<{ n: string }>('select count(*) as n from intents where deployment_id = $1 and run_id = $2', [input.deploymentId, input.runId]);
      if (Number(runCount.rows[0]!.n) >= input.maxIntentsPerRun) return { kind: 'runLimit' } as const;

      const balance = await db.query<{ available: string }>(
        'select available from simulation_balances where tenant_id = $1 and account_id = $2 and asset_ref = $3 for update',
        [input.tenantId, input.simulationAccountId, input.action.tokenInRef],
      );
      const dayStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
      const window = await db.query<{ n: string }>(
        'select count(*) as n from intents where tenant_id = $1 and agent_id = $2 and created_at >= $3 and state = any($4)',
        [input.tenantId, input.agentId, dayStart, COUNTED_STATES],
      );
      const decision = await decide({
        availableInputAtomic: BigInt(balance.rows[0]?.available ?? '0'),
        actionsInWindow: Number(window.rows[0]!.n),
        intentsInRun: Number(runCount.rows[0]!.n),
      });

      const allowed = decision.verdict.allow && decision.resolvedInputAtomic !== undefined;
      const reason = decision.verdict.allow ? undefined : decision.verdict.denials[0];
      const { rows } = await db.query<IntentRecord>(
        `insert into intents (tenant_id, id, agent_id, deployment_id, generation, mode, simulation_account_id, run_id, node_id,
           iteration_path, logical_key, request_hash, request, action, input_atomic, state, reason_code, reason_message, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'paper', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18) returning *`,
        [
          input.tenantId, input.intentId, input.agentId, input.deploymentId, input.generation, input.simulationAccountId, input.runId,
          input.nodeId, JSON.stringify(input.iterationPath), input.logicalKey, input.requestHash, input.request, input.action,
          decision.resolvedInputAtomic && decision.resolvedInputAtomic > 0n ? decision.resolvedInputAtomic.toString() : null,
          allowed ? 'reserved' : 'rejected', reason?.code ?? null, reason?.message ?? null, input.now,
        ],
      );
      const row = toRow(rows[0]!);
      await insertVerdict(db, row, 'admission', decision.verdict, decision.contextHash, input.now);
      if (allowed) {
        const hold = decision.resolvedInputAtomic!;
        const moved = await db.query(
          `update simulation_balances set available = available - $4, held = held + $4
           where tenant_id = $1 and account_id = $2 and asset_ref = $3 and available >= $4`,
          [row.tenantId, row.simulationAccountId, row.action.tokenInRef, hold.toString()],
        );
        if (moved.rowCount !== 1) throw new Error('reservation invariant: balance changed under the account lock');
        await db.query(
          `insert into simulation_reservations (tenant_id, intent_id, account_id, asset_ref, amount, state, created_at, updated_at)
           values ($1, $2, $3, $4, $5, 'held', $6, $6)`,
          [row.tenantId, row.id, row.simulationAccountId, row.action.tokenInRef, hold.toString(), input.now],
        );
        await outbox(db, row, 'reservation.changed', { state: 'held', assetRef: row.action.tokenInRef, amountAtomic: hold.toString() }, input.now);
      } else {
        await outbox(db, row, 'policy.denied', { reason: reason!.code, phase: 'admission' }, input.now);
      }
      await outbox(db, row, 'transaction.stateChanged', stateChange(row), input.now);
      return { kind: 'created', row } as const;
    });
  }

  /** Synthetic fill: settle the hold, credit the output and record the fill once. Idempotent by state. */
  async settle(intentId: string, fill: SettleInput): Promise<IntentRow> {
    return this.#tx(async (db) => {
      const locked = await lockReserved(db, intentId);
      if (locked.kind === 'done') return locked.row;
      const row = locked.row;
      const input = row.inputAtomic!;
      await insertVerdict(db, row, 'dispatch', fill.verdict, fill.contextHash, fill.now);
      await db.query(
        `insert into paper_fills (tenant_id, id, intent_id, account_id, adapter_version, input_asset_ref, input_atomic, output_asset_ref, output_atomic, basis, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [row.tenantId, fill.paperFillId, row.id, row.simulationAccountId, fill.adapterVersion, row.action.tokenInRef, input.toString(),
          row.action.tokenOutRef, fill.outputAtomic.toString(), fill.basis, fill.now],
      );
      // Balance rows in canonical (asset ref) order.
      for (const asset of [row.action.tokenInRef, row.action.tokenOutRef].sort()) {
        if (asset === row.action.tokenInRef) {
          await db.query(
            'update simulation_balances set held = held - $4 where tenant_id = $1 and account_id = $2 and asset_ref = $3',
            [row.tenantId, row.simulationAccountId, asset, input.toString()],
          );
        } else {
          await db.query(
            `insert into simulation_balances (tenant_id, account_id, asset_ref, available) values ($1, $2, $3, $4)
             on conflict (tenant_id, account_id, asset_ref) do update set available = simulation_balances.available + excluded.available`,
            [row.tenantId, row.simulationAccountId, asset, fill.outputAtomic.toString()],
          );
        }
      }
      await db.query(`update simulation_reservations set state = 'settled', updated_at = $2 where intent_id = $1 and state = 'held'`, [row.id, fill.now]);
      const { rows } = await db.query<IntentRecord>(
        `update intents set state = 'settled', paper_fill_id = $2, settled_input_atomic = $3, settled_output_atomic = $4,
           version = version + 1, updated_at = $5 where id = $1 and state = 'reserved' returning *`,
        [row.id, fill.paperFillId, input.toString(), fill.outputAtomic.toString(), fill.now],
      );
      const settled = toRow(rows[0]!);
      await outbox(db, settled, 'reservation.changed', { state: 'settled', assetRef: row.action.tokenInRef, amountAtomic: input.toString() }, fill.now);
      await outbox(db, settled, 'ledger.settled', {
        mode: 'paper', paperFillId: fill.paperFillId, inputAssetRef: row.action.tokenInRef, inputAtomic: input.toString(),
        outputAssetRef: row.action.tokenOutRef, outputAtomic: fill.outputAtomic.toString(),
      }, fill.now);
      await outbox(db, settled, 'transaction.stateChanged', stateChange(settled), fill.now);
      return settled;
    });
  }

  /** End a reserved paper intent without a fill (pause before dispatch, or a proven no-fill) and release the hold. */
  async release(intentId: string, state: 'cancelled' | 'failed', reason: Denial, verdict: Verdict | undefined, contextHash: string | undefined, now: Date): Promise<IntentRow> {
    return this.#tx(async (db) => {
      const locked = await lockReserved(db, intentId);
      if (locked.kind === 'done') return locked.row;
      const row = locked.row;
      const input = row.inputAtomic!.toString();
      if (verdict && contextHash) await insertVerdict(db, row, 'dispatch', verdict, contextHash, now);
      await db.query(
        'update simulation_balances set available = available + $4, held = held - $4 where tenant_id = $1 and account_id = $2 and asset_ref = $3',
        [row.tenantId, row.simulationAccountId, row.action.tokenInRef, input],
      );
      await db.query(`update simulation_reservations set state = 'released', updated_at = $2 where intent_id = $1 and state = 'held'`, [row.id, now]);
      const { rows } = await db.query<IntentRecord>(
        `update intents set state = $2, reason_code = $3, reason_message = $4, version = version + 1, updated_at = $5
         where id = $1 and state = 'reserved' returning *`,
        [row.id, state, reason.code, reason.message, now],
      );
      const ended = toRow(rows[0]!);
      if (verdict && !verdict.allow) await outbox(db, ended, 'policy.denied', { reason: reason.code, phase: 'dispatch' }, now);
      await outbox(db, ended, 'reservation.changed', { state: 'released', assetRef: row.action.tokenInRef, amountAtomic: input }, now);
      await outbox(db, ended, 'transaction.stateChanged', stateChange(ended), now);
      return ended;
    });
  }
}

async function lockReserved(db: pg.PoolClient, intentId: string): Promise<{ kind: 'locked' | 'done'; row: IntentRow }> {
  // Account lock first (canonical order), then the intent row.
  const { rows: accounts } = await db.query<{ simulation_account_id: string; tenant_id: string }>('select tenant_id, simulation_account_id from intents where id = $1', [intentId]);
  const account = accounts[0];
  if (!account) throw new Error('intent not found');
  await db.query('select 1 from simulation_accounts where tenant_id = $1 and id = $2 for update', [account.tenant_id, account.simulation_account_id]);
  const { rows } = await db.query<IntentRecord>('select * from intents where id = $1 for update', [intentId]);
  const row = toRow(rows[0]!);
  return { kind: row.state === 'reserved' ? 'locked' : 'done', row };
}

async function insertVerdict(db: pg.PoolClient, row: IntentRow, phase: 'admission' | 'dispatch', verdict: Verdict, contextHash: string, now: Date): Promise<void> {
  await db.query(
    `insert into policy_verdicts (tenant_id, intent_id, phase, allow, denials, policy_version, context_hash, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.tenantId, row.id, phase, verdict.allow, JSON.stringify(verdict.allow ? [] : verdict.denials), verdict.policyVersion, contextHash, now],
  );
}

function stateChange(row: IntentRow): Record<string, unknown> {
  // The API worker resumes the run from definitive states using runId + logicalKey (the operation key) + intentId.
  return { mode: 'paper', state: row.state, ...(row.reason ? { reason: row.reason.code } : {}), ...(row.paperFillId ? { paperFillId: row.paperFillId } : {}) };
}

async function outbox(db: pg.PoolClient, row: IntentRow, type: string, payload: Record<string, unknown>, now: Date): Promise<void> {
  await db.query(
    `insert into executor_outbox (tenant_id, agent_id, intent_id, run_id, logical_key, type, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.tenantId, row.agentId, row.id, row.runId, row.logicalKey, type, payload, now],
  );
}
