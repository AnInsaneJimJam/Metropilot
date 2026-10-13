// Custody configuration from the environment (docs/integration/funds.md). Nothing is enabled by default:
//   CUSTODY_PROVIDER=local  in-process local chain and wallets, labelled local (development only)
//   CUSTODY_PROVIDER=privy  Privy server wallets + Monad JSON-RPC; needs the PRIVY_* values, CUSTODY_CHAIN_ID,
//                           CUSTODY_RPC (and CUSTODY_RPC_SECONDARY for cross-checked finality), CUSTODY_NETWORK_REF,
//                           GAS_ASSET_REF, and optionally FUNDING_TOKEN_ADDRESS/FUNDING_TOKEN_DECIMALS/FUNDING_ASSET_REF
//                           (without them, agents are funded with native MON only).
//                           ENVIO_API_TOKEN switches deposit discovery to the HyperSync index (HYPERSYNC_URL defaults to
//                           https://<chainId>.hypersync.xyz); RPC still supplies every credited value and finality.
// LIVE_OUTFLOWS=1 enables the withdrawal gateway; it stays off until the E03 proof has dated evidence.
import { CrossCheckedChain, HyperSyncChain, JsonRpcChain, LocalChain, LocalCustody, PrivyCustody, hyperSyncUrlFor } from '@monad-hack/custody';
import type { ChainReader, CustodyConfig, CustodyProvider } from '@monad-hack/custody';
import { MAINNET_UNISWAP } from './db/live-catalog.ts';

export interface CustodySetup {
  readonly provider: CustodyProvider;
  readonly chain: ChainReader;
  readonly config: CustodyConfig;
  /** Withdrawal gateway enabled (sends transactions). */
  readonly outflows: boolean;
  /** Present only for the local stand-in: mint test assets into a wallet. */
  readonly localChain?: LocalChain;
  /** RPC endpoints whose eth_chainId must equal the configured chain before any scan or settlement. */
  readonly endpoints?: readonly JsonRpcChain[];
}

/** Refuse to start when an RPC serves another chain: its native deposits would be labelled with this chain's asset. */
export async function verifyCustodyChain(setup: CustodySetup): Promise<void> {
  for (const endpoint of setup.endpoints ?? []) await endpoint.verifyChainId();
}

