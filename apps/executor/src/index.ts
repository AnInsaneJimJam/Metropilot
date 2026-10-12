// Assembles the paper executor. main.ts wires PostgresAuthority (deployments) and PostgresMarketData
// (market_observations); tests may wire in-memory stand-ins instead.
import type { Server } from 'node:http';
import type pg from 'pg';
import type { ActionLimits } from '@monad-hack/policy';
import type { AuthoritySource } from './authorization.ts';
import type { MarketData } from './paper.ts';
import { checkReadiness } from './readiness.ts';
import { createExecutorServer } from './server.ts';
import type { LogEntry } from './server.ts';
import { ExecutorService } from './service.ts';
import { ExecutorStore } from './store.ts';

export interface ExecutorWiring {
  readonly pool: pg.Pool;
  readonly authority: AuthoritySource;
  readonly market: MarketData;
  readonly capabilitySecret: Uint8Array;
  readonly platformLimits: ActionLimits;
  readonly maxQuoteAgeSeconds: number;
  readonly dispatchInline?: boolean;
  readonly now?: () => Date;
  readonly log?: (entry: LogEntry) => void;
}

export function createExecutor(wiring: ExecutorWiring): { service: ExecutorService; server: Server; store: ExecutorStore } {
  // An idle connection dropped by the database (restart, failover) must not crash the process; the next
  // query fails and readiness reports DATABASE_UNAVAILABLE. Unhandled, pg re-emits it as uncaughtException.
  wiring.pool.on('error', () => undefined);
  const store = new ExecutorStore(wiring.pool);
  const service = new ExecutorService({
    store, authority: wiring.authority, market: wiring.market, capabilitySecret: wiring.capabilitySecret,
    platformLimits: wiring.platformLimits, maxQuoteAgeSeconds: wiring.maxQuoteAgeSeconds,
    ...(wiring.dispatchInline === undefined ? {} : { dispatchInline: wiring.dispatchInline }),
    ...(wiring.now ? { now: wiring.now } : {}),
  });
  const server = createExecutorServer({ service, readiness: () => checkReadiness(wiring.pool), ...(wiring.log ? { log: wiring.log } : {}) });
  return { service, server, store };
}

export { signCapability, verifyCapability, CAPABILITY_AUDIENCE, MAX_CAPABILITY_SECONDS } from './capability.ts';
export type { Capability } from './capability.ts';
export type { AuthoritySource, DeploymentAuthority, DesiredState } from './authorization.ts';
export { PAPER_ADAPTER_VERSION, PAPER_ASSUMPTIONS } from './paper.ts';
export type { MarketData, RecordedQuote } from './paper.ts';
export { ExecutorService } from './service.ts';
export { ExecutorStore } from './store.ts';
export { PostgresAuthority } from './authority.ts';
export { PostgresMarketData } from './market.ts';
export type { FeedPair } from './market.ts';
