import type { Price, Trigger } from '@monad-hack/contracts';
import { decimal, timestamp } from './expression.ts';
import { LanguageError } from './errors.ts';
export type PriceTrigger = Extract<Trigger, { type: 'price.crossesAbove' | 'price.crossesBelow' }>;
export interface PriceObservation { sourceEventKey: string; feedRef: string; price: Price; observedAt: string; receivedAt: string }
export interface CrossingState { baseline?: string; observedAt?: string; sourceEventKey?: string; acceptedAt?: string }
export interface TriggerDecision { state: CrossingState; fire: boolean; reason: 'baseline' | 'crossing' | 'no-crossing' | 'cooldown' | 'stale' | 'out-of-order' }
// The caller persists this transition and accepted run atomically. State is revision/feed scoped.
export function transitionPrice(trigger: PriceTrigger, previous: CrossingState, observation: PriceObservation, now: string): TriggerDecision {
  const time = timestamp(now); const observed = timestamp(observation.observedAt); const received = timestamp(observation.receivedAt);
  if (!observation.sourceEventKey || observation.feedRef !== trigger.feedRef || observation.price.baseAssetRef !== trigger.threshold.baseAssetRef || observation.price.quoteUnit !== trigger.threshold.quoteUnit) throw new LanguageError('TYPE_MISMATCH', 'Observation feed/price units do not match trigger.', trigger.id);
  const current = decimal(observation.price.decimal); const threshold = decimal(trigger.threshold.decimal);
  if (current <= 0n || threshold <= 0n) throw new LanguageError('TYPE_MISMATCH', 'Prices must be positive.', trigger.id);
  if (observed > received || received > time) throw new LanguageError('STALE_DATA', 'Future-dated observation is not accepted.', trigger.id);
  if (previous.observedAt && (observed <= timestamp(previous.observedAt) || previous.sourceEventKey === observation.sourceEventKey)) return { state: previous, fire: false, reason: 'out-of-order' };
  const state: CrossingState = { observedAt: observation.observedAt, sourceEventKey: observation.sourceEventKey, ...(previous.acceptedAt ? { acceptedAt: previous.acceptedAt } : {}) };
  if (time - observed > trigger.maxAgeSeconds * 1000) return { state, fire: false, reason: 'stale' };
  state.baseline = observation.price.decimal;
  if (!previous.baseline || !previous.observedAt || observed - timestamp(previous.observedAt) > trigger.maxAgeSeconds * 1000) return { state, fire: false, reason: 'baseline' };
  const before = decimal(previous.baseline);
  const crosses = trigger.type === 'price.crossesAbove' ? before <= threshold && current > threshold : before >= threshold && current < threshold;
  if (!crosses) return { state, fire: false, reason: 'no-crossing' };
  if (previous.acceptedAt && time - timestamp(previous.acceptedAt) < trigger.cooldownSeconds * 1000) return { state, fire: false, reason: 'cooldown' };
  state.acceptedAt = now;
  return { state, fire: true, reason: 'crossing' };
}
export function scheduleSlot(trigger: Extract<Trigger, { type: 'schedule' }>, now: string, lastAcceptedSlot?: string): string | undefined {
  const anchor = timestamp(trigger.anchorAt); const time = timestamp(now);
  if (time < anchor) return undefined;
  const slot = new Date(anchor + Math.floor((time - anchor) / (trigger.intervalSeconds * 1000)) * trigger.intervalSeconds * 1000).toISOString();
  if (lastAcceptedSlot && timestamp(slot) <= timestamp(lastAcceptedSlot)) return undefined;
  return slot;
}
