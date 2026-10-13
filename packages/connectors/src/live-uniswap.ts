// Live Uniswap v3 exact-input route on Monad mainnet (docs/specs/executor.md sections 9 and 10). The connector quotes,
// builds, decodes and interprets; it never authorizes, reserves, signs, broadcasts or settles. Everything it reads
// back from a transaction or receipt is checked against the frozen authorization, and anything it cannot decode is a
// rejection. One reviewed pool, SwapRouter02 `multicall(deadline, [exactInputSingle])`: the router enforces the
// deadline on chain, and the single inner call is the only nested command accepted.
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import type { Hex } from 'viem';
import { meanTick, tickPrice } from './index.ts';

export interface UniswapRoute {
  readonly chainId: number;
  readonly factory: string;
  readonly router: string;
  readonly quoter: string;
  readonly pool: string;
  readonly fee: number;
  /** Wrapped native token (the router's WETH9). Native MON in is sent as value with tokenIn = wmon. */
  readonly wmon: string;
  readonly token0: { readonly address: string; readonly decimals: number };
  readonly token1: { readonly address: string; readonly decimals: number };
}

/** The read surface the connector needs (JsonRpcChain satisfies it). */
export interface RouteReader {
  simulate(request: { from: string; to: string; data: string; value?: bigint }, block?: bigint | 'latest'): Promise<string>;
}

export interface SwapLeg {
  readonly tokenIn: string;
  readonly tokenOut: string;
  /** Native MON in: tokenIn is the wrapped token and the amount is sent as transaction value. */
  readonly nativeIn: boolean;
  readonly amountIn: bigint;
}

export interface FrozenSwap extends SwapLeg {
  readonly recipient: string;
  readonly amountOutMinimum: bigint;
  /** Unix seconds; the router reverts after it. */
  readonly deadline: bigint;
}

export interface UnsignedTransaction {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

export const routeAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function getPool(address, address, uint24) view returns (address)',
  'function WETH9() view returns (address)',
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);

const lower = (a: string): string => a.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const READER = '0x0000000000000000000000000000000000000001';

async function read<T>(reader: RouteReader, to: string, functionName: string, args: readonly unknown[] = [], block: bigint | 'latest' = 'latest'): Promise<T> {
  const data = encodeFunctionData({ abi: routeAbi, functionName, args } as never);
  const raw = await reader.simulate({ from: READER, to, data }, block);
  return decodeFunctionResult({ abi: routeAbi, functionName, data: raw as Hex } as never) as T;
}

/** Route identity at a block: factory membership, router and quoter wiring, pool tokens and fee. */
export async function verifyRoute(reader: RouteReader, route: UniswapRoute, block: bigint | 'latest' = 'latest'): Promise<void> {
  const [pool, weth, routerFactory, quoterFactory, token0, token1, fee] = await Promise.all([
    read<string>(reader, route.factory, 'getPool', [route.token0.address, route.token1.address, route.fee], block),
    read<string>(reader, route.router, 'WETH9', [], block),
    read<string>(reader, route.router, 'factory', [], block),
    read<string>(reader, route.quoter, 'factory', [], block),
    read<string>(reader, route.pool, 'token0', [], block),
    read<string>(reader, route.pool, 'token1', [], block),
    read<number>(reader, route.pool, 'fee', [], block),
  ]);
  if (lower(pool) !== lower(route.pool)) throw new RouteError('The pool is not the factory pool for this pair and fee.');
  if (lower(weth) !== lower(route.wmon)) throw new RouteError('The router wraps a different native token.');
  if (lower(routerFactory) !== lower(route.factory) || lower(quoterFactory) !== lower(route.factory)) throw new RouteError('Router or quoter belongs to another factory.');
  if (lower(token0) !== lower(route.token0.address) || lower(token1) !== lower(route.token1.address) || Number(fee) !== route.fee) throw new RouteError('Pool tokens or fee changed.');
}

function checkLeg(route: UniswapRoute, leg: SwapLeg): void {
  const pair = [lower(route.token0.address), lower(route.token1.address)];
  if (!pair.includes(lower(leg.tokenIn)) || !pair.includes(lower(leg.tokenOut)) || lower(leg.tokenIn) === lower(leg.tokenOut)) throw new RouteError('The pair is not this pool.');
  if (leg.nativeIn && lower(leg.tokenIn) !== lower(route.wmon)) throw new RouteError('Native input must be wrapped by the router.');
  if (leg.amountIn <= 0n) throw new RouteError('The input must be positive.');
}

/** QuoterV2 exact-input quote at the given state. */
export async function quote(reader: RouteReader, route: UniswapRoute, leg: SwapLeg, block: bigint | 'latest' = 'latest'): Promise<{ readonly expectedOutputAtomic: bigint; readonly gasEstimate: bigint }> {
  checkLeg(route, leg);
  const [amountOut, , , gasEstimate] = await read<readonly [bigint, bigint, number, bigint]>(reader, route.quoter, 'quoteExactInputSingle', [{ tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn: leg.amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }], block);
  if (amountOut <= 0n) throw new RouteError('The pool quotes no output.');
  return { expectedOutputAtomic: amountOut, gasEstimate };
}

