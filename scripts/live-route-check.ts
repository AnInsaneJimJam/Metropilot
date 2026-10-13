// Read-only check of the live Uniswap v3 route on Monad mainnet (E04). Sends nothing and needs no key:
//   node scripts/live-route-check.ts [RPC]   (default https://rpc.monad.xyz)
// At a finalized block: chain 143, route identity (factory pool, router WETH9 and factory, quoter factory, pool tokens
// and fee), token decimals, quotes for the three offered directions, the TWAP reference and its deviation, build →
// full decode round trip, and an eth_call of the exact native-input swap from an address that holds MON.
import { JsonRpcChain } from '../packages/custody/src/index.ts';
import { MAINNET_UNISWAP, buildSwap, decodeSwap, mainnetRoute, minimumOutput, quote, referenceOutput, verifyRoute } from '../packages/connectors/src/index.ts';
import type { SwapLeg, UniswapRoute } from '../packages/connectors/src/index.ts';

const u = MAINNET_UNISWAP;
const route: UniswapRoute = mainnetRoute();
const rpc = new JsonRpcChain({ endpoint: process.argv[2] ?? 'https://rpc.monad.xyz', chainId: 143 });
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${detail}`);
};
const attempt = async (check: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (error) {
    record(check, false, error instanceof Error ? error.message : 'failed');
  }
};

await rpc.verifyChainId();
const block = await rpc.finalizedHeight();
console.log(`Monad mainnet finalized block ${block}`);
await attempt('route identity', async () => {
  await verifyRoute(rpc, route, block);
  const decimals = await Promise.all([u.wmon, u.usdc].map(async (t) => Number(BigInt(await rpc.simulate({ from: '0x0000000000000000000000000000000000000001', to: t, data: '0x313ce567' }, block)))));
  if (decimals[0] !== 18 || decimals[1] !== 6) throw new Error(`decimals ${decimals.join('/')}`);
  record('route identity', true, `factory pool ${u.pool} fee ${u.fee}, router WETH9 = WMON, router/quoter factory match, WMON 18 / USDC 6 decimals`);
});
const legs: [string, SwapLeg][] = [
  ['MON→USDC', { tokenIn: u.wmon, tokenOut: u.usdc, nativeIn: true, amountIn: 10n ** 18n }],
  ['WMON→USDC', { tokenIn: u.wmon, tokenOut: u.usdc, nativeIn: false, amountIn: 10n ** 18n }],
  ['USDC→WMON', { tokenIn: u.usdc, tokenOut: u.wmon, nativeIn: false, amountIn: 100_000n }],
];
for (const [name, leg] of legs) {
  await attempt(`quote ${name}`, async () => {
    const [q, ref] = await Promise.all([quote(rpc, route, leg, block), referenceOutput(rpc, route, leg, block)]);
    const deviationBps = Number(((ref - q.expectedOutputAtomic) * 10_000n) / ref);
    record(`quote ${name}`, q.expectedOutputAtomic > 0n && Math.abs(deviationBps) <= 100, `${leg.amountIn} in → ${q.expectedOutputAtomic} out (TWAP reference ${ref}, ${deviationBps} bps below incl. the 30 bps fee), gas estimate ${q.gasEstimate}`);
  });
}
await attempt('build and simulate', async () => {
  // The WMON contract holds MON, so it can be the simulated sender of a native-input swap (eth_call only).
  const holder = u.wmon;
  const leg = legs[0]![1];
  const q = await quote(rpc, route, leg, block);
  const swap = { ...leg, recipient: holder, amountOutMinimum: minimumOutput(q.expectedOutputAtomic, 50), deadline: BigInt(Math.floor(Date.now() / 1000) + 300) };
  const tx = buildSwap(route, swap);
  const decoded = decodeSwap(route, tx);
  if (JSON.stringify(decoded, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== JSON.stringify(swap, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) throw new Error('decode differs from the frozen swap');
  const raw = await rpc.simulate({ from: holder, to: tx.to, data: tx.data, value: tx.value }, 'latest');
  const gas = await rpc.estimateGas({ from: holder, to: tx.to, data: tx.data, value: tx.value });
  record('build and simulate', raw.length > 2, `multicall(deadline, [exactInputSingle]) decodes to the frozen swap; eth_call succeeds (min out ${swap.amountOutMinimum}), estimateGas ${gas}`);
});
const passed = results.filter((r) => r.pass).length;
console.log(`\nE04 live route check ${new Date().toISOString().slice(0, 10)} at block ${block}: ${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
