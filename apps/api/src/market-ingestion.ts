import { contentHash } from '@monad-hack/contracts';
// API owns RPC access. Runtime/executor receive only normalized, persisted observations.
import type pg from 'pg';
import { MainnetMarkets, SOURCES, TOKENS, checkedObservation, eventTopics, validateSwapLog } from '@monad-hack/connectors';
import type { Market } from '@monad-hack/connectors';
import type { PriceObservation } from '@monad-hack/contracts';
import type { RuntimeControlStore } from './runtime-control/store.ts';

type MarketFailureCode = 'FINALIZED_HEAD_MISSING' | 'BLOCK_IDENTITY_MISSING' | 'LOG_IDENTITY_MISSING' |
    'FINALIZED_HEAD_REGRESSION' | 'FINALIZED_CURSOR_CHANGED' | 'LOG_BATCH_LIMIT' | 'INVALID_LOG_ENVELOPE' |
    'CONFLICTING_LOG_HASH' | 'FINALIZED_HEAD_CHANGED' | 'NONCANONICAL_LOG' | 'OBSERVATION_BLOCK_MISMATCH' | 'ORACLE_RESULT_CONFLICT';
export class MarketIngestionError extends Error {
  readonly code: MarketFailureCode;
  constructor(code: MarketFailureCode, message: string) {
    super(message);this.name='MarketIngestionError';this.code=code;
  }
}

export interface FinalizedBlock { number: bigint; hash: string }
export interface MarketLog { blockNumber: bigint; blockHash: string; logIndex: number; address: string; data: string; topics: readonly string[]; removed?: boolean }
export interface MarketSource {
  finalized(): Promise<FinalizedBlock>;
  block(number: bigint): Promise<FinalizedBlock>;
  verify(market: Market, number: bigint): Promise<void>;
  logs(market: Market, from: bigint, to: bigint): Promise<readonly MarketLog[]>;
  observe(market: Market, number: bigint): Promise<PriceObservation>;
}
export class RpcMarketSource implements MarketSource {
  readonly markets: MainnetMarkets;
  /** Blocks per eth_getLogs request; providers cap the range (Alchemy free tier: 10, D60). */
  readonly logSpan: bigint;
  constructor(markets = new MainnetMarkets(), logSpan = 100n) {
    if (logSpan < 1n) throw new Error('Market log span must be at least one block.');
    this.markets = markets; this.logSpan = logSpan;
  }
  async finalized(): Promise<FinalizedBlock> {
    const b = await this.markets.client.getBlock({ blockTag: 'finalized' });
    if (b.number === null || !b.hash) throw new MarketIngestionError('FINALIZED_HEAD_MISSING', 'Finalized block identity missing.');
    return { number: b.number, hash: b.hash };
  }
  async block(number: bigint): Promise<FinalizedBlock> {
    const b = await this.markets.client.getBlock({ blockNumber: number });
    if (b.number === null || !b.hash) throw new MarketIngestionError('BLOCK_IDENTITY_MISSING', 'Block identity missing.');
    return { number: b.number, hash: b.hash };
  }
  verify(market: Market, number: bigint): Promise<void> { return this.markets.verify(market, number); }
  async logs(market: Market, fromBlock: bigint, toBlock: bigint): Promise<readonly MarketLog[]> {
    const topics = eventTopics(market);
    const logs = [];
    for (let from = fromBlock; from <= toBlock; from += this.logSpan) {
      const to = from + this.logSpan - 1n < toBlock ? from + this.logSpan - 1n : toBlock;
      logs.push(...await this.markets.client.getLogs({ address: market.pool, fromBlock: from, toBlock: to }));
    }
    return logs.filter((l) => l.topics[0] && topics.includes(l.topics[0]) && (market.protocol !== 'aave-v3' || l.topics[1]?.slice(-40).toLowerCase() === TOKENS[market.base].address.slice(2))).map((l) => {
      validateSwapLog(market, l);
      if (l.blockNumber === null || !l.blockHash || l.logIndex === null) throw new MarketIngestionError('LOG_IDENTITY_MISSING', 'Unfinalized log identity.');
      return { blockNumber: l.blockNumber, blockHash: l.blockHash, logIndex: l.logIndex, address: l.address, data: l.data, topics: l.topics, removed: l.removed };
    });
  }
  observe(market: Market, number: bigint): Promise<PriceObservation> { return this.markets.observe(market, number); }
}

