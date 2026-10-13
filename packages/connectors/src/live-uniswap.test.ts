// Live Uniswap v3 route: build/decode round trip, every rejection the executor relies on before signing (G8: wrong
// chain, router, selector, nested command, recipient shape, value, unlimited approval), and receipt interpretation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { buildApproval, buildSwap, decodeApproval, decodeSwap, interpretApprovalReceipt, interpretSwapReceipt, minimumOutput, routeAbi } from './live-uniswap.ts';
import type { FrozenSwap, UniswapRoute } from './live-uniswap.ts';

const topics = (t: readonly unknown[]): string[] => t as string[];

const WMON = '0x3bd359c1119da7da1d913d1c4d2b7c461115433a';
const USDC = '0x754704bc059f8c67012fed69bc8a327a5aafb603';
const route: UniswapRoute = {
  chainId: 143, factory: '0x204faca1764b154221e35c0d20abb3c525710498', router: '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900', quoter: '0x661e93cca42afacb172121ef892830ca3b70f08d',
  pool: '0x659bd0bc4167ba25c62e05656f78043e7ed4a9da', fee: 3000, wmon: WMON, token0: { address: WMON, decimals: 18 }, token1: { address: USDC, decimals: 6 },
};
const WALLET = '0x00000000000000000000000000000000000000a1';
const sell: FrozenSwap = { tokenIn: WMON, tokenOut: USDC, nativeIn: false, amountIn: 10n ** 18n, recipient: WALLET, amountOutMinimum: 24_000n, deadline: 1_800_000_000n };

test('build and full decode round-trip, native input sends value', () => {
  assert.deepEqual(decodeSwap(route, buildSwap(route, sell)), sell);
  const native = { ...sell, nativeIn: true };
  const tx = buildSwap(route, native);
  assert.equal(tx.value, sell.amountIn);
  assert.deepEqual(decodeSwap(route, tx), native);
  assert.equal(minimumOutput(24_590n, 50), 24_468n, '24590 − floor(24590 × 50 / 10000)');
});

