// G5 custody, deposits, metering and withdrawals against a real PostgreSQL and the local chain stand-in
// (funds-and-budgets.md sections 3, 5, 7 and 8; verification V09–V12). The local chain is labelled local and
// models finality depth, reorgs, reverts and fees; real-network evidence is gated by E03/E04/E06.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  AccountingError, agentBalances, allocate, depositPostings, postJournal, chargeHostingSlice, escalateUnknownUsage, markModelUnknown, modelProfilePaused, pendingDeposits, publishRateCard,
  recordModelDispatch, requestWithdrawal, reserveModelCall, resolveUnknownUsage, settleModelUsage, user, uuidv7, withdrawalById,
} from '../packages/accounting/src/index.ts';
import type { AgentScope, StoredRateCard } from '../packages/accounting/src/index.ts';
import { DepositScanner, LocalChain, LocalCustody, NATIVE, WithdrawalGateway, provisionWallet, reconcileWallets } from '../packages/custody/src/index.ts';
import type { CustodyConfig } from '../packages/custody/src/index.ts';
import { databaseSkip, SEED_TENANT, scratchDb } from './scratch-db.ts';
import type { ScratchDb } from './scratch-db.ts';

const skip = await databaseSkip();
const USDC = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const config: CustodyConfig = {
  networkRef: 'local-chain', chainId: 31_337, gasAssetRef: 'local.MON', startHeight: 0n,
  assets: [
    { assetRef: 'local.USD', chainId: 31_337, token: USDC, decimals: 6, funding: true },
    { assetRef: 'local.MON', chainId: 31_337, token: 'native', decimals: 18, funding: true },
    { assetRef: 'local.JUNK', chainId: 31_337, token: OTHER, decimals: 18, funding: false },
  ],
};
const now = new Date('2026-10-12T10:00:00Z');
const code = (fn: () => Promise<unknown>) => fn().then(() => 'ok', (e: unknown) => (e instanceof AccountingError ? e.code : `raw:${(e as Error).message}`));

