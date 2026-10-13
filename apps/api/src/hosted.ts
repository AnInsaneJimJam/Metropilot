// Hosted control API entry point (API-1, issue #16, D56). Production only: verified Privy sessions, one HTTPS
// studio origin, no development session. TLS terminates at the ingress in front of this process.
import pg from "pg";
import { ConfigError, databaseUrl, requireEnv, type Env } from "./config.ts";
import { createApp } from "./app.ts";
import { ControlStore } from "./store.ts";
import { LifecycleService, MARKET_PAPER_FUNDING_ASSET } from "./lifecycle.ts";
import { CatalogResolver } from "./catalog.ts";
import { RuntimeControlStore } from "./runtime-control/store.ts";
import { SessionService } from "./auth/sessions.ts";
import { AuthError, PrivyVerifier } from "./auth/verifier.ts";
import type { FundsService } from "./funds.ts";
import { fundsFromEnv } from "./funds-wiring.ts";
import type { LiveLaunchOptions } from "./live-launch.ts";

export interface HostedConfig {
  databaseUrl: URL;
  origin: string;
  privyAppId: string;
  privyVerificationKey: string;
  runtimeImageDigest: string;
  host: string;
  port: number;
}

/** Read and check hosted configuration. Errors name variables, never their values. */
export function hostedConfig(env: Env): HostedConfig {
  if (env["NODE_ENV"] !== "production") throw new ConfigError("The hosted entry point requires NODE_ENV=production.");
  if (env["LOCAL_WORKSPACE"] === "1") throw new ConfigError("LOCAL_WORKSPACE must not be set on a hosted server.");
  const origin = requireEnv(env, "PUBLIC_ORIGIN");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ConfigError("PUBLIC_ORIGIN must be an https:// origin.");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) throw new ConfigError("PUBLIC_ORIGIN must be an https:// origin with no path.");
  const runtimeImageDigest = requireEnv(env, "RUNTIME_IMAGE_DIGEST");
  if (!/^0x[0-9a-f]{64}$/.test(runtimeImageDigest)) throw new ConfigError("RUNTIME_IMAGE_DIGEST must be a 0x SHA-256 digest.");
  const port = Number(env["PORT"] ?? "3001");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be a TCP port.");
  return {
    databaseUrl: databaseUrl(env),
    origin,
    privyAppId: requireEnv(env, "PRIVY_APP_ID"),
    privyVerificationKey: requireEnv(env, "PRIVY_VERIFICATION_KEY"),
    runtimeImageDigest,
    host: env["HOST"] ?? "0.0.0.0",
    port,
  };
}

/** The production app: sessions come only from verified provider tokens; there is no localSession. */
export function createHostedApp(pool: pg.Pool, config: HostedConfig, wiring: { funds?: FundsService; live?: LiveLaunchOptions } = {}) {
  let verifier: PrivyVerifier;
  try {
    verifier = new PrivyVerifier({ appId: config.privyAppId, verificationKey: config.privyVerificationKey });
  } catch (error) {
    if (error instanceof AuthError) throw new ConfigError(error.message);
    throw error;
  }
  const sessions = new SessionService({ pool, verifier });
  const lifecycle = new LifecycleService({
    pool,
    runtime: new RuntimeControlStore({ pool }),
    runtimeImageDigest: config.runtimeImageDigest,
    catalog: new CatalogResolver(),
    // Same funding as the local market stack: the market presets spend paper.USDC.
    paperFundingAsset: MARKET_PAPER_FUNDING_ASSET,
    ...(wiring.live ? { live: wiring.live } : {}),
  });
  return createApp({
    store: new ControlStore(pool),
    lifecycle,
    ...(wiring.funds ? { funds: wiring.funds } : {}),
    catalog: () => lifecycle.paperCatalog(),
    origin: config.origin,
    authenticate: (cookie) => sessions.authenticate(cookie),
    identity: sessions,
  });
}

if (import.meta.main) {
  const config = hostedConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrl.toString(), max: 10, connectionTimeoutMillis: 3000 });
  pool.on("error", (error) => console.error(`database pool error: ${error.name}`));
  // Step-up codes: the production MFA delivery is not built yet, so hosted codes go to the operator log only
  // (team demo; a known limitation). Funds stay off unless CUSTODY_PROVIDER is set.
  const wiring = await fundsFromEnv(pool, process.env, {
    deliver: async (_tenant, challengeId, code, purpose) => console.log(JSON.stringify({ event: "stepUp.code", purpose, challengeId, code })),
  });
  const app = createHostedApp(pool, config, { funds: wiring.funds, ...(wiring.live ? { live: wiring.live } : {}) });
  const close = async () => {
    wiring.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  await app.listen({ host: config.host, port: config.port });
  console.log(`Hosted control API listening on ${config.host}:${config.port}`);
}
