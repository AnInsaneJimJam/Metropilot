// INT-2: the runtime's executor conformance kit through the runtime's real executor HTTP client
// (apps/runtime/src/dispatch/executor.ts) against the real paper executor on PostgreSQL. Capabilities are
// minted per arranged run here; in the stack the control API issues them (tests/paper-stack.test.ts).
import { after } from 'node:test';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';
import { databaseSkip, ExecutorTestHarness } from '../apps/executor/src/testing.ts';
import type { Arranged } from '../apps/executor/src/testing.ts';
import { EXECUTOR_CONFORMANCE_STRATEGY, executorConformance } from '../apps/runtime/src/conformance/executor.ts';
import { HttpExecutor } from '../apps/runtime/src/dispatch/executor.ts';

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
  const executor = new HttpExecutor({ origin: h.baseUrl, attempts: 1, capability: async (intent) => runs.get(intent.runId)?.capability() ?? 'missing.capability.token' });
  executorConformance('runtime HttpExecutor → paper executor → PostgreSQL', async () => ({
    executor,
    arrangeRun: async () => {
      const arranged = await h.arrange({ strategy: EXECUTOR_CONFORMANCE_STRATEGY });
      runs.set(arranged.runId, arranged);
      return { deploymentId: arranged.deploymentId, generation: arranged.generation, runId: arranged.runId };
    },
    revoke: async (runId) => h.authority.set(runs.get(runId)!.deploymentId, { desiredState: 'paused' }),
  }));
}
