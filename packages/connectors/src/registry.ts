// Reviewed read-only Monad mainnet markets. Paper asset refs identify virtual inventory, never real custody.
// Discovery and finalized-block probes: docs/research/market-data-sources.md.
export const MAINNET_CHAIN_ID = 143;
export const HTTP_RPC = 'https://rpc.monad.xyz';
export const WS_RPC = 'wss://rpc.monad.xyz';
export const UNISWAP_FACTORY = '0x204faca1764b154221e35c0d20abb3c525710498';
export const CURVE_FACTORY = '0x8271e06e5887fe5ba05234f5315c19f3ec90e8ad';
export const TOKENS = {
  WMON: { address: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a', decimals: 18 },
  USDC: { address: '0x754704bc059f8c67012fed69bc8a327a5aafb603', decimals: 6 },
  AUSD: { address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a', decimals: 6 },
} as const;
export const MARKETS = [
  { feedRef: 'paper.wmon-usdc', connectorRef: 'paper.uniswap', connectorVersion: '1.1.0', protocol: 'uniswap-v3',
    pool: '0x83fef384587d07731880416db8850f8af66fda03', base: 'WMON', quote: 'USDC', fee: 100,
    method: 'uniswap-v3-geometric-twap', windowSeconds: 30 },
  { feedRef: 'paper.ausd-usdc', connectorRef: 'paper.curve', connectorVersion: '1.0.0', protocol: 'curve-stableswap-ng',
    pool: '0x942644106b073e30d72c2c5d7529d5c296ea91ab', base: 'AUSD', quote: 'USDC', baseIndex: 0, quoteIndex: 1, factoryIndex: 2,
    method: 'curve-native-ema', windowSeconds: 866 },
] as const;
export const AAVE = {
  provider: '0x34793fb9935f7bb5e5ae920fb963f39063e7a615', pool: '0x69a5f9ad4f96ebf0a0c792dd42a01cc5c0102fef',
  oracle: '0x0c02b2c2038066c10eab8fe1d5cdb73d5a78a1bf', dataProvider: '0xb65a68b98274ef7d9a60e0c0747dd1bec3d32fad',
} as const;
export const AAVE_RESERVES = (['USDC', 'AUSD'] as const).map(base => ({
  feedRef: `paper.aave-${base.toLowerCase()}-usd`, connectorRef: 'paper.aave', connectorVersion: '1.0.0', protocol: 'aave-v3',
  pool: AAVE.pool, base, quote: 'USD', method: 'aave-native-oracle', windowSeconds: 0,
} as const));
export const SOURCES = [...MARKETS, ...AAVE_RESERVES] as const;
export type Market = typeof SOURCES[number];
export const MANIFESTS = [
  ...MARKETS.map(m => ({
    schemaVersion: 'connector-manifest/1' as const, ref: m.connectorRef, version: m.connectorVersion,
    networkRef: 'paper-monad' as const, mode: 'paper' as const, sourceNetworkRef: 'monad-mainnet' as const,
    sourceChainId: MAINNET_CHAIN_ID, protocol: m.protocol, poolAddress: m.pool,
    capabilities: ['price.read', 'swap.quote', 'swap.exactInput'],
    limitations: ['Mainnet observations; virtual inventory and simulated fills only.', 'One reviewed pool; no live signing, routing or liquidity positions.'],
    verifiedAt: '2026-10-12T17:21:04.000Z',
  })),
  { schemaVersion: 'connector-manifest/1' as const, ref: 'paper.aave', version: '1.0.0', networkRef: 'paper-monad' as const, mode: 'paper' as const,
    sourceNetworkRef: 'monad-mainnet' as const, sourceChainId: MAINNET_CHAIN_ID, protocol: 'aave-v3', poolAddress: AAVE.pool,
    capabilities: ['price.read', 'reserve.read', 'ausd.price.read', 'ausd.reserve.read'],
    limitations: ['USDC and AUSD reserve prices and annualized supply/variable borrow rates only.', 'Block observation time is not underlying price update time; adapter exposes no latestRoundData.', 'No supply, borrow, repay, withdraw, swap or signing capability.'], verifiedAt: '2026-10-12T17:45:17.000Z' },
];
const priceRead = (base: string, quoteUnit: string) => ({ arguments: {}, result: { price: { valueType: 'Price', baseAssetRef: `paper.${base}`, quoteUnit }, observedAt: { valueType: 'Timestamp' } }, maxAgeSeconds: 30 } as const);
const reserveRead = { arguments: {}, result: { supplyApr: { valueType: 'Decimal' }, variableBorrowApr: { valueType: 'Decimal' }, observedAt: { valueType: 'Timestamp' } }, maxAgeSeconds: 30 } as const;
// USDC/AUSD are token units, never implicitly converted into USD.
export const marketCatalog: import('@monad-hack/strategy').Catalog = {
  networks: { 'paper-monad': { blockMillis: 400, finalityBlocks: 2 } },
  assets: {
    'paper.MON': { networkRef: 'paper-monad', mode: 'paper', decimals: 18, native: true },
    'paper.WMON': { networkRef: 'paper-monad', mode: 'paper', decimals: 18 },
    'paper.USDC': { networkRef: 'paper-monad', mode: 'paper', decimals: 6 },
    'paper.AUSD': { networkRef: 'paper-monad', mode: 'paper', decimals: 6 },
  },
  feeds: Object.fromEntries(SOURCES.map(m => [m.feedRef, {
    baseAssetRef: `paper.${m.base}`, quoteUnit: m.quote, source: m.method === 'aave-native-oracle' ? 'nativeOracle' : m.method === 'curve-native-ema' ? 'poolEma' : 'poolTwap',
    connectorRef: m.connectorRef, windowSeconds: m.windowSeconds, finality: 'finalized',
  } as const])),
  connectors: {
    ...Object.fromEntries(MARKETS.map(m => [m.connectorRef, { networkRef: 'paper-monad', mode: 'paper', version: m.connectorVersion, venue: m.protocol === 'uniswap-v3' ? 'uniswap-v3' : 'curve', actions: ['swap.exactInput', 'price.read'] } as const])),
    'paper.aave': { networkRef: 'paper-monad', mode: 'paper', version: '1.0.0', venue: 'aave', actions: ['price.read', 'reserve.read', 'ausd.price.read', 'ausd.reserve.read'] },
  },
  reads: {
    ...Object.fromEntries(MARKETS.map(m => [m.connectorRef, { 'price.read': priceRead(m.base,m.quote) }])),
    'paper.aave': { 'price.read': priceRead('USDC','USD'), 'reserve.read': reserveRead, 'ausd.price.read': priceRead('AUSD','USD'), 'ausd.reserve.read': reserveRead },
  },
  modelProfiles: {},
} as const;
export function catalogSeeds() {
  const entry = (kind: string, ref: string, version: string, definition: object) => ({ kind, ref, version, modes: ['paper'], definition });
  return [
    ...MANIFESTS.map(manifest => entry('connector',manifest.ref,manifest.version,{networkRef:'paper-monad',capabilities:manifest.capabilities,manifest})),
    ...Object.entries(TOKENS).map(([symbol,token]) => entry('asset',`paper.${symbol}`,'1.0.0',{identity:{kind:'paper',networkRef:'paper-monad',assetRef:`paper.${symbol}`},decimals:token.decimals})),
    ...SOURCES.map(m => entry('feed',m.feedRef,'1.0.0',{networkRef:'paper-monad',baseAssetRef:`paper.${m.base}`,quoteUnit:m.quote,source:'mainnet',method:m.method,sourceChainId:143,poolAddress:m.pool})),
  ];
}
