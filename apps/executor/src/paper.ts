// Paper adapter (docs/specs/executor.md section 8): recorded quotes, declared assumptions and exact floor
// arithmetic. It has no wallet, signer or RPC dependency and never produces a transaction hash.
import { contentHash } from '@monad-hack/contracts';

export const PAPER_ADAPTER_VERSION = 'paper-adapter/1';

/** Declared paper-adapter/1 assumptions; changing them is a new adapter version. */
export const PAPER_ASSUMPTIONS = { feeBps: 30n, adverseSlippageBps: 5n, latencyMillis: 0 } as const;

/** A recorded market observation, expressed as output atomic units per input atomic unit. */
export interface RecordedQuote {
  /** Provenance: the recorded observation this rate came from. */
  readonly source: string;
  readonly tokenInRef: string;
  readonly tokenOutRef: string;
  readonly rateNumerator: bigint;
  readonly rateDenominator: bigint;
  /** UTC RFC 3339 with milliseconds. */
  readonly observedAt: string;
}

/**
 * Port for recorded market data. Until broker results are persisted (observationRefs), the deployment
 * wires a recorded source; an unavailable source throws, a missing pair returns undefined.
 */
export interface MarketData {
  quote(tokenInRef: string, tokenOutRef: string, connectorRef?: string): Promise<RecordedQuote | undefined>;
}

export type FillOutcome =
  | { readonly ok: true; readonly outputAtomic: bigint; readonly minimumOutputAtomic: bigint }
  | { readonly ok: false; readonly code: 'EXECUTOR_QUOTE_INVALID' | 'EXECUTOR_SLIPPAGE_EXCEEDED'; readonly message: string };

/** Expected output net of fee, minimum output from the slippage limit, actual output after adverse slippage. */
export function computeFill(inputAtomic: bigint, quote: RecordedQuote, maxSlippageBps: number): FillOutcome {
  if (quote.rateNumerator <= 0n || quote.rateDenominator <= 0n) return { ok: false, code: 'EXECUTOR_QUOTE_INVALID', message: 'The recorded quote has no usable rate.' };
  const gross = (inputAtomic * quote.rateNumerator) / quote.rateDenominator;
  const expected = (gross * (10_000n - PAPER_ASSUMPTIONS.feeBps)) / 10_000n;
  const minimum = (expected * (10_000n - BigInt(maxSlippageBps))) / 10_000n;
  const actual = (expected * (10_000n - PAPER_ASSUMPTIONS.adverseSlippageBps)) / 10_000n;
  if (actual <= 0n) return { ok: false, code: 'EXECUTOR_QUOTE_INVALID', message: 'The input is too small to fill at the recorded price.' };
  if (actual < minimum) return { ok: false, code: 'EXECUTOR_SLIPPAGE_EXCEEDED', message: 'The simulated fill is below the minimum output.' };
  return { ok: true, outputAtomic: actual, minimumOutputAtomic: minimum };
}

/** Deterministic synthetic fill identity: a replay of the same logical intent yields the same ID. */
export function paperFillId(logicalKey: string): Promise<string> {
  return contentHash({ schemaVersion: 'paper-fill/1', logicalKey, adapter: PAPER_ADAPTER_VERSION });
}
