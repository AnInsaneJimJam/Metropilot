import { KimiAdapter } from '../kimi-adapter.ts';
import { KimiBroker } from '../kimi-broker.ts';
import { kimiVerified } from '../kimi-config.ts';
import { registerKimiDemo } from '../kimi-demo.ts';
import { PaperBrokerService } from '../broker-service.ts';
import { MarketIngestion, RpcMarketSource } from '../market-ingestion.ts';
import { WS_RPC, rpcClient, MainnetMarkets } from '@monad-hack/connectors';
// Local entry point for the runtime-facing internal API plus its worker loop (schedule ticks, lease reclaim,
// executor outbox consumption, paper quota enforcement, finishing stopping deployments).
// Development only: loopback, a header-based workload identity and no TLS. A hosted entry point must supply the
// selected workload-identity mechanism (gate E02) and terminate TLS; this file refuses to run in production.
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from '../config.ts';
import { createInternalApp } from './app.ts';
import { RuntimeControlStore } from './store.ts';

// Hosted (HOSTED=1, NODE_ENV=production): runtimes reach this API only through their task's loopback proxy
// (infra/sidecar/workload-proxy.mjs), which signs the task-bound workload ID with RUNTIME_WORKLOAD_SECRET.
const hosted = process.env['HOSTED'] === '1';
const workloadSecretHex = process.env['RUNTIME_WORKLOAD_SECRET'];
if (hosted) {
  if (process.env['NODE_ENV'] !== 'production' || process.env['LOCAL_RUNTIME_CONTROL'] === '1') throw new Error('HOSTED=1 needs NODE_ENV=production and no LOCAL_RUNTIME_CONTROL.');
  if (!workloadSecretHex || !/^[0-9a-f]{64}$/.test(workloadSecretHex)) throw new Error('HOSTED=1 needs RUNTIME_WORKLOAD_SECRET (64 lower-case hex characters).');
} else if (process.env['LOCAL_RUNTIME_CONTROL'] !== '1' || process.env['NODE_ENV'] === 'production') {
  throw new Error('Local development only. Set LOCAL_RUNTIME_CONTROL=1; hosted servers need a verified workload identity.');
}
const workloadKey = hosted ? Buffer.from(workloadSecretHex!, 'hex') : undefined;
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
const kimi = new KimiBroker(pool, new KimiAdapter({ apiKey: process.env['AI_GATEWAY_API_KEY'] ?? '', verified: kimiVerified(process.env) }));
// Hosted opt-in (service_env.control): the hosted user API has no other path that registers the paper Kimi profile.
if (process.env['DEMO_KIMI'] === '1') await registerKimiDemo(pool);
const broker = brokerSecret ? new PaperBrokerService({ pool, secret: brokerSecret, kimi }) : undefined;
const app = createInternalApp({
  store,
  ...(broker ? { broker } : {}),
  // Local: the runtime names itself (loopback only). Hosted: the name must carry the task proxy's HMAC proof.
  authenticateWorkload: (headers) => {
    const id = headers['x-runtime-workload'];
    if (typeof id !== 'string' || !/^[!-~]{1,128}$/.test(id)) return undefined;
    if (!workloadKey) return id;
    const proof = headers['x-runtime-workload-proof'];
    const expected = createHmac('sha256', workloadKey).update(id).digest();
    const given = typeof proof === 'string' && /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, 'hex') : undefined;
    return given && timingSafeEqual(given, expected) ? id : undefined;
  },
});
// New-head pushes are hints only. Every tick fetches the finalized head independently.
// A 5-second watchdog also covers quiet pools and missed/disconnected subscriptions.
if (process.env['LOCAL_SYNTHETIC_FEED'] === '1') throw new Error('Synthetic market feeds are disabled.');
const ingestion = new MarketIngestion(pool, new RpcMarketSource(new MainnetMarkets(rpcClient(process.env['MARKET_RPC_URL'], { maxRequestsPerSecond: Number(process.env['MARKET_RPC_MAX_RPS'] ?? '0') })), BigInt(process.env['MARKET_LOG_SPAN'] ?? '100')), (o) => store.ingestPrice(o), undefined, (entry) => console.log(JSON.stringify(entry)));
let refreshBusy = false, recoveryBusy = false;
let stopping = false;
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
const marketLane = async (phase: 'refresh' | 'recovery', wake: string): Promise<void> => {
  if (stopping || (phase === 'refresh' ? refreshBusy : recoveryBusy)) return;
  if(phase==='refresh')refreshBusy=true;else recoveryBusy=true;
  const started = performance.now();
  try {
    if(phase==='refresh')await ingestion.refresh();else await ingestion.tick();
    console.log(JSON.stringify({ event: 'market.ingestion.tick', phase, wake, elapsedMillis: Math.round(performance.now() - started) }));
  } catch {
    // MarketIngestion reports safe per-feed reason codes. Provider errors must never be printed here.
  } finally { if(phase==='refresh')refreshBusy=false;else recoveryBusy=false; }
};
// Push wakes can be spaced out for metered providers (Alchemy free tier rate limit, D60); the watchdog is unaffected.
const pushMinMillis = Number(process.env['MARKET_PUSH_MIN_MILLIS'] ?? '0');
if (!Number.isSafeInteger(pushMinMillis) || pushMinMillis < 0) throw new Error('MARKET_PUSH_MIN_MILLIS must be a non-negative integer.');
let lastPush = 0;
const marketTick = (wake = 'watchdog'): void => {
  if (wake === 'push') {
    if (Date.now() - lastPush < pushMinMillis) return;
    lastPush = Date.now();
  }
  void marketLane('refresh',wake);
  void marketLane('recovery',wake);
};
const connect = (): void => {
  if (stopping) return;
  const url = new URL(process.env['MARKET_WS_URL'] ?? WS_RPC);
  if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('Market WebSocket must use WSS without URL credentials.');
  socket = new WebSocket(url);
  socket.onopen = () => socket?.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message.error) socket?.close();
      if (message.id === 1 && typeof message.result === 'string') console.log(JSON.stringify({event:'market.subscription.connected',transport:'wss-newHeads'}));
      if (message.method === 'eth_subscription') void marketTick('push');
    } catch { socket?.close(); }
  };
  socket.onerror = () => socket?.close();
  socket.onclose = () => { if (!stopping) reconnect = setTimeout(connect, 10_000); };
};
connect();
void marketTick();
const watchdog = setInterval(() => void marketTick(), 5_000);
let busy = false;
const worker = setInterval(() => {
  if (busy) return;
  busy = true;
  // Schedules, lost leases and executor outbox → audit stream and resumed runs.
  Promise.all([store.tickSchedules(), store.reclaimExpiredLeases(), store.consumeExecutorOutbox(), store.meterHosting(), store.consumeBrokerResults(), kimi.recover(), broker?.allowance.settleKnown(), store.enforcePaperQuotas(), store.finaliseStopping()])
    .catch((error: unknown) => console.error(`worker tick failed: ${(error as Error).name}`))
    .finally(() => { busy = false; });
}, 1_000);
const close = async (): Promise<void> => {
  stopping = true;
  clearInterval(watchdog);
  if (reconnect) clearTimeout(reconnect);
  socket?.close();
  clearInterval(worker);
  while (refreshBusy || recoveryBusy || busy) await new Promise((resolve) => setTimeout(resolve, 50));
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
const port = Number(process.env['RUNTIME_CONTROL_PORT'] ?? 3002);
await app.listen({ host: hosted ? '0.0.0.0' : '127.0.0.1', port });
console.log(hosted ? `Hosted runtime control API listening on 0.0.0.0:${port} (private network only)` : `Local runtime control API listening on http://127.0.0.1:${port} (development only)`);
