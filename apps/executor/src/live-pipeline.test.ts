// Live Uniswap pipeline end to end on PostgreSQL (executor.md sections 9 and 13; verification V17–V22): admission →
// signing-phase policy → exact approval → swap → canonical finality → settlement of actual movements and all gas;
// ambiguous provider answers recover with the same request; denials, reverts and unexpected effects never settle as a
// trade. The chain is an in-memory pool simulation behind the same reads the real RPC serves; addresses are the
// reviewed mainnet route, but nothing here touches a network or a key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult } from 'viem';
import type { Hex } from 'viem';
import { intentKey } from '../../../packages/contracts/src/index.ts';
import type { ActionIntent, Strategy } from '../../../packages/contracts/src/index.ts';
import { agentBalances, allocate, depositPostings, postJournal } from '../../../packages/accounting/src/index.ts';
import type { AgentScope } from '../../../packages/accounting/src/index.ts';
import { MAINNET_UNISWAP, mainnetRoute, routeAbi, tickPrice } from '../../../packages/connectors/src/index.ts';
import type { UniswapRoute } from '../../../packages/connectors/src/index.ts';
import { ProviderError } from '../../../packages/custody/src/index.ts';
import type { CustodyProvider, Receipt, ReceiptLog, SendRequest } from '../../../packages/custody/src/index.ts';
import { migrate } from '../../api/src/db/migrate.ts';
import { seedPaper } from '../../api/src/db/seed.ts';
import { seedLiveCatalog } from '../../api/src/db/live-catalog.ts';
import { LiveIntents } from './live.ts';
import type { LiveConfig } from './live.ts';
import { LivePipeline } from './live-pipeline.ts';
import type { LiveChain, LiveRouteConfig } from './live-pipeline.ts';
import type { AuthoritySource } from './authorization.ts';
import { ExecutorStore } from './store.ts';
import { databaseSkip, ExecutorTestHarness } from './testing.ts';
import type { Arranged } from './testing.ts';
import { uuidv7 } from './ids.ts';

const skip = await databaseSkip();
const u = MAINNET_UNISWAP;
const CHAIN = 143;
const NETWORK = 'monad-mainnet';
const CONNECTOR = 'mainnet.uniswap-v3';
const E18 = 10n ** 18n;
const GAS_CEILING = 10n ** 15n;
const GAS_PRICE = 10n ** 9n;
const route: UniswapRoute = mainnetRoute();
const NATIVE = 'native';
const h32 = (s: string) => `0x${createHash('sha256').update(s).digest('hex')}`;
const pad = (a: string) => a as Hex;

/** In-memory WMON/USDC pool behind the router and quoter: exact-input swaps at the TWAP price less the 0.3% fee. */
class PoolChain implements LiveChain {
  readonly chainId = CHAIN;
  readonly finalityDepth = 2;
  readonly blocks: string[] = [h32('genesis')];
  readonly receipts = new Map<string, Receipt & { block: number }>();
  pending: { hash: string; run: () => Omit<Receipt, 'blockNumber' | 'blockHash' | 'txHash'> }[] = [];
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  /** TWAP tick (≈ 0.0246 USDC per WMON) and a spot multiplier the quote uses (1 = no manipulation). */
  tick = -313_375;
  spotBps = 10_000n;
  revertSwaps = false;
  /** Pay swap output to this address instead of the recipient (an unexpected effect). */
  divertTo: string | undefined;
  sent = 0;

