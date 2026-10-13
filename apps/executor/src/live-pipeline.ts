// Live exact-input pipeline (docs/specs/executor.md sections 9, 11 and 13): prepare, approve, sign, broadcast, finality,
// settlement and recovery for admitted live intents. Every step is one short database transaction; provider and
// chain calls happen between them, never inside. The connector builds and interprets; this module authorizes against
// the frozen intent and the signing-phase policy, and LiveIntents moves holds. One unresolved transaction per wallet.
//
// Recovery rule: an attempt is recorded (with its exact transaction and provider idempotency key) before the provider
// is called. A crash or ambiguous answer re-sends the same transaction under the same key, which the provider
// deduplicates; a new trade is never created for the same intent.
import type pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import { freeze, openFreezes } from '@monad-hack/accounting';
import { evaluateAction } from '@monad-hack/policy';
import type { ActionContext, ActionLimits, Denial } from '@monad-hack/policy';
import {
  buildApproval, buildSwap, decodeApproval, decodeSwap, decodeSwapResult, interpretApprovalReceipt, interpretSwapReceipt, minimumOutput, quote, referenceOutput, RouteError,
} from '@monad-hack/connectors';
import type { FrozenSwap, RouteReader, SwapLeg, UniswapRoute, UnsignedTransaction } from '@monad-hack/connectors';
import { ProviderError, walletPolicyDestinations } from '@monad-hack/custody';
import type { CustodyConfig, CustodyProvider, Receipt } from '@monad-hack/custody';
import type { AuthoritySource } from './authorization.ts';
import { uuidv7 } from './ids.ts';
import type { LiveIntents } from './live.ts';
import { policyLimits } from './service.ts';
import { toRow } from './store.ts';
import type { ExecutorStore, IntentRecord, IntentRow } from './store.ts';

/** Chain reads the pipeline needs (JsonRpcChain satisfies it). */
export interface LiveChain extends RouteReader {
  readonly chainId: number;
  latestHeight(): Promise<bigint>;
  finalizedHeight(): Promise<bigint>;
  blockHashAt(height: bigint): Promise<string | undefined>;
  receipt(txHash: string): Promise<Receipt | undefined>;
  nativeBalance(owner: string, height: bigint): Promise<bigint>;
  erc20Balance(token: string, owner: string, height: bigint): Promise<bigint>;
  erc20Allowance(token: string, owner: string, spender: string, height?: bigint | 'latest'): Promise<bigint>;
  estimateGas(request: { from: string; to: string; data: string; value?: bigint }): Promise<bigint>;
  gasPrice(): Promise<bigint>;
}

export interface LiveRouteConfig {
  readonly connectorRef: string;
  readonly connectorVersion: string;
  readonly route: UniswapRoute;
  /** Catalog asset ref → token; native MON trades as the wrapped token sent as value. */
  readonly assets: Readonly<Record<string, { readonly address: string; readonly native: boolean }>>;
  /** Offered directions [tokenInRef, tokenOutRef]. */
  readonly pairs: readonly (readonly [string, string])[];
  /** Quote lifetime and on-chain deadline. */
  readonly quoteTtlSeconds: number;
  /** Extra gas limit over the estimate, basis points. */
  readonly gasMarginBps: number;
  /** For the provider policy's approved destinations (tokens, router, verified withdrawals). */
  readonly custody: CustodyConfig;
}

interface WalletRow { readonly id: string; readonly address: string; readonly provider_wallet_id: string; readonly provider_policy_id: string | null }
interface AttemptRow {
  readonly tenant_id: string; readonly id: string; readonly intent_id: string; readonly kind: 'approve' | 'swap'; readonly wallet_id: string; readonly chain_id: number;
  readonly idempotency_key: string; readonly to_address: string; readonly data: string; readonly value_atomic: string; readonly gas_limit: string;
  readonly state: 'prepared' | 'sent' | 'ambiguous' | 'refused' | 'finalized' | 'reverted'; readonly tx_hash: string | null; readonly fee_atomic: string | null;
  readonly quote: Record<string, string | boolean> | null;
}

export interface PipelineReport {
  started: number;
  sent: number;
  settled: number;
  failed: number;
  reconciling: number;
}

