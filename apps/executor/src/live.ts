// Live intents on the funds ledger (docs/specs/executor.md sections 5, 7, 9 and 13; funds-and-budgets.md
// section 4). Admission reserves token-in plus the native gas ceiling through packages/accounting, counted in the
// UTC-day windows and blocked by open reconciliation freezes, with the live policy blocks at the admission phase.
// The later transitions (dispatch, reconciling, finalized settlement, revert, cancel) are the only way a live
// intent's holds move; the quote/build/sign/broadcast pipeline (#39–#41) calls them and never touches balances.
// Every transition is one short transaction with its verdict and outbox rows; no provider call happens inside.
import type pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import type { ActionIntent } from '@monad-hack/contracts';
import {
  AccountingError, gasPostings, lockAccounts, markDispatched, markReconciling, openFreezes, release, reserve, settle, swapPostings, user, utcDay,
} from '@monad-hack/accounting';
import { evaluateAction } from '@monad-hack/policy';
import type { ActionContext, ActionLimits, Denial, Verdict } from '@monad-hack/policy';
import type { DeploymentAuthority, NodeMatch } from './authorization.ts';
import type { Capability } from './capability.ts';
import { uuidv7 } from './ids.ts';
import { toRow } from './store.ts';
import type { FrozenAction, IntentRecord, IntentRow } from './store.ts';

/** Reference valuation for daily notional: integer micro-USD per one whole token, with provenance time. */
export interface LiveValuation {
  usdMicrosPerToken(assetRef: string): Promise<{ readonly usdMicros: bigint; readonly decimals: number; readonly observedAt: string } | undefined>;
}

export interface LiveConfig {
  readonly chainId: number;
  /** The live network deployments must name. */
  readonly networkRef: string;
  /** Native gas asset (trading MON sub-reservation). */
  readonly gasAssetRef: string;
  /** Native fee ceiling held per swap intent, approval included. */
  readonly gasCeilingAtomic: bigint;
  /** Live platform limits (chain, quote age, reference deviation, gas, reserve, notional, input). */
  readonly platformLimits: ActionLimits;
  readonly valuation: LiveValuation;
  readonly maxValuationAgeSeconds: number;
  /** How long an undispatched hold lives before it expires and the intent is cancelled. */
  readonly holdSeconds: number;
}

export type LiveAdmission =
  | { readonly kind: 'created' | 'existing'; readonly row: IntentRow }
  | { readonly kind: 'runLimit' }
  | { readonly kind: 'noWallet' };

const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

export class LiveIntents {
  readonly #pool: pg.Pool;
  readonly #config: LiveConfig;

  constructor(pool: pg.Pool, config: LiveConfig) {
    this.#pool = pool;
    this.#config = config;
  }

  get config(): LiveConfig {
    return this.#config;
  }

