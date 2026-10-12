import { PaperBrokerService } from '../broker-service.ts';
// Local entry point for the runtime-facing internal API plus its worker loop (schedule ticks, lease reclaim,
// executor outbox consumption).
// Development only: loopback, a header-based workload identity and no TLS. A hosted entry point must supply the
// selected workload-identity mechanism (gate E02) and terminate TLS; this file refuses to run in production.
import pg from 'pg';
import { databaseUrl } from '../config.ts';
import { createInternalApp } from './app.ts';
import { RuntimeControlStore } from './store.ts';

if (process.env['LOCAL_RUNTIME_CONTROL'] !== '1' || process.env['NODE_ENV'] === 'production') {
  throw new Error('Local development only. Set LOCAL_RUNTIME_CONTROL=1; hosted servers need a verified workload identity.');
}
const pool = new pg.Pool({ connectionString: databaseUrl(process.env).toString(), max: 10, connectionTimeoutMillis: 3000 });
// An idle client losing its connection must not crash the process; the next query reconnects.
pool.on('error', (error) => console.error(`database pool error: ${error.name}`));
// Shared with the executor only (D35); 32 bytes as 64 hex characters. Without it no executor capability is issued.
const secretHex = process.env['EXECUTOR_CAPABILITY_SECRET'];
if (secretHex !== undefined && !/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('EXECUTOR_CAPABILITY_SECRET must be 64 lower-case hex characters.');
const brokerSecretHex = process.env['BROKER_CAPABILITY_SECRET'];
if (brokerSecretHex !== undefined && !/^[0-9a-f]{64}$/.test(brokerSecretHex)) throw new Error('BROKER_CAPABILITY_SECRET must be 64 lower-case hex characters.');
const brokerSecret = brokerSecretHex ? Buffer.from(brokerSecretHex, 'hex') : undefined;
const store = new RuntimeControlStore({ pool, ...(secretHex ? { executorCapabilitySecret: Buffer.from(secretHex, 'hex') } : {}), ...(brokerSecret ? { brokerCapabilitySecret: brokerSecret } : {}) });
const app = createInternalApp({
  store,
  ...(brokerSecret ? { broker: new PaperBrokerService({ pool, secret: brokerSecret }) } : {}),
  // Dev-only workload identity: the runtime names itself. Never acceptable outside loopback.
  authenticateWorkload: (headers) => {
    const id = headers['x-runtime-workload'];
    return typeof id === 'string' && /^[!-~]{1,128}$/.test(id) ? id : undefined;
  },
});
// SYNTHETIC: with LOCAL_SYNTHETIC_FEED=1, a random-walk WETH/USD price is ingested every 5 s so paper fills
// have recorded quotes and price triggers can cross. Never a market data source; labelled as synthetic.
const feed = process.env['LOCAL_SYNTHETIC_FEED'] === '1';
let price = 250_000; // cents
let busy = false;
const worker = setInterval(() => {
  if (busy) return;
  busy = true;
  // Schedules, lost leases and executor outbox → audit stream and resumed runs.
  const tick = feed && Date.now() % 5_000 < 1_000 ? (() => {
    price = Math.max(200_000, Math.min(300_000, price + Math.round((Math.random() - 0.5) * 2_000)));
    const now = new Date().toISOString();
    return store.ingestPrice({ sourceEventKey: `synthetic:${now}`, feedRef: 'paper.weth-usd', price: { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', decimal: (price / 100).toFixed(2).replace(/\.?0+$/, '') }, observedAt: now, receivedAt: now });
  })() : Promise.resolve([]);
  Promise.all([tick, store.tickSchedules(), store.reclaimExpiredLeases(), store.consumeExecutorOutbox(), store.consumeBrokerResults()])
    .catch((error: unknown) => console.error(`worker tick failed: ${(error as Error).name}`))
    .finally(() => { busy = false; });
}, 1_000);
const close = async (): Promise<void> => {
  clearInterval(worker);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
await app.listen({ host: '127.0.0.1', port: Number(process.env['RUNTIME_CONTROL_PORT'] ?? 3002) });
console.log('Local runtime control API listening on http://127.0.0.1:3002 (development only)');
