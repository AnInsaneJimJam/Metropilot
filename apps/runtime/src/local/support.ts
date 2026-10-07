// Deterministic clock and IDs for local runs. Synthetic and labelled; never a production identity source.
import type { Clock } from '../ports.ts';

export class ManualClock implements Clock {
  #millis: number;
  #mono = 0;
  constructor(start = '2026-10-07T12:00:00.000Z') {
    this.#millis = Date.parse(start);
  }
  now(): string {
    return new Date(this.#millis).toISOString();
  }
  monotonic(): number {
    return this.#mono;
  }
  advance(millis: number): void {
    this.#millis += millis;
    this.#mono += millis;
  }
}

/** Monotonic synthetic UUIDv7 values: the time prefix comes from the clock, the rest is a counter. */
export class Ids {
  #counter = 0;
  readonly #clock: Clock;
  constructor(clock: Clock) {
    this.#clock = clock;
  }
  next(): string {
    const time = Date.parse(this.#clock.now()).toString(16).padStart(12, '0');
    const n = (++this.#counter).toString(16).padStart(15, '0');
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${n.slice(0, 3)}-8${n.slice(3, 6)}-${n.slice(3, 15).padStart(12, '0').slice(-12)}`;
  }
}

/** The interpreter's run identity: SHA-256 over the UTF-8 JSON tuple (strategy-language.md section 9). */
export async function runIdFor(deploymentRevision: string, triggerId: string, sourceEventKey: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([deploymentRevision, triggerId, sourceEventKey])));
  return '0x' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
