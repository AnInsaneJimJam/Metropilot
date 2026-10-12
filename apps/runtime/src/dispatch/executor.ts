// HTTP implementation of the Executor port (docs/integration/executor.md). Sends the closed ActionIntent with
// Idempotency-Key = logicalKey and the executor-audience capability obtained from the control API; answers are
// closed intent-result/1 documents (200 duplicate, 201 admitted, 202 pending). Failures use the shared mapping.
// A retry always resends the identical body under the same key: the executor deduplicates, so a timeout is
// never a reason to build a new intent.
import { parse, validate } from '@monad-hack/contracts';
import type { ActionIntent, IntentResult } from '@monad-hack/contracts';
import { RuntimeError } from '../errors.ts';
import type { Executor } from '../ports.ts';
import { runtimeErrorFor } from './errors.ts';
import { uuidv7 } from './ids.ts';

export interface HttpExecutorOptions {
  /** Internal executor origin (closed runtime configuration). */
  readonly origin: string;
  /** Executor capability for this intent's run; called again after the executor refuses an expired one. */
  readonly capability: (intent: ActionIntent) => Promise<string>;
  /** Drop a cached capability so the next call fetches a fresh one. */
  readonly forgetCapability?: () => void;
  readonly timeoutMillis?: number;
  readonly attempts?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpExecutor implements Executor {
  readonly origin: string;
  readonly #o: HttpExecutorOptions;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: HttpExecutorOptions) {
    const origin = new URL(options.origin);
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new RuntimeError('ASSIGNMENT_INVALID', 'Executor origin must be a bare origin.');
    this.origin = origin.origin;
    this.#o = options;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async submit(intent: ActionIntent): Promise<IntentResult> {
    // Same code as the executor's 400 for a malformed body: refused before it leaves the process.
    if (!validate('actionIntent', intent).ok) throw new RuntimeError('RESULT_INVALID', 'Refusing to send a malformed ActionIntent.');
    const body = JSON.stringify(intent);
    const attempts = this.#o.attempts ?? 3;
    let refreshed = false;
    let last: RuntimeError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await this.#fetch(`${this.origin}/internal/v1/intents`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.#o.timeoutMillis ?? 10_000),
          headers: {
            accept: 'application/json', 'content-type': 'application/json', 'x-request-id': uuidv7(),
            'idempotency-key': intent.logicalKey, authorization: `Bearer ${await this.#o.capability(intent)}`,
          },
          body,
        });
        const text = await response.text();
        if (response.ok) {
          const parsed = parse('intentResult', text);
          if (!parsed.ok) throw new RuntimeError('RESULT_INVALID', 'Executor answer failed intent-result/1.');
          return parsed.value;
        }
        let code: string | undefined;
        try { code = (JSON.parse(text) as { code?: unknown }).code as string | undefined; } catch { code = undefined; }
        // An expired capability: fetch a fresh one once and resend the identical intent.
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          this.#o.forgetCapability?.();
          attempt--;
          continue;
        }
        const error = runtimeErrorFor(response.status, typeof code === 'string' ? code : undefined);
        if (error.code !== 'UNAVAILABLE') throw error;
        last = error;
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        // Network error or timeout: the intent may be admitted. Resending the same body and key is safe.
        last = new RuntimeError('UNAVAILABLE', 'Executor unreachable or timed out.');
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt + Math.random() * 50));
    }
    throw last ?? new RuntimeError('UNAVAILABLE', 'Executor unavailable.');
  }
}
