// E10 acceptance for the HyperSync deposit index on Monad testnet. Read-only: no database writes, no transactions.
//   node --env-file=.env scripts/hypersync-check.ts
// Needs ENVIO_API_TOKEN (optional HYPERSYNC_URL, CUSTODY_RPC). Checks, against the RPC trace reader as ground truth:
//   1. the index serves chain 10143 (block hash matches RPC);
//   2. the recorded contract-forwarded 5 MON deposit (block 70492750) is found with the same key and amount;
//   3. the wallet's own withdrawal blocks are indexed (they split the balance segments);
//   4. a recent real USDC Transfer is found through the index with the RPC's exact log;
//   5. throughput: a 20 000-block scan for the testnet wallets, against the per-block trace rate.
// Prints dated evidence for docs/decisions.md E10. Never prints the token.
import { HyperSyncChain, JsonRpcChain, TRANSFER_TOPIC, hyperSyncUrlFor } from '../packages/custody/src/index.ts';
import type { TransferLog } from '../packages/custody/src/index.ts';

const token = process.env['ENVIO_API_TOKEN'];
if (!token) {
  console.log('E10 check skipped: set ENVIO_API_TOKEN in .env (https://envio.dev/app/api-tokens).');
  process.exit(0);
}
const CHAIN = 10143;
const rpc = new JsonRpcChain({ endpoint: process.env['CUSTODY_RPC'] ?? 'https://testnet-rpc.monad.xyz', chainId: CHAIN });
await rpc.verifyChainId();
const index = new HyperSyncChain(rpc, { url: process.env['HYPERSYNC_URL'] ?? hyperSyncUrlFor(CHAIN), apiToken: token });

const WALLET = '0x83874dbad11513d46b4b0a455e7832804d19c130';
const DEPOSIT = { tx: '0x91e92af957ad31624b9c86ada062a2f839893d4afcf5671f088f9dbed3f75870', logIndex: 40001, block: 70492750n, amount: 5_000_000_000_000_000_000n };
const WITHDRAWALS = ['0xde86d6f1d533729a0d77564cdffdad821812fcc4527965e8a673e24c588e2db7', '0x39cdd0fb1deefcbb59046eebb5a5d2ef32e56c2deb4bc0d38c134f45ee514c8b'];
const USDC = '0x534b2f3a21130d7a60830c2df862319e593943a3';

const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${detail}`);
};
const key = (l: TransferLog) => `${l.txHash}:${l.logIndex}:${l.amount}:${l.blockHash}`;
const attempt = async (check: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (error) {
    record(check, false, error instanceof Error ? error.message : 'failed');
  }
};

await attempt('chain', async () => {
  await index.verify();
  record('chain', true, `index serves chain ${CHAIN}; indexed height ${await index.indexedHeight()}`);
});

await attempt('forwarded deposit', async () => {
  const [from, to] = [DEPOSIT.block - 200n, DEPOSIT.block + 200n];
  const found = await index.nativeTransfers([WALLET], from, to);
  const truth = await rpc.nativeTransfers([WALLET], DEPOSIT.block, DEPOSIT.block);
  const hit = found.find((l) => l.txHash === DEPOSIT.tx && l.logIndex === DEPOSIT.logIndex && l.amount === DEPOSIT.amount);
  record('forwarded deposit', !!hit && truth.every((t) => found.some((f) => key(f) === key(t))),
    hit ? `5 MON at block ${hit.blockNumber} key ${hit.logIndex} (same as RPC traces); ${found.length} transfer(s) in ${to - from + 1n} blocks` : 'not found');
});

await attempt('own sends indexed', async () => {
  for (const tx of WITHDRAWALS) {
    const receipt = await rpc.receipt(tx);
    if (!receipt) throw new Error(`no receipt for ${tx.slice(0, 10)}`);
    // A window around the send: the wallet's own block is traced and the segments either side reconcile.
    const found = await index.nativeTransfers([WALLET], receipt.blockNumber - 50n, receipt.blockNumber + 50n);
    const truth = (await rpc.nativeTransfers([WALLET], receipt.blockNumber - 50n, receipt.blockNumber + 50n)).map(key).sort();
    if (JSON.stringify(found.map(key).sort()) !== JSON.stringify(truth)) throw new Error(`mismatch around block ${receipt.blockNumber}`);
  }
  record('own sends indexed', true, `${WITHDRAWALS.length} withdrawal windows match the RPC trace scan exactly`);
});

await attempt('USDC transfer', async () => {
  const head = await rpc.finalizedHeight();
  let sample: { to: string; block: bigint } | undefined;
  for (let end = head; !sample && end > head - 5_000n; end -= 100n) {
    const logs = await rpc.call<{ topics: string[]; blockNumber: string }[]>('eth_getLogs', [{ address: USDC, fromBlock: `0x${(end - 99n).toString(16)}`, toBlock: `0x${end.toString(16)}`, topics: [TRANSFER_TOPIC] }]);
    const l = logs.find((x) => x.topics.length === 3);
    if (l) sample = { to: `0x${l.topics[2]!.slice(-40)}`, block: BigInt(l.blockNumber) };
  }
  if (!sample) throw new Error('no USDC Transfer in the last 5000 finalized blocks');
  const viaIndex = (await index.transferLogs(USDC, [sample.to], sample.block - 10n, sample.block + 10n)).map(key).sort();
  const viaRpc = (await rpc.transferLogs(USDC, [sample.to], sample.block - 10n, sample.block + 10n)).map(key).sort();
  record('USDC transfer', viaIndex.length > 0 && JSON.stringify(viaIndex) === JSON.stringify(viaRpc), `${viaIndex.length} log(s) at block ${sample.block}, identical to eth_getLogs`);
});

await attempt('throughput', async () => {
  const head = await index.finalizedHeight();
  const span = 20_000n;
  const t0 = performance.now();
  await index.nativeTransfers([WALLET, '0xfad91835b440d8b3759c4fe7523cddfd82ac2330'], head - span + 1n, head);
  await index.transferLogs(USDC, [WALLET], head - span + 1n, head);
  const indexSeconds = (performance.now() - t0) / 1000;
  const t1 = performance.now();
  await rpc.nativeTransfers([WALLET], head - 49n, head);
  const traceRate = 50 / ((performance.now() - t1) / 1000);
  const rate = Number(span) / indexSeconds;
  record('throughput', rate > traceRate * 10, `${Math.round(rate)} blocks/s via the index vs ${traceRate.toFixed(1)} blocks/s tracing every block (chain makes ~2.5/s)`);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\nE10 HyperSync check ${new Date().toISOString().slice(0, 10)}: ${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
