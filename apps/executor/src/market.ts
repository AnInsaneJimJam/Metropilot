// Recorded market data from finalized price observations persisted by the control plane's ingestion
// (market_observations, migration 0005). Paper fills read the latest observation of the feed that prices the
// pair, in exact integer arithmetic. Replaced by persisted broker results once observationRefs resolve (D36).
import type pg from 'pg';
import type { MarketData, RecordedQuote } from './paper.ts';

/** A feed quoting `baseAssetRef` in `quoteAssetRef` (for example paper.WETH in paper.USD), with asset decimals. */
export interface FeedPair {
  readonly feedRef: string;
  readonly connectorRef?: string;
  readonly baseAssetRef: string;
  readonly quoteAssetRef: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
}

/** Exact decimal text → [integer digits, power-of-ten scale]. */
function scaled(decimal: string): [bigint, bigint] {
  const [whole, fraction = ''] = decimal.split('.');
  return [BigInt(whole! + fraction), 10n ** BigInt(fraction.length)];
}

export class PostgresMarketData implements MarketData {
  readonly #pool: pg.Pool;
  readonly #feeds: readonly FeedPair[];
  constructor(pool: pg.Pool, feeds: readonly FeedPair[]) {
    this.#pool = pool;
    this.#feeds = feeds;
  }

  async quote(tokenInRef: string, tokenOutRef: string, connectorRef?: string): Promise<RecordedQuote | undefined> {
    const feed = this.#feeds.find((f) => (!connectorRef || f.connectorRef === connectorRef) && ((f.baseAssetRef === tokenInRef && f.quoteAssetRef === tokenOutRef) || (f.baseAssetRef === tokenOutRef && f.quoteAssetRef === tokenInRef)));
    if (!feed) return undefined;
    const { rows } = await this.#pool.query<{ source_event_key: string; price: string; observed_at: Date }>(
      'select source_event_key, price::text as price, observed_at from market_observations where feed_ref = $1 order by observed_at desc limit 1',
      [feed.feedRef],
    );
    const row = rows[0];
    if (!row) return undefined;
    // numeric(78,18) renders trailing zeros; strip them so the scale is exact.
    const [price, scale] = scaled(row.price.includes('.') ? row.price.replace(/0+$/, '').replace(/\.$/, '') : row.price);
    if (price <= 0n) return undefined;
    const base = 10n ** BigInt(feed.baseDecimals);
    const quote = 10n ** BigInt(feed.quoteDecimals);
    const sell = tokenInRef === feed.baseAssetRef;
    // Output atomic per input atomic: base→quote is price·10^q / (scale·10^b); quote→base is the inverse.
    return {
      source: `observation:${feed.feedRef}:${row.source_event_key}`, tokenInRef, tokenOutRef, observedAt: row.observed_at.toISOString(),
      rateNumerator: sell ? price * quote : scale * base,
      rateDenominator: sell ? scale * base : price * quote,
    };
  }
}
