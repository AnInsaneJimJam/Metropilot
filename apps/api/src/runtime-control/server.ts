// Local entry point for the runtime-facing internal API plus its worker loop (schedule ticks, lease reclaim).
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
const store = new RuntimeControlStore({ pool });
const app = createInternalApp({
  store,
  // Dev-only workload identity: the runtime names itself. Never acceptable outside loopback.
  authenticateWorkload: (headers) => {
    const id = headers['x-runtime-workload'];
    return typeof id === 'string' && /^[!-~]{1,128}$/.test(id) ? id : undefined;
  },
});
let busy = false;
const worker = setInterval(() => {
  if (busy) return;
  busy = true;
  Promise.all([store.tickSchedules(), store.reclaimExpiredLeases()])
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
