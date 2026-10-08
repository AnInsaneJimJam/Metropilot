// Executor conformance kit for the runtime-facing contract (docs/integration/executor.md): admission is
// idempotent by logical key, the key is recomputed from authenticated identity, bodies are closed, stale
// generations are refused and answers are closed intent-result/1 documents. Paper mode only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { intentKey, validate } from '@monad-hack/contracts';
import type { ActionIntent, Strategy } from '@monad-hack/contracts';
import { RuntimeError } from '../errors.ts';
import type { Executor } from '../ports.ts';

/**
 * The approved strategy every conformance intent matches (executor.md section 5 steps 7–9): a real executor
 * rejects an intent whose node, iteration path or amount rule is not in the deployed AST, so the kit only
 * sends intents this strategy can produce.
 */
export const EXECUTOR_CONFORMANCE_STRATEGY: Strategy = {
  schemaVersion: 'strategy/1',
  id: 'executor_conformance',
  name: 'Executor conformance (paper)',
  triggers: [{
    id: 'hourly', type: 'schedule', intervalSeconds: 3600, anchorAt: '2026-10-01T00:00:00.000Z',
    body: [
      { id: 'sell_tenth', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50 },
      { id: 'sell_each', type: 'repeat', count: 2, body: [
        { id: 'sell_small', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', amount: { kind: 'fixed', atomic: '1000' }, maxSlippageBps: 50 },
      ] },
      { id: 'sell_too_much', type: 'swap.exactInput', connectorRef: 'paper.uniswap', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD', amount: { kind: 'fixed', atomic: '1' + '0'.repeat(40) }, maxSlippageBps: 50 },
    ],
  }],
  limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 0, maxIntentsPerRun: 3, maxActiveSecondsPerRun: 60 },
};

export interface ExecutorHarness {
  readonly executor: Executor;
  /**
   * A paper run of EXECUTOR_CONFORMANCE_STRATEGY (connector paper.uniswap 1.0.0) that the executor's capability
   * check will authorize, with at least 1 paper.WETH available.
   */
  arrangeRun(): Promise<{ deploymentId: string; generation: string; runId: string }>;
  /** Revoke the run's generation (pause or redeploy). */
  revoke(runId: string): Promise<void>;
}

const throwsCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof RuntimeError && error.code === code);
};

export function executorConformance(name: string, makeHarness: () => Promise<ExecutorHarness>): void {
  const intentFor = async (id: { deploymentId: string; generation: string; runId: string }, overrides: Partial<ActionIntent> = {}): Promise<ActionIntent> => {
    const nodeId = overrides.nodeId ?? 'sell_tenth';
    const iterationPath = overrides.iterationPath ?? [];
    return {
      schemaVersion: 'action-intent/1', logicalKey: await intentKey({ ...id, nodeId, iterationPath }), runId: id.runId, nodeId, iterationPath,
      connectorRef: 'paper.uniswap', connectorVersion: '1.0.0', action: 'swap.exactInput', tokenInRef: 'paper.WETH', tokenOutRef: 'paper.USD',
      amount: { kind: 'positionBps', bps: 1000 }, maxSlippageBps: 50, observationRefs: [], ...overrides,
    };
  };

  describe(`executor conformance: ${name}`, () => {
    test('admits a paper intent and answers with a closed intent-result/1', async () => {
      const h = await makeHarness();
      const intent = await intentFor(await h.arrangeRun());
      const result = await h.executor.submit(intent);
      assert.ok(validate('intentResult', result).ok, JSON.stringify(result));
      assert.equal(result.logicalKey, intent.logicalKey);
      assert.equal(result.mode, 'paper');
      assert.equal(result.transactionHash, undefined, 'paper never returns a transaction hash');
      if (result.state !== 'rejected') assert.ok(result.action.resolvedInputAtomic, 'positionBps resolves to a frozen atomic input');
    });

    test('the same logical key and body returns the same intent; a different body conflicts', async () => {
      const h = await makeHarness();
      const intent = await intentFor(await h.arrangeRun());
      const first = await h.executor.submit(intent);
      const again = await h.executor.submit(structuredClone(intent));
      assert.equal(again.intentId, first.intentId);
      await throwsCode(h.executor.submit({ ...intent, maxSlippageBps: 40 }), 'CONFLICT');
    });

    test('the logical key is recomputed from the authenticated identity', async () => {
      const h = await makeHarness();
      const intent = await intentFor(await h.arrangeRun());
      await throwsCode(h.executor.submit({ ...intent, logicalKey: '0x' + '99'.repeat(32) }), 'CONFLICT');
    });

    test('closed body: wallet, recipient and calldata fields are refused', async () => {
      const h = await makeHarness();
      const intent = await intentFor(await h.arrangeRun());
      await throwsCode(h.executor.submit({ ...intent, recipient: '0x' + '00'.repeat(20) } as ActionIntent), 'RESULT_INVALID');
    });

    test('repeat iterations are distinct intents', async () => {
      const h = await makeHarness();
      const id = await h.arrangeRun();
      const a = await h.executor.submit(await intentFor(id, { nodeId: 'sell_small', iterationPath: [0], amount: { kind: 'fixed', atomic: '1000' } }));
      const b = await h.executor.submit(await intentFor(id, { nodeId: 'sell_small', iterationPath: [1], amount: { kind: 'fixed', atomic: '1000' } }));
      assert.notEqual(a.intentId, b.intentId);
    });

    test('insufficient input is a durable rejection with a stable reason, not an error', async () => {
      const h = await makeHarness();
      const result = await h.executor.submit(await intentFor(await h.arrangeRun(), { nodeId: 'sell_too_much', amount: { kind: 'fixed', atomic: '1' + '0'.repeat(40) } }));
      assert.equal(result.state, 'rejected');
      assert.ok(result.reason?.code.startsWith('EXECUTOR_'));
    });

    test('a revoked generation cannot create a new intent', async () => {
      const h = await makeHarness();
      const id = await h.arrangeRun();
      await h.revoke(id.runId);
      await throwsCode(h.executor.submit(await intentFor(id)), 'REVOKED');
    });
  });
}