  bal(token: string, owner: string) {
    return this.balances.get(`${token}:${owner.toLowerCase()}`) ?? 0n;
  }
  #add(token: string, owner: string, delta: bigint) {
    this.balances.set(`${token}:${owner.toLowerCase()}`, this.bal(token, owner) + delta);
  }
  fund(token: string, owner: string, amount: bigint) {
    this.#add(token, owner, amount);
  }
  #price(): { num: bigint; scale: bigint } {
    const [whole, frac = ''] = tickPrice(this.tick, 18, 6, false).split('.');
    return { num: BigInt(whole! + frac), scale: 10n ** BigInt(frac.length) };
  }
  out(tokenIn: string, amountIn: bigint): bigint {
    const { num, scale } = this.#price();
    const fair = tokenIn === u.wmon ? (amountIn * num * 10n ** 6n) / (scale * E18) : (amountIn * scale * E18) / (num * 10n ** 6n);
    return (fair * 9_970n * this.spotBps) / (10_000n * 10_000n);
  }
  mine(n = 1) {
    for (let i = 0; i < n; i++) {
      const height = this.blocks.length;
      const hash = h32(`block:${height}`);
      this.blocks.push(hash);
      for (const p of this.pending) this.receipts.set(p.hash, { ...p.run(), txHash: p.hash, blockNumber: BigInt(height), blockHash: hash, block: height });
      this.pending = [];
    }
  }

  async latestHeight() { return BigInt(this.blocks.length - 1); }
  async finalizedHeight() { return BigInt(Math.max(0, this.blocks.length - 1 - this.finalityDepth)); }
  async blockHashAt(height: bigint) { return this.blocks[Number(height)]; }
  async receipt(hash: string) { return this.receipts.get(hash); }
  async nativeBalance(owner: string) { return this.bal(NATIVE, owner); }
  async erc20Balance(token: string, owner: string) { return this.bal(token.toLowerCase(), owner); }
  async erc20Allowance(token: string, owner: string, spender: string) { return this.allowances.get(`${token.toLowerCase()}:${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n; }
  async estimateGas(r: { data: string }) { return r.data.startsWith('0x095ea7b3') ? 50_000n : 180_000n; }
  async gasPrice() { return GAS_PRICE; }

  #swapArgs(data: string) {
    const outer = decodeFunctionData({ abi: routeAbi, data: data as Hex });
    const inner = decodeFunctionData({ abi: routeAbi, data: (outer.args as readonly [bigint, readonly Hex[]])[1][0]! });
    return (inner.args as readonly [{ tokenIn: string; tokenOut: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint }])[0];
  }
  async simulate(r: { from: string; to: string; data: string; value?: bigint }): Promise<string> {
    const to = r.to.toLowerCase();
    if (to === u.quoter) {
      const p = (decodeFunctionData({ abi: routeAbi, data: r.data as Hex }).args as readonly [{ tokenIn: string; amountIn: bigint }])[0];
      return encodeFunctionResult({ abi: routeAbi, functionName: 'quoteExactInputSingle', result: [this.out(p.tokenIn.toLowerCase(), p.amountIn), 0n, 0, 150_000n] });
    }
    if (to === u.pool) return encodeFunctionResult({ abi: routeAbi, functionName: 'observe', result: [[0n, BigInt(this.tick) * 30n], [0n, 0n]] });
    if (to === u.router) {
      const p = this.#swapArgs(r.data);
      const out = this.out(p.tokenIn.toLowerCase(), p.amountIn);
      if (out < p.amountOutMinimum) throw new Error('Too little received');
      return encodeFunctionResult({ abi: routeAbi, functionName: 'multicall', result: [encodeFunctionResult({ abi: routeAbi, functionName: 'exactInputSingle', result: out })] });
    }
    throw new Error(`unexpected call to ${to}`);
  }

  /** Broadcast: the fee is the full gas limit (Monad), applied when the block is mined. */
  submit(from: string, req: SendRequest): string {
    const hash = h32(`tx:${req.idempotencyKey}`);
    this.sent++;
    const wallet = from.toLowerCase();
    const fee = req.gasLimit! * GAS_PRICE;
    const log = (address: string, eventName: 'Transfer' | 'Approval' | 'Swap', args: Record<string, string>, types: { type: string }[], values: unknown[]): ReceiptLog => ({
      address, topics: encodeEventTopics({ abi: routeAbi, eventName, args } as never) as string[], data: encodeAbiParameters(types, values as never), logIndex: 0,
    });
    this.pending.push({ hash, run: () => {
      this.#add(NATIVE, wallet, -fee);
      if (req.to.toLowerCase() !== u.router) {
        const [spender, amount] = decodeFunctionData({ abi: routeAbi, data: req.data as Hex }).args as readonly [string, bigint];
        this.allowances.set(`${req.to.toLowerCase()}:${wallet}:${spender.toLowerCase()}`, amount);
        return { succeeded: true, feeAtomic: fee, logs: [log(req.to.toLowerCase(), 'Approval', { owner: pad(wallet), spender: pad(spender) }, [{ type: 'uint256' }], [amount])] };
      }
      const p = this.#swapArgs(req.data);
      const tin = p.tokenIn.toLowerCase();
      const tout = p.tokenOut.toLowerCase();
      const out = this.out(tin, p.amountIn);
      if (this.revertSwaps || out < p.amountOutMinimum) return { succeeded: false, feeAtomic: fee, logs: [] };
      const recipient = (this.divertTo ?? p.recipient).toLowerCase();
      if (req.value > 0n) this.#add(NATIVE, wallet, -req.value);
      else {
        this.#add(tin, wallet, -p.amountIn);
        const key = `${tin}:${wallet}:${u.router}`;
        this.allowances.set(key, (this.allowances.get(key) ?? 0n) - p.amountIn);
      }
      this.#add(tout, recipient, out);
      const payer = req.value > 0n ? u.router : wallet;
      const inIs0 = tin === u.wmon;
      return {
        succeeded: true, feeAtomic: fee, logs: [
          log(tout, 'Transfer', { from: pad(u.pool), to: pad(recipient) }, [{ type: 'uint256' }], [out]),
          log(tin, 'Transfer', { from: pad(payer), to: pad(u.pool) }, [{ type: 'uint256' }], [p.amountIn]),
          log(u.pool, 'Swap', { sender: pad(u.router), recipient: pad(recipient) }, [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [inIs0 ? p.amountIn : -out, inIs0 ? -out : p.amountIn, 1n, 1n, this.tick]),
        ],
      };
    } });
    return hash;
  }
}

/** Provider with request deduplication by idempotency key; can lose an answer after broadcasting. */
class Provider implements CustodyProvider {
  readonly name = 'local' as const;
  readonly wallets = new Map<string, string>();
  readonly byKey = new Map<string, string>();
  readonly policies: string[][] = [];
  readonly chain: PoolChain;
  loseNextAnswer = false;
  refuseNext = false;
  constructor(chain: PoolChain) {
    this.chain = chain;
  }
  async createWallet(): Promise<never> { throw new Error('not used'); }
  async allowDestinations(_id: string, _p: string | undefined, policy: { allowedTo: readonly string[] }) { this.policies.push([...policy.allowedTo]); }
  async send(req: SendRequest) {
    if (this.refuseNext) {
      this.refuseNext = false;
      throw new ProviderError('refused', 'Policy denied (test).');
    }
    const existing = this.byKey.get(req.idempotencyKey);
    const hash = existing ?? this.chain.submit(this.wallets.get(req.providerWalletId)!, req);
    this.byKey.set(req.idempotencyKey, hash);
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new ProviderError('unavailable', 'Timed out after broadcast (test).');
    }
    return { txHash: hash };
  }
}

const STRATEGY: Strategy = {
  schemaVersion: 'strategy/1', id: 'live_uni', name: 'Live Uniswap (test)',
  triggers: [{
    id: 'hourly', type: 'schedule', intervalSeconds: 3600, anchorAt: '2026-10-01T00:00:00.000Z',
    body: [
      { id: 'sell_wmon', type: 'swap.exactInput', connectorRef: CONNECTOR, tokenInRef: 'mainnet.WMON', tokenOutRef: 'mainnet.USDC', amount: { kind: 'fixed', atomic: E18.toString() }, maxSlippageBps: 50 },
      { id: 'sell_mon', type: 'swap.exactInput', connectorRef: CONNECTOR, tokenInRef: 'mainnet.MON', tokenOutRef: 'mainnet.USDC', amount: { kind: 'fixed', atomic: E18.toString() }, maxSlippageBps: 50 },
    ],
  }],
  limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 3, maxActiveSecondsPerRun: 60 },
};

const live: LiveConfig = {
  chainId: CHAIN, networkRef: NETWORK, gasAssetRef: 'mainnet.MON', gasCeilingAtomic: GAS_CEILING, holdSeconds: 120, maxValuationAgeSeconds: 60,
  platformLimits: {
    allowedChainIds: [CHAIN], maxInputAtomic: 100n * E18, dailyActionCount: 20, dailyNotionalUsdMicros: 1_000_000_000n, maxSlippageBps: 100, maxQuoteAgeSeconds: 30,
    maxReferenceDeviationBps: 100, maxGasAtomic: GAS_CEILING, minNativeReserveAtomic: 10n ** 16n, maxApprovalAtomic: 100n * E18, allowedSpenders: [u.router],
  },
  valuation: { usdMicrosPerToken: async (ref) => (ref === 'mainnet.USDC' ? { usdMicros: 1_000_000n, decimals: 6, observedAt: new Date().toISOString() } : { usdMicros: 24_600n, decimals: 18, observedAt: new Date().toISOString() }) },
};

describe('live Uniswap pipeline', { skip }, () => {
  let h: ExecutorTestHarness;
  let chain: PoolChain;
  let provider: Provider;
  let pipeline: LivePipeline;
  let routeConfig: LiveRouteConfig;
  before(async () => {
    h = await ExecutorTestHarness.start({ migrate, seed: seedPaper, wiring: { live } });
    const c = await h.pool.connect();
    try {
      await seedLiveCatalog(c);
    } finally {
      c.release();
    }
    chain = new PoolChain();
    provider = new Provider(chain);
    routeConfig = {
      connectorRef: CONNECTOR, connectorVersions: ['1.0.0'], route, quoteTtlSeconds: 60, gasMarginBps: 2_000,
      assets: { 'mainnet.MON': { address: u.wmon, native: true }, 'mainnet.WMON': { address: u.wmon, native: false }, 'mainnet.USDC': { address: u.usdc, native: false } },
      pairs: [['mainnet.MON', 'mainnet.USDC'], ['mainnet.WMON', 'mainnet.USDC'], ['mainnet.USDC', 'mainnet.WMON']],
      custody: { networkRef: NETWORK, chainId: CHAIN, gasAssetRef: 'mainnet.MON', startHeight: 0n, assets: [{ assetRef: 'mainnet.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }], tradingContracts: [u.router, u.wmon, u.usdc] },
    };
    pipeline = new LivePipeline({ pool: h.pool, live: new LiveIntents(h.pool, live), store: new ExecutorStore(h.pool), chain, provider, authority: h.authority, route: routeConfig, onError: (id, e) => console.error('pipeline', id, e) });
  });
  after(async () => {
    await h?.stop();
  });

  let n = 0;
  async function arrange(): Promise<Arranged & { scope: AgentScope; wallet: string; cap: () => string }> {
    const a = await h.arrange({ strategy: STRATEGY, policyLimits: { maxSlippageBps: 50, dailyActionCount: 24 } });
    await h.pool.query(`update deployments set mode = 'live', simulation_account_id = null, network_ref = $2, connector_versions = $3 where id = $1`, [a.deploymentId, NETWORK, { [CONNECTOR]: '1.0.0' }]);
    h.authority.set(a.deploymentId, { mode: 'live', networkRef: NETWORK, connectorPins: { [CONNECTOR]: '1.0.0' } });
    const { simulationAccountId: _ignored, ...rest } = h.authority.deployments.get(a.deploymentId)!;
    h.authority.deployments.set(a.deploymentId, rest);
    const wallet = `0x${(++n).toString(16).padStart(40, 'a')}`;
    const providerId = `local-${a.agentId}`;
    provider.wallets.set(providerId, wallet);
    await h.pool.query(`insert into wallets (tenant_id, id, agent_id, network_ref, chain_id, provider, provider_wallet_id, address, status, created_at) values ($1, $2, $3, $4, $5, 'local', $6, $7, 'active', now())`,
      [a.tenantId, uuidv7(), a.agentId, NETWORK, CHAIN, providerId, wallet]);
    const scope: AgentScope = { mode: 'live', tenantId: a.tenantId, agentId: a.agentId };
    const funds: [string, bigint][] = [['mainnet.WMON', 5n * E18], ['mainnet.MON', 5n * E18]];
    chain.fund(u.wmon, wallet, 5n * E18);
    chain.fund(NATIVE, wallet, 5n * E18);
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      for (const [asset, amount] of funds) {
        await postJournal(c, { operationKey: `fund:${a.agentId}:${asset}`, mode: 'live', tenantId: a.tenantId, agentId: a.agentId, kind: 'deposit', postings: depositPostings(scope, asset, amount), occurredAt: new Date() });
        const v = (await c.query<{ budget_version: number }>('select budget_version from agents where id = $1', [a.agentId])).rows[0]!.budget_version;
        await allocate(c, { scope, assetRef: asset, expectedBudgetVersion: v, targets: { trading: amount }, actor: 'test', now: new Date() });
      }
      await c.query('commit');
    } finally {
      c.release();
    }
    return { ...a, scope, wallet, cap: () => a.capability({ mode: 'live', connectors: { [CONNECTOR]: '1.0.0' } }) };
  }
  const intentFor = async (a: Arranged, nodeId: 'sell_wmon' | 'sell_mon'): Promise<ActionIntent> => ({
    schemaVersion: 'action-intent/1', logicalKey: await intentKey({ deploymentId: a.deploymentId, generation: a.generation, runId: a.runId, nodeId, iterationPath: [] }),
    runId: a.runId, nodeId, iterationPath: [], connectorRef: CONNECTOR, connectorVersion: '1.0.0', action: 'swap.exactInput',
    tokenInRef: nodeId === 'sell_wmon' ? 'mainnet.WMON' : 'mainnet.MON', tokenOutRef: 'mainnet.USDC', amount: { kind: 'fixed', atomic: E18.toString() }, maxSlippageBps: 50, observationRefs: [],
  });
  const admit = async (a: Arranged & { cap: () => string }, node: 'sell_wmon' | 'sell_mon') => {
    const r = await h.post(await intentFor(a, node), a.cap());
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json['state'], 'reserved', JSON.stringify(r.json['reason']));
    return r.json['intentId'] as string;
  };
  const state = async (id: string) => (await h.pool.query<{ state: string; reason_code: string | null }>('select state, reason_code from intents where id = $1', [id])).rows[0]!;
  const trading = async (scope: AgentScope, asset: string) => {
    const row = (await agentBalances(h.pool, scope)).find((b) => b.kind === 'user' && b.bucket === 'trading' && b.assetRef === asset);
    return { balance: row?.balance ?? 0n, held: row?.held ?? 0n };
  };
  const finalize = async () => {
    chain.mine(chain.finalityDepth + 1);
    return pipeline.tick();
  };

  test('ERC-20 input: exact approval, then a fresh quote and the swap; actual movements and both fees settle once', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_wmon');
    const sentBefore = chain.sent;
    await pipeline.tick();
    assert.equal((await state(id)).state, 'signing', 'approval sent, holds dispatched');
    assert.ok(provider.policies.at(-1)!.includes(u.router) && provider.policies.at(-1)!.includes(u.usdc), 'provider policy lists the router and tokens');
    await finalize(); // approval final → swap prepared and sent in the same pass
    assert.equal((await state(id)).state, 'submitted');
    await finalize();
    assert.equal((await state(id)).state, 'settled');
    assert.equal(chain.sent - sentBefore, 2, 'one approval and one swap');
    const out = chain.out(u.wmon, E18);
    const fees = (60_000n + 216_000n) * GAS_PRICE; // estimates plus the 20% margin, charged in full
    assert.deepEqual(await trading(a.scope, 'mainnet.WMON'), { balance: 4n * E18, held: 0n });
    assert.deepEqual(await trading(a.scope, 'mainnet.USDC'), { balance: out, held: 0n });
    assert.deepEqual(await trading(a.scope, 'mainnet.MON'), { balance: 5n * E18 - fees, held: 0n });
    assert.equal(chain.bal(u.usdc, a.wallet), out, 'ledger matches the simulated chain');
    const attempts = await h.pool.query<{ kind: string; state: string }>('select kind, state from transaction_attempts where intent_id = $1 order by kind', [id]);
    assert.deepEqual(attempts.rows.map((r) => [r.kind, r.state]), [['approve', 'finalized'], ['swap', 'finalized']]);
    await pipeline.tick();
    assert.deepEqual(await trading(a.scope, 'mainnet.USDC'), { balance: out, held: 0n }, 'nothing settles twice');
  });

  test('native MON input needs no approval; a lost provider answer recovers with the same request, no second trade', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    const sentBefore = chain.sent;
    provider.loseNextAnswer = true;
    await pipeline.tick();
    assert.equal((await state(id)).state, 'reconciling', 'ambiguous send keeps every hold');
    await pipeline.tick(); // asks again under the same key → same hash
    assert.equal((await state(id)).state, 'submitted');
    await finalize();
    assert.equal((await state(id)).state, 'settled');
    assert.equal(chain.sent - sentBefore, 1, 'exactly one swap broadcast');
    const fee = 216_000n * GAS_PRICE;
    assert.deepEqual(await trading(a.scope, 'mainnet.MON'), { balance: 5n * E18 - E18 - fee, held: 0n });
    assert.equal(chain.bal(NATIVE, a.wallet), 5n * E18 - E18 - fee);
  });

  test('a quote far from the TWAP reference is denied before signing and releases every hold', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    chain.spotBps = 9_700n; // spot 3% below the oracle
    const sentBefore = chain.sent;
    try {
      await pipeline.tick();
    } finally {
      chain.spotBps = 10_000n;
    }
    assert.deepEqual(await state(id), { state: 'cancelled', reason_code: 'EXECUTOR_QUOTE_INVALID' });
    assert.equal(chain.sent, sentBefore, 'nothing signed');
    assert.deepEqual(await trading(a.scope, 'mainnet.MON'), { balance: 5n * E18, held: 0n });
  });

  test('a reverted swap charges only gas; diverted output freezes the agent and stays reconciling', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    chain.revertSwaps = true;
    await pipeline.tick();
    await finalize();
    chain.revertSwaps = false;
    assert.deepEqual(await state(id), { state: 'failed', reason_code: 'EXECUTOR_SIMULATION_FAILED' });
    assert.deepEqual(await trading(a.scope, 'mainnet.MON'), { balance: 5n * E18 - 216_000n * GAS_PRICE, held: 0n });

    const b = await arrange();
    const id2 = await admit(b, 'sell_mon');
    chain.divertTo = '0x00000000000000000000000000000000000000c3';
    await pipeline.tick();
    await finalize();
    chain.divertTo = undefined;
    assert.equal((await state(id2)).state, 'reconciling');
    const f = await h.pool.query<{ reason_code: string }>('select reason_code from reconciliation_freezes where agent_id = $1 and cleared_at is null', [b.agentId]);
    assert.deepEqual(f.rows.map((r) => r.reason_code), ['UNEXPECTED_TRADE_EFFECTS']);
    assert.equal((await trading(b.scope, 'mainnet.MON')).held > 0n, true, 'holds stay until an operator reconciles');
  });

  test('one unresolved transaction per wallet; a refused send fails the intent without a trade', async () => {
    const a = await arrange();
    const first = await admit(a, 'sell_mon');
    const second = await admit(a, 'sell_wmon');
    await pipeline.tick();
    assert.deepEqual([(await state(first)).state, (await state(second)).state], ['submitted', 'reserved'], 'the second waits for the wallet');
    provider.refuseNext = true; // the second's approval goes out in the pass that settles the first
    await finalize();
    assert.equal((await state(first)).state, 'settled');
    assert.deepEqual(await state(second), { state: 'failed', reason_code: 'EXECUTOR_PROVIDER_UNAVAILABLE' });
    assert.deepEqual(await trading(a.scope, 'mainnet.WMON'), { balance: 5n * E18, held: 0n });
  });
  test('a cancel landing while the swap is prepared stops it before signing; nothing is sent', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    const intents = new LiveIntents(h.pool, live);
    let calls = 0;
    // The second authority read is the recheck at the signing claim: cancel concurrently just before it.
    const racing: AuthoritySource = {
      current: async (t, d) => {
        if (d === a.deploymentId && ++calls === 2) await intents.cancel(id, { code: 'EXECUTOR_QUOTE_INVALID', message: 'Expired (test).' }, new Date());
        return h.authority.current(t, d);
      },
    };
    const p = new LivePipeline({ pool: h.pool, live: intents, store: new ExecutorStore(h.pool), chain, provider, authority: racing, route: routeConfig });
    const sentBefore = chain.sent;
    await p.tick();
    assert.equal(chain.sent, sentBefore, 'no transaction after the holds were released');
    assert.equal((await state(id)).state, 'cancelled');
    assert.deepEqual(await trading(a.scope, 'mainnet.MON'), { balance: 5n * E18, held: 0n });
  });

  test('a crash between the provider answer and the submitted transition recovers from the saved attempt', async () => {
    class CrashOnce extends LiveIntents {
      crash = true;
      override async markSubmitted(intentId: string, txHash: string, now: Date) {
        if (this.crash) {
          this.crash = false;
          throw new Error('Process died (test).');
        }
        return super.markSubmitted(intentId, txHash, now);
      }
    }
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    const p = new LivePipeline({ pool: h.pool, live: new CrashOnce(h.pool, live), store: new ExecutorStore(h.pool), chain, provider, authority: h.authority, route: routeConfig });
    const sentBefore = chain.sent;
    await p.tick();
    chain.mine(chain.finalityDepth + 1);
    await p.tick();
    assert.equal((await state(id)).state, 'settled');
    assert.equal(chain.sent - sentBefore, 1, 'one swap, settled from its saved attempt');
  });

  // Last: disabling a catalog row is permanent for this database.
  test('an asset disabled after admission stops the trade before signing', async () => {
    const a = await arrange();
    const id = await admit(a, 'sell_mon');
    await h.pool.query(`update catalog_versions set disabled_reason = 'Disabled (test).' where ref = 'mainnet.USDC'`);
    const sentBefore = chain.sent;
    await pipeline.tick();
    assert.equal(chain.sent, sentBefore);
    assert.deepEqual(await state(id), { state: 'cancelled', reason_code: 'EXECUTOR_ASSET_NOT_ALLOWED' });
  });
});
