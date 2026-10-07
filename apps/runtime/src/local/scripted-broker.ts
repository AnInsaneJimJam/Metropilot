// In-memory API Broker for local runs: answers read and ai.decide from scripts, deduplicates by operation key
// (a retried operation never becomes a second provider call) and returns closed broker-result/1 documents.
// Synthetic only: no provider, no credentials, no network.
import { validate } from '@monad-hack/contracts';
import type { BrokerRequest, BrokerResult } from '@monad-hack/contracts';
import { RuntimeError } from '../errors.ts';
import type { Broker, Clock } from '../ports.ts';
import { Ids } from './support.ts';

export type ScriptAnswer =
  | { value: Record<string, unknown>; observedAt?: string }
  | { refuse: NonNullable<BrokerResult['reason']>['code'] }
  | { unknown: true };

export interface ScriptedBrokerOptions {
  readonly clock: Clock;
  readonly read: (request: BrokerRequest) => ScriptAnswer;
  readonly decide: (request: BrokerRequest) => ScriptAnswer;
}

export class ScriptedBroker implements Broker {
  /** Provider calls actually made; replays of a known operation key do not add to it. */
  providerCalls = 0;
  readonly #options: ScriptedBrokerOptions;
  readonly #ids: Ids;
  readonly #byKey = new Map<string, BrokerResult>();

  constructor(options: ScriptedBrokerOptions) {
    this.#options = options;
    this.#ids = new Ids(options.clock);
  }

  /**
   * Reconciliation of an ambiguous (`unknown`) or `pending` operation: the same provider call is resolved to a
   * definitive answer. No new provider call is made; the next request under the key returns it.
   */
  resolve(operationKey: string, answer: ScriptAnswer): void {
    const known = this.#byKey.get(operationKey);
    if (!known || (known.disposition !== 'unknown' && known.disposition !== 'pending')) throw new RuntimeError('CONFLICT', 'Only a pending or unknown operation can be resolved.');
    this.#byKey.set(operationKey, this.#answer(operationKey, answer));
  }

  async request(request: BrokerRequest): Promise<BrokerResult> {
    if (!validate('brokerRequest', request).ok) throw new RuntimeError('RESULT_INVALID', 'Broker 400: malformed request.');
    const known = this.#byKey.get(request.operationKey);
    if (known) return structuredClone(known);
    this.providerCalls += 1;
    const answer = request.kind === 'read' ? this.#options.read(request) : this.#options.decide(request);
    const result = this.#answer(request.operationKey, answer);
    this.#byKey.set(request.operationKey, result);
    return structuredClone(result);
  }

  #answer(operationKey: string, answer: ScriptAnswer): BrokerResult {
    const base = { schemaVersion: 'broker-result/1' as const, operationKey };
    let result: BrokerResult;
    if ('value' in answer) {
      const receivedAt = this.#options.clock.now();
      result = { ...base, disposition: 'completed', resultId: this.#ids.next(), value: answer.value, receivedAt, ...(answer.observedAt ? { observedAt: answer.observedAt } : {}) };
    } else if ('refuse' in answer) {
      result = { ...base, disposition: 'refused', reason: { code: answer.refuse, message: 'Synthetic broker refused the request.' } };
    } else {
      result = { ...base, disposition: 'unknown' };
    }
    return result;
  }
}