  async #tx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('begin');
      const out = await work(c);
      await c.query('commit');
      return out;
    } catch (error) {
      await c.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  /**
   * Admission (executor.md section 5 steps 10–13 for live): resolve the input from available trading inventory,
   * evaluate the live policy at the admission phase, then create the intent, verdict, reservation and outbox
   * together. A denial or a reservation the ledger refuses records a rejected intent with its stable reason.
   */
  async admit(input: {
    readonly capability: Capability;
    readonly authority: DeploymentAuthority;
    readonly intent: ActionIntent;
    readonly match: Extract<NodeMatch, { ok: true }>;
    readonly maxIntentsPerRun: number;
    readonly requestHash: string;
    readonly catalog: { readonly connector: boolean; readonly assets: boolean };
    readonly limits: readonly ActionLimits[];
    /** Read after the valuation: a price observed after a stale `now` would count as future-dated. */
    readonly clock: () => Date;
  }): Promise<LiveAdmission> {
    const { capability, authority, intent } = input;
    const cfg = this.#config;
    const scope = { mode: 'live' as const, tenantId: authority.tenantId, agentId: authority.agentId };
    // Reference price for notional, read before the transaction (no network call inside it).
    const price = await cfg.valuation.usdMicrosPerToken(intent.tokenInRef);
    const now = input.clock();
    return this.#tx(async (c) => {
      const wallet = await c.query<{ id: string; address: string }>(
        `select id, address from wallets where tenant_id = $1 and agent_id = $2 and chain_id = $3 and status = 'active'`, [scope.tenantId, scope.agentId, cfg.chainId]);
      const w = wallet.rows[0];
      if (!w) return { kind: 'noWallet' } as const;
      // Canonical lock order: the agent's trading accounts first, then the logical key recheck.
      const tokenIn = user(scope, 'trading', intent.tokenInRef);
      const gas = user(scope, 'trading', cfg.gasAssetRef);
      const locked = await lockAccounts(c, [tokenIn, gas]);
      const existing = await c.query<IntentRecord>('select * from intents where logical_key = $1', [intent.logicalKey]);
      if (existing.rows[0]) return { kind: 'existing', row: toRow(existing.rows[0]) } as const;
      const runCount = await c.query<{ n: string }>('select count(*) as n from intents where deployment_id = $1 and run_id = $2', [authority.deploymentId, intent.runId]);
      if (Number(runCount.rows[0]!.n) >= input.maxIntentsPerRun) return { kind: 'runLimit' } as const;

      const inRow = [...locked.values()].find((a) => a.ref.kind === 'user' && a.ref.assetRef === intent.tokenInRef)!;
      const gasRow = [...locked.values()].find((a) => a.ref.kind === 'user' && a.ref.assetRef === cfg.gasAssetRef)!;
      const sameAsset = intent.tokenInRef === cfg.gasAssetRef;
      // Token-in availability excludes the gas ceiling when token-in is the gas asset itself.
      const availableIn = inRow.balance - inRow.held - (sameAsset ? cfg.gasCeilingAtomic : 0n);
      const available = availableIn > 0n ? availableIn : 0n;
      const resolved = intent.amount.kind === 'fixed' ? BigInt(intent.amount.atomic) : (available * BigInt(intent.amount.bps)) / 10_000n;
      const window = await c.query<{ pending_actions: number; committed_actions: number; pending_notional_usd_micros: string; committed_notional_usd_micros: string }>(
        `select pending_actions, committed_actions, pending_notional_usd_micros, committed_notional_usd_micros from spend_windows where scope_key = $1 and mode = 'live' and day = $2`,
        [`agent:${scope.agentId}`, utcDay(now)]);
      const win = window.rows[0];
      const notional = price ? (resolved * price.usdMicros) / 10n ** BigInt(price.decimals) : undefined;
      const freezes = await openFreezes(c, 'live', scope.tenantId, scope.agentId);
      const context: ActionContext = {
        mode: 'live', phase: 'admission', deploymentActive: true, connectorEnabled: input.catalog.connector, assetsAllowed: input.catalog.assets,
        requestedSlippageBps: intent.maxSlippageBps, limits: [cfg.platformLimits, ...input.limits], resolvedInputAtomic: resolved, availableInputAtomic: available,
        actionsInWindow: win ? win.pending_actions + win.committed_actions : 0,
        valuation: price && { observedAtMillis: Date.parse(price.observedAt), maxAgeSeconds: cfg.maxValuationAgeSeconds }, nowMillis: now.getTime(),
        identity: {
          capabilityTenantId: capability.tenantId, capabilityAgentId: capability.agentId, capabilityDeploymentId: capability.deploymentId, capabilityGeneration: capability.generation,
          tenantId: authority.tenantId, agentId: authority.agentId, deploymentId: authority.deploymentId, currentGeneration: authority.generation, fundingOwnerAgentId: authority.agentId,
        },
        // The strategy never names a recipient: the swap pays out to the agent's own wallet.
        chain: { chainId: cfg.chainId, recipient: w.address, agentWallet: w.address },
        ...(notional !== undefined ? { notional: { notionalUsdMicros: notional, windowNotionalUsdMicros: win ? BigInt(win.pending_notional_usd_micros) + BigInt(win.committed_notional_usd_micros) : 0n } } : {}),
        // D36: live mode denies a node under `if` until branch evidence is verified from persisted broker results.
        branchEvidenceVerified: !input.match.branchGated,
        reconciliationOpen: freezes.length > 0,
      };
      const verdict = evaluateAction(context);
      const contextHash = await contentHash(jsonSafe({ phase: 'admission', logicalKey: intent.logicalKey, generation: authority.generation, price, context }));
      const action: FrozenAction = { connectorRef: intent.connectorRef, connectorVersion: intent.connectorVersion, tokenInRef: intent.tokenInRef, tokenOutRef: intent.tokenOutRef, maxSlippageBps: intent.maxSlippageBps };
      const intentId = uuidv7(now.getTime());
      const reservationKey = `intent:${intent.logicalKey}`;

      let denial: Denial | undefined = verdict.allow ? undefined : verdict.denials[0];
      if (!denial) {
        await c.query('savepoint live_reserve');
        try {
          const holds = sameAsset
            ? [{ account: tokenIn, amount: resolved + cfg.gasCeilingAtomic }]
            : [{ account: tokenIn, amount: resolved }, { account: gas, amount: cfg.gasCeilingAtomic }];
          const limitsCombined = [cfg.platformLimits, ...input.limits];
          const maxActions = limitsCombined.map((l) => l.dailyActionCount).filter((v): v is number => v !== undefined).reduce((a, b) => Math.min(a, b), Number.MAX_SAFE_INTEGER);
          const maxNotional = limitsCombined.map((l) => l.dailyNotionalUsdMicros).filter((v): v is bigint => v !== undefined).reduce<bigint | undefined>((a, b) => (a === undefined || b < a ? b : a), undefined);
          await reserve(c, {
            operationKey: reservationKey, ...scope, purpose: 'trade', holds, now, expiresAt: new Date(now.getTime() + cfg.holdSeconds * 1000), policyVersion: verdict.policyVersion,
            window: {
              countsAction: true, notionalUsdMicros: notional ?? 0n,
              limits: [{ scopeKey: `agent:${scope.agentId}`, maxActions, ...(maxNotional !== undefined ? { maxNotionalUsdMicros: maxNotional } : {}) }, { scopeKey: `tenant:${scope.tenantId}` }, { scopeKey: 'platform' }],
            },
          });
          await c.query('release savepoint live_reserve');
        } catch (error) {
          if (!(error instanceof AccountingError)) throw error;
          await c.query('rollback to savepoint live_reserve');
          denial = error.code === 'DAILY_LIMIT_EXCEEDED' ? { code: 'EXECUTOR_DAILY_LIMIT_EXCEEDED', message: 'The daily limit is reached, counting pending trades.' }
            : error.code === 'RECONCILIATION_REQUIRED' ? { code: 'EXECUTOR_RECONCILIATION_REQUIRED', message: 'A balance difference blocks new trades until it is investigated.' }
              : { code: 'EXECUTOR_INSUFFICIENT_BUDGET', message: 'The trading funds or gas reserve cannot cover this trade.' };
        }
      }
      const { rows } = await c.query<IntentRecord>(
        `insert into intents (tenant_id, id, agent_id, deployment_id, generation, mode, wallet_id, reservation_key, run_id, node_id, iteration_path, logical_key,
           request_hash, request, action, input_atomic, state, reason_code, reason_message, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'live', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19) returning *`,
        [authority.tenantId, intentId, authority.agentId, authority.deploymentId, authority.generation, w.id, denial ? null : reservationKey, intent.runId, intent.nodeId,
          JSON.stringify(intent.iterationPath), intent.logicalKey, input.requestHash, intent, action, resolved > 0n ? resolved.toString() : null,
          denial ? 'rejected' : 'reserved', denial?.code ?? null, denial?.message ?? null, now],
      );
      const row = toRow(rows[0]!);
      const recorded: Verdict = denial && verdict.allow ? { allow: false, policyVersion: verdict.policyVersion, denials: [denial] } : verdict;
      await verdictRow(c, row, 'admission', recorded, contextHash, now);
      if (denial) await outbox(c, row, 'policy.denied', { reason: denial.code, phase: 'admission' }, now);
      else await outbox(c, row, 'reservation.changed', { state: 'held', assetRef: intent.tokenInRef, amountAtomic: resolved.toString(), gasAssetRef: cfg.gasAssetRef, gasCeilingAtomic: cfg.gasCeilingAtomic.toString() }, now);
      await outbox(c, row, 'transaction.stateChanged', stateChange(row), now);
      return { kind: 'created', row } as const;
    });
  }

  async #lock(c: pg.PoolClient, intentId: string): Promise<IntentRow> {
    const r = await c.query<IntentRecord>(`select * from intents where id = $1 and mode = 'live' for update`, [intentId]);
    if (!r.rows[0]) throw new Error('live intent not found');
    return toRow(r.rows[0]);
  }

  async #move(c: pg.PoolClient, row: IntentRow, state: IntentRow['state'], now: Date, extra: { reason?: Denial; txHash?: string } = {}): Promise<IntentRow> {
    const r = await c.query<IntentRecord>(
      `update intents set state = $2, reason_code = coalesce($3, reason_code), reason_message = coalesce($4, reason_message), tx_hash = coalesce($5, tx_hash),
         version = version + 1, updated_at = $6 where id = $1 returning *`,
      [row.id, state, extra.reason?.code ?? null, extra.reason?.message ?? null, extra.txHash ?? null, now]);
    const moved = toRow(r.rows[0]!);
    await outbox(c, moved, 'transaction.stateChanged', stateChange(moved), now);
    return moved;
  }

  /** Before any external authorization exists: release every hold and cancel (pause, stop, denial, expiry). */
  async cancel(intentId: string, reason: Denial, now: Date, verdict?: { verdict: Verdict; contextHash: string }): Promise<IntentRow> {
    return this.#tx(async (c) => {
      const row = await this.#lock(c, intentId);
      if (row.state !== 'reserved' && row.state !== 'prepared') return row;
      if (verdict) await verdictRow(c, row, 'dispatch', verdict.verdict, verdict.contextHash, now);
      await release(c, row.reservationKey!, now, reason.message);
      if (verdict && !verdict.verdict.allow) await outbox(c, row, 'policy.denied', { reason: reason.code, phase: 'dispatch' }, now);
      await outbox(c, row, 'reservation.changed', { state: 'released', assetRef: row.action.tokenInRef, amountAtomic: row.inputAtomic!.toString() }, now);
      return this.#move(c, row, 'cancelled', now, { reason });
    });
  }

  /** The prepared transaction passed the signing-phase policy; holds can no longer expire. */
  async markSigning(intentId: string, verdict: Verdict, contextHash: string, now: Date): Promise<IntentRow> {
    return this.#tx(async (c) => {
      const row = await this.#lock(c, intentId);
      if (row.state !== 'reserved' && row.state !== 'prepared') return row;
      if (!verdict.allow) throw new Error('markSigning needs an allowing signing-phase verdict');
      await verdictRow(c, row, 'dispatch', verdict, contextHash, now);
      await markDispatched(c, row.reservationKey!, now);
      return this.#move(c, row, 'signing', now);
    });
  }

  async markSubmitted(intentId: string, txHash: string, now: Date): Promise<IntentRow> {
    return this.#tx(async (c) => {
      const row = await this.#lock(c, intentId);
      if (row.state === 'submitted' && row.transactionHash === txHash.toLowerCase()) return row;
      if (!['signing', 'signed', 'reconciling'].includes(row.state)) throw new Error(`a ${row.state} intent cannot be submitted`);
      return this.#move(c, row, 'submitted', now, { txHash: txHash.toLowerCase() });
    });
  }

  /** Timeout or contradictory answers after signing: keep every hold; recover from the same nonce/hash later. */
  async markReconciling(intentId: string, reason: string, now: Date): Promise<IntentRow> {
    return this.#tx(async (c) => {
      const row = await this.#lock(c, intentId);
      if (row.state === 'reconciling' || row.state === 'settled' || row.state === 'failed') return row;
      if (!['signing', 'signed', 'submitted', 'included', 'finalized'].includes(row.state)) throw new Error(`a ${row.state} intent cannot reconcile`);
      await markReconciling(c, row.reservationKey!, reason);
      return this.#move(c, row, 'reconciling', now);
    });
  }

  /**
   * Finalized canonical receipt: post the actual per-asset effects and gas once, return the unspent remainder,
   * settle the window holds and mark the intent. A revert charges gas only and fails the intent. Effects outside
   * the reservation (spending more than held) are refused by the ledger and leave the intent reconciling.
   */
  async settleFinalized(intentId: string, effect: { readonly txHash: string; readonly succeeded: boolean; readonly inputAtomic: bigint; readonly outputAtomic: bigint; readonly gasAtomic: bigint }, now: Date): Promise<IntentRow> {
    return this.#tx(async (c) => {
      const row = await this.#lock(c, intentId);
      if (row.state === 'settled' || row.state === 'failed') return row;
      if (!['submitted', 'included', 'finalized', 'reconciling'].includes(row.state)) throw new Error(`a ${row.state} intent cannot settle`);
      const scope = { mode: 'live' as const, tenantId: row.tenantId, agentId: row.agentId };
      const cfg = this.#config;
      if (effect.succeeded) {
        const postings = swapPostings(scope, { assetIn: row.action.tokenInRef, amountIn: effect.inputAtomic, assetOut: row.action.tokenOutRef, amountOut: effect.outputAtomic, gasAsset: cfg.gasAssetRef, gasUsed: effect.gasAtomic });
        const settled = await settle(c, row.reservationKey!, { journal: { kind: 'trade', postings, occurredAt: now, memo: `swap ${effect.txHash}` }, now });
        if (settled.outcome === 'conflict') return this.#move(c, row, 'reconciling', now);
        const r = await c.query<IntentRecord>(
          `update intents set state = 'settled', settlement_journal_id = $2, tx_hash = $3, settled_input_atomic = $4, settled_output_atomic = $5, settled_gas_atomic = $6,
             version = version + 1, updated_at = $7 where id = $1 returning *`,
          [row.id, settled.journalId, effect.txHash.toLowerCase(), effect.inputAtomic.toString(), effect.outputAtomic.toString(), effect.gasAtomic.toString(), now]);
        const done = toRow(r.rows[0]!);
        await outbox(c, done, 'reservation.changed', { state: 'settled', assetRef: row.action.tokenInRef, amountAtomic: effect.inputAtomic.toString() }, now);
        await outbox(c, done, 'ledger.settled', {
          mode: 'live', transactionHash: done.transactionHash, inputAssetRef: row.action.tokenInRef, inputAtomic: effect.inputAtomic.toString(),
          outputAssetRef: row.action.tokenOutRef, outputAtomic: effect.outputAtomic.toString(), gasAtomic: effect.gasAtomic.toString(),
        }, now);
        await outbox(c, done, 'transaction.stateChanged', stateChange(done), now);
        return done;
      }
      // Reverted: the input never moved; gas actually consumed is charged and the rest is released.
      if (effect.gasAtomic > 0n) await settle(c, row.reservationKey!, { journal: { kind: 'gas', postings: gasPostings(scope, cfg.gasAssetRef, effect.gasAtomic), occurredAt: now, memo: `revert ${effect.txHash}` }, now });
      else await release(c, row.reservationKey!, now, 'Reverted without gas.');
      await c.query('update intents set settled_gas_atomic = $2 where id = $1', [row.id, effect.gasAtomic.toString()]);
      await outbox(c, row, 'reservation.changed', { state: 'released', assetRef: row.action.tokenInRef, amountAtomic: row.inputAtomic!.toString() }, now);
      return this.#move(c, row, 'failed', now, { reason: { code: 'EXECUTOR_SIMULATION_FAILED', message: 'The swap reverted on chain; only gas was charged.' }, txHash: effect.txHash });
    });
  }

  /**
   * Recovery for undispatched live intents (executor.md section 13): a paused, stopped or replaced deployment, or
   * a hold that expired, cancels the intent and releases its holds. Dispatched intents are left to reconciliation.
   */
  async reconcile(current: (tenantId: string, deploymentId: string) => Promise<DeploymentAuthority | undefined>, now: Date): Promise<number> {
    const open = await this.#pool.query<IntentRecord>(`select * from intents where mode = 'live' and state in ('reserved', 'prepared') order by updated_at limit 100`);
    let ended = 0;
    for (const record of open.rows) {
      const row = toRow(record);
      const res = await this.#pool.query<{ state: string; expires_at: Date }>('select state, expires_at from reservations where operation_key = $1', [row.reservationKey]);
      const hold = res.rows[0];
      let authority: DeploymentAuthority | undefined;
      try {
        authority = await current(row.tenantId, row.deploymentId);
      } catch {
        continue;
      }
      let reason: Denial | undefined;
      if (!authority || authority.generation !== row.generation || authority.desiredState === 'stopping' || authority.desiredState === 'stopped') reason = { code: 'EXECUTOR_STALE_GENERATION', message: 'The deployment generation changed before signing.' };
      else if (authority.desiredState !== 'active') reason = { code: 'EXECUTOR_DEPLOYMENT_INACTIVE', message: 'The deployment was paused before signing.' };
      else if (!hold || hold.state === 'released' || hold.expires_at <= now) reason = { code: 'EXECUTOR_QUOTE_INVALID', message: 'The trade was not signed before its hold expired.' };
      if (reason) {
        await this.cancel(row.id, reason, now);
        ended++;
      }
    }
    return ended;
  }
}

async function verdictRow(c: pg.PoolClient, row: IntentRow, phase: 'admission' | 'dispatch', verdict: Verdict, contextHash: string, now: Date): Promise<void> {
  await c.query(
    `insert into policy_verdicts (tenant_id, intent_id, phase, allow, denials, policy_version, context_hash, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (intent_id, phase) do nothing`,
    [row.tenantId, row.id, phase, verdict.allow, JSON.stringify(verdict.allow ? [] : verdict.denials), verdict.policyVersion, contextHash, now]);
}

function stateChange(row: IntentRow): Record<string, unknown> {
  return { mode: 'live', state: row.state, ...(row.reason ? { reason: row.reason.code } : {}), ...(row.transactionHash ? { transactionHash: row.transactionHash } : {}) };
}

async function outbox(c: pg.PoolClient, row: IntentRow, type: string, payload: Record<string, unknown>, now: Date): Promise<void> {
  await c.query(
    `insert into executor_outbox (tenant_id, agent_id, intent_id, run_id, logical_key, type, payload, occurred_at) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.tenantId, row.agentId, row.id, row.runId, row.logicalKey, type, payload, now]);
}
