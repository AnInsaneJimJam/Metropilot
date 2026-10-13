// Live executor configuration from the environment (docs/integration/executor.md section 7b). Off unless
// EXECUTOR_LIVE=1, and it also needs LIVE_OUTFLOWS=1 (the same switch as withdrawals), the Privy values and a Monad
// mainnet RPC. Limits default to small caps; each can be lowered or raised explicitly:
//   LIVE_DAILY_NOTIONAL_USD_MICROS (default 5 000 000 = $5/day), LIVE_DAILY_ACTIONS (10), LIVE_MAX_SLIPPAGE_BPS (100),
//   LIVE_GAS_CEILING_WEI per trade, approval included (5e16 = 0.05 MON), LIVE_MIN_NATIVE_RESERVE_WEI (1e17 = 0.1 MON).
import type pg from 'pg';
import type { UniswapRoute } from '@monad-hack/connectors';
import { MAINNET_UNISWAP, mainnetRoute, referenceOutput } from '@monad-hack/connectors';
import { JsonRpcChain, PrivyCustody } from '@monad-hack/custody';
import type { CustodyConfig } from '@monad-hack/custody';
import type { AuthoritySource } from './authorization.ts';
import { LiveIntents } from './live.ts';
import type { LiveConfig } from './live.ts';
import { LivePipeline } from './live-pipeline.ts';
import type { LiveRouteConfig } from './live-pipeline.ts';
import type { ExecutorStore } from './store.ts';

const ROUTE = MAINNET_UNISWAP;
const CHAIN = 143;

const num = (env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint => {
  const v = env[name];
  if (v === undefined) return fallback;
  if (!/^[0-9]{1,30}$/.test(v)) throw new Error(`${name} must be a non-negative integer.`);
  return BigInt(v);
};

export interface LiveSetup {
  readonly config: LiveConfig;
  /** The RPC must serve Monad mainnet; checked before the pipeline starts. */
  verify(): Promise<void>;
  pipeline(o: { pool: pg.Pool; store: ExecutorStore; authority: AuthoritySource; onError: (intentId: string, error: unknown) => void }): LivePipeline;
}

export function liveFromEnv(env: NodeJS.ProcessEnv): LiveSetup | undefined {
  if (env['EXECUTOR_LIVE'] !== '1') return undefined;
  if (env['LIVE_OUTFLOWS'] !== '1') throw new Error('EXECUTOR_LIVE=1 needs LIVE_OUTFLOWS=1 (live outflows are one switch).');
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is required for EXECUTOR_LIVE=1.`);
    return v;
  };
  // An empty optional value (a secret stored as "") counts as absent.
  const chain = new JsonRpcChain({ endpoint: env['LIVE_RPC'] || need('CUSTODY_RPC'), chainId: CHAIN });
  const provider = new PrivyCustody({ appId: need('PRIVY_APP_ID'), appSecret: need('PRIVY_APP_SECRET'), authorizationKey: need('PRIVY_AUTHORIZATION_KEY') });
  const route: UniswapRoute = mainnetRoute();
  const gasCeiling = num(env, 'LIVE_GAS_CEILING_WEI', 5n * 10n ** 16n);
  const config: LiveConfig = {
    chainId: CHAIN, networkRef: 'monad-mainnet', gasAssetRef: 'mainnet.MON', gasCeilingAtomic: gasCeiling, holdSeconds: 120, maxValuationAgeSeconds: 60,
    platformLimits: {
      allowedChainIds: [CHAIN], maxInputAtomic: 10n ** 21n, dailyActionCount: Number(num(env, 'LIVE_DAILY_ACTIONS', 10n)),
      dailyNotionalUsdMicros: num(env, 'LIVE_DAILY_NOTIONAL_USD_MICROS', 5_000_000n), maxSlippageBps: Number(num(env, 'LIVE_MAX_SLIPPAGE_BPS', 100n)),
      maxQuoteAgeSeconds: 30, maxReferenceDeviationBps: 100, maxGasAtomic: gasCeiling, minNativeReserveAtomic: num(env, 'LIVE_MIN_NATIVE_RESERVE_WEI', 10n ** 17n),
      maxApprovalAtomic: 10n ** 21n, allowedSpenders: [ROUTE.router],
    },
    // Notional: USDC at $1 (stablecoin parity, labelled) and MON/WMON at the pool's finalized 30 s TWAP in USDC.
    valuation: {
      usdMicrosPerToken: async (ref) => {
        const now = new Date().toISOString();
        if (ref === 'mainnet.USDC') return { usdMicros: 1_000_000n, decimals: 6, observedAt: now };
        if (ref !== 'mainnet.MON' && ref !== 'mainnet.WMON') return undefined;
        const usdc = await referenceOutput(chain, route, { tokenIn: ROUTE.wmon, tokenOut: ROUTE.usdc, nativeIn: false, amountIn: 10n ** 18n }, await chain.finalizedHeight());
        return { usdMicros: usdc, decimals: 18, observedAt: new Date().toISOString() };
      },
    },
  };
  const custody: CustodyConfig = {
    networkRef: 'monad-mainnet', chainId: CHAIN, gasAssetRef: 'mainnet.MON', startHeight: 0n,
    assets: [{ assetRef: 'mainnet.MON', chainId: CHAIN, token: 'native', decimals: 18, funding: true }], tradingContracts: [ROUTE.router, ROUTE.wmon, ROUTE.usdc],
  };
  const routeConfig: LiveRouteConfig = {
    connectorRef: 'mainnet.uniswap-v3', connectorVersions: ['1.0.0', '1.1.0'], route, quoteTtlSeconds: 60, gasMarginBps: 2_000, custody,
    assets: { 'mainnet.MON': { address: ROUTE.wmon, native: true }, 'mainnet.WMON': { address: ROUTE.wmon, native: false }, 'mainnet.USDC': { address: ROUTE.usdc, native: false } },
    pairs: [['mainnet.MON', 'mainnet.USDC'], ['mainnet.WMON', 'mainnet.USDC'], ['mainnet.USDC', 'mainnet.WMON']],
  };
  return {
    config,
    verify: () => chain.verifyChainId(),
    pipeline: (o) => new LivePipeline({ pool: o.pool, live: new LiveIntents(o.pool, config), store: o.store, chain, provider, authority: o.authority, route: routeConfig, onError: o.onError }),
  };
}