describe('custody, deposits, metering and withdrawals', { skip }, () => {
  let db: ScratchDb;
  let chain: LocalChain;
  let custody: LocalCustody;
  before(async () => {
    db = await scratchDb('custody_test');
    chain = new LocalChain(31_337, 2);
    custody = new LocalCustody(chain);
  });
  after(async () => {
    await db?.drop();
  });

  async function agent(): Promise<AgentScope & { address: string; walletId: string }> {
    const agentId = uuidv7();
    await db.pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'custody test agent')`, [SEED_TENANT, agentId]);
    const w = await provisionWallet(db.pool, custody, config, SEED_TENANT, agentId, now);
    return { mode: 'live', tenantId: SEED_TENANT, agentId, address: w.address, walletId: w.id };
  }
  const bucket = async (scope: AgentScope, b: string, asset = 'local.USD') =>
    (await agentBalances(db.pool, scope)).find((x) => x.kind === 'user' && x.bucket === b && x.assetRef === asset)?.balance ?? 0n;

  test('one wallet per agent: provisioning retries return the same wallet', async () => {
    const a = await agent();
    const again = await provisionWallet(db.pool, custody, config, a.tenantId, a.agentId, now);
    assert.equal(again.id, a.walletId);
    assert.match(again.address, /^0x[0-9a-f]{40}$/);
    assert.equal((await db.pool.query('select 1 from wallets where agent_id = $1', [a.agentId])).rowCount, 1);
  });

  test('deposits stay pending and unspendable until finalized, credit once, and a reorged or unsupported transfer never credits', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(USDC, a.address, 100_000_000n);
    chain.fund(OTHER, a.address, 5n);
    chain.fund(NATIVE, a.address, 10n ** 18n);
    chain.mine();
    await scanner.tick(now);
    const pending = await pendingDeposits(db.pool, a.tenantId, a.agentId);
    assert.deepEqual(pending.map((d) => d.state).sort(), ['pending', 'pending', 'quarantined']);
    assert.equal(await bucket(a, 'unallocated'), 0n, 'speculative deposits are not spendable');
    assert.equal(await code(() => db.tx((c) => allocate(c, { scope: a, assetRef: 'local.USD', expectedBudgetVersion: 1, targets: { trading: 1n }, actor: 't', now }))), 'INSUFFICIENT_BUDGET');

    // A speculative transfer that is reorged out before finality is abandoned.
    chain.fund(USDC, a.address, 7n);
    chain.mine();
    await scanner.tick(now);
    chain.reorg(1);
    chain.mine(3);
    const report = await scanner.tick(now);
    assert.equal(report.credited, 2);
    assert.equal(report.abandoned, 1);
    assert.equal(await bucket(a, 'unallocated'), 100_000_000n);
    assert.equal(await bucket(a, 'unallocated', 'local.MON'), 10n ** 18n);
    // Re-running the scanner from the start (a backfill) posts nothing new.
    await db.pool.query('delete from chain_cursors');
    await scanner.tick(now);
    await scanner.tick(now);
    assert.equal(await bucket(a, 'unallocated'), 100_000_000n);
    assert.equal((await db.pool.query(`select 1 from deposits where agent_id = $1 and state = 'quarantined'`, [a.agentId])).rowCount, 1);
    const recon = await reconcileWallets(db.pool, chain, config, now);
    assert.ok(recon.length > 0 && recon.every((r) => r.ok), JSON.stringify(recon.map((r) => [r.chainDifference.toString(), r.ledgerDifference.toString()])));
  });

  test('withdrawals reserve amount plus gas, execute through the gateway, settle actual gas and reconcile; a pending trade blocks them', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(USDC, a.address, 50_000_000n);
    chain.fund(NATIVE, a.address, 10n ** 17n);
    chain.mine(3);
    await scanner.tick(now);
    await db.tx(async (c) => {
      await allocate(c, { scope: a, assetRef: 'local.USD', expectedBudgetVersion: 1, targets: { trading: 50_000_000n }, actor: 't', now });
      await allocate(c, { scope: a, assetRef: 'local.MON', expectedBudgetVersion: 2, targets: { trading: 10n ** 17n }, actor: 't', now });
    });
    const dest = '0x00000000000000000000000000000000000000d5';
    const destinationId = await destination(a, dest);
    // A pending trade holds 45 of 50.
    const { reserve } = await import('../packages/accounting/src/reservations.ts');
    await db.tx((c) => reserve(c, { operationKey: `trade:${a.agentId}`, ...a, purpose: 'trade', now, expiresAt: new Date(now.getTime() + 60_000), holds: [{ account: user(a, 'trading', 'local.USD'), amount: 45_000_000n }] }));
    const ask = (amount: bigint, key: string) => db.tx(async (c) => requestWithdrawal(c, {
      tenantId: a.tenantId, agentId: a.agentId, idempotencyKey: key, requestHash: `0x${key.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0')}`, walletId: a.walletId, destinationId,
      assetRef: 'local.USD', amount, gasAssetRef: 'local.MON', gasCeiling: chain.feePerTx * 2n, stepUpId: await stepUp(a), now,
    }));
    assert.equal(await code(() => ask(6_000_000n, 'w-too-big')), 'INSUFFICIENT_BUDGET');
    const { withdrawal } = await ask(5_000_000n, 'w-ok');
    custody.wallets.get((await db.pool.query<{ provider_wallet_id: string }>('select provider_wallet_id from wallets where id = $1', [a.walletId])).rows[0]!.provider_wallet_id)!.allowedTo.add(USDC);
    const gateway = new WithdrawalGateway(db.pool, custody, chain, config);
    assert.equal((await gateway.tick(now)).submitted, 1);
    assert.equal((await withdrawalById(db.pool, a.tenantId, withdrawal.id))!.state, 'submitted');
    chain.mine(3);
    assert.equal((await gateway.tick(now)).finalized, 1);
    const done = (await withdrawalById(db.pool, a.tenantId, withdrawal.id))!;
    assert.equal(done.state, 'finalized');
    assert.equal(done.gasUsed, chain.feePerTx);
    assert.equal(chain.balanceOf(USDC, dest), 5_000_000n);
    assert.equal(await bucket(a, 'trading'), 45_000_000n);
    assert.equal(await bucket(a, 'trading', 'local.MON'), 10n ** 17n - chain.feePerTx);
    await scanner.tick(now);
    const recon = (await reconcileWallets(db.pool, chain, config, now)).filter((r) => r.recordedWalletAtomic > 0n);
    assert.ok(recon.length > 0 && recon.every((r) => r.ok), JSON.stringify(recon.map((r) => [r.chainDifference.toString(), r.ledgerDifference.toString()])));
  });

  test('native MON withdraws to a verified destination: the gateway refreshes the wallet policy before sending', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(NATIVE, a.address, 10n ** 17n);
    chain.mine(3);
    await scanner.tick(now);
    await db.tx((c) => allocate(c, { scope: a, assetRef: 'local.MON', expectedBudgetVersion: 1, targets: { trading: 10n ** 17n }, actor: 't', now }));
    const dest = '0x00000000000000000000000000000000000000d9';
    const destinationId = await destination(a, dest);
    const { withdrawal } = await db.tx(async (c) => requestWithdrawal(c, {
      tenantId: a.tenantId, agentId: a.agentId, idempotencyKey: 'native-1', requestHash: `0x${'c'.repeat(64)}`, walletId: a.walletId, destinationId,
      assetRef: 'local.MON', amount: 10n ** 16n, gasAssetRef: 'local.MON', gasCeiling: chain.feePerTx * 2n, stepUpId: await stepUp(a), now,
    }));
    const gateway = new WithdrawalGateway(db.pool, custody, chain, config);
    assert.equal((await gateway.tick(now)).submitted, 1);
    chain.mine(3);
    await gateway.tick(now);
    assert.equal((await withdrawalById(db.pool, a.tenantId, withdrawal.id))!.state, 'finalized');
    assert.equal(chain.balanceOf(NATIVE, dest), 10n ** 16n);
    assert.equal(await bucket(a, 'trading', 'local.MON'), 10n ** 17n - 10n ** 16n - chain.feePerTx);
  });

  test('a provider outage during wallet creation moves to a fresh idempotency key; one wallet is recorded', async () => {
    const agentId = uuidv7();
    await db.pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'retry agent')`, [SEED_TENANT, agentId]);
    const keys: string[] = [];
    let fail = true;
    const flaky = {
      name: 'local' as const,
      createWallet: async (r: Parameters<LocalCustody['createWallet']>[0]) => {
        keys.push(r.idempotencyKey);
        if (fail) { fail = false; const { ProviderError } = await import('../packages/custody/src/provider.ts'); throw new ProviderError('unavailable', 'test outage', 503); }
        return custody.createWallet(r);
      },
      allowDestinations: custody.allowDestinations.bind(custody),
      send: custody.send.bind(custody),
    };
    await assert.rejects(provisionWallet(db.pool, flaky, config, SEED_TENANT, agentId, now));
    const w = await provisionWallet(db.pool, flaky, config, SEED_TENANT, agentId, now);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal((await provisionWallet(db.pool, flaky, config, SEED_TENANT, agentId, now)).id, w.id);
    assert.equal(keys.length, 2, 'an existing wallet is returned without a provider call');
  });

  test('an ambiguous provider send is never resent: it reconciles from the chain; external wallet activity freezes outflows', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(USDC, a.address, 10_000_000n);
    chain.fund(NATIVE, a.address, 10n ** 17n);
    chain.mine(3);
    await scanner.tick(now);
    await db.tx(async (c) => {
      await allocate(c, { scope: a, assetRef: 'local.USD', expectedBudgetVersion: 1, targets: { trading: 10_000_000n }, actor: 't', now });
      await allocate(c, { scope: a, assetRef: 'local.MON', expectedBudgetVersion: 2, targets: { trading: 10n ** 17n }, actor: 't', now });
    });
    const destinationId = await destination(a, '0x00000000000000000000000000000000000000d6');
    const { withdrawal } = await db.tx(async (c) => requestWithdrawal(c, {
      tenantId: a.tenantId, agentId: a.agentId, idempotencyKey: 'amb', requestHash: `0x${'a'.repeat(64)}`, walletId: a.walletId, destinationId,
      assetRef: 'local.USD', amount: 1_000_000n, gasAssetRef: 'local.MON', gasCeiling: chain.feePerTx * 2n, stepUpId: await stepUp(a), now,
    }));
    custody.unavailable = true;
    const gateway = new WithdrawalGateway(db.pool, custody, chain, config);
    assert.equal((await gateway.tick(now)).reconciling, 1);
    custody.unavailable = false;
    await gateway.tick(now);
    const w = (await withdrawalById(db.pool, a.tenantId, withdrawal.id))!;
    assert.equal(w.state, 'reconciling');
    assert.equal(await bucket(a, 'trading'), 10_000_000n, 'hold kept, nothing posted');
    // Unexplained external activity on another agent's wallet (an unobserved transfer) freezes its outflows.
    const b = await agent();
    chain.fund(NATIVE, b.address, 10n ** 16n);
    chain.mine(3);
    await scanner.tick(now);
    // Funds leave the wallet without a platform operation (e.g. a compromised provider key).
    chain.submit(b.address, '0x00000000000000000000000000000000000000ee', NATIVE, 1n, `external-${b.agentId}`);
    chain.mine(3);
    await scanner.tick(now);
    const reports = await reconcileWallets(db.pool, chain, config, now);
    assert.ok(reports.some((r) => r.freezeId && r.chainDifference < 0n), 'deficit detected');
    const { reserve } = await import('../packages/accounting/src/reservations.ts');
    assert.equal(await code(() => db.tx((c) => reserve(c, { operationKey: `blocked:${b.agentId}`, ...b, purpose: 'trade', now, expiresAt: new Date(now.getTime() + 1000), holds: [{ account: user(b, 'trading', 'local.MON'), amount: 1n }] }))), 'RECONCILIATION_REQUIRED');
  });

  test('traded tokens reconcile: an unsolicited transfer in is tolerated, a shortfall freezes', async () => {
    const traded: CustodyConfig = { ...config, tradedAssets: [{ assetRef: 'local.WMON', chainId: config.chainId, token: OTHER, decimals: 18, funding: false }] };
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, traded);
    chain.fund(NATIVE, a.address, 10n ** 17n);
    chain.fund(OTHER, a.address, 5n);
    chain.mine(3);
    await scanner.tick(now);
    // The ledger records 3 of the token (a settled trade's output); 5 on chain: 2 unsolicited, tolerated.
    await db.tx((c) => postJournal(c, { operationKey: `trade-output:${a.agentId}`, mode: 'live', tenantId: a.tenantId, agentId: a.agentId, kind: 'deposit', postings: depositPostings(a, 'local.WMON', 3n), occurredAt: now }));
    const { openFreezes } = await import('../packages/accounting/src/index.ts');
    await reconcileWallets(db.pool, chain, traded, now);
    assert.deepEqual(await openFreezes(db.pool, 'live', a.tenantId, a.agentId), []);
    // 3 leave without a platform operation: 2 on chain against 3 recorded.
    chain.submit(a.address, '0x00000000000000000000000000000000000000ee', OTHER, 3n, `external-traded-${a.agentId}`);
    chain.mine(3);
    await scanner.tick(now);
    await reconcileWallets(db.pool, chain, traded, now);
    const frozen = await db.pool.query<{ reason_code: string; asset: string }>(`select reason_code, detail ->> 'assetRef' as asset from reconciliation_freezes where agent_id = $1 and cleared_at is null order by asset`, [a.agentId]);
    // The token's shortfall, and MON: the external send also paid gas the ledger never saw.
    assert.deepEqual(frozen.rows.map((r) => [r.asset, r.reason_code]), [['local.MON', 'BALANCE_DEFICIT'], ['local.WMON', 'BALANCE_DEFICIT']]);
  });

  test('a deposit finalized after the last scanner pass is not mistaken for external activity', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(USDC, a.address, 3_000_000n);
    chain.mine(3);
    await scanner.tick(now);
    chain.fund(USDC, a.address, 2_000_000n); // lands between the scanner pass and reconciliation
    chain.mine(3);
    assert.deepEqual(await reconcileWallets(db.pool, chain, config, now), [], 'the scanner lags the finalized head: defer');
    await scanner.tick(now);
    assert.equal(await bucket(a, 'unallocated'), 5_000_000n);
    assert.ok((await reconcileWallets(db.pool, chain, config, now)).length > 0);
    const { openFreezes } = await import('../packages/accounting/src/index.ts');
    assert.deepEqual(await openFreezes(db.pool, 'live', a.tenantId, a.agentId), []);
  });

  test('an uncredited deposit takes the newest canonical values; an abandoned one can be re-included; a missing receipt retries', async () => {
    const a = await agent();
    const { observeDeposit, finalizeDeposit } = await import('../packages/accounting/src/index.ts');
    const accepted = [{ chainId: config.chainId, tokenAddress: USDC, assetRef: 'local.USD', decimals: 6 }];
    const log = { chainId: config.chainId, txHash: `0x${'d1'.repeat(32)}`, logIndex: 0, tokenAddress: USDC, sender: OTHER, destination: a.address, amount: 5n, blockHash: `0x${'aa'.repeat(32)}`, blockNumber: 10n, observedAt: now };
    await db.tx((c) => observeDeposit(c, log, accepted));
    // The block was discarded: abandoned, never credited.
    assert.equal(await db.tx((c) => finalizeDeposit(c, config.chainId, log.txHash, 0, { receiptSucceeded: true, canonicalBlockHash: `0x${'bb'.repeat(32)}`, finalizedHeight: 20n, at: now })), 'abandoned');
    // Re-included on the canonical chain with a different amount: the record takes the new values and credits them.
    const again = { ...log, amount: 7n, blockHash: `0x${'cc'.repeat(32)}`, blockNumber: 12n };
    const record = await db.tx((c) => observeDeposit(c, again, accepted));
    assert.deepEqual([record!.state, record!.amount], ['pending', 7n]);
    assert.equal(await db.tx((c) => finalizeDeposit(c, config.chainId, log.txHash, 0, { receiptSucceeded: true, canonicalBlockHash: again.blockHash, finalizedHeight: 20n, at: now })), 'credited');
    assert.equal(await bucket(a, 'unallocated'), 7n);

    // A finalized transfer whose receipt is not available yet is retried, not abandoned.
    const b = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    await scanner.tick(now); // catch up first
    chain.fund(USDC, b.address, 3_000_000n);
    chain.mine(3);
    const receipt = chain.receipt.bind(chain);
    chain.receipt = async () => undefined;
    await assert.rejects(scanner.tick(now), /no receipt yet/);
    chain.receipt = receipt;
    await scanner.tick(now);
    assert.equal(await bucket(b, 'unallocated'), 3_000_000n);
  });

  test('a withdrawal whose hold expired before the gateway ran ends as failed instead of blocking the gateway', async () => {
    const a = await agent();
    const scanner = new DepositScanner(db.pool, chain, config);
    chain.fund(USDC, a.address, 2_000_000n);
    chain.fund(NATIVE, a.address, 10n ** 17n);
    chain.mine(3);
    await scanner.tick(now);
    await db.tx(async (c) => {
      await allocate(c, { scope: a, assetRef: 'local.USD', expectedBudgetVersion: 1, targets: { trading: 2_000_000n }, actor: 't', now });
      await allocate(c, { scope: a, assetRef: 'local.MON', expectedBudgetVersion: 2, targets: { trading: 10n ** 17n }, actor: 't', now });
    });
    const destinationId = await destination(a, '0x00000000000000000000000000000000000000d7');
    const { withdrawal } = await db.tx(async (c) => requestWithdrawal(c, {
      tenantId: a.tenantId, agentId: a.agentId, idempotencyKey: 'expired', requestHash: `0x${'e'.repeat(64)}`, walletId: a.walletId, destinationId,
      assetRef: 'local.USD', amount: 1_000_000n, gasAssetRef: 'local.MON', gasCeiling: chain.feePerTx * 2n, stepUpId: await stepUp(a), now,
    }));
    const { expireHeld } = await import('../packages/accounting/src/index.ts');
    await db.tx((c) => expireHeld(c, new Date(now.getTime() + 24 * 3600_000)));
    const gateway = new WithdrawalGateway(db.pool, custody, chain, config);
    await gateway.tick(now);
    const w = (await withdrawalById(db.pool, a.tenantId, withdrawal.id))!;
    assert.deepEqual([w.state, w.txHash], ['failed', undefined]);
    assert.equal(await bucket(a, 'trading'), 2_000_000n, 'nothing left the wallet');
    await gateway.tick(now); // the gateway keeps running
  });

  test('hosting slices are charged once per slice and stop when the hosting bucket is empty; trading funds are never used', async () => {
    const a = await agent();
    const card: StoredRateCard = { version: 'hosting.test/1', kind: 'hosting', mode: 'live', profileRef: 'runtime.small', assetRef: 'local.USD', sliceSeconds: 60, atomicPerSlice: 4n, marginBps: 2000, effectiveFrom: new Date('2026-01-01T00:00:00Z'), source: 'placeholder (test)' };
    await publishRateCard(db.pool, card);
    await fundBuckets(a, { hosting: 8n, trading: 1000n });
    const deploymentId = uuidv7();
    const slice = (i: bigint) => db.tx((c) => chargeHostingSlice(c, { scope: a, deploymentId, card, sliceIndex: i, now }));
    assert.equal((await slice(100n)).status, 'charged');
    assert.equal((await slice(100n)).status, 'alreadyCharged');
    await slice(101n);
    assert.equal(await code(() => slice(102n)), 'INSUFFICIENT_BUDGET');
    assert.equal(await bucket(a, 'hosting'), 0n);
    assert.equal(await bucket(a, 'trading'), 1000n);
  });

  test('model calls hold the worst case, settle actual usage once, and unknown charges stay held, escalate after 24 h and pause the profile', async () => {
    const a = await agent();
    const card: StoredRateCard = { version: 'model.test/1', kind: 'model', mode: 'live', profileRef: 'test.kimi', assetRef: 'local.USD', inputAtomicPerMillion: 1_000_000n, outputAtomicPerMillion: 4_000_000n, marginBps: 0, effectiveFrom: new Date('2026-01-01T00:00:00Z'), source: 'placeholder (test)' };
    await publishRateCard(db.pool, card);
    await fundBuckets(a, { api: 10_000n, trading: 500n });
    const bounds = { maxInputTokens: 1000, maxOutputTokens: 500, requests: 1 };
    const held = await db.tx((c) => reserveModelCall(c, { scope: a, logicalKey: 'call-1', card, bounds, now }));
    assert.equal(held.heldAtomic, 3000n);
    await db.tx((c) => recordModelDispatch(c, 'call-1', now));
    assert.equal(await code(() => db.tx((c) => recordModelDispatch(c, 'call-1', now))), 'ok');
    const settled = await db.tx((c) => settleModelUsage(c, 'call-1', { inputTokens: 200, outputTokens: 100, requests: 1, providerRequestId: 'req-1' }, now));
    assert.equal(settled.charged, 600n);
    assert.equal((await db.tx((c) => settleModelUsage(c, 'call-1', { inputTokens: 200, outputTokens: 100, requests: 1 }, now))).charged, 600n);
    assert.equal(await bucket(a, 'api'), 9400n);

    await db.tx(async (c) => {
      await reserveModelCall(c, { scope: a, logicalKey: 'call-2', card, bounds, now });
      await recordModelDispatch(c, 'call-2', now);
      await markModelUnknown(c, 'call-2', now);
    });
    assert.equal(await bucket(a, 'api'), 9400n, 'unknown charge is held, not refunded or charged');
    assert.deepEqual(await db.tx((c) => escalateUnknownUsage(c, new Date(now.getTime() + 23 * 3_600_000))), []);
    assert.deepEqual(await db.tx((c) => escalateUnknownUsage(c, new Date(now.getTime() + 24 * 3_600_000))), ['call-2']);
    assert.equal(await modelProfilePaused(db.pool, a, 'test.kimi'), true);
    assert.equal(await code(() => db.tx((c) => reserveModelCall(c, { scope: a, logicalKey: 'call-3', card, bounds, now }))), 'RECONCILIATION_REQUIRED');
    assert.equal(await code(() => db.tx((c) => resolveUnknownUsage(c, 'call-2', { chargeAtomic: 3001n, evidence: 'statement' }, now))), 'INVALID');
    await db.tx((c) => resolveUnknownUsage(c, 'call-2', { chargeAtomic: 2500n, evidence: 'Provider statement 2026-10-13' }, now));
    assert.equal(await bucket(a, 'api'), 6900n);
    assert.equal(await modelProfilePaused(db.pool, a, 'test.kimi'), false);
    // Budget exhaustion: a call whose ceiling exceeds the API bucket fails; trading is untouched.
    assert.equal(await code(() => db.tx((c) => reserveModelCall(c, { scope: a, logicalKey: 'call-4', card, bounds: { maxInputTokens: 10_000, maxOutputTokens: 10_000, requests: 1 }, now }))), 'INSUFFICIENT_BUDGET');
    assert.equal(await bucket(a, 'trading'), 500n);
  });

  async function fundBuckets(a: AgentScope, targets: { hosting?: bigint; api?: bigint; trading?: bigint }): Promise<void> {
    const total = (targets.hosting ?? 0n) + (targets.api ?? 0n) + (targets.trading ?? 0n);
    const { postJournal, depositPostings } = await import('../packages/accounting/src/index.ts');
    await db.tx(async (c) => {
      await postJournal(c, { operationKey: `fund:${a.agentId}`, mode: 'live', tenantId: a.tenantId, agentId: a.agentId, kind: 'deposit', postings: depositPostings(a, 'local.USD', total), occurredAt: now });
      await allocate(c, { scope: a, assetRef: 'local.USD', expectedBudgetVersion: 1, targets, actor: 't', now });
    });
  }

  async function stepUp(a: AgentScope): Promise<string> {
    const id = uuidv7();
    await db.pool.query(
      `insert into step_up_challenges (tenant_id, id, purpose, action_hash, code_hash, created_at, expires_at, verified_at) values ($1, $2, 'withdrawal', $3, $3, $4, $5, $4)`,
      [a.tenantId, id, `0x${'1'.repeat(64)}`, now, new Date(now.getTime() + 300_000)]);
    return id;
  }

  async function destination(a: AgentScope, address: string): Promise<string> {
    const id = uuidv7();
    await db.pool.query(`insert into withdrawal_destinations (tenant_id, id, agent_id, chain_id, address, label, step_up_id, verified_at) values ($1, $2, $3, 31337, $4, 'test', $5, $6)`,
      [a.tenantId, id, a.agentId, address, await stepUp(a), now]);
    return id;
  }
});