const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const frozenToJson = (s: FrozenSwap): Record<string, string | boolean> => ({ tokenIn: s.tokenIn, tokenOut: s.tokenOut, nativeIn: s.nativeIn, amountIn: s.amountIn.toString(), recipient: s.recipient, amountOutMinimum: s.amountOutMinimum.toString(), deadline: s.deadline.toString() });
const frozenFromJson = (j: Record<string, string | boolean>): FrozenSwap => ({ tokenIn: String(j['tokenIn']), tokenOut: String(j['tokenOut']), nativeIn: j['nativeIn'] === true, amountIn: BigInt(String(j['amountIn'])), recipient: String(j['recipient']), amountOutMinimum: BigInt(String(j['amountOutMinimum'])), deadline: BigInt(String(j['deadline'])) });
const sameSwap = (a: FrozenSwap, b: FrozenSwap): boolean => JSON.stringify(frozenToJson(a)) === JSON.stringify(frozenToJson(b));

export class LivePipeline {
  readonly #pool: pg.Pool;
  readonly #live: LiveIntents;
  readonly #store: ExecutorStore;
  readonly #chain: LiveChain;
  readonly #provider: CustodyProvider;
  readonly #authority: AuthoritySource;
  readonly #cfg: LiveRouteConfig;
  readonly #onError: (intentId: string, error: unknown) => void;

  constructor(o: { pool: pg.Pool; live: LiveIntents; store: ExecutorStore; chain: LiveChain; provider: CustodyProvider; authority: AuthoritySource; route: LiveRouteConfig; onError?: (intentId: string, error: unknown) => void }) {
    this.#onError = o.onError ?? (() => undefined);
    this.#pool = o.pool;
    this.#live = o.live;
    this.#store = o.store;
    this.#chain = o.chain;
    this.#provider = o.provider;
    this.#authority = o.authority;
    this.#cfg = o.route;
    if (o.chain.chainId !== o.route.route.chainId || o.live.config.chainId !== o.route.route.chainId) throw new Error('Live pipeline chain mismatch.');
  }

