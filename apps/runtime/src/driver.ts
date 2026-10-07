// Thin adapter around the shared interpreter. packages/strategy is the only implementation of language
// semantics; this file adds active-time measurement and separates the two failure channels.
import type { RunCheckpoint } from '@monad-hack/contracts';
import { advanceRun, LanguageError, startRun } from '@monad-hack/strategy';
import type { AdvanceResult, CompiledStrategy, HostResponse } from '@monad-hack/strategy';
import { RuntimeError } from './errors.ts';
import type { Clock } from './ports.ts';

export class Driver {
  readonly #program: CompiledStrategy;
  readonly #clock: Clock;
  /** Active milliseconds measured since the last interpreter call, charged on the next one. */
  #unbilled = 0;

  constructor(program: CompiledStrategy, clock: Clock) {
    this.#program = program;
    this.#clock = clock;
  }

  start(context: { deploymentRevision: string; triggerId: string; sourceEventKey: string }): Promise<RunCheckpoint> {
    return this.#guard(() => startRun(this.#program, context));
  }

  /**
   * A returned `failed` checkpoint is a deterministic run failure (stale read, limit, refused AI): persist it.
   * A thrown LanguageError means the host offered an invalid checkpoint or response: a runtime defect (HOST_BUG),
   * never recorded as the run's outcome.
   */
  async advance(checkpoint: RunCheckpoint, response?: HostResponse): Promise<AdvanceResult> {
    const started = this.#clock.monotonic();
    const charge = Math.max(0, Math.round(this.#unbilled));
    const result = await this.#guard(() => advanceRun(this.#program, checkpoint, response, charge));
    this.#unbilled = this.#clock.monotonic() - started;
    return result;
  }

  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LanguageError) throw new RuntimeError('HOST_BUG', `Interpreter refused host input (${error.code}): ${error.message}`);
      throw error;
    }
  }
}
