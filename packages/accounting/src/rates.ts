// Rate-card arithmetic and the runway recommendation (ACC-4; funds-and-budgets.md sections 1, 5 and 6).
// Exact integers only. Prices are in the accepted token's atomic units; a USD conversion is explicit,
// timestamped and locked for the reservation. Ceilings round up so a hold always covers the charge.
import { invalid } from './errors.ts';

export const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n) invalid('Division by a non-positive value.');
  if (a <= 0n) return a === 0n ? 0n : -((-a) / b);
  return (a + b - 1n) / b;
};

export type RateKind = 'hosting' | 'model' | 'data';

/** A versioned, immutable price list for one resource or model profile, in one asset. */
export interface RateCard {
  readonly version: string;
  readonly kind: RateKind;
  readonly profileRef: string;
  readonly assetRef: string;
  /** Hosting: price of one billable slice. */
  readonly sliceSeconds?: number;
  readonly atomicPerSlice?: bigint;
  /** Model: prices per one million tokens and per request. */
  readonly inputAtomicPerMillion?: bigint;
  readonly outputAtomicPerMillion?: bigint;
  readonly atomicPerRequest?: bigint;
  /** Disclosed platform margin in basis points, already included in the prices above. */
  readonly marginBps: number;
  readonly effectiveFrom: Date;
  readonly expiresAt?: Date;
}

export function assertCurrent(card: RateCard, at: Date): void {
  if (at < card.effectiveFrom || (card.expiresAt && at >= card.expiresAt)) invalid(`Rate card ${card.version} is not in effect.`);
}

export interface ModelCallBounds {
  readonly maxInputTokens: number;
  /** Output plus reasoning cap the provider enforces. */
  readonly maxOutputTokens: number;
  readonly requests: number;
}

/** Worst-case cost of a bounded model call; unknown prices refuse. */
export function modelCallCeiling(card: RateCard, bounds: ModelCallBounds): bigint {
  if (card.kind !== 'model' || card.inputAtomicPerMillion === undefined || card.outputAtomicPerMillion === undefined) {
    invalid('The model price is unknown, so the call cannot be bounded.');
  }
  for (const n of [bounds.maxInputTokens, bounds.maxOutputTokens, bounds.requests]) {
    if (!Number.isSafeInteger(n) || n < 0) invalid('Model call bounds are non-negative integers.');
  }
  if (bounds.requests < 1) invalid('A model call has at least one request.');
  const tokens = BigInt(bounds.maxInputTokens) * card.inputAtomicPerMillion! + BigInt(bounds.maxOutputTokens) * card.outputAtomicPerMillion!;
  return BigInt(bounds.requests) * (ceilDiv(tokens, 1_000_000n) + (card.atomicPerRequest ?? 0n));
}

/** Actual charge for reported usage, capped at the held ceiling (excess is a platform discrepancy). */
export function modelCallCharge(card: RateCard, usage: { inputTokens: number; outputTokens: number; requests: number }, ceiling: bigint): { charge: bigint; excess: bigint } {
  const raw = modelCallCeiling(card, { maxInputTokens: usage.inputTokens, maxOutputTokens: usage.outputTokens, requests: Math.max(1, usage.requests) });
  return raw > ceiling ? { charge: ceiling, excess: raw - ceiling } : { charge: raw, excess: 0n };
}

export function hostingSlicePrice(card: RateCard): { sliceSeconds: number; atomic: bigint } {
  if (card.kind !== 'hosting' || card.atomicPerSlice === undefined || !card.sliceSeconds) invalid('The hosting rate is unknown.');
  return { sliceSeconds: card.sliceSeconds!, atomic: card.atomicPerSlice! };
}

/** Price per day of a hosting card when always on. */
export const hostingPerDay = (card: RateCard): bigint => {
  const { sliceSeconds, atomic } = hostingSlicePrice(card);
  return ceilDiv(86_400n * atomic, BigInt(sliceSeconds));
};

/** Explicit, timestamped USD → token conversion: atomic units per one USD (1e6 micro-USD). */
export interface UsdRate {
  readonly assetRef: string;
  readonly atomicPerUsd: bigint;
  readonly quotedAt: Date;
  readonly source: string;
}

export const usdMicrosToAtomic = (usdMicros: bigint, rate: UsdRate): bigint => ceilDiv(usdMicros * rate.atomicPerUsd, 1_000_000n);
export const atomicToUsdMicros = (atomic: bigint, rate: UsdRate): bigint => (atomic * 1_000_000n) / rate.atomicPerUsd;