  /** One pass: advance in-flight attempts, then continue or start intents whose wallet is free. */
  async tick(now: Date = new Date()): Promise<PipelineReport> {
    const report: PipelineReport = { started: 0, sent: 0, settled: 0, failed: 0, reconciling: 0 };
    const open = await this.#pool.query<AttemptRow>(`select * from transaction_attempts where state in ('prepared', 'sent', 'ambiguous') order by created_at limit 50`);
    for (const a of open.rows) await this.#advance(a, now, report);
    // Intents whose swap attempt finished but did not settle yet (a crash between the two steps).
    const unsettled = await this.#pool.query<AttemptRow>(
      `select a.* from transaction_attempts a join intents i on i.id = a.intent_id where a.kind = 'swap' and a.state in ('finalized', 'reverted') and i.state in ('submitted', 'reconciling') limit 50`);
    for (const a of unsettled.rows) await this.#settle(a, now, report);
    const ready = await this.#pool.query<IntentRecord>(
      `select i.* from intents i where i.mode = 'live' and i.state in ('reserved', 'signing')
         and not exists (select 1 from transaction_attempts a where a.intent_id = i.id and (a.kind = 'swap' or a.state in ('prepared', 'sent', 'ambiguous')))
       order by i.created_at limit 20`);
    for (const record of ready.rows) {
      try {
        if (await this.#prepare(toRow(record), now, report)) report.started++;
      } catch (error) {
        // Chain or provider reads failed before anything was recorded: the next tick retries.
        this.#onError(record.id, error);
      }
    }
    return report;
  }

  async #wallet(id: string): Promise<WalletRow> {
    const r = await this.#pool.query<WalletRow>('select id, address, provider_wallet_id, provider_policy_id from wallets where id = $1', [id]);
    return r.rows[0]!;
  }

  /** One unresolved transaction per wallet: another intent's transaction or a withdrawal in flight waits it out. */
  async #walletBusy(walletId: string, intentId: string): Promise<boolean> {
    const r = await this.#pool.query(
      `select 1 from intents where wallet_id = $1 and id <> $2 and mode = 'live' and state in ('signing', 'signed', 'submitted', 'included', 'finalized', 'reconciling')
       union all select 1 from transaction_attempts where wallet_id = $1 and intent_id <> $2 and state in ('prepared', 'sent', 'ambiguous')
       union all select 1 from withdrawals where wallet_id = $1 and state in ('submitted', 'reconciling') limit 1`, [walletId, intentId]);
    return (r.rowCount ?? 0) > 0;
  }

  async #approvalFee(intentId: string): Promise<bigint> {
    const r = await this.#pool.query<{ fee_atomic: string | null }>(`select fee_atomic from transaction_attempts where intent_id = $1 and kind = 'approve' and state in ('finalized', 'reverted')`, [intentId]);
    return BigInt(r.rows[0]?.fee_atomic ?? '0');
  }

  async #end(row: IntentRow, reason: Denial, now: Date, report: { failed: number }, verdict?: { verdict: ReturnType<typeof evaluateAction>; contextHash: string }): Promise<void> {
    if (row.state === 'reserved') await this.#live.cancel(row.id, reason, now, verdict);
    else await this.#live.failAfterSigning(row.id, reason, await this.#approvalFee(row.id), now);
    report.failed++;
  }

  /**
   * Prepare the next transaction for a reserved intent (or a signing one whose approval finalized): re-read balances,
   * quote, reference, gas; evaluate the signing-phase policy; build, decode and simulate; record the attempt; send.
   */
  async #prepare(row: IntentRow, now: Date, report: { sent: number; failed: number }): Promise<boolean> {
    const cfg = this.#cfg;
    const authority = await this.#authority.current(row.tenantId, row.deploymentId);
    if (!authority || authority.generation !== row.generation || authority.desiredState !== 'active') {
      await this.#end(row, { code: authority?.desiredState === 'paused' ? 'EXECUTOR_DEPLOYMENT_INACTIVE' : 'EXECUTOR_STALE_GENERATION', message: 'The deployment changed before the swap was signed.' }, now, report);
      return false;
    }
    if (await this.#walletBusy(row.walletId!, row.id)) return false;
    const wallet = await this.#wallet(row.walletId!);
    const tin = cfg.assets[row.action.tokenInRef];
    const tout = cfg.assets[row.action.tokenOutRef];
    const offered = cfg.pairs.some(([a, b]) => a === row.action.tokenInRef && b === row.action.tokenOutRef);
    if (!tin || !tout || tout.native || !offered || row.action.connectorRef !== cfg.connectorRef || row.action.connectorVersion !== cfg.connectorVersion) {
      await this.#end(row, { code: 'EXECUTOR_ASSET_NOT_ALLOWED', message: 'This connector does not offer that pair.' }, now, report);
      return false;
    }
    const amountIn = row.inputAtomic!;
    const leg: SwapLeg = { tokenIn: tin.address, tokenOut: tout.address, nativeIn: tin.native, amountIn };
    const [latest, finalized, gasPrice] = await Promise.all([this.#chain.latestHeight(), this.#chain.finalizedHeight(), this.#chain.gasPrice()]);
    const [q, reference, native, held, allowance] = await Promise.all([
      quote(this.#chain, cfg.route, leg, 'latest'),
      referenceOutput(this.#chain, cfg.route, leg, finalized),
      this.#chain.nativeBalance(wallet.address, latest),
      tin.native ? Promise.resolve(amountIn) : this.#chain.erc20Balance(tin.address, wallet.address, latest),
      tin.native ? Promise.resolve(amountIn) : this.#chain.erc20Allowance(tin.address, wallet.address, cfg.route.router, 'latest'),
    ]);
    const quotedAt = now.getTime();
    const limitsSnapshot = await this.#store.loadPolicyLimits(row.tenantId, row.agentId, authority.policyVersion);
    const limits: ActionLimits[] = [this.#live.config.platformLimits, policyLimits(limitsSnapshot, row.action.tokenInRef), { maxSlippageBps: row.action.maxSlippageBps }];
    const slippage = Math.min(...limits.map((l) => l.maxSlippageBps).filter((v): v is number => v !== undefined));
    const swap: FrozenSwap = { ...leg, recipient: wallet.address, amountOutMinimum: minimumOutput(q.expectedOutputAtomic, slippage), deadline: BigInt(Math.floor(quotedAt / 1000) + cfg.quoteTtlSeconds) };
    const needApproval = !tin.native && allowance < amountIn;
    const approveTx = needApproval ? buildApproval(cfg.route, tin.address, amountIn) : undefined;
    const swapTx = buildSwap(cfg.route, swap);
    // The built transactions must decode back to exactly what is being authorized.
    if (!sameSwap(decodeSwap(cfg.route, swapTx), swap)) throw new RouteError('The built swap does not decode to the frozen swap.');
    if (approveTx) {
      const a = decodeApproval(cfg.route, approveTx);
      if (a.token !== tin.address.toLowerCase() || a.amount !== amountIn) throw new RouteError('The built approval does not match the input.');
    }
    const margin = (gas: bigint) => (gas * BigInt(10_000 + cfg.gasMarginBps)) / 10_000n;
    const call = (tx: UnsignedTransaction) => ({ from: wallet.address, to: tx.to, data: tx.data, value: tx.value });
    const approvalGas = approveTx ? margin(await this.#chain.estimateGas(call(approveTx))) : 0n;
    // Without the allowance yet, the swap cannot be estimated; the quoter's estimate plus margin bounds it now and
    // the swap is re-estimated after the approval finalizes.
    let swapGas = margin(q.gasEstimate + 60_000n);
    let simulated: bigint | undefined;
    if (!approveTx) {
      try {
        simulated = decodeSwapResult(await this.#chain.simulate(call(swapTx), 'latest'));
        swapGas = margin(await this.#chain.estimateGas(call(swapTx)));
      } catch {
        simulated = undefined;
      }
    }
    const spentApproval = await this.#approvalFee(row.id);
    const feeCeiling = (approvalGas + swapGas) * gasPrice + spentApproval;
    const window = await this.#pool.query<{ notional_usd_micros: string; day: Date }>('select notional_usd_micros, window_day as day from reservations where operation_key = $1', [row.reservationKey]);
    const own = BigInt(window.rows[0]?.notional_usd_micros ?? '0');
    const usage = await this.#pool.query<{ pending: string; committed: string }>(
      `select pending_notional_usd_micros as pending, committed_notional_usd_micros as committed from spend_windows where scope_key = $1 and mode = 'live' and day = $2`,
      [`agent:${row.agentId}`, window.rows[0]?.day ?? now]);
    const used = usage.rows[0] ? BigInt(usage.rows[0].pending) + BigInt(usage.rows[0].committed) : 0n;
    const freezes = await openFreezes(this.#pool, 'live', row.tenantId, row.agentId);
    const context: ActionContext = {
      mode: 'live', phase: 'signing', deploymentActive: true, connectorEnabled: true, assetsAllowed: true, requestedSlippageBps: row.action.maxSlippageBps, limits,
      resolvedInputAtomic: amountIn, availableInputAtomic: held < amountIn ? held : amountIn, actionsInWindow: 0, nowMillis: quotedAt,
      // The reference is read now from a finalized block.
      valuation: { observedAtMillis: quotedAt, maxAgeSeconds: this.#live.config.maxValuationAgeSeconds },
      identity: {
        capabilityTenantId: row.tenantId, capabilityAgentId: row.agentId, capabilityDeploymentId: row.deploymentId, capabilityGeneration: row.generation,
        tenantId: authority.tenantId, agentId: authority.agentId, deploymentId: authority.deploymentId, currentGeneration: authority.generation, fundingOwnerAgentId: authority.agentId,
      },
      chain: { chainId: cfg.route.chainId, recipient: swap.recipient, agentWallet: wallet.address },
      quote: { quotedAtMillis: quotedAt, expiresAtMillis: quotedAt + cfg.quoteTtlSeconds * 1000, inputAtomic: amountIn, expectedOutputAtomic: q.expectedOutputAtomic, minOutputAtomic: swap.amountOutMinimum, referenceOutputAtomic: reference },
      gas: { ceilingAtomic: feeCeiling, availableNativeAtomic: native - (tin.native ? amountIn : 0n) },
      allowance: needApproval ? { required: true, spender: cfg.route.router, approvalAtomic: amountIn } : { required: false },
      notional: { notionalUsdMicros: own, windowNotionalUsdMicros: used - own },
      // Admission denies nodes under `if` until branch evidence is verified, so an admitted intent has it.
      branchEvidenceVerified: true, signerReady: true, reconciliationOpen: freezes.length > 0,
    };
    let verdict = evaluateAction(context);
    let denial: Denial | undefined = verdict.allow ? undefined : verdict.denials[0];
    // The action counter was already taken at admission; reservation total must still cover the fee ceiling.
    if (!denial && feeCeiling > this.#live.config.gasCeilingAtomic) denial = { code: 'EXECUTOR_GAS_LIMIT_EXCEEDED', message: 'The fee estimate is above the gas reserved for this trade.' };
    if (!denial && !approveTx && (simulated === undefined || simulated < swap.amountOutMinimum)) denial = { code: 'EXECUTOR_SIMULATION_FAILED', message: 'The exact swap did not simulate to at least the minimum output.' };
    if (denial && verdict.allow) verdict = { allow: false, policyVersion: verdict.policyVersion, denials: [denial] };
    const contextHash = await contentHash(jsonSafe({ phase: 'signing', logicalKey: row.logicalKey, context, swap, approval: approveTx ? amountIn : null }));
    if (denial) {
      await this.#end(row, denial, now, report, { verdict, contextHash });
      return false;
    }
    if (row.state === 'reserved') await this.#live.markSigning(row.id, verdict, contextHash, now);
    const kind = approveTx ? 'approve' : 'swap';
    const tx = approveTx ?? swapTx;
    const attempt = await this.#record(row, wallet, kind, tx, kind === 'approve' ? approvalGas : swapGas, kind === 'swap' ? swap : undefined, now);
    await this.#send(attempt, now, report);
    return true;
  }

  async #record(row: IntentRow, wallet: WalletRow, kind: 'approve' | 'swap', tx: UnsignedTransaction, gasLimit: bigint, swap: FrozenSwap | undefined, now: Date): Promise<AttemptRow> {
    const r = await this.#pool.query<AttemptRow>(
      `insert into transaction_attempts (tenant_id, id, intent_id, kind, wallet_id, chain_id, idempotency_key, to_address, data, value_atomic, gas_limit, state, quote, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'prepared', $12, $13, $13)
       on conflict (intent_id, kind) do update set updated_at = transaction_attempts.updated_at returning *`,
      [row.tenantId, uuidv7(now.getTime()), row.id, kind, wallet.id, tx.chainId, `intent:${row.id}:${kind}`, tx.to.toLowerCase(), tx.data.toLowerCase(), tx.value.toString(), gasLimit.toString(), swap ? frozenToJson(swap) : null, now]);
    return r.rows[0]!;
  }

  /** Call the provider for a recorded attempt; the same key and transaction every time. */
  async #send(a: AttemptRow, now: Date, report: { sent: number; failed: number }): Promise<void> {
    const wallet = await this.#wallet(a.wallet_id);
    const intent = toRow((await this.#pool.query<IntentRecord>('select * from intents where id = $1', [a.intent_id])).rows[0]!);
    try {
      // The provider policy must list the router and tokens; refresh replaces the list, so it is built in one place.
      await this.#provider.allowDestinations(wallet.provider_wallet_id, wallet.provider_policy_id ?? undefined, {
        chainId: a.chain_id, allowedTo: await walletPolicyDestinations(this.#pool, this.#cfg.custody, intent.agentId),
      });
      const sent = await this.#provider.send({
        providerWalletId: wallet.provider_wallet_id, idempotencyKey: a.idempotency_key, chainId: a.chain_id,
        to: a.to_address, data: a.data, value: BigInt(a.value_atomic), gasLimit: BigInt(a.gas_limit),
      });
      await this.#pool.query(`update transaction_attempts set state = 'sent', tx_hash = $2, updated_at = $3 where id = $1 and state in ('prepared', 'ambiguous')`, [a.id, sent.txHash.toLowerCase(), now]);
      if (a.kind === 'swap') await this.#live.markSubmitted(a.intent_id, sent.txHash, now);
      report.sent++;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'refused') {
        // Definitively not broadcast: nothing to reconcile.
        await this.#pool.query(`update transaction_attempts set state = 'refused', updated_at = $2 where id = $1`, [a.id, now]);
        await this.#live.failAfterSigning(a.intent_id, { code: 'EXECUTOR_PROVIDER_UNAVAILABLE', message: 'The wallet provider refused the transaction.' }, await this.#approvalFee(a.intent_id), now);
        report.failed++;
        return;
      }
      // Unknown outcome: keep every hold; the next tick asks again with the same key.
      await this.#pool.query(`update transaction_attempts set state = 'ambiguous', updated_at = $2 where id = $1 and state in ('prepared', 'ambiguous')`, [a.id, now]);
      if (a.kind === 'swap') await this.#live.markReconciling(a.intent_id, 'The provider did not confirm the swap; recovering with the same request.', now);
    }
  }

  async #advance(a: AttemptRow, now: Date, report: PipelineReport): Promise<void> {
    if (a.state === 'prepared' || a.state === 'ambiguous') {
      await this.#send(a, now, report);
      return;
    }
    const receipt = await this.#chain.receipt(a.tx_hash!);
    if (!receipt) return;
    const finalized = await this.#chain.finalizedHeight();
    // Inclusion is provisional: only a receipt at or below the finalized height on the canonical chain counts.
    if (receipt.blockNumber > finalized || (await this.#chain.blockHashAt(receipt.blockNumber)) !== receipt.blockHash) return;
    const state = receipt.succeeded ? 'finalized' : 'reverted';
    await this.#pool.query(
      `update transaction_attempts set state = $2, block_number = $3, block_hash = $4, fee_atomic = $5, updated_at = $6 where id = $1 and state = 'sent'`,
      [a.id, state, receipt.blockNumber.toString(), receipt.blockHash, receipt.feeAtomic.toString(), now]);
    const done: AttemptRow = { ...a, state, fee_atomic: receipt.feeAtomic.toString() };
    if (a.kind === 'swap') {
      await this.#settle(done, now, report, receipt);
      return;
    }
    const wallet = await this.#wallet(a.wallet_id);
    try {
      const ok = interpretApprovalReceipt(this.#cfg.route, decodeApproval(this.#cfg.route, { chainId: a.chain_id, to: a.to_address, data: a.data, value: BigInt(a.value_atomic) }), receipt, wallet.address);
      // Success: the intent stays signing and the next tick re-quotes and sends the swap.
      if (!ok) {
        await this.#live.failAfterSigning(a.intent_id, { code: 'EXECUTOR_SIMULATION_FAILED', message: 'The approval reverted on chain; only its gas was charged.' }, receipt.feeAtomic, now);
        report.failed++;
      }
    } catch (error) {
      if (!(error instanceof RouteError)) throw error;
      await this.#unexpected(a, error.message, now);
      report.reconciling++;
    }
  }

  /** Settle a finished swap attempt from its canonical receipt: actual movements and all gas, exactly once. */
  async #settle(a: AttemptRow, now: Date, report: PipelineReport, known?: Receipt): Promise<void> {
    const receipt = known ?? (await this.#chain.receipt(a.tx_hash!));
    if (!receipt || receipt.blockHash !== (await this.#chain.blockHashAt(receipt.blockNumber))) return;
    const wallet = await this.#wallet(a.wallet_id);
    const swap = frozenFromJson(a.quote!);
    const gas = receipt.feeAtomic + (await this.#approvalFee(a.intent_id));
    let effects;
    try {
      if (!sameSwap(decodeSwap(this.#cfg.route, { chainId: a.chain_id, to: a.to_address, data: a.data, value: BigInt(a.value_atomic) }), swap)) throw new RouteError('The sent swap differs from the frozen swap.');
      effects = interpretSwapReceipt(this.#cfg.route, swap, receipt, wallet.address);
    } catch (error) {
      if (!(error instanceof RouteError)) throw error;
      await this.#unexpected(a, error.message, now);
      report.reconciling++;
      return;
    }
    const row = await this.#live.settleFinalized(a.intent_id, effects.succeeded
      ? { txHash: a.tx_hash!, succeeded: true, inputAtomic: effects.inputAtomic, outputAtomic: effects.outputAtomic, gasAtomic: gas }
      : { txHash: a.tx_hash!, succeeded: false, inputAtomic: 0n, outputAtomic: 0n, gasAtomic: gas }, now);
    if (row.state === 'settled') report.settled++;
    else if (row.state === 'failed') report.failed++;
    else report.reconciling++;
  }

  /** Movements the authorization does not explain: freeze the agent's live outflows and leave the intent reconciling. */
  async #unexpected(a: AttemptRow, detail: string, now: Date): Promise<void> {
    const row = toRow((await this.#pool.query<IntentRecord>('select * from intents where id = $1', [a.intent_id])).rows[0]!);
    await freeze(this.#pool, { mode: 'live', tenantId: row.tenantId, agentId: row.agentId, reasonCode: 'UNEXPECTED_TRADE_EFFECTS', detail: { intentId: row.id, txHash: a.tx_hash ?? '', detail }, sourceKey: `trade-effects:${a.id}`, now });
    if (['signing', 'signed', 'submitted', 'included', 'finalized'].includes(row.state)) await this.#live.markReconciling(row.id, detail, now);
  }
}
