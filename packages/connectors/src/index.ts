// Server-only connector reads; browser consumers import ./registry instead.
import { createPublicClient, http, parseAbi, decodeEventLog, toEventSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { contentHash, validate } from '@monad-hack/contracts';
import type { PriceObservation } from '@monad-hack/contracts';
import { HTTP_RPC, SOURCES, AAVE, TOKENS, UNISWAP_FACTORY, CURVE_FACTORY } from './registry.ts';
import type { Market } from './registry.ts';
export * from './registry.ts';

export const abi = parseAbi([
  'function getPool() view returns (address)', 'function getPriceOracle() view returns (address)',
  'function BASE_CURRENCY() view returns (address)', 'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetPrice(address) view returns (uint256)', 'function getSourceOfAsset(address) view returns (address)',
  'function getReserveData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40)',
  'function getReserveConfigurationData(address) view returns (uint256,uint256,uint256,uint256,uint256,bool,bool,bool,bool,bool)',
  'event ReserveDataUpdated(address indexed reserve,uint256 liquidityRate,uint256 stableBorrowRate,uint256 variableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex)',
  'function getPool(address,address,uint24) view returns (address)',
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function liquidity() view returns (uint128)',
  'function observe(uint32[]) view returns (int56[],uint160[])',
  'function pool_list(uint256) view returns (address)', 'function coins(uint256) view returns (address)',
  'function decimals() view returns (uint8)', 'function balances(uint256) view returns (uint256)',
  'function price_oracle(uint256) view returns (uint256)', 'function ma_exp_time() view returns (uint256)',
  'event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)',
  'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
  'event TokenExchange(address indexed buyer,int128 sold_id,uint256 tokens_sold,int128 bought_id,uint256 tokens_bought)',
  'event AddLiquidity(address indexed provider,uint256[] token_amounts,uint256[] fees,uint256 invariant,uint256 token_supply)',
  'event RemoveLiquidity(address indexed provider,uint256[] token_amounts,uint256[] fees,uint256 token_supply)',
  'event RemoveLiquidityOne(address indexed provider,int128 token_id,uint256 token_amount,uint256 coin_amount,uint256 token_supply)',
  'event RemoveLiquidityImbalance(address indexed provider,uint256[] token_amounts,uint256[] fees,uint256 invariant,uint256 token_supply)',
]);
const SCALE = 10n ** 18n;
export function decimal(numerator: bigint, denominator: bigint): string {
  if (numerator <= 0n || denominator <= 0n) throw new Error('Price inputs must be positive.');
  const value = numerator * SCALE / denominator;
  if (value <= 0n) throw new Error('Price is below supported precision.');
  const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (value / SCALE).toString() + (fraction ? '.' + fraction : '');
}
// Fixed-point exponentiation for 1.0001^tick; Q256 keeps precision even at the v3 tick extremes.
export function tickPrice(tick: number, baseDecimals: number, quoteDecimals: number, invert: boolean): string {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new Error('Tick outside Uniswap bounds.');
  const q = 1n << 256n;
  let power = Math.abs(tick), factor = q * 10001n / 10000n, ratio = q;
  while (power) { if (power % 2) ratio = ratio * factor / q; factor = factor * factor / q; power = Math.floor(power / 2); }
  if ((tick < 0) !== invert) ratio = q * q / ratio;
  return decimal(ratio * 10n ** BigInt(baseDecimals), q * 10n ** BigInt(quoteDecimals));
}
/** Annual percentage RATE as a fraction (0.05 = 5% APR), not compounded APY. Exact raw RAY stays in provenance. */
export function rayToApr(ray: string): string {
  const value = BigInt(ray) / 1_000_000_000n;
  const fraction = (value % SCALE).toString().padStart(18,'0').replace(/0+$/,'');
  return String(value / SCALE) + (fraction ? '.' + fraction : '');
}
export function meanTick(before: bigint, after: bigint, seconds: number): number {
  const delta = after - before, window = BigInt(seconds);
  // Solidity OracleLibrary rounds negative, non-integral mean ticks toward negative infinity.
  return Number(delta / window - (delta < 0n && delta % window !== 0n ? 1n : 0n));
}
export function checkedObservation(input: unknown, now = Date.now()): PriceObservation {
  const checked = validate('priceObservation', input);
  if (!checked.ok) throw new Error('Market observation failed its contract.');
  const o = checked.value;
  const m = SOURCES.find((market) => market.feedRef === o.feedRef);
  if (!m || o.connectorRef !== m.connectorRef || o.connectorVersion !== m.connectorVersion || o.poolAddress !== m.pool ||
      o.price.baseAssetRef !== `paper.${m.base}` || o.price.quoteUnit !== m.quote || o.method !== m.method ||
      o.windowSeconds !== m.windowSeconds || o.sourceEventKey !== `143:${m.pool}:${o.block.hash}:${m.method}` ||
      Date.parse(o.observedAt) > Date.parse(o.receivedAt) || Date.parse(o.receivedAt) > now ||
      BigInt(o.price.decimal.replace('.', '')) <= 0n) throw new Error('Market observation identity, units or time is invalid.');
  if (m.protocol === 'aave-v3' && (!o.reserve || o.reserve.assetAddress !== TOKENS[m.base].address || o.reserve.oracleAddress !== AAVE.oracle || Date.parse(o.reserve.lastUpdateAt) > Date.parse(o.observedAt))) throw new Error('Aave reserve identity or time is invalid.');
  return o;
}

/** Spaces requests to at most `perSecond` (metered providers such as the Alchemy free tier, D60). */
export function pacedFetch(perSecond: number, fetchFn: typeof globalThis.fetch = globalThis.fetch, now = () => Date.now()): typeof globalThis.fetch {
  if (!Number.isFinite(perSecond) || perSecond <= 0) throw new Error('Request rate must be positive.');
  const gap = 1000 / perSecond;
  let next = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const at = Math.max(now(), next);
    next = at + gap;
    if (at > now()) await new Promise((resolve) => setTimeout(resolve, at - now()));
    return fetchFn(input, init);
  }) as typeof globalThis.fetch;
}

