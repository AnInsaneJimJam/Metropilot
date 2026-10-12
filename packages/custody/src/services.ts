// Custody jobs: wallet provisioning, the deposit scanner, the withdrawal gateway and wallet reconciliation.
// Each provider or chain call happens outside any database transaction; state changes before and after it are
// separate short transactions, so a crash between them leaves a record that reconciles instead of repeating.
import type pg from 'pg';
import {
  claimWithdrawalForDispatch, failWithdrawalBeforeSend, finalizeDeposit, finalizeWithdrawal, getReservation, markWithdrawalReconciling,
  observeDeposit, openWithdrawals, recordWithdrawalSubmitted, reconcileWallet,
} from '@monad-hack/accounting';
import type { AcceptedAsset, ReconcileReport } from '@monad-hack/accounting';
import type { ChainReader } from './chain.ts';
import { ChainError, NATIVE_TOKEN } from './chain.ts';
import { ProviderError, erc20TransferData } from './provider.ts';
import type { CustodyProvider } from './provider.ts';
import { uuidv7 } from '@monad-hack/accounting';

/** One asset on one chain: an ERC-20 contract, or the native gas token. */
export interface ChainAsset {
  readonly assetRef: string;
  readonly chainId: number;
  readonly token: string | 'native';
  readonly decimals: number;
  /** Accepted as funding (credited on deposit). Other tokens are quarantined. */
  readonly funding: boolean;
}

export interface CustodyConfig {
  readonly networkRef: string;
  readonly chainId: number;
  readonly assets: readonly ChainAsset[];
  readonly gasAssetRef: string;
  /** First block the scanner reads when it has no cursor. */
  readonly startHeight: bigint;
}

async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

export interface WalletView {
  readonly id: string;
  readonly address: string;
  readonly chainId: number;
  readonly networkRef: string;
  readonly provider: string;
  readonly status: string;
}

export async function walletFor(c: Pick<pg.ClientBase, 'query'>, tenantId: string, agentId: string, chainId: number): Promise<(WalletView & { providerWalletId: string }) | undefined> {
  const r = await c.query<{ id: string; address: string; chain_id: number; network_ref: string; provider: string; status: string; provider_wallet_id: string }>(
    'select id, address, chain_id, network_ref, provider, status, provider_wallet_id from wallets where tenant_id = $1 and agent_id = $2 and chain_id = $3', [tenantId, agentId, chainId]);
  const w = r.rows[0];
  return w ? { id: w.id, address: w.address, chainId: w.chain_id, networkRef: w.network_ref, provider: w.provider, status: w.status, providerWalletId: w.provider_wallet_id } : undefined;
}

/** One custodial wallet per agent and chain; a retry returns the same wallet (provider idempotency key). */
export async function provisionWallet(pool: pg.Pool, provider: CustodyProvider, config: CustodyConfig, tenantId: string, agentId: string, now: Date): Promise<WalletView> {
  const existing = await walletFor(pool, tenantId, agentId, config.chainId);
  if (existing) return existing;
  const allowedTo = config.assets.filter((a) => a.chainId === config.chainId && a.token !== 'native').map((a) => a.token as string);
  await pool.query('insert into wallet_provisioning (agent_id, chain_id) values ($1, $2) on conflict do nothing', [agentId, config.chainId]);
  const attempt = (await pool.query<{ attempt: number }>('select attempt from wallet_provisioning where agent_id = $1 and chain_id = $2', [agentId, config.chainId])).rows[0]!.attempt;
  let created;
  try {
    created = await provider.createWallet({ idempotencyKey: `wallet-${agentId}-${config.chainId}-${attempt}`, agentId, policy: { chainId: config.chainId, allowedTo } });
  } catch (error) {
    // The provider replays a cached failure for the same key: the next try uses a new one.
    if (error instanceof ProviderError && error.kind === 'unavailable') {
      await pool.query('update wallet_provisioning set attempt = attempt + 1 where agent_id = $1 and chain_id = $2 and attempt = $3 and attempt < 100', [agentId, config.chainId, attempt]);
    }
    throw error;
  }
  await pool.query(
    `insert into wallets (tenant_id, id, agent_id, network_ref, chain_id, provider, provider_wallet_id, address, provider_policy_id, status, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10) on conflict (agent_id, chain_id) do nothing`,
    [tenantId, uuidv7(now.getTime()), agentId, config.networkRef, config.chainId, provider.name, created.providerWalletId, created.address.toLowerCase(), created.policyId ?? null, now],
  );
  return (await walletFor(pool, tenantId, agentId, config.chainId))!;
}

