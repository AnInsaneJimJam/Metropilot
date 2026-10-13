// Live catalog for Monad testnet: the network and the three tradable assets (MON, WMON, USDC). Unlike the paper
// seed these describe real contracts; each address was taken from the official lists and confirmed on chain
// (symbol() and decimals() at a finalized block; evidence under "Live catalog" in docs/decisions.md):
//   WMON  0xFb8b…C541  docs.monad.xyz testnet canonical contracts and monad-crypto/token-list: "WMON", 18 decimals
//   USDC  0x534b…43A3  Circle USDC contract addresses and monad-crypto/token-list: "USDC", 6 decimals
// Catalog entries alone do not enable live trading: a live connector (venue) entry is still required.
import { contentHash } from '@monad-hack/contracts';
import type pg from 'pg';

export const MONAD_TESTNET = { networkRef: 'monad-testnet', chainId: 10143 } as const;

type CatalogEntry = { kind: string; ref: string; version: string; modes: string[]; definition: Record<string, unknown> };

export function liveCatalog(): CatalogEntry[] {
  const { networkRef, chainId } = MONAD_TESTNET;
  const live = ['live'];
  const erc20 = (ref: string, symbol: string, contractAddress: string, decimals: number): CatalogEntry => ({
    kind: 'asset', ref, version: '1.0.0', modes: live,
    definition: { identity: { kind: 'erc20', networkRef, chainId, contractAddress }, decimals, symbol },
  });
  return [
    { kind: 'network', ref: networkRef, version: '1.0.0', modes: live, definition: { registry: 'monad', chainId, finality: 'finalized' } },
    { kind: 'asset', ref: 'live.MON', version: '1.0.0', modes: live, definition: { identity: { kind: 'native', networkRef, chainId }, decimals: 18, symbol: 'MON' } },
    erc20('live.WMON', 'WMON', '0xfb8bf4c1cc7a94c73d209a149ea2abea852bc541', 18),
    erc20('live.USDC', 'USDC', '0x534b2f3a21130d7a60830c2df862319e593943a3', 6),
  ];
}

/** Insert the live catalog in one transaction. Re-running is a no-op; a conflicting existing row is an error. */
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
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
