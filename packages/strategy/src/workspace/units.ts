import { LanguageError } from '../errors.ts';
import { atomic, decimal } from '../expression.ts';
// Human-unit text ↔ exact language values. Bigint string math only; nothing is ever rounded.
const HUMAN = /^[0-9]+(\.[0-9]+)?$/;
/** Canonical form of a non-negative human decimal: no leading zeros, no trailing fractional zeros. */
export function normalizeHuman(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > 100 || !HUMAN.test(trimmed)) throw new LanguageError('INVALID_AMOUNT', 'Enter a plain non-negative number such as 0.25.');
  const [whole = '', fraction = ''] = trimmed.split('.');
  const digits = fraction.replace(/0+$/, '');
  return (whole.replace(/^0+(?=[0-9])/, '')) + (digits ? '.' + digits : '');
}
export function fractionDigits(human: string): number {
  return normalizeHuman(human).split('.')[1]?.length ?? 0;
}
/** "0.25" with 18 decimals → "250000000000000000". More places than the asset allows is an error. */
export function toAtomic(human: string, decimals: number): string {
  const [whole = '0', fraction = ''] = normalizeHuman(human).split('.');
  if (fraction.length > decimals) throw new LanguageError('INVALID_AMOUNT', `This asset allows at most ${decimals} decimal places.`);
  const value = (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
  atomic(value); return value;
}
export function fromAtomic(atomicText: string, decimals: number): string {
  const n = atomic(atomicText); const scale = 10n ** BigInt(decimals);
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (n / scale).toString() + (fraction ? '.' + fraction : '');
}
/** Human price text → canonical language decimal (positive, at most 18 places). */
export function toPriceDecimal(human: string): string {
  const value = normalizeHuman(human);
  if (decimal(value) <= 0n) throw new LanguageError('TYPE_MISMATCH', 'Price must be positive.');
  return value;
}
/** "10" % → 1000 bps; "0.01" % is the smallest step; 100 % is the most. */
export function percentToBps(human: string): number {
  const [whole = '0', fraction = ''] = normalizeHuman(human).split('.');
  if (fraction.length > 2) throw new LanguageError('INVALID_AMOUNT', 'Use at most two decimal places for a percentage.');
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (bps < 1n || bps > 10000n) throw new LanguageError('INVALID_AMOUNT', 'Percentage must be between 0.01 and 100.');
  return Number(bps);
}
export function bpsToPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 1 || bps > 10000) throw new LanguageError('INVALID_AMOUNT', 'Basis points must be 1–10,000.');
  return normalizeHuman(`${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`);
}
/** Human signed decimal → canonical language decimal (at most 18 places, no negative zero). */
export function toLanguageDecimal(human: string): string {
  const trimmed = human.trim(); const negative = trimmed.startsWith('-');
  const magnitude = normalizeHuman(negative ? trimmed.slice(1) : trimmed);
  const value = negative && magnitude !== '0' ? '-' + magnitude : magnitude;
  decimal(value); return value;
}