test('decode rejects every shape outside the reviewed one', () => {
  const tx = buildSwap(route, sell);
  assert.throws(() => decodeSwap(route, { ...tx, chainId: 10143 }), /Wrong chain or router/);
  assert.throws(() => decodeSwap(route, { ...tx, to: '0x00000000000000000000000000000000000000b2' }), /Wrong chain or router/);
  assert.throws(() => decodeSwap(route, { ...tx, data: '0xdeadbeef' }), /Unknown router call/);
  const inner = encodeFunctionData({ abi: routeAbi, functionName: 'exactInputSingle', args: [{ tokenIn: WMON, tokenOut: USDC, fee: 3000, recipient: WALLET, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  assert.throws(() => decodeSwap(route, { ...tx, data: inner }), /Only multicall/);
  assert.throws(() => decodeSwap(route, { ...tx, data: encodeFunctionData({ abi: routeAbi, functionName: 'multicall', args: [1n, [inner, inner]] }) }), /Exactly one nested call/);
  assert.throws(() => decodeSwap(route, { ...tx, data: encodeFunctionData({ abi: routeAbi, functionName: 'multicall', args: [1n, ['0x12345678' as Hex]] }) }), /Unknown nested command/);
  const otherFee = encodeFunctionData({ abi: routeAbi, functionName: 'exactInputSingle', args: [{ tokenIn: WMON, tokenOut: USDC, fee: 100, recipient: WALLET, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  assert.throws(() => decodeSwap(route, { ...tx, data: encodeFunctionData({ abi: routeAbi, functionName: 'multicall', args: [1n, [otherFee]] }) }), /reviewed shape/);
  assert.throws(() => decodeSwap(route, { ...tx, value: 5n }), /Value must equal/);
  assert.throws(() => buildSwap(route, { ...sell, tokenOut: WMON }), /not this pool/);
  assert.throws(() => buildSwap(route, { ...sell, tokenIn: USDC, tokenOut: WMON, nativeIn: true }), /wrapped/);
});

test('approvals are exact, to the router, on a pool token; unlimited is refused', () => {
  const a = buildApproval(route, USDC, 1_000_000n);
  assert.deepEqual(decodeApproval(route, a), { token: USDC, amount: 1_000_000n });
  assert.throws(() => decodeApproval(route, { ...a, to: '0x00000000000000000000000000000000000000c3' }), /pool token/);
  const unlimited = encodeFunctionData({ abi: routeAbi, functionName: 'approve', args: [route.router as Hex, 2n ** 256n - 1n] });
  assert.throws(() => decodeApproval(route, { ...a, data: unlimited }), /Unlimited/);
  const otherSpender = encodeFunctionData({ abi: routeAbi, functionName: 'approve', args: [WALLET as Hex, 5n] });
  assert.throws(() => decodeApproval(route, { ...a, data: otherSpender }), /spender/);
});

const transfer = (token: string, from: string, to: string, value: bigint) => ({
  address: token, topics: topics(encodeEventTopics({ abi: routeAbi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } })), data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
const swapLog = (recipient: string, amount0: bigint, amount1: bigint) => ({
  address: route.pool, topics: topics(encodeEventTopics({ abi: routeAbi, eventName: 'Swap', args: { sender: route.router as Hex, recipient: recipient as Hex } })),
  data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [amount0, amount1, 1n, 1n, 0]),
});

test('receipt: exact movements settle; a foreign recipient, extra outflow or short input is an unexpected effect', () => {
  const ok = [transfer(USDC, route.pool, WALLET, 24_500n), transfer(WMON, WALLET, route.pool, sell.amountIn), swapLog(WALLET, sell.amountIn, -24_500n)];
  assert.deepEqual(interpretSwapReceipt(route, sell, { succeeded: true, logs: ok }, WALLET), { succeeded: true, inputAtomic: sell.amountIn, outputAtomic: 24_500n });
  assert.deepEqual(interpretSwapReceipt(route, sell, { succeeded: false, logs: [] }, WALLET), { succeeded: false });
  assert.throws(() => interpretSwapReceipt(route, sell, { succeeded: true, logs: [ok[0]!, ok[1]!, swapLog('0x00000000000000000000000000000000000000c3', sell.amountIn, -24_500n)] }, WALLET), /someone other/);
  assert.throws(() => interpretSwapReceipt(route, sell, { succeeded: true, logs: [...ok, transfer(USDC, WALLET, '0x00000000000000000000000000000000000000c3', 1n)] }, WALLET), /outside the authorized swap/);
  assert.throws(() => interpretSwapReceipt(route, sell, { succeeded: true, logs: [ok[0]!, transfer(WMON, WALLET, route.pool, 1n), ok[2]!] }, WALLET), /different input/);
  assert.throws(() => interpretSwapReceipt(route, sell, { succeeded: true }, WALLET), /no logs/);
  // Native input: the router pays the pool with wrapped MON; the wallet sends no token.
  const native = { ...sell, nativeIn: true };
  const nativeLogs = [transfer(USDC, route.pool, WALLET, 24_500n), transfer(WMON, route.router, route.pool, sell.amountIn), swapLog(WALLET, sell.amountIn, -24_500n)];
  assert.deepEqual(interpretSwapReceipt(route, native, { succeeded: true, logs: nativeLogs }, WALLET), { succeeded: true, inputAtomic: sell.amountIn, outputAtomic: 24_500n });
  const approval = {
    address: USDC, topics: topics(encodeEventTopics({ abi: routeAbi, eventName: 'Approval', args: { owner: WALLET as Hex, spender: route.router as Hex } })), data: encodeAbiParameters([{ type: 'uint256' }], [7n]),
  };
  assert.equal(interpretApprovalReceipt(route, { token: USDC, amount: 7n }, { succeeded: true, logs: [approval] }, WALLET), true);
  assert.throws(() => interpretApprovalReceipt(route, { token: USDC, amount: 8n }, { succeeded: true, logs: [approval] }, WALLET), /authorized allowance/);
});