async function cursor(c: Pick<pg.ClientBase, 'query'>, chainId: number, name: 'observed' | 'finalized', start: bigint): Promise<bigint> {
  const r = await c.query<{ height: string }>('select height from chain_cursors where chain_id = $1 and name = $2', [chainId, name]);
  return r.rows[0] ? BigInt(r.rows[0].height) : start - 1n;
}

async function setCursor(c: Pick<pg.ClientBase, 'query'>, chainId: number, name: 'observed' | 'finalized', height: bigint, now: Date): Promise<void> {
  await c.query(
    `insert into chain_cursors (chain_id, name, height, updated_at) values ($1, $2, $3, $4)
     on conflict (chain_id, name) do update set height = greatest(chain_cursors.height, excluded.height), updated_at = excluded.updated_at`,
    [chainId, name, height.toString(), now]);
}

export interface ScanReport {
  readonly observed: number;
  readonly credited: number;
  readonly abandoned: number;
  readonly finalizedHeight: bigint;
}

/**
 * Observed pass (latest head): pending, unspendable records for display. Finalized pass: re-read logs only up
 * to the finalized height, confirm each block hash is canonical, credit once, and abandon any pending record at
 * or below that height that the canonical chain does not contain.
 */
export class DepositScanner {
  readonly pool: pg.Pool;
  readonly chain: ChainReader;
  readonly config: CustodyConfig;
  readonly batch: bigint;
  constructor(pool: pg.Pool, chain: ChainReader, config: CustodyConfig, batch = 500n) {
    this.pool = pool;
    this.chain = chain;
    this.config = config;
    this.batch = batch;
  }

  #accepted(): AcceptedAsset[] {
    return this.config.assets.filter((a) => a.funding && a.chainId === this.chain.chainId)
      .map((a) => ({ chainId: a.chainId, tokenAddress: a.token === 'native' ? NATIVE_TOKEN : a.token.toLowerCase(), assetRef: a.assetRef, decimals: a.decimals }));
  }

  async #addresses(): Promise<string[]> {
    const r = await this.pool.query<{ address: string }>(`select address from wallets where chain_id = $1 and status = 'active'`, [this.chain.chainId]);
    return r.rows.map((w) => w.address);
  }

  async tick(now: Date): Promise<ScanReport> {
    const addresses = await this.#addresses();
    const accepted = this.#accepted();
    // Every token contract we know about; unaccepted ones are recorded as quarantined.
    const tokens = this.config.assets.filter((a) => a.token !== 'native' && a.chainId === this.chain.chainId).map((a) => a.token as string);
    const native = this.config.assets.some((a) => a.token === 'native' && a.funding && a.chainId === this.chain.chainId);
    const transfers = async (from: bigint, to: bigint) => [
      ...(await Promise.all(tokens.map((t) => this.chain.transferLogs(t, addresses, from, to)))).flat(),
      ...(native ? await this.chain.nativeTransfers(addresses, from, to) : []),
    ];
    let observed = 0;
    const latest = await this.chain.latestHeight();
    const from = (await cursor(this.pool, this.chain.chainId, 'observed', this.config.startHeight)) + 1n;
    const to = latest < from + this.batch - 1n ? latest : from + this.batch - 1n;
    if (addresses.length && to >= from) {
      for (const log of await transfers(from, to)) {
        if (await tx(this.pool, (c) => observeDeposit(c, { ...log, observedAt: now }, accepted))) observed++;
      }
    }
    if (to >= from) await setCursor(this.pool, this.chain.chainId, 'observed', to, now);

    let credited = 0;
    let abandoned = 0;
    const finalized = await this.chain.finalizedHeight();
    const fFrom = (await cursor(this.pool, this.chain.chainId, 'finalized', this.config.startHeight)) + 1n;
    const fTo = finalized < fFrom + this.batch - 1n ? finalized : fFrom + this.batch - 1n;
    if (fTo >= fFrom) {
      const seen = new Set<string>();
      if (addresses.length) {
        {
          for (const log of await transfers(fFrom, fTo)) {
            const canonical = await this.chain.blockHashAt(log.blockNumber);
            if (canonical !== log.blockHash) throw new ChainError('A finalized log is not in the canonical chain; settlement pauses.');
            const receipt = await this.chain.receipt(log.txHash);
            const record = await tx(this.pool, (c) => observeDeposit(c, { ...log, observedAt: now }, accepted));
            if (!record) continue;
            seen.add(`${log.txHash}:${log.logIndex}`);
            const outcome = await tx(this.pool, (c) => finalizeDeposit(c, log.chainId, log.txHash, log.logIndex, {
              receiptSucceeded: receipt?.succeeded === true && receipt.blockHash === canonical, canonicalBlockHash: canonical, finalizedHeight: finalized, at: now,
            }));
            if (outcome === 'credited') credited++;
          }
        }
      }
      // Speculative records in the finalized range that the canonical chain does not contain.
      const stale = await this.pool.query<{ tx_hash: string; log_index: number; block_number: string }>(
        `select tx_hash, log_index, block_number from deposits where chain_id = $1 and state = 'pending' and block_number between $2 and $3`,
        [this.chain.chainId, fFrom.toString(), fTo.toString()]);
      for (const d of stale.rows) {
        if (seen.has(`${d.tx_hash}:${d.log_index}`)) continue;
        const outcome = await tx(this.pool, (c) => finalizeDeposit(c, this.chain.chainId, d.tx_hash, d.log_index, {
          receiptSucceeded: false, canonicalBlockHash: undefined, finalizedHeight: finalized, at: now,
        }));
        if (outcome === 'abandoned') abandoned++;
      }
      await setCursor(this.pool, this.chain.chainId, 'finalized', fTo, now);
    }
    return { observed, credited, abandoned, finalizedHeight: finalized };
  }
}