/** Cursor advances only after persistence and fan-out. A failed fan-out replays the same canonical identities.
 * At most 100 blocks/feed/tick; no catch-up trade from stale observations (transitionPrice enforces freshness).
 * Ordered recovery checkpoints baseline new deployments even if the pool has no swaps.
 */
export class MarketIngestion {
  readonly pool: pg.Pool;
  readonly source: MarketSource;
  readonly ingest: RuntimeControlStore['ingestPrice'];
  readonly subscriptions: readonly Market[];
  readonly report: (entry: Record<string, unknown>) => void;
  constructor(pool: pg.Pool, source: MarketSource, ingest: RuntimeControlStore['ingestPrice'], subscriptions: readonly Market[] = SOURCES, report: (entry: Record<string, unknown>) => void = () => {}) { this.pool = pool; this.source = source; this.ingest = ingest; this.subscriptions = subscriptions; this.report = report; }
  async tick(): Promise<void> {
    return this.#run('recovery', (market, head) => this.process(market, head));
  }
  async refresh(): Promise<void> {
    return this.#run('refresh', (market, head) => this.#refreshFeed(market, head));
  }
  async #run(phase: 'recovery' | 'refresh', action: (market: Market, head: FinalizedBlock) => Promise<void>): Promise<void> {
    const failure = (market: Market, error: unknown): void => {
      // Never log provider messages, URLs, bodies or arbitrary error.code values.
      this.report({event:'market.ingestion.failed',phase,feedRef:market.feedRef,code:error instanceof MarketIngestionError ? error.code : 'SOURCE_OR_STORAGE_FAILURE'});
    };
    let head: FinalizedBlock;
    try { head = await this.source.finalized(); }
    catch(error) { for(const market of this.subscriptions) failure(market,error);throw error; }
    const outcomes = await Promise.allSettled(this.subscriptions.map(async market => {
      try { await action(market, head); } catch(error) { failure(market,error);throw error; }
    }));
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
  }
  async #refreshFeed(market: Market, head: FinalizedBlock): Promise<void> {
    const c = await this.pool.connect();
    let locked = false;
    try {
      // Independent lane: a slow or failing historical read cannot hold this current-head lock.
      locked = (await c.query<{locked:boolean}>('select pg_try_advisory_lock(hashtextextended($1, 11)) as locked',[market.feedRef])).rows[0]!.locked;
      if(!locked)return;
      const last=(await c.query<{received_at:string}>("select document->>'receivedAt' as received_at from finalized_market_observations where feed_ref=$1 order by document->>'observedAt' desc limit 1",[market.feedRef])).rows[0];
      if(last && Date.now()-Date.parse(last.received_at)<5_000)return;
      await this.source.verify(market,head.number);
      const canonical=await this.source.block(head.number);
      if(canonical.hash!==head.hash)throw new MarketIngestionError('FINALIZED_HEAD_CHANGED','Finalized heartbeat head hash changed.');
      await this.#accept(c,market,head.number,head.hash,[],false);
      // Cache-only: a newer head must not overtake unprocessed event blocks in trigger state.
    } finally {
      try {if(locked)await c.query('select pg_advisory_unlock(hashtextextended($1, 11))',[market.feedRef]);}
      finally {c.release();}
    }
  }
  async process(market: Market, head: FinalizedBlock): Promise<void> {
    const c = await this.pool.connect();
    let locked = false;
    try {
      // A session lock prevents two worker processes from racing a subscription. No transaction spans RPC.
      locked = (await c.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 10)) as locked', [market.feedRef])).rows[0]!.locked;
      if (!locked) return;
      const row = (await c.query<{ block_number: string; block_hash: string }>('select block_number::text, block_hash from market_cursors where feed_ref = $1', [market.feedRef])).rows[0];
      let cursor = row ? BigInt(row.block_number) : (head.number > 100n ? head.number - 100n : 0n);
      if (cursor > head.number) throw new MarketIngestionError('FINALIZED_HEAD_REGRESSION', 'Finalized head moved backwards.');
      if (row && (await this.source.block(cursor)).hash !== row.block_hash) throw new MarketIngestionError('FINALIZED_CURSOR_CHANGED', 'Finalized cursor hash changed; operator investigation required.');
      if (cursor === head.number) return;
      const end = cursor + 100n < head.number ? cursor + 100n : head.number;
      await this.source.verify(market, end);
      const logs = await this.source.logs(market, cursor + 1n, end);
      if (logs.length > 2048) throw new MarketIngestionError('LOG_BATCH_LIMIT', 'Market log batch exceeds the bounded event limit; reduce backfill range.');
      const blocks = new Map<bigint, string>();
      for (const log of logs) {
        if (log.removed || log.address.toLowerCase() !== market.pool || log.blockNumber <= cursor || log.blockNumber > end || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new MarketIngestionError('INVALID_LOG_ENVELOPE', 'Invalid finalized log envelope.');
        const previous = blocks.get(log.blockNumber);
        if (previous && previous !== log.blockHash) throw new MarketIngestionError('CONFLICTING_LOG_HASH', 'Conflicting block hashes in log batch.');
        blocks.set(log.blockNumber, log.blockHash);
      }
      const boundary = await this.source.block(end);
      if (end === head.number && boundary.hash !== head.hash) throw new MarketIngestionError('FINALIZED_HEAD_CHANGED', 'Finalized head hash changed.');
      blocks.set(end, boundary.hash); // Recovery checkpoint observation; current heartbeats run independently.
      for (const number of [...blocks.keys()].sort((a, b) => a < b ? -1 : 1)) {
        const canonical = await this.source.block(number);
        if (canonical.hash !== blocks.get(number)) throw new MarketIngestionError('NONCANONICAL_LOG', 'Noncanonical finalized log.');
        await this.#accept(c,market,number,canonical.hash,logs.filter(log=>log.blockNumber===number));
      }
      await c.query(`insert into market_cursors (feed_ref,block_number,block_hash) values ($1,$2,$3)
        on conflict (feed_ref) do update set block_number=excluded.block_number, block_hash=excluded.block_hash, updated_at=now()`, [market.feedRef, String(end), boundary.hash]);
    } finally {
      try {
        if (locked) await c.query('select pg_advisory_unlock(hashtextextended($1, 10))', [market.feedRef]);
      } finally {
        c.release();
      }
    }
  }
  async #accept(c: pg.PoolClient, market: Market, number: bigint, canonicalHash: string, logs: readonly MarketLog[] = [], deliver = true): Promise<void> {
    const oracleStarted = performance.now();
    const observation = checkedObservation(await this.source.observe(market, number));
    if (observation.feedRef !== market.feedRef || BigInt(observation.block.number) !== number || observation.block.hash !== canonicalHash) throw new MarketIngestionError('OBSERVATION_BLOCK_MISMATCH', 'Oracle observation block mismatch.');
    const oracleReadMillis = performance.now()-oracleStarted;
    const persistenceStarted = performance.now();
    for (const log of logs) {
      await c.query('insert into finalized_market_logs (feed_ref, block_hash, log_index, document) values ($1,$2,$3,$4) on conflict do nothing', [market.feedRef, log.blockHash, log.logIndex, { ...log, blockNumber: String(number) }]);
    }
    await c.query('insert into finalized_market_observations (feed_ref, source_event_key, document) values ($1,$2,$3) on conflict do nothing', [market.feedRef, observation.sourceEventKey, observation]);
    const prior = (await c.query<{ document: PriceObservation }>('select document from finalized_market_observations where feed_ref=$1 and source_event_key=$2',[market.feedRef,observation.sourceEventKey])).rows[0]!.document;
    if (prior.provenanceHash !== observation.provenanceHash || await contentHash(prior.price) !== await contentHash(observation.price) || await contentHash(prior.reserve ?? null) !== await contentHash(observation.reserve ?? null)) throw new MarketIngestionError('ORACLE_RESULT_CONFLICT', 'Conflicting oracle result for a finalized block.');
    const persistedAt = new Date().toISOString(), fanOutStarted = performance.now();
    const results = deliver ? await this.ingest(prior) : [];
    this.report({event:'market.observation.accepted',feedRef:market.feedRef,method:market.method,observedAt:prior.observedAt,receivedAt:prior.receivedAt,persistedAt,triggerDelivery:deliver?'ordered-recovery':'cache-only',fanOutCompletedAt:deliver?new Date().toISOString():null,sourceLagMillis:Date.parse(prior.receivedAt)-Date.parse(prior.observedAt),oracleReadMillis:Math.round(oracleReadMillis),persistenceMillis:Math.round(fanOutStarted-persistenceStarted),fanOutMillis:Math.round(performance.now()-fanOutStarted),runs:results.flatMap(r=>r.runId?[r.runId]:[])});
  }
}