const need = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for CUSTODY_PROVIDER=${env['CUSTODY_PROVIDER']}.`);
  return value;
};

export const LOCAL_USD_TOKEN = '0x00000000000000000000000000000000000000aa';

export function custodyFromEnv(env: NodeJS.ProcessEnv): CustodySetup | undefined {
  const kind = env['CUSTODY_PROVIDER'];
  if (!kind) return undefined;
  if (kind === 'local') {
    if (env['NODE_ENV'] === 'production') throw new Error('The local custody stand-in is development only.');
    // The local chain lives in this process and starts empty, so each run gets its own chain ID (wallets, deposits
    // and scan cursors from earlier runs belong to other chains). LOCAL_CHAIN_ID pins one for tests.
    const chainId = Number(env['LOCAL_CHAIN_ID'] ?? 1_000_000 + Math.floor(Math.random() * 1_000_000));
    const chain = new LocalChain(chainId, 2);
    return {
      provider: new LocalCustody(chain), chain, localChain: chain, outflows: true,
      config: {
        networkRef: 'local-chain', chainId, gasAssetRef: 'local.MON', startHeight: 0n,
        assets: [
          { assetRef: 'local.USD', chainId, token: LOCAL_USD_TOKEN, decimals: 6, funding: true },
          { assetRef: 'local.MON', chainId, token: 'native', decimals: 18, funding: true },
        ],
      },
    };
  }
  if (kind !== 'privy') throw new Error('CUSTODY_PROVIDER is local or privy.');
  const chainId = Number(need(env, 'CUSTODY_CHAIN_ID'));
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('CUSTODY_CHAIN_ID must be a chain ID.');
  // Optional: without a funding token, users fund with native MON only (gas and trading inventory).
  const tokenAddress = env['FUNDING_TOKEN_ADDRESS']?.toLowerCase();
  if (tokenAddress !== undefined && !/^0x[0-9a-f]{40}$/.test(tokenAddress)) throw new Error('FUNDING_TOKEN_ADDRESS must be an address.');
  const decimals = tokenAddress ? Number(need(env, 'FUNDING_TOKEN_DECIMALS')) : 0;
  const primary = new JsonRpcChain({ endpoint: need(env, 'CUSTODY_RPC'), chainId });
  const secondaryUrl = env['CUSTODY_RPC_SECONDARY'];
  const secondary = secondaryUrl ? new JsonRpcChain({ endpoint: secondaryUrl, chainId }) : undefined;
  const checked = secondary ? new CrossCheckedChain(primary, secondary) : primary;
  const envioToken = env['ENVIO_API_TOKEN'];
  const chain = envioToken ? new HyperSyncChain(primary, { url: env['HYPERSYNC_URL'] ?? hyperSyncUrlFor(chainId), apiToken: envioToken }, checked) : checked;
  // Asset refs are per network (testnet.* / mainnet.*); the ledger never mixes chains.
  const gasAssetRef = env['GAS_ASSET_REF'] ?? (chainId === 143 ? 'mainnet.MON' : chainId === 10143 ? 'testnet.MON' : need(env, 'GAS_ASSET_REF'));
  return {
    provider: new PrivyCustody({ appId: need(env, 'PRIVY_APP_ID'), appSecret: need(env, 'PRIVY_APP_SECRET'), authorizationKey: need(env, 'PRIVY_AUTHORIZATION_KEY') }),
    chain, outflows: env['LIVE_OUTFLOWS'] === '1', endpoints: secondary ? [primary, secondary] : [primary],
    config: {
      networkRef: need(env, 'CUSTODY_NETWORK_REF'), chainId, gasAssetRef, startHeight: BigInt(env['CUSTODY_START_HEIGHT'] ?? '0'),
      // Mainnet wallets may call the reviewed Uniswap router and approve it on the traded tokens.
      ...(chainId === 143 ? {
        tradingContracts: [MAINNET_UNISWAP.router, MAINNET_UNISWAP.wmon, MAINNET_UNISWAP.usdc],
        // A token that is also the funding token is reconciled as funding; trade outputs paid to the wallet are
        // excluded from deposit crediting by the scanner either way, so nothing credits twice.
        tradedAssets: [
          { assetRef: 'mainnet.WMON', chainId, token: MAINNET_UNISWAP.wmon, decimals: 18, funding: false },
          { assetRef: 'mainnet.USDC', chainId, token: MAINNET_UNISWAP.usdc, decimals: 6, funding: false },
        ].filter((t) => t.token !== tokenAddress),
      } : {}),
      assets: [
        ...(tokenAddress ? [{ assetRef: need(env, 'FUNDING_ASSET_REF'), chainId, token: tokenAddress, decimals, funding: true }] : []),
        { assetRef: gasAssetRef, chainId, token: 'native', decimals: 18, funding: true },
      ],
    },
  };
}

/**
 * Every custody asset must be the catalog asset of the same chain (and contract): a ref that names another network's
 * asset would let a balance credited on one chain back a spend on another. Checked at startup, before any scan.
 */
export async function assertCustodyCatalog(pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: { ref: string; definition: { identity?: { kind?: string; chainId?: number; contractAddress?: string } } }[] }> }, config: CustodyConfig): Promise<void> {
  const assets = [...config.assets, ...(config.tradedAssets ?? [])];
  const { rows } = await pool.query(`select ref, definition from catalog_versions where kind = 'asset' and 'live' = any(modes) and disabled_reason is null and ref = any($1)`, [assets.map((a) => a.assetRef)]);
  for (const asset of assets) {
    const identity = rows.find((r) => r.ref === asset.assetRef)?.definition.identity;
    const ok = identity !== undefined && identity.chainId === asset.chainId
      && (asset.token === 'native' ? identity.kind === 'native' : identity.kind === 'erc20' && identity.contractAddress?.toLowerCase() === asset.token.toLowerCase());
    if (!ok) throw new Error(`Custody asset ${asset.assetRef} is not the live catalog asset for chain ${asset.chainId}; run pnpm db:seed:live or fix the asset refs.`);
  }
}
