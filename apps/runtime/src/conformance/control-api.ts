// Control API conformance kit. The control API owner runs it against their implementation through the runtime's
// ControlApi client (docs/integration/control-api.md). It checks the semantics the runtime relies on: closed
// documents, checkpoint-before-dispatch, idempotent results, fencing and terminal commits.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { operationKey, validate } from '@monad-hack/contracts';
import type { RunCheckpoint, RuntimeAssignment } from '@monad-hack/contracts';
import { compileStrategy } from '@monad-hack/strategy';
import type { HostCommand } from '@monad-hack/strategy';
import { Driver } from '../driver.ts';
import { RuntimeError } from '../errors.ts';
import type { Clock, ControlApi } from '../ports.ts';

export interface ControlApiHarness {
  readonly api: ControlApi;
  readonly clock: Clock;
  /** Arrange a fresh run (deploy + trigger) so the next poll offers its assignment. */
  arrangeRun(): Promise<void>;
  /** Expire the current lease of a run and issue a newer one (the next poll offers it). */
  expireLease(runId: string): Promise<void>;
  /** Number of timeline rows stored for a run. */
  timelineCount(runId: string): Promise<number>;
}

const throwsCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof RuntimeError && error.code === code);
};

export function controlApiConformance(name: string, makeHarness: () => Promise<ControlApiHarness>): void {
  const poll = async (h: ControlApiHarness): Promise<RuntimeAssignment> => {
    const offer = await h.api.poll({ schemaVersion: 'assignment-poll/1', runtimeId: 'conformance', state: 'ready', waitSeconds: 0 });
    assert.ok(validate('assignmentOffer', offer).ok, 'offer must be a closed assignment-offer/1');
    assert.equal(offer.disposition, 'assigned');
    return offer.assignment!;
  };
  /** Advance the pinned strategy to its first host command, exactly as the runtime would. */
  const firstCommand = async (h: ControlApiHarness, a: RuntimeAssignment): Promise<{ checkpoint: RunCheckpoint; command: HostCommand; key: string }> => {
    const catalog = JSON.parse((await h.api.fetchArtifact(a.artifacts.catalogRef)).text);
    const program = await compileStrategy((await h.api.fetchArtifact(a.artifacts.strategyRef)).text, catalog);
    assert.equal(program.hash, a.artifacts.strategyHash, 'strategyHash is compileStrategy(...).hash');
    const driver = new Driver(program, h.clock);
    const started = await driver.start({ deploymentRevision: a.run.deploymentRevision, triggerId: a.run.triggerId, sourceEventKey: a.run.sourceEventKey });
    assert.equal(started.runId, a.run.runId, 'assignment runId must equal the interpreter run identity');
    const { checkpoint, command } = await driver.advance(started);
    assert.ok(command, 'conformance strategy must start with a host operation');
    const key = await operationKey(command.kind, { deploymentId: a.deployment.deploymentId, generation: a.deployment.generation, runId: command.runId, nodeId: command.nodeId, iterationPath: command.iterationPath });
    return { checkpoint, command, key };
  };
  const fenceOf = (a: RuntimeAssignment) => ({ runId: a.run.runId, assignmentId: a.assignmentId, fencingToken: a.lease.fencingToken });
  const op = (command: HostCommand, key: string) => ({ operationKey: key, kind: command.kind, nodeId: command.nodeId, iterationPath: [...command.iterationPath] });

  describe(`control API conformance: ${name}`, () => {
    test('offers closed, verifiable assignments and immutable artifacts', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const a = await poll(h);
      assert.ok(validate('runtimeAssignment', a).ok);
      assert.equal(a.interpreter.checkpointVersion, 'strategy-run/2');
      const strategy = await h.api.fetchArtifact(a.artifacts.strategyRef);
      assert.equal(strategy.contentHash, a.artifacts.strategyHash);
      const none = await h.api.poll({ schemaVersion: 'assignment-poll/1', runtimeId: 'conformance', state: 'idle', waitSeconds: 0 });
      assert.equal(none.disposition, 'none', 'one assignment per lease');
    });

    test('a new run has no checkpoint; a saved wait is returned by loadRun', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const a = await poll(h);
      const fresh = await h.api.loadRun(a.run.runId, a.assignmentId, a.lease.fencingToken);
      assert.ok(validate('runState', fresh).ok);
      assert.equal(fresh.checkpoint, undefined);
      assert.deepEqual(fresh.observationRefs, []);
      const { checkpoint, command, key } = await firstCommand(h, a);
      await h.api.wait({ schemaVersion: 'run-wait/1', ...fenceOf(a), checkpoint, operation: op(command, key) });
      const loaded = await h.api.loadRun(a.run.runId, a.assignmentId, a.lease.fencingToken);
      assert.deepEqual(loaded.checkpoint, checkpoint);
      assert.equal(loaded.recorded, undefined, 'a just-saved wait has no result yet');
    });

    test('wait is idempotent for the same operation and rejects a reused key', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const a = await poll(h);
      const { checkpoint, command, key } = await firstCommand(h, a);
      const body = { schemaVersion: 'run-wait/1' as const, ...fenceOf(a), checkpoint, operation: op(command, key) };
      await h.api.wait(body);
      await h.api.wait(body);
      await throwsCode(h.api.wait({ ...body, operation: { ...body.operation, nodeId: 'someOtherNode' } }), 'CONFLICT');
    });

    test('results are idempotent by key; a different definitive outcome conflicts; pending may become definitive', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const a = await poll(h);
      const { checkpoint, command, key } = await firstCommand(h, a);
      const fence = fenceOf(a);
      await throwsCode(h.api.result({ schemaVersion: 'run-result/1', ...fence, operationKey: key, outcome: 'acknowledged' }), 'CONFLICT');
      await h.api.wait({ schemaVersion: 'run-wait/1', ...fence, checkpoint, operation: op(command, key) });
      await h.api.result({ schemaVersion: 'run-result/1', ...fence, operationKey: key, outcome: 'pending' });
      const definitive = { schemaVersion: 'run-result/1' as const, ...fence, operationKey: key, outcome: 'rejected' as const };
      await h.api.result(definitive);
      await h.api.result(definitive);
      await throwsCode(h.api.result({ ...definitive, outcome: 'failed' }), 'CONFLICT');
      const loaded = await h.api.loadRun(a.run.runId, a.assignmentId, a.lease.fencingToken);
      assert.equal(loaded.recorded?.operationKey, key);
      assert.equal(loaded.recorded?.outcome, 'rejected');
    });

    test('a stale fencing token can neither write nor heartbeat', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const old = await poll(h);
      const { checkpoint, command, key } = await firstCommand(h, old);
      await h.expireLease(old.run.runId);
      const current = await poll(h);
      assert.ok(BigInt(current.lease.fencingToken) > BigInt(old.lease.fencingToken), 'fencing tokens increase');
      const stale = fenceOf(old);
      await throwsCode(h.api.wait({ schemaVersion: 'run-wait/1', ...stale, checkpoint, operation: op(command, key) }), 'FENCED');
      await throwsCode(h.api.loadRun(stale.runId, stale.assignmentId, stale.fencingToken), 'FENCED');
      await throwsCode(h.api.heartbeat(stale.assignmentId, stale.fencingToken), 'FENCED');
      await h.api.heartbeat(current.assignmentId, current.lease.fencingToken);
    });

    test('complete accepts only terminal checkpoints; timeline entries are idempotent', async () => {
      const h = await makeHarness();
      await h.arrangeRun();
      const a = await poll(h);
      const { checkpoint } = await firstCommand(h, a);
      const fence = fenceOf(a);
      await throwsCode(h.api.complete({ schemaVersion: 'run-complete/1', ...fence, checkpoint }), 'CONFLICT');
      const entry = { schemaVersion: 'timeline-entry/1' as const, ...fence, operationKey: '0x' + 'ab'.repeat(32), nodeId: 'note', message: 'Conformance entry.', inputs: {} };
      await h.api.timeline(entry);
      await h.api.timeline(entry);
      assert.equal(await h.timelineCount(a.run.runId), 1);
      const terminal: RunCheckpoint = { ...structuredClone(checkpoint), status: 'failed', frames: [], error: { code: 'POLICY_DENIED', message: 'Conformance terminal state.', nodeId: checkpoint.triggerId } };
      delete terminal.waiting;
      await h.api.complete({ schemaVersion: 'run-complete/1', ...fence, checkpoint: terminal });
    });
  });
}