export function rpcClient(url = HTTP_RPC, options: { maxRequestsPerSecond?: number } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Market RPC must use HTTPS without URL credentials.');
  const fetchFn = options.maxRequestsPerSecond ? pacedFetch(options.maxRequestsPerSecond) : undefined;
  return createPublicClient({ transport: http(url, { retryCount: 2, timeout: 10_000, fetchOptions: { redirect: 'error' }, ...(fetchFn ? { fetchFn } : {}) }) });
}
export type RpcClient = ReturnType<typeof rpcClient>;
export class MainnetMarkets {
  readonly client: RpcClient;
  constructor(client: RpcClient = rpcClient()) { this.client = client; }
  async verify(market: Market, blockNumber: bigint): Promise<void> {
    if (await this.client.getChainId() !== 143) throw new Error('Expected Monad mainnet chain 143.');
    const read = (address: string, functionName: string, args: readonly unknown[] = []) => this.client.readContract({ address: address as Address, abi, functionName, args, blockNumber } as never) as Promise<unknown>;
    if (!(await this.client.getCode({ address: market.pool, blockNumber }))) throw new Error('Pool bytecode is missing.');
    for (const symbol of (market.protocol === 'aave-v3' ? [market.base] : [market.base, market.quote])) {
      if (await read(TOKENS[symbol].address, 'decimals') !== TOKENS[symbol].decimals) throw new Error('Token decimals do not match the registry.');
    }
    if (market.protocol === 'uniswap-v3') {
      if (String(await read(UNISWAP_FACTORY, 'getPool', [TOKENS[market.base].address, TOKENS[market.quote].address, market.fee])).toLowerCase() !== market.pool) throw new Error('Uniswap factory membership mismatch.');
      const token0 = String(await read(market.pool, 'token0')).toLowerCase(), token1 = String(await read(market.pool, 'token1')).toLowerCase();
      if (![token0, token1].includes(TOKENS[market.base].address) || ![token0, token1].includes(TOKENS[market.quote].address) || token0 === token1) throw new Error('Uniswap token identity mismatch.');
      if ((await read(market.pool, 'liquidity') as bigint) <= 0n) throw new Error('Uniswap pool has no active liquidity.');
    } else if (market.protocol === 'curve-stableswap-ng') {
      if (String(await read(CURVE_FACTORY, 'pool_list', [BigInt(market.factoryIndex)])).toLowerCase() !== market.pool) throw new Error('Curve factory membership mismatch.');
      for (const [index, symbol] of [[market.baseIndex, market.base], [market.quoteIndex, market.quote]] as const) {
        if (String(await read(market.pool, 'coins', [BigInt(index)])).toLowerCase() !== TOKENS[symbol].address) throw new Error('Curve coin identity mismatch.');
        if ((await read(market.pool, 'balances', [BigInt(index)]) as bigint) <= 0n) throw new Error('Curve pool has no inventory.');
      }
    } else {
      if (String(await read(AAVE.provider,'getPool')).toLowerCase() !== AAVE.pool || String(await read(AAVE.provider,'getPriceOracle')).toLowerCase() !== AAVE.oracle) throw new Error('Aave provider identity changed.');
      if (await read(AAVE.oracle,'BASE_CURRENCY_UNIT') !== 100_000_000n || String(await read(AAVE.oracle,'BASE_CURRENCY')).toLowerCase() !== '0x'+'0'.repeat(40)) throw new Error('Aave USD reference unit changed.');
      const config = await read(AAVE.dataProvider,'getReserveConfigurationData',[TOKENS[market.base].address]) as readonly unknown[];
      if (config[0] !== BigInt(TOKENS[market.base].decimals) || config[8] !== true) throw new Error('Aave reserve is inactive or has different decimals.');
    }
  }
  async observe(market: Market, blockNumber: bigint): Promise<PriceObservation> {
    const [block, finalized] = await Promise.all([this.client.getBlock({ blockNumber }), this.client.getBlock({ blockTag: 'finalized' })]);
    if (finalized.number === null || blockNumber > finalized.number || (blockNumber === finalized.number && block.hash !== finalized.hash)) throw new Error('Oracle read is not finalized.');
    let price: string, windowSeconds: number;
    let reserve: PriceObservation["reserve"];
    if (market.protocol === 'uniswap-v3') {
      const [ticks] = await this.client.readContract({ address: market.pool, abi, functionName: 'observe', args: [[30, 0]], blockNumber });
      const token0 = await this.client.readContract({ address: market.pool, abi, functionName: 'token0', blockNumber });
      price = tickPrice(meanTick(ticks[0]!, ticks[1]!, 30), TOKENS[market.base].decimals, TOKENS[market.quote].decimals, token0.toLowerCase() !== TOKENS[market.base].address);
      windowSeconds = 30;
    } else if (market.protocol === 'curve-stableswap-ng') {
      // StableSwap-NG oracle[i] is coin i+1 denominated in coin 0, both in human units.
      const oracle = await this.client.readContract({ address: market.pool, abi, functionName: 'price_oracle', args: [0n], blockNumber });
      price = decimal(SCALE, oracle);
      const window = await this.client.readContract({ address: market.pool, abi, functionName: 'ma_exp_time', blockNumber });
      if (window < 1n || window > 86400n) throw new Error('Curve oracle smoothing outside published bounds.');
      windowSeconds = Number(window);
    } else {
      const asset = TOKENS[market.base].address;
      const [value, data, source] = await Promise.all([
        this.client.readContract({address:AAVE.oracle,abi,functionName:'getAssetPrice',args:[asset],blockNumber}),
        this.client.readContract({address:AAVE.dataProvider,abi,functionName:'getReserveData',args:[asset],blockNumber}),
        this.client.readContract({address:AAVE.oracle,abi,functionName:'getSourceOfAsset',args:[asset],blockNumber}),
      ]);
      price = decimal(value,100_000_000n); windowSeconds = 0;
      if (BigInt(data[11]) > block.timestamp || data[2] <= 0n || source === '0x'+'0'.repeat(40)) throw new Error('Aave reserve state is invalid.');
      reserve = {assetAddress:asset,oracleAddress:AAVE.oracle,oracleSourceAddress:source.toLowerCase(),priceUpdateTimeAvailable:false,supplyRateRay:String(data[5]),variableBorrowRateRay:String(data[6]),lastUpdateAt:new Date(Number(data[11])*1000).toISOString()};
    }
    if (!block.hash) throw new Error('Canonical block hash unavailable.');
    const raw = { pool: market.pool, blockHash: block.hash, blockNumber: String(block.number), price, method: market.method, windowSeconds, ...(reserve ? {reserve} : {}) };
    const now = new Date().toISOString();
    return checkedObservation({
      schemaVersion: 'price-observation/1', feedRef: market.feedRef, connectorRef: market.connectorRef, connectorVersion: market.connectorVersion,
      networkRef: 'monad-mainnet', sourceEventKey: `143:${market.pool}:${block.hash}:${market.method}`, poolAddress: market.pool,
      finality: 'finalized', method: market.method, windowSeconds, ...(reserve ? {reserve} : {}),
      price: { baseAssetRef: `paper.${market.base}`, quoteUnit: market.quote, decimal: price },
      observedAt: new Date(Number(block.timestamp) * 1000).toISOString(), receivedAt: now,
      block: { chainId: 143, number: String(block.number), hash: block.hash }, provenanceHash: await contentHash(raw),
    });
  }
}
export function eventTopics(market: Market): Hex[] {
  const names = market.protocol === 'aave-v3' ? ['ReserveDataUpdated'] : market.protocol === 'uniswap-v3' ? ['Swap', 'Mint', 'Burn'] : ['TokenExchange', 'AddLiquidity', 'RemoveLiquidity', 'RemoveLiquidityOne', 'RemoveLiquidityImbalance'];
  const signatures: Record<string, string> = { Mint: 'Mint(address,address,int24,int24,uint128,uint256,uint256)', Burn: 'Burn(address,int24,int24,uint128,uint256,uint256)' };
  return names.map((name) => toEventSelector(signatures[name] ?? abi.find((item) => item.type === 'event' && item.name === name)!));
}
export function validateSwapLog(market: Market, log: { address: string; data: Hex; topics: readonly Hex[] }): void {
  if (log.address.toLowerCase() !== market.pool) throw new Error('Log came from an unregistered pool.');
  decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
}
export * from './live-uniswap.ts';
