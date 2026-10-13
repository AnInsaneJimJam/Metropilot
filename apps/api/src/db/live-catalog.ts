// Live catalogs for Monad testnet (funding checks) and Monad mainnet (trading through Uniswap v3). These describe
// real contracts; each address comes from the official lists and was confirmed on chain at a finalized block
// (evidence under "Live catalog" in docs/decisions.md). Asset refs differ per network so a balance credited on one
// chain can never back a spend on another (the ledger keys accounts by asset ref).
//   testnet  WMON 0xFb8b…C541 (docs.monad.xyz, monad-crypto/token-list)  USDC 0x534b…43A3 (Circle, token-list)
//   mainnet  WMON 0x3bd3…433A, USDC 0x7547…b603 (packages/connectors registry, Circle); Uniswap v3 per
//            developers.uniswap.org Monad deployments: factory 0x204f…0498, SwapRouter02 0xfe31…b900,
//            QuoterV2 0x661e…f08d; WMON/USDC 0.3% pool 0x659b…a9da (the deep pool; the 0.01% pool the market-data
//            feed reads held about 0.26 USDC on 2026-10-13, see D52).
import { contentHash } from '@monad-hack/contracts';
import type pg from 'pg';

export const MONAD_TESTNET = { networkRef: 'monad-testnet', chainId: 10143 } as const;
export const MONAD_MAINNET = { networkRef: 'monad-mainnet', chainId: 143 } as const;

export const MAINNET_UNISWAP = {
  ref: 'mainnet.uniswap-v3',
  version: '1.0.0',
  factory: '0x204faca1764b154221e35c0d20abb3c525710498',
  router: '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
  quoter: '0x661e93cca42afacb172121ef892830ca3b70f08d',
  pool: '0x659bd0bc4167ba25c62e05656f78043e7ed4a9da',
  fee: 3000,
  wmon: '0x3bd359c1119da7da1d913d1c4d2b7c461115433a',
  usdc: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
} as const;

type CatalogEntry = { kind: string; ref: string; version: string; modes: string[]; definition: Record<string, unknown> };

function networkAssets(prefix: string, network: { networkRef: string; chainId: number }, wmon: string, usdc: string): CatalogEntry[] {
  const { networkRef, chainId } = network;
  const live = ['live'];
  const erc20 = (symbol: string, contractAddress: string, decimals: number): CatalogEntry => ({
    kind: 'asset', ref: `${prefix}.${symbol}`, version: '1.0.0', modes: live,
    definition: { identity: { kind: 'erc20', networkRef, chainId, contractAddress }, decimals, symbol },
  });
  return [
    { kind: 'network', ref: networkRef, version: '1.0.0', modes: live, definition: { registry: 'monad', chainId, finality: 'finalized' } },
    { kind: 'asset', ref: `${prefix}.MON`, version: '1.0.0', modes: live, definition: { identity: { kind: 'native', networkRef, chainId }, decimals: 18, symbol: 'MON' } },
    erc20('WMON', wmon, 18),
    erc20('USDC', usdc, 6),
  ];
}

export function liveCatalog(): CatalogEntry[] {
  const u = MAINNET_UNISWAP;
  return [
    ...networkAssets('testnet', MONAD_TESTNET, '0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541', '0x534b2f3a21130d7a60830c2df862319e593943a3'),
    ...networkAssets('mainnet', MONAD_MAINNET, u.wmon, u.usdc),
    {
      kind: 'connector', ref: u.ref, version: u.version, modes: ['live'],
      definition: {
        networkRef: MONAD_MAINNET.networkRef, chainId: MONAD_MAINNET.chainId, capabilities: ['swap.quote', 'swap.exactInput'], protocol: 'uniswap-v3',
        factory: u.factory, router: u.router, quoter: u.quoter, pool: u.pool, fee: u.fee,
        // One reviewed pool; USDC → native MON (unwrap) is not offered yet.
        pairs: [['mainnet.MON', 'mainnet.USDC'], ['mainnet.WMON', 'mainnet.USDC'], ['mainnet.USDC', 'mainnet.WMON']],
        referencePrice: 'pool 30 s geometric TWAP (packages/connectors MainnetMarkets.observe)',
      },
    },
  ];
}

/** Refs seeded under an earlier name for the testnet assets; disabled so nothing resolves them. */
const LEGACY_TESTNET_REFS = ['live.MON', 'live.WMON', 'live.USDC'];

/** Insert the live catalogs in one transaction. Re-running is a no-op; a conflicting existing row is an error. */
export async function seedLiveCatalog(client: pg.ClientBase): Promise<void> {
  await client.query('begin');
  try {
    for (const entry of liveCatalog()) {
      const hash = await contentHash(entry.definition);
      await client.query(
        `insert into catalog_versions (kind, ref, version, modes, content_hash, definition)
         values ($1, $2, $3, $4, $5, $6) on conflict (ref, version) do nothing`,
        [entry.kind, entry.ref, entry.version, entry.modes, hash, entry.definition],
      );
      const { rows } = await client.query<{ content_hash: string }>('select content_hash from catalog_versions where ref = $1 and version = $2', [entry.ref, entry.version]);
      if (rows[0]?.content_hash !== hash) throw new Error(`catalog ${entry.ref}@${entry.version} exists with different content`);
    }
    await client.query(
      `update catalog_versions set disabled_reason = 'Renamed to testnet.* (asset refs are per network).'
         where ref = any($1) and disabled_reason is null and definition -> 'identity' ->> 'networkRef' = $2`,
      [LEGACY_TESTNET_REFS, MONAD_TESTNET.networkRef]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
