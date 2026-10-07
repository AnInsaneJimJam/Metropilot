// In-memory paper executor implementing the runtime-facing executor contract (docs/specs/executor.md sections 3–8):
// capability-derived identity, logical-key recomputation, idempotent admission, exact virtual balances and a
// deterministic synthetic fill. It never signs, never returns a transaction hash and never touches live identities.
import { canonicalize, contentHash, intentKey, validate } from '@monad-hack/contracts';
import type { ActionIntent, IntentResult } from '@monad-hack/contracts';
import { RuntimeError } from '../errors.ts';
import type { Clock, Executor } from '../ports.ts';
import { Ids } from './support.ts';

export const PAPER_ADAPTER_VERSION = 'paper-adapter/1';

export interface ExecutorAuthority {
  deploymentId: string;
  generation: string;
  mode: 'paper' | 'live';
  active: boolean;
}

export interface PaperExecutorOptions {
  readonly clock: Clock;
  /** What the authenticated capability and current deployment say about this run (never the request body). */
  readonly authorityFor: (runId: string) => ExecutorAuthority | undefined;
  /** Virtual available trading inventory per asset, atomic units. */
  readonly balances: Map<string, bigint>;
  /** Paper fill model: output atomic for an input, using recorded market data and declared fee/slippage. */
  readonly fill: (intent: ActionIntent, inputAtomic: bigint) => bigint;
  /** Settle at admission (true) or leave the intent reserved until settlePending() (false). */
  readonly autoSettle?: boolean;
  /** Reconciliation callback: the control plane records the definitive result and schedules a resume. */
  readonly onSettled?: (intent: ActionIntent, result: IntentResult) => Promise<void>;
}

interface Stored {
  body: string;
  intent: ActionIntent;
  result: IntentResult;
  submissions: number;
}

export class PaperExecutor implements Executor {
  readonly #options: PaperExecutorOptions;
  readonly #ids: Ids;
  readonly #byKey = new Map<string, Stored>();

  constructor(options: PaperExecutorOptions) {
    this.#options = options;
    this.#ids = new Ids(options.clock);
  }

  /** How many times a logical intent was presented (duplicates included); effects happen once. */
  submissions(logicalKey: string): number {
    return this.#byKey.get(logicalKey)?.submissions ?? 0;
  }

  get intents(): readonly IntentResult[] {
    return [...this.#byKey.values()].map((s) => structuredClone(s.result));
  }

  async submit(intent: ActionIntent): Promise<IntentResult> {
    if (!validate('actionIntent', intent).ok) throw new RuntimeError('RESULT_INVALID', 'Executor 400: malformed ActionIntent.');
    const authority = this.#options.authorityFor(intent.runId);
    if (!authority || authority.mode !== 'paper') throw new RuntimeError('REVOKED', 'Executor 403: capability is not valid for a paper intent on this run.');
    const expected = await intentKey({ deploymentId: authority.deploymentId, generation: authority.generation, runId: intent.runId, nodeId: intent.nodeId, iterationPath: intent.iterationPath });
    if (expected !== intent.logicalKey) throw new RuntimeError('CONFLICT', 'Executor 409: logical key does not match the authenticated identity.');
    const body = canonicalize(intent);
    const existing = this.#byKey.get(intent.logicalKey);
    if (existing) {
      existing.submissions += 1;
      if (existing.body !== body) throw new RuntimeError('CONFLICT', 'Executor 409 EXECUTOR_INTENT_CONFLICT: same logical key, different body.');
      return structuredClone(existing.result); // 200: duplicate known intent
    }
    if (!authority.active) throw new RuntimeError('REVOKED', 'Executor 409 EXECUTOR_STALE_GENERATION: generation is no longer authorized.');

    const now = this.#options.clock.now();
    const action = { connectorRef: intent.connectorRef, connectorVersion: intent.connectorVersion, tokenInRef: intent.tokenInRef, tokenOutRef: intent.tokenOutRef, maxSlippageBps: intent.maxSlippageBps };
    const base = { schemaVersion: 'intent-result/1' as const, intentId: this.#ids.next(), logicalKey: intent.logicalKey, mode: 'paper' as const, createdAt: now, updatedAt: now };
    const available = this.#options.balances.get(intent.tokenInRef) ?? 0n;
    // positionBps resolves once, against available inventory at authorization time, and is frozen.
    const input = intent.amount.kind === 'fixed' ? BigInt(intent.amount.atomic) : (available * BigInt(intent.amount.bps)) / 10_000n;
    let result: IntentResult;
    if (input <= 0n || input > available) {
      result = { ...base, state: 'rejected', action, reason: { code: input <= 0n ? 'EXECUTOR_AMOUNT_EXCEEDED' : 'EXECUTOR_INSUFFICIENT_BUDGET', message: input <= 0n ? 'Resolved input is zero.' : 'Virtual balance is below the requested input.' } };
    } else {
      this.#options.balances.set(intent.tokenInRef, available - input); // reservation hold
      result = { ...base, state: 'reserved', action: { ...action, resolvedInputAtomic: input.toString() } };
    }
    const stored: Stored = { body, intent: structuredClone(intent), result, submissions: 1 };
    this.#byKey.set(intent.logicalKey, stored);
    if (result.state === 'reserved' && this.#options.autoSettle) await this.#settle(stored, false);
    return structuredClone(stored.result); // 201
  }

  /** Settle every reserved intent (the synthetic fill) and notify reconciliation. */
  async settlePending(): Promise<number> {
    let settled = 0;
    for (const stored of this.#byKey.values()) if (stored.result.state === 'reserved') { await this.#settle(stored, true); settled += 1; }
    return settled;
  }

  async #settle(stored: Stored, notify: boolean): Promise<void> {
    const input = BigInt(stored.result.action.resolvedInputAtomic!);
    const output = this.#options.fill(stored.intent, input);
    const out = stored.intent.tokenOutRef;
    this.#options.balances.set(out, (this.#options.balances.get(out) ?? 0n) + output);
    stored.result = {
      ...stored.result, state: 'settled', updatedAt: this.#options.clock.now(),
      paperFillId: await contentHash({ schemaVersion: 'paper-fill/1', logicalKey: stored.intent.logicalKey, adapter: PAPER_ADAPTER_VERSION }),
      settlement: { inputAtomic: input.toString(), outputAtomic: output.toString() },
    };
    if (notify) await this.#options.onSettled?.(stored.intent, structuredClone(stored.result));
  }
}