/**
 * Independent reference: the pool's own 30 s geometric TWAP at a finalized block (the oracle, not the spot price the
 * quote moves), converted to the output this input would buy with no price impact or fee.
 */
export async function referenceOutput(reader: RouteReader, route: UniswapRoute, leg: SwapLeg, block: bigint, windowSeconds = 30): Promise<bigint> {
  checkLeg(route, leg);
  const [ticks] = await read<readonly [readonly bigint[], readonly bigint[]]>(reader, route.pool, 'observe', [[windowSeconds, 0]], block);
  // tickPrice(…, invert=false): token1 per token0 in whole units, 18-digit decimal string.
  const price = tickPrice(meanTick(ticks[0]!, ticks[1]!, windowSeconds), route.token0.decimals, route.token1.decimals, false);
  const [whole, frac = ''] = price.split('.');
  const scale = 10n ** BigInt(frac.length);
  const num = BigInt(whole! + frac); // price = num / scale
  const d0 = 10n ** BigInt(route.token0.decimals);
  const d1 = 10n ** BigInt(route.token1.decimals);
  return lower(leg.tokenIn) === lower(route.token0.address)
    ? (leg.amountIn * num * d1) / (scale * d0)
    : (leg.amountIn * scale * d0) / (num * d1);
}

/** minimumOutput = floor(expected × (10 000 − slippage) / 10 000). */
export const minimumOutput = (expected: bigint, slippageBps: number): bigint => (expected * BigInt(10_000 - slippageBps)) / 10_000n;

export function buildSwap(route: UniswapRoute, swap: FrozenSwap): UnsignedTransaction {
  checkLeg(route, swap);
  const inner = encodeFunctionData({
    abi: routeAbi, functionName: 'exactInputSingle',
    args: [{ tokenIn: swap.tokenIn as Hex, tokenOut: swap.tokenOut as Hex, fee: route.fee, recipient: swap.recipient as Hex, amountIn: swap.amountIn, amountOutMinimum: swap.amountOutMinimum, sqrtPriceLimitX96: 0n }],
  });
  const data = encodeFunctionData({ abi: routeAbi, functionName: 'multicall', args: [swap.deadline, [inner]] });
  return { chainId: route.chainId, to: lower(route.router), data, value: swap.nativeIn ? swap.amountIn : 0n };
}

/** Full decode of a swap transaction; anything but the one reviewed shape is rejected. */
export function decodeSwap(route: UniswapRoute, tx: UnsignedTransaction): FrozenSwap {
  if (tx.chainId !== route.chainId || lower(tx.to) !== lower(route.router)) throw new RouteError('Wrong chain or router.');
  let outer;
  try {
    outer = decodeFunctionData({ abi: routeAbi, data: tx.data as Hex });
  } catch {
    throw new RouteError('Unknown router call.');
  }
  if (outer.functionName !== 'multicall') throw new RouteError('Only multicall(deadline, [exactInputSingle]) is accepted.');
  const [deadline, calls] = outer.args as readonly [bigint, readonly Hex[]];
  if (calls.length !== 1) throw new RouteError('Exactly one nested call is accepted.');
  let inner;
  try {
    inner = decodeFunctionData({ abi: routeAbi, data: calls[0]! });
  } catch {
    throw new RouteError('Unknown nested command.');
  }
  if (inner.functionName !== 'exactInputSingle') throw new RouteError('Only exactInputSingle is accepted.');
  const p = (inner.args as readonly [{ tokenIn: string; tokenOut: string; fee: number; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }])[0];
  if (p.fee !== route.fee || p.sqrtPriceLimitX96 !== 0n || lower(p.recipient) === ZERO) throw new RouteError('Fee, price limit or recipient is not the reviewed shape.');
  const nativeIn = tx.value > 0n;
  if (nativeIn && (tx.value !== p.amountIn || lower(p.tokenIn) !== lower(route.wmon))) throw new RouteError('Value must equal the wrapped native input.');
  const swap: FrozenSwap = { tokenIn: lower(p.tokenIn), tokenOut: lower(p.tokenOut), nativeIn, amountIn: p.amountIn, recipient: lower(p.recipient), amountOutMinimum: p.amountOutMinimum, deadline };
  checkLeg(route, swap);
  return swap;
}

export function buildApproval(route: UniswapRoute, token: string, amount: bigint): UnsignedTransaction {
  if (amount <= 0n) throw new RouteError('An approval must be bounded and positive.');
  return { chainId: route.chainId, to: lower(token), data: encodeFunctionData({ abi: routeAbi, functionName: 'approve', args: [route.router as Hex, amount] }), value: 0n };
}