export interface GatewayReport {
  readonly submitted: number;
  readonly finalized: number;
  readonly failed: number;
  readonly reconciling: number;
}

/** Executes reserved withdrawals through the provider and settles them from finalized receipts. */
export class WithdrawalGateway {
  readonly pool: pg.Pool;
  readonly provider: CustodyProvider;
  readonly chain: ChainReader;
  readonly config: CustodyConfig;
  constructor(pool: pg.Pool, provider: CustodyProvider, chain: ChainReader, config: CustodyConfig) {
    this.pool = pool;
    this.provider = provider;
    this.chain = chain;
    this.config = config;
  }

  #asset(ref: string): ChainAsset {
    const a = this.config.assets.find((x) => x.assetRef === ref && x.chainId === this.chain.chainId);
    if (!a) throw new Error(`Unknown chain asset ${ref}.`);
    return a;
  }

  async tick(now: Date): Promise<GatewayReport> {
    const report = { submitted: 0, finalized: 0, failed: 0, reconciling: 0 };
    for (const w of await openWithdrawals(this.pool)) {
      if (w.state === 'reserved') {
        // A dispatched reservation with no recorded hash means a previous attempt may have sent: reconcile, never resend.
        const reservation = await getReservation(this.pool, w.reservationKey);
        if (reservation?.state !== 'held') {
          await tx(this.pool, (c) => markWithdrawalReconciling(c, w.tenantId, w.id, 'A previous send attempt has no recorded outcome.', now));
          report.reconciling++;
          continue;
        }
        const claimed = await tx(this.pool, (c) => claimWithdrawalForDispatch(c, w.tenantId, w.id, now));
        if (!claimed) continue;
        const wallet = await this.pool.query<{ provider_wallet_id: string; provider_policy_id: string | null }>('select provider_wallet_id, provider_policy_id from wallets where tenant_id = $1 and id = $2', [w.tenantId, w.walletId]);
        const dest = await this.pool.query<{ address: string }>('select address from withdrawal_destinations where tenant_id = $1 and id = $2', [w.tenantId, w.destinationId]);
        const asset = this.#asset(w.assetRef);
        const to = dest.rows[0]!.address;
        try {
          if (asset.token === 'native') {
            // A native transfer goes straight to the recipient: the provider policy must list the verified destinations.
            const verified = await this.pool.query<{ address: string }>('select address from withdrawal_destinations where agent_id = $1 and chain_id = $2 and revoked_at is null', [w.agentId, this.chain.chainId]);
            const tokens = this.config.assets.filter((a) => a.chainId === this.chain.chainId && a.token !== 'native').map((a) => a.token as string);
            await this.provider.allowDestinations(wallet.rows[0]!.provider_wallet_id, wallet.rows[0]!.provider_policy_id ?? undefined, { chainId: this.chain.chainId, allowedTo: [...tokens, ...verified.rows.map((r) => r.address)] });
          }
          const sent = await this.provider.send({
            providerWalletId: wallet.rows[0]!.provider_wallet_id, idempotencyKey: w.id, chainId: this.chain.chainId,
            to: asset.token === 'native' ? to : asset.token, data: asset.token === 'native' ? '0x' : erc20TransferData(to, w.amount), value: asset.token === 'native' ? w.amount : 0n,
          });
          await tx(this.pool, (c) => recordWithdrawalSubmitted(c, w.tenantId, w.id, sent.txHash, now));
          report.submitted++;
        } catch (error) {
          if (error instanceof ProviderError && error.kind === 'refused') {
            await tx(this.pool, (c) => failWithdrawalBeforeSend(c, w.tenantId, w.id, error.message, now));
            report.failed++;
          } else {
            await tx(this.pool, (c) => markWithdrawalReconciling(c, w.tenantId, w.id, 'The provider did not confirm the send.', now));
            report.reconciling++;
          }
        }
        continue;
      }
      if (!w.txHash) continue; // reconciling without a hash: operator investigates with the provider; never resent.
      const receipt = await this.chain.receipt(w.txHash);
      const finalized = await this.chain.finalizedHeight();
      if (!receipt || receipt.blockNumber > finalized) continue;
      if ((await this.chain.blockHashAt(receipt.blockNumber)) !== receipt.blockHash) continue;
      const done = await tx(this.pool, (c) => finalizeWithdrawal(c, w.tenantId, w.id, { succeeded: receipt.succeeded, gasUsed: receipt.feeAtomic, txHash: receipt.txHash }, now));
      if (done.state === 'finalized') report.finalized++;
      else report.failed++;
    }
    return report;
  }
}