export interface RunwayInput {
  /** Total accepted deposit D. */
  readonly depositAtomic: bigint;
  /** Desired operating days T (may be fractional through days × 1000). */
  readonly operatingDaysMilli: bigint;
  /** Minimum trading allocation K. */
  readonly minTradingAtomic: bigint;
  /** Gas earmark G inside trading (in the deposit asset after conversion). */
  readonly gasAtomic: bigint;
  /** Daily hosting h and API a at the selected settings. */
  readonly hostingPerDayAtomic: bigint;
  readonly apiPerDayAtomic: bigint;
  /** Usage margin m in basis points. */
  readonly marginBps: number;
}

export interface RunwayPlan {
  readonly feasible: boolean;
  readonly hostingAtomic: bigint;
  readonly apiAtomic: bigint;
  readonly tradingAtomic: bigint;
  readonly gasAtomic: bigint;
  /** K + G − proposed trading when infeasible. */
  readonly shortfallAtomic: bigint;
}

const withMargin = (perDay: bigint, daysMilli: bigint, marginBps: number): bigint =>
  ceilDiv(perDay * daysMilli * BigInt(10_000 + marginBps), 1000n * 10_000n);

/** H = ceil(T·h·(1+m)), A = ceil(T·a·(1+m)), trading = D − H − A; infeasible below K + G. */
export function recommendForDays(input: RunwayInput): RunwayPlan {
  for (const v of [input.depositAtomic, input.operatingDaysMilli, input.minTradingAtomic, input.gasAtomic, input.hostingPerDayAtomic, input.apiPerDayAtomic]) {
    if (v < 0n) invalid('Runway inputs are non-negative.');
  }
  if (!Number.isInteger(input.marginBps) || input.marginBps < 0 || input.marginBps > 10_000) invalid('Margin is 0–10000 bps.');
  const hosting = withMargin(input.hostingPerDayAtomic, input.operatingDaysMilli, input.marginBps);
  const api = withMargin(input.apiPerDayAtomic, input.operatingDaysMilli, input.marginBps);
  const trading = input.depositAtomic - hosting - api;
  const needed = input.minTradingAtomic + input.gasAtomic;
  return { feasible: trading >= needed, hostingAtomic: hosting, apiAtomic: api, tradingAtomic: trading, gasAtomic: input.gasAtomic, shortfallAtomic: trading >= needed ? 0n : needed - trading };
}

export interface BalancedPlan {
  readonly feasible: boolean;
  readonly operatingAtomic: bigint;
  readonly hostingAtomic: bigint;
  readonly apiAtomic: bigint;
  readonly tradingAtomic: bigint;
  /** Expected runway in seconds: the minimum of the funded category runtimes, after margin. */
  readonly runwaySeconds: bigint | undefined;
}

/**
 * Fixed operating pool O = D − K − G split hosting O·h/(h+a), API the exact remainder; runway is the minimum
 * funded category runtime. a = 0 assigns all of O to hosting and API does not constrain runway.
 */
export function balancedSplit(input: Omit<RunwayInput, 'operatingDaysMilli'>): BalancedPlan {
  const pool = input.depositAtomic - input.minTradingAtomic - input.gasAtomic;
  const trading = input.minTradingAtomic + input.gasAtomic;
  const h = input.hostingPerDayAtomic;
  const a = input.apiPerDayAtomic;
  if (pool < 0n) return { feasible: false, operatingAtomic: pool, hostingAtomic: 0n, apiAtomic: 0n, tradingAtomic: trading, runwaySeconds: undefined };
  if (h + a === 0n) return { feasible: true, operatingAtomic: pool, hostingAtomic: 0n, apiAtomic: 0n, tradingAtomic: trading + pool, runwaySeconds: undefined };
  const hosting = (pool * h) / (h + a);
  const api = pool - hosting;
  const scale = BigInt(10_000 + input.marginBps);
  const seconds = (funded: bigint, perDay: bigint): bigint => (funded * 86_400n * 10_000n) / (perDay * scale);
  const candidates = [h > 0n ? seconds(hosting, h) : undefined, a > 0n ? seconds(api, a) : undefined].filter((s): s is bigint => s !== undefined);
  const runway = candidates.reduce((m, s) => (s < m ? s : m));
  return { feasible: true, operatingAtomic: pool, hostingAtomic: hosting, apiAtomic: api, tradingAtomic: trading, runwaySeconds: runway };
}

/** Quotes expire after five minutes by default; a changed input invalidates them regardless. */
export const QUOTE_TTL_MILLIS = 5 * 60_000;
