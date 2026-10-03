import { normalizeHuman, toPriceDecimal, toLanguageDecimal, NODE_ID } from '@monad-hack/strategy';
// Field validators. Returning null rejects the edit; returning a string stores that (canonical) text.
// These guide typing only; the converter and compiler stay authoritative.
const attempt = (convert: (text: string) => string) => (text: string): string | null => {
  try { return convert(text); } catch { return null; }
};
export const humanAmount = attempt(normalizeHuman);
export const humanPrice = attempt(toPriceDecimal);
export const humanDecimal = attempt(toLanguageDecimal);
export const text = (max: number) => (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
};
export const bindName = (value: string): string | null => NODE_ID.test(value.trim()) ? value.trim() : null;
/** Accepts UTC text such as 2026-10-03T12:00Z and stores the language form 2026-10-03T12:00:00.000Z. */
export function utcTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?Z$/.test(trimmed)) return null;
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  return iso.startsWith(trimmed.slice(0, 16)) ? iso : null; // refuses rolled-over dates such as Feb 30
}
/** The current minute in the language's UTC timestamp form, used as a new schedule's anchor. */
export function currentMinute(): string {
  const now = new Date(); now.setUTCSeconds(0, 0); return now.toISOString();
}
