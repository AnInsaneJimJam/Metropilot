// Funds wiring shared by the local and hosted API entry points: custody from the environment, the FundsService,
// the funds worker (deposit scanner, withdrawal gateway, reconciliation, hold expiry, unknown-usage escalation)
// and, on the live network, the options that enable live launches (D60).
import type pg from "pg";
import { escalateUnknownUsage, expireHeld } from "@monad-hack/accounting";
import { DepositScanner, NATIVE, WithdrawalGateway, reconcileWallets } from "@monad-hack/custody";
import { FundsService } from "./funds.ts";
import type { StepUpDelivery } from "./funds.ts";
import { assertCustodyCatalog, custodyFromEnv, verifyCustodyChain } from "./funds-config.ts";
import type { LiveLaunchOptions } from "./live-launch.ts";

export interface FundsWiring {
  readonly funds: FundsService;
  /** Present when live launches are enabled (LIVE_LAUNCH=1 on a real custody chain). */
  readonly live: LiveLaunchOptions | undefined;
  /** Stop the funds worker loop. */
  stop(): void;
}

/** Trading MON a live launch requires by default: the executor's 0.1 MON native reserve plus 0.05 MON gas for one trade. */
const DEFAULT_MIN_TRADING_GAS = 15n * 10n ** 16n;

export async function fundsFromEnv(pool: pg.Pool, env: NodeJS.ProcessEnv, stepUp: StepUpDelivery, log: (line: string) => void = console.log): Promise<FundsWiring> {
  const custody = custodyFromEnv(env);
  if (custody && !custody.localChain) {
    await verifyCustodyChain(custody);
    await assertCustodyCatalog(pool, custody.config);
  }
  const funds = new FundsService({
    pool,
    ...(custody ? { custody: { provider: custody.provider, config: custody.config } } : {}),
    stepUp,
    ...(custody?.localChain ? {
      localFaucet: async (address: string, assetRef: string, amount: bigint) => {
        const asset = custody.config.assets.find((a) => a.assetRef === assetRef);
        if (!asset) throw new Error("unknown asset");
        custody.localChain!.fund(asset.token === "native" ? NATIVE : asset.token, address, amount);
        custody.localChain!.mine(custody.localChain!.finalityDepth + 1);
      },
    } : {}),
  });
  let stopped = false;
  if (custody) {
    const scanner = new DepositScanner(pool, custody.chain, custody.config);
    const gateway = new WithdrawalGateway(pool, custody.provider, custody.chain, custody.config);
    const tick = async () => {
      const now = new Date();
      // The local stand-in has no validators: produce one block per tick so sends reach finality.
      custody.localChain?.mine(1);
      await scanner.tick(now);
      if (custody.outflows) await gateway.tick(now);
      await reconcileWallets(pool, custody.chain, custody.config, now);
      const c = await pool.connect();
      try {
        await c.query("begin");
        await expireHeld(c, now);
        await escalateUnknownUsage(c, now);
        await c.query("commit");
      } catch (error) {
        await c.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    };
    const loop = () => {
      if (stopped) return;
      void tick().catch((error) => console.error(`funds worker: ${(error as Error).message}`)).finally(() => setTimeout(loop, 2000).unref());
    };
    loop();
    log(`Custody: ${custody.provider.name} on chain ${custody.config.chainId}${custody.outflows ? "" : " (outflows disabled)"}`);
  }
  // Live launches need a real custody chain and an explicit switch; the executor signs only with EXECUTOR_LIVE=1.
  let live: LiveLaunchOptions | undefined;
  if (env["LIVE_LAUNCH"] === "1") {
    if (!custody || custody.localChain) throw new Error("LIVE_LAUNCH=1 needs CUSTODY_PROVIDER=privy on the live network.");
    const raw = env["LIVE_MIN_TRADING_GAS_WEI"];
    if (raw !== undefined && !/^[0-9]{1,30}$/.test(raw)) throw new Error("LIVE_MIN_TRADING_GAS_WEI must be an integer.");
    live = { networkRef: custody.config.networkRef, chainId: custody.config.chainId, gasAssetRef: custody.config.gasAssetRef, minTradingGasAtomic: raw === undefined ? DEFAULT_MIN_TRADING_GAS : BigInt(raw) };
    log(`Live launches enabled on ${live.networkRef}`);
  }
  return { funds, live, stop: () => { stopped = true; } };
}
