// Real Monad testnet check of the funds path (#34, #36) with Privy custody and MON-only funding. Uses the dev
// database from .env and a labelled test agent under the local workspace tenant.
//   node --env-file=.env scripts/testnet-funds-check.ts prepare
//       Creates the test agent and its Privy wallet, records the current finalized height, prints the address.
//       Send a small amount of testnet MON to that address.
//   node --env-file=.env scripts/testnet-funds-check.ts run <agentId> <returnAddress> [withdrawMon=0.001]
//       Scans finalized blocks for the deposit, credits it once, allocates it to trading, withdraws part of it to
//       <returnAddress> through the gateway (provider policy updated for that destination), waits for finality,
//       settles actual gas and reconciles the wallet against the chain.
// Needs PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY and CUSTODY_RPC (default: the public testnet RPC);
// ENVIO_API_TOKEN, when set, scans through the HyperSync index.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { agentBalances, allocate, requestWithdrawal, uuidv7, withdrawalById } from '../packages/accounting/src/index.ts';
import { DepositScanner, HyperSyncChain, JsonRpcChain, PrivyCustody, hyperSyncUrlFor, WithdrawalGateway, provisionWallet, reconcileWallets } from '../packages/custody/src/index.ts';
import type { CustodyConfig } from '../packages/custody/src/index.ts';

const CHAIN = 10143;
const endpoint = process.env['CUSTODY_RPC'] ?? 'https://testnet-rpc.monad.xyz';
const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const rpc = new JsonRpcChain({ endpoint, chainId: CHAIN });
await rpc.verifyChainId();
// With ENVIO_API_TOKEN the scanner reads through the HyperSync deposit index (D50); RPC still supplies every value.
const envio = process.env['ENVIO_API_TOKEN'];
const chain = envio ? new HyperSyncChain(rpc, { url: process.env['HYPERSYNC_URL'] ?? hyperSyncUrlFor(CHAIN), apiToken: envio }) : rpc;
const provider = new PrivyCustody({ appId: process.env['PRIVY_APP_ID']!, appSecret: process.env['PRIVY_APP_SECRET']!, authorizationKey: process.env['PRIVY_AUTHORIZATION_KEY']! });
const tenant = (await pool.query<{ id: string }>(`select id from tenants where auth_subject = 'local-control-workspace'`)).rows[0]?.id
  ?? (await pool.query<{ id: string }>('select id from tenants order by created_at limit 1')).rows[0]!.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const [mode, agentArg, returnArg, amountArg] = process.argv.slice(2);