/** approve(router, amount) on a pool token, exact and bounded; anything else is rejected. */
export function decodeApproval(route: UniswapRoute, tx: UnsignedTransaction): { readonly token: string; readonly amount: bigint } {
  const tokens = [lower(route.token0.address), lower(route.token1.address)];
  if (tx.chainId !== route.chainId || !tokens.includes(lower(tx.to)) || tx.value !== 0n) throw new RouteError('Approvals go to a pool token with no value.');
  let call;
  try {
    call = decodeFunctionData({ abi: routeAbi, data: tx.data as Hex });
  } catch {
    throw new RouteError('Unknown token call.');
  }
  if (call.functionName !== 'approve') throw new RouteError('Only approve is accepted.');
  const [spender, amount] = call.args as readonly [string, bigint];
  if (lower(spender) !== lower(route.router)) throw new RouteError('The spender must be the reviewed router.');
  if (amount <= 0n || amount >= 2n ** 255n) throw new RouteError('Unlimited or empty approvals are refused.');
  return { token: lower(tx.to), amount };
}

export interface ReceiptLike {
  readonly succeeded: boolean;
  readonly logs?: readonly { readonly address: string; readonly topics: readonly string[]; readonly data: string }[];
}

type Decoded = { address: string; eventName: string; args: Record<string, unknown> };
function events(receipt: ReceiptLike): Decoded[] {
  if (!receipt.logs) throw new RouteError('The receipt has no logs to interpret.');
  const out: Decoded[] = [];
  for (const log of receipt.logs) {
    try {
      const e = decodeEventLog({ abi: routeAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
      out.push({ address: lower(log.address), eventName: e.eventName, args: e.args as Record<string, unknown> });
    } catch {
      // Events outside the reviewed ABI (e.g. WMON Deposit) carry no movement we settle on.
    }
  }
  return out;
}

/**
 * Actual movements from a canonical receipt, checked against the frozen swap: the pool's Swap pays the wallet, the
 * pool receives exactly the input, the wallet receives exactly the output, and the wallet sends nothing else.
 * Anything else is an unexpected effect: the caller freezes and reconciles instead of settling.
 */
export function interpretSwapReceipt(route: UniswapRoute, swap: FrozenSwap, receipt: ReceiptLike, wallet: string): { readonly succeeded: false } | { readonly succeeded: true; readonly inputAtomic: bigint; readonly outputAtomic: bigint } {
  if (!receipt.succeeded) return { succeeded: false };
  const w = lower(wallet);
  const pool = lower(route.pool);
  const all = events(receipt);
  const swaps = all.filter((e) => e.eventName === 'Swap' && e.address === pool);
  if (swaps.length !== 1) throw new RouteError('Expected exactly one Swap on the reviewed pool.');
  const s = swaps[0]!.args as { recipient: string; amount0: bigint; amount1: bigint };
  if (lower(s.recipient) !== w) throw new RouteError('The swap paid someone other than the wallet.');
  const inIs0 = lower(swap.tokenIn) === lower(route.token0.address);
  const deltaIn = inIs0 ? s.amount0 : s.amount1;
  const deltaOut = inIs0 ? s.amount1 : s.amount0;
  if (deltaIn !== swap.amountIn || deltaOut >= 0n) throw new RouteError('Swap amounts differ from the authorized input.');
  const output = -deltaOut;
  const transfers = all.filter((e) => e.eventName === 'Transfer').map((e) => ({ token: e.address, from: lower(e.args['from'] as string), to: lower(e.args['to'] as string), value: e.args['value'] as bigint }));
  const received = transfers.filter((t) => t.token === lower(swap.tokenOut) && t.to === w).reduce((a, t) => a + t.value, 0n);
  const fromWallet = transfers.filter((t) => t.from === w);
  const expectedPayer = swap.nativeIn ? lower(route.router) : w;
  const paid = transfers.filter((t) => t.token === lower(swap.tokenIn) && t.from === expectedPayer && t.to === pool).reduce((a, t) => a + t.value, 0n);
  if (received !== output) throw new RouteError('The wallet received a different output than the pool paid.');
  if (paid !== swap.amountIn) throw new RouteError('The pool received a different input than authorized.');
  if (fromWallet.some((t) => !(t.token === lower(swap.tokenIn) && t.to === pool && !swap.nativeIn)) || fromWallet.length > (swap.nativeIn ? 0 : 1)) throw new RouteError('The wallet sent tokens outside the authorized swap.');
  if (output < swap.amountOutMinimum) throw new RouteError('Output below the authorized minimum.');
  return { succeeded: true, inputAtomic: swap.amountIn, outputAtomic: output };
}

/** The approval receipt must set exactly the authorized allowance for the router. */
export function interpretApprovalReceipt(route: UniswapRoute, approval: { readonly token: string; readonly amount: bigint }, receipt: ReceiptLike, wallet: string): boolean {
  if (!receipt.succeeded) return false;
  const ok = events(receipt).some((e) => e.eventName === 'Approval' && e.address === lower(approval.token) && lower(e.args['owner'] as string) === lower(wallet)
    && lower(e.args['spender'] as string) === lower(route.router) && (e.args['value'] as bigint) === approval.amount);
  if (!ok) throw new RouteError('The approval receipt does not show the authorized allowance.');
  return true;
}
