import { marketCatalog } from '@monad-hack/connectors/registry';
import { randomBytes } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./config.ts";
import { createApp } from "./app.ts";
import { ControlStore } from "./store.ts";
import { LifecycleService } from "./lifecycle.ts";
import { RuntimeControlStore } from "./runtime-control/store.ts";
import { escalateUnknownUsage, expireHeld } from "@monad-hack/accounting";
import { DepositScanner, NATIVE, WithdrawalGateway, reconcileWallets } from "@monad-hack/custody";
import { FundsService } from "./funds.ts";
import { assertCustodyCatalog, custodyFromEnv } from "./funds-config.ts";

// Explicitly local-only until the production identity adapter and HTTPS deployment are supplied.
if (
  process.env["LOCAL_WORKSPACE"] !== "1" ||
  process.env["NODE_ENV"] === "production"
)
  throw new Error(
    "This entry point is local development only. Set LOCAL_WORKSPACE=1; hosted servers require a verified identity adapter.",
  );
const pool = new pg.Pool({
  connectionString: databaseUrl(process.env).toString(),
  max: 10,
  connectionTimeoutMillis: 3000,
});
// An idle client losing its connection must not crash the process; the next query reconnects.
pool.on("error", (error) => console.error(`database pool error: ${error.name}`));
const store = new ControlStore(pool);
// Deployments pin this runtime image; local runtimes run with the same RUNTIME_IMAGE_DIGEST (or this default).
const runtimeImageDigest = process.env["RUNTIME_IMAGE_DIGEST"] ?? "0x" + "5a".repeat(32);
if (!/^0x[0-9a-f]{64}$/.test(runtimeImageDigest)) throw new Error("RUNTIME_IMAGE_DIGEST must be a 0x SHA-256 digest.");
const lifecycle = new LifecycleService({ pool, runtime: new RuntimeControlStore({ pool }), runtimeImageDigest, catalog: marketCatalog, paperFundingAsset: "paper.USDC" });
const tenant = await store.tenant("local-control-workspace");
// Live funds: off unless CUSTODY_PROVIDER is set (funds-config.ts). Step-up codes go to this server's log locally.
const custody = custodyFromEnv(process.env);
if (custody && !custody.localChain) await assertCustodyCatalog(pool, custody.config);
const funds = new FundsService({
  pool,
  ...(custody ? { custody: { provider: custody.provider, config: custody.config } } : {}),
  stepUp: { deliver: async (_tenant, challengeId, code, purpose) => console.log(`Local step-up code for ${purpose} approval ${challengeId}: ${code}`) },
  ...(custody?.localChain ? {
    localFaucet: async (address: string, assetRef: string, amount: bigint) => {
      const asset = custody.config.assets.find((a) => a.assetRef === assetRef);
      if (!asset) throw new Error("unknown asset");
      custody.localChain!.fund(asset.token === "native" ? NATIVE : asset.token, address, amount);
      custody.localChain!.mine(custody.localChain!.finalityDepth + 1);
    },
  } : {}),
});
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
  const loop = () => void tick().catch((error) => console.error(`funds worker: ${(error as Error).message}`)).finally(() => setTimeout(loop, 2000).unref());
  loop();
  console.log(`Custody: ${custody.provider.name} on chain ${custody.config.chainId}${custody.outflows ? "" : " (outflows disabled)"}`);
}
const sessions = new Map<string, number>();
const app = createApp({
  store,
  catalog: marketCatalog,
  lifecycle,
  funds,
  origin: "http://127.0.0.1:5173",
  authenticate: async (cookie) => {
    const token = cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("monad_session="))
      ?.slice("monad_session=".length);
    if (!token) return undefined;
    const expires = sessions.get(token);
    return expires && expires > Date.now() ? tenant : undefined;
  },
  localSession: async () => {
    const now = Date.now();
    for (const [key, expires] of sessions)
      if (expires <= now) sessions.delete(key);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + 8 * 60 * 60 * 1000);
    return {
      tenant,
      cookie: `monad_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    };
  },
});
const close = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ host: "127.0.0.1", port: 3001 });
console.log("Local control API listening at http://127.0.0.1:3001");
