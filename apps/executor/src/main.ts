// Executor process entry (EXE-1). Paper by default: a live capability answers 403 CAPABILITY_DISABLED unless
// EXECUTOR_LIVE=1 configures the Monad mainnet Uniswap route (live-wiring.ts), whose pipeline then runs here. Reads
// authority from `deployments` and recorded prices from `market_observations`; a reconcile() loop finishes
// reserved intents after restarts. Local development only until the hosted profile exists: loopback, no TLS.
// Run it under a restricted database role in hosted environments (docs/integration/executor.md section 3a).
import pg from 'pg';
import { marketCatalog, MARKETS, TOKENS } from '@monad-hack/connectors/registry';
import { PostgresAuthority } from './authority.ts';
import { createExecutor } from './index.ts';
import { liveFromEnv } from './live-wiring.ts';
import { PostgresMarketData } from './market.ts';
import type { FeedPair } from './market.ts';

if (process.env['LOCAL_EXECUTOR'] !== '1' || process.env['NODE_ENV'] === 'production') {
  throw new Error('Local development only. Set LOCAL_EXECUTOR=1; hosted executors need the selected identity and a restricted database role.');
}
const url = process.env['EXECUTOR_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (!url) throw new Error('EXECUTOR_DATABASE_URL (or DATABASE_URL) is not set.');
const secretHex = process.env['EXECUTOR_CAPABILITY_SECRET'];
if (!secretHex || !/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('EXECUTOR_CAPABILITY_SECRET must be 64 lower-case hex characters, shared with the control API only.');

// Paper feeds come from the synthetic catalog: USD-quoted feeds price their base asset in paper.USD.
const feeds: FeedPair[] = MARKETS.map(m => ({feedRef:m.feedRef,connectorRef:m.connectorRef,baseAssetRef:`paper.${m.base}`,quoteAssetRef:`paper.${m.quote}`,baseDecimals:TOKENS[m.base].decimals,quoteDecimals:TOKENS[m.quote].decimals}));
const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000 });
const live = liveFromEnv(process.env);
const authority = new PostgresAuthority(pool);
const { service, server, store } = createExecutor({
  pool, authority, market: new PostgresMarketData(pool, feeds), capabilitySecret: Buffer.from(secretHex, 'hex'),
  platformLimits: { maxSlippageBps: 100, dailyActionCount: 1000 }, maxQuoteAgeSeconds: 120, ...(live ? { live: live.config } : {}),
  log: (entry) => console.log(JSON.stringify(entry)),
});
let busy = false;
const reconciler = setInterval(() => {
  if (busy) return;
  busy = true;
  service.reconcile().catch((error: unknown) => console.error(`reconcile failed: ${(error as Error).name}`)).finally(() => { busy = false; });
}, 1_000);
// Live: prepare, sign, broadcast, finality and settlement for admitted live intents (one pass every 2 s).
const pipeline = live?.pipeline({ pool, store, authority, onError: (intentId, error) => console.error(`live intent ${intentId}: ${(error as Error).message}`) });
let liveBusy = false;
const liveLoop = pipeline ? setInterval(() => {
  if (liveBusy) return;
  liveBusy = true;
  pipeline.tick().catch((error: unknown) => console.error(`live pipeline failed: ${(error as Error).message}`)).finally(() => { liveBusy = false; });
}, 2_000) : undefined;
const port = Number(process.env['EXECUTOR_PORT'] ?? 3003);
server.listen(port, '127.0.0.1', () => console.log(`Local ${live ? 'paper + LIVE (Monad mainnet)' : 'paper'} executor listening on http://127.0.0.1:${port} (development only)`));
const close = (): void => {
  clearInterval(reconciler);
  if (liveLoop) clearInterval(liveLoop);
  server.close(() => void pool.end().then(() => process.exit(0)));
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