/**
 * Compare finalized on-chain balances with the ledger for every live wallet and asset. Skips a wallet with an
 * unsettled send (its effect cannot be explained yet). A difference freezes that agent's outflows.
 */
export async function reconcileWallets(pool: pg.Pool, chain: ChainReader, config: CustodyConfig, now: Date): Promise<ReconcileReport[]> {
  const height = await chain.finalizedHeight();
  const wallets = await pool.query<{ id: string; tenant_id: string; agent_id: string; address: string }>(`select id, tenant_id, agent_id, address from wallets where chain_id = $1 and status = 'active'`, [chain.chainId]);
  const reports: ReconcileReport[] = [];
  for (const w of wallets.rows) {
    const open = await pool.query(`select 1 from withdrawals where wallet_id = $1 and state in ('submitted', 'reconciling') limit 1`, [w.id]);
    if (open.rowCount) continue;
    for (const asset of config.assets.filter((a) => a.chainId === chain.chainId && (a.funding || a.assetRef === config.gasAssetRef))) {
      const onChain = asset.token === 'native' ? await chain.nativeBalance(w.address, height) : await chain.erc20Balance(asset.token, w.address, height);
      const pending = await pool.query<{ sum: string | null }>(
        `select sum(amount) as sum from deposits where destination = $1 and asset_ref = $2 and state = 'pending' and block_number <= $3`, [w.address, asset.assetRef, height.toString()]);
      reports.push(await tx(pool, (c) => reconcileWallet(c, {
        mode: 'live', tenantId: w.tenant_id, agentId: w.agent_id, assetRef: asset.assetRef, onChainAtomic: onChain,
        unpostedInboundAtomic: BigInt(pending.rows[0]!.sum ?? '0'), unpostedOutboundAtomic: 0n, observationKey: `block:${height}`, now,
      })));
    }
  }
  return reports;
}
