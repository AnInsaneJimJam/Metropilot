// INT-2 rehearsal: the runtime's executor conformance kit against the real paper executor over HTTP, with a
// real PostgreSQL. The client below is a test-only adapter that applies the error mapping of
// docs/integration/runtime-http-clients.md section 3; it is replaced by apps/runtime/src/dispatch/executor.ts
// when INT-0 lands. Deployment authority is the in-memory stand-in until the control API provides it (G3).
import { after } from 'node:test';
import { parse } from '../packages/contracts/src/index.ts';
import type { ActionIntent, IntentResult } from '../packages/contracts/src/index.ts';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { uuidv7 } from '../apps/executor/src/ids.ts';
import { databaseSkip, ExecutorTestHarness } from '../apps/executor/src/testing.ts';
import type { Arranged } from '../apps/executor/src/testing.ts';
import { EXECUTOR_CONFORMANCE_STRATEGY, executorConformance } from '../apps/runtime/src/conformance/executor.ts';
import { RuntimeError } from '../apps/runtime/src/errors.ts';
import type { Executor } from '../apps/runtime/src/ports.ts';

/** Status + error-1 code → runtime code, exactly as runtime-http-clients.md section 3. */
function mapFailure(status: number, text: string): RuntimeError {
  const body = parse('error', text);
  const code = body.ok ? body.value.code : undefined;
  if (status === 409 && code === 'LEASE_FENCED') return new RuntimeError('FENCED', 'Executor 409 LEASE_FENCED.');
  if (status === 409 && code === 'GENERATION_REVOKED') return new RuntimeError('REVOKED', 'Executor 409 GENERATION_REVOKED.');
  if (status === 409 && code === 'IDEMPOTENCY_CONFLICT') return new RuntimeError('CONFLICT', 'Executor 409 IDEMPOTENCY_CONFLICT.');
  if (status === 401 || status === 403) return new RuntimeError('REVOKED', `Executor ${status}.`);
  if (status === 429 || status === 503) return new RuntimeError('UNAVAILABLE', `Executor ${status}.`);
  return new RuntimeError('RESULT_INVALID', `Executor ${status}.`);
}

/** Routes runs to the capability minted for them; the runtime would hold one capability per assignment. */
class HttpExecutorClient implements Executor {
  readonly #baseUrl: string;
  readonly #capabilityFor: (runId: string) => string | undefined;
  constructor(baseUrl: string, capabilityFor: (runId: string) => string | undefined) {
    this.#baseUrl = baseUrl;
    this.#capabilityFor = capabilityFor;
  }
  async submit(intent: ActionIntent): Promise<IntentResult> {
    const capability = this.#capabilityFor(intent.runId);
    const response = await fetch(`${this.#baseUrl}/internal/v1/intents`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json', 'x-request-id': uuidv7(), 'idempotency-key': intent.logicalKey,
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      },
      // Sent as-is: a body that fails action-intent/1 is the server's to refuse (the kit checks that).
      body: JSON.stringify(intent),
    });
    const text = await response.text();
    if (![200, 201, 202].includes(response.status)) throw mapFailure(response.status, text);
    const result = parse('intentResult', text);
    if (!result.ok || result.value.logicalKey !== intent.logicalKey || result.value.mode !== 'paper') throw new RuntimeError('RESULT_INVALID', 'Executor answer failed intent-result/1.');
    return result.value;
  }
}

const skip = await databaseSkip();
if (skip) {
  const { test } = await import('node:test');
  test('executor conformance: paper executor over HTTP', { skip }, () => undefined);
} else {
  const h = await ExecutorTestHarness.start({ migrate, seed: seedPaper });
  after(async () => {
    await h.stop();
  });
  const runs = new Map<string, Arranged>();
  const executor = new HttpExecutorClient(h.baseUrl, (runId) => runs.get(runId)?.capability());
  executorConformance('paper executor over HTTP + PostgreSQL', async () => ({
    executor,
    arrangeRun: async () => {
      const arranged = await h.arrange({ strategy: EXECUTOR_CONFORMANCE_STRATEGY });
      runs.set(arranged.runId, arranged);
      return { deploymentId: arranged.deploymentId, generation: arranged.generation, runId: arranged.runId };
    },
    revoke: async (runId) => h.authority.set(runs.get(runId)!.deploymentId, { desiredState: 'paused' }),
  }));
}
