// Custody configuration from the environment (docs/integration/funds.md). Nothing is enabled by default:
//   CUSTODY_PROVIDER=local  in-process local chain and wallets, labelled local (development only)
//   CUSTODY_PROVIDER=privy  Privy server wallets + Monad JSON-RPC; needs the PRIVY_* values, CUSTODY_CHAIN_ID,
//                           CUSTODY_RPC (and CUSTODY_RPC_SECONDARY for cross-checked finality), CUSTODY_NETWORK_REF,
//                           GAS_ASSET_REF, and optionally FUNDING_TOKEN_ADDRESS/FUNDING_TOKEN_DECIMALS/FUNDING_ASSET_REF
//                           (without them, agents are funded with native MON only).
// LIVE_OUTFLOWS=1 enables the withdrawal gateway; it stays off until the E03 proof has dated evidence.
import { CrossCheckedChain, JsonRpcChain, LocalChain, LocalCustody, PrivyCustody } from '@monad-hack/custody';
import type { ChainReader, CustodyConfig, CustodyProvider } from '@monad-hack/custody';

export interface CustodySetup {
  readonly provider: CustodyProvider;
  readonly chain: ChainReader;
  readonly config: CustodyConfig;
  /** Withdrawal gateway enabled (sends transactions). */
  readonly outflows: boolean;
  /** Present only for the local stand-in: mint test assets into a wallet. */
  readonly localChain?: LocalChain;
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
  const chain = secondaryUrl ? new CrossCheckedChain(primary, new JsonRpcChain({ endpoint: secondaryUrl, chainId })) : primary;
  const gasAssetRef = env['GAS_ASSET_REF'] ?? 'live.MON';
  return {
    provider: new PrivyCustody({ appId: need(env, 'PRIVY_APP_ID'), appSecret: need(env, 'PRIVY_APP_SECRET'), authorizationKey: need(env, 'PRIVY_AUTHORIZATION_KEY') }),
    chain, outflows: env['LIVE_OUTFLOWS'] === '1',
    config: {
      networkRef: need(env, 'CUSTODY_NETWORK_REF'), chainId, gasAssetRef, startHeight: BigInt(env['CUSTODY_START_HEIGHT'] ?? '0'),
      assets: [
        ...(tokenAddress ? [{ assetRef: need(env, 'FUNDING_ASSET_REF'), chainId, token: tokenAddress, decimals, funding: true }] : []),
        { assetRef: gasAssetRef, chainId, token: 'native', decimals: 18, funding: true },
      ],
    },
  };
}