if (mode === 'prepare') {
  const agentId = uuidv7();
  await pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'Testnet funds check (test agent)')`, [tenant, agentId]);
  const startHeight = await chain.finalizedHeight();
  const config: CustodyConfig = { networkRef: 'monad-testnet', chainId: CHAIN, gasAssetRef: 'live.MON', startHeight, assets: [{ assetRef: 'live.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }] };
  const w = await provisionWallet(pool, provider, config, tenant, agentId, new Date());
  await pool.query(`insert into chain_cursors (chain_id, name, height, updated_at) values ($1, 'observed', $2, now()), ($1, 'finalized', $2, now()) on conflict (chain_id, name) do update set height = greatest(chain_cursors.height, excluded.height)`, [CHAIN, startHeight.toString()]);
  console.log(JSON.stringify({ agentId, walletAddress: w.address, chainId: CHAIN, scanFrom: startHeight.toString() }));
  console.log(`Send a small amount of testnet MON (e.g. 0.01) to ${w.address}, then run: node --env-file=.env scripts/testnet-funds-check.ts run ${agentId} <yourAddress>`);
  await pool.end();
  process.exit(0);
}
if (mode === 'reconcile') {
  // Catch the scanner up to the finalized head, then compare every testnet wallet with the ledger.
  const config: CustodyConfig = { networkRef: 'monad-testnet', chainId: CHAIN, gasAssetRef: 'live.MON', startHeight: 0n, assets: [{ assetRef: 'live.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }] };
  const scanner = new DepositScanner(pool, chain, config, 400n);
  for (let i = 0; i < 400; i++) {
    const r = await scanner.tick(new Date());
    const c = await pool.query<{ height: string }>(`select height from chain_cursors where chain_id = $1 and name = 'finalized'`, [CHAIN]);
    if (BigInt(c.rows[0]!.height) < r.finalizedHeight) continue;
    const reports = await reconcileWallets(pool, chain, config, new Date());
    if (!reports.length) continue;
    console.log(JSON.stringify(reports.map((x) => ({ ok: x.ok, recordedWallet: x.recordedWalletAtomic.toString(), liabilities: x.liabilitiesAtomic.toString(), chainDifference: x.chainDifference.toString(), ledgerDifference: x.ledgerDifference.toString() }))));
    break;
  }
  for (const a of process.argv.slice(3)) console.log(a, (await chain.nativeBalance(a, await chain.finalizedHeight())).toString());
  await pool.end();
  process.exit(0);
}
if (mode !== 'run' || !agentArg || !returnArg) {
  console.log('Usage: prepare | run <agentId> <returnAddress> [withdrawMon] | reconcile [address…]');
  process.exit(1);
}

const agentId = agentArg;
const destination = returnArg.toLowerCase();
const withdrawAtomic = BigInt(Math.round(Number(amountArg ?? '0.001') * 1e6)) * 10n ** 12n;
const cursor = await pool.query<{ height: string }>(`select height from chain_cursors where chain_id = $1 and name = 'finalized'`, [CHAIN]);
const config: CustodyConfig = { networkRef: 'monad-testnet', chainId: CHAIN, gasAssetRef: 'live.MON', startHeight: BigInt(cursor.rows[0]?.height ?? '0'), assets: [{ assetRef: 'live.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }] };
const scope = { mode: 'live' as const, tenantId: tenant, agentId };
const scanner = new DepositScanner(pool, chain, config, 200n);
const gateway = new WithdrawalGateway(pool, provider, chain, config);
const mon = async (bucket: string) => (await agentBalances(pool, scope)).find((b) => b.kind === 'user' && b.bucket === bucket && b.assetRef === 'live.MON')?.balance ?? 0n;

console.log('Scanning finalized blocks for the deposit…');
for (let i = 0; i < 600 && (await mon('unallocated')) + (await mon('trading')) === 0n; i++) {
  const r = await scanner.tick(new Date());
  if (i % 10 === 0) console.log(`  scanned to ${r.finalizedHeight}, observed ${r.observed}, credited ${r.credited}`);
  await sleep(500);
}
const credited = await mon('unallocated');
console.log(`Credited after finality: ${credited} wei MON (unallocated)`);
if (credited > 0n) {
  const v = (await pool.query<{ budget_version: number }>('select budget_version from agents where id = $1', [agentId])).rows[0]!.budget_version;
  await tx((c) => allocate(c, { scope, assetRef: 'live.MON', expectedBudgetVersion: v, targets: { trading: credited }, actor: 'testnet-check', now: new Date() }));
}
// Operator-verified destination and approval for this test (the user API requires a one-time code instead).
const stepUp = async () => {
  const id = uuidv7();
  const h = `0x${createHash('sha256').update(randomBytes(16)).digest('hex')}`;
  await pool.query(`insert into step_up_challenges (tenant_id, id, purpose, action_hash, code_hash, created_at, expires_at, verified_at) values ($1, $2, 'withdrawal', $3, $3, now(), now() + interval '5 minutes', now())`, [tenant, id, h]);
  return id;
};
const destinationId = uuidv7();
await pool.query(`insert into withdrawal_destinations (tenant_id, id, agent_id, chain_id, address, label, step_up_id, verified_at) values ($1, $2, $3, $4, $5, 'Testnet return address', $6, now())`, [tenant, destinationId, agentId, CHAIN, destination, await stepUp()]);
const walletId = (await pool.query<{ id: string }>('select id from wallets where agent_id = $1 and chain_id = $2', [agentId, CHAIN])).rows[0]!.id;
const gasCeiling = 200_000n * 200_000_000_000n;
const { withdrawal } = await tx(async (c) => requestWithdrawal(c, {
  tenantId: tenant, agentId, idempotencyKey: `testnet-check-${agentId}`, requestHash: `0x${createHash('sha256').update(`${agentId}:${destination}:${withdrawAtomic}`).digest('hex')}`,
  walletId, destinationId, assetRef: 'live.MON', amount: withdrawAtomic, gasAssetRef: 'live.MON', gasCeiling, stepUpId: await stepUp(), now: new Date(),
}));
console.log(`Withdrawal ${withdrawal.id} reserved: ${withdrawAtomic} wei + gas ceiling ${gasCeiling}`);
for (let i = 0; i < 240; i++) {
  await gateway.tick(new Date());
  const w = (await withdrawalById(pool, tenant, withdrawal.id))!;
  if (i % 5 === 0 || ['finalized', 'failed', 'reconciling'].includes(w.state)) console.log(`  withdrawal ${w.state}${w.txHash ? ` ${w.txHash}` : ''}${w.failureReason ? ` (${w.failureReason})` : ''}`);
  if (['finalized', 'failed'].includes(w.state)) break;
  if (w.state === 'reconciling' && !w.txHash) break;
  await sleep(1000);
}
await scanner.tick(new Date());
const reports = await reconcileWallets(pool, chain, config, new Date());
const final = (await withdrawalById(pool, tenant, withdrawal.id))!;
console.log(JSON.stringify({
  withdrawal: final.state, txHash: final.txHash, gasUsedWei: final.gasUsed?.toString(), tradingMonWei: (await mon('trading')).toString(),
  reconciliation: reports.map((r) => ({ ok: r.ok, chainDifference: r.chainDifference.toString(), ledgerDifference: r.ledgerDifference.toString() })),
}));
await pool.end();
