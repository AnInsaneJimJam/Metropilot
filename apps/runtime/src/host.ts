// One assignment, one run (agent-runtime.md section 8): advance → persist waiting checkpoint → recheck authority
// → dispatch → record result → resume. A pending result releases the process; the control API schedules a resume.
import { validate } from '@monad-hack/contracts';
import type { RunCheckpoint, RuntimeAssignment } from '@monad-hack/contracts';
import type { HostCommand, HostResponse } from '@monad-hack/strategy';
import { Driver } from './driver.ts';
import { RuntimeError } from './errors.ts';
import { actionIntentFor, keyFor } from './keys.ts';
import type { Broker, Clock, ControlApi, Executor } from './ports.ts';
import type { Telemetry } from './telemetry.ts';
import type { VerifiedAssignment } from './assignment.ts';

/** Shared revocation flag: the supervisor flips it on drain, fence loss or refused heartbeat. */
export class Authority {
  #lost: RuntimeError | undefined;
  revoke(error: RuntimeError): void {
    this.#lost ??= error;
  }
  get lost(): RuntimeError | undefined {
    return this.#lost;
  }
  assertActive(): void {
    if (this.#lost) throw this.#lost;
  }
}

export interface HostDeps {
  readonly control: ControlApi;
  readonly broker: Broker;
  readonly executor: Executor;
  readonly clock: Clock;
  readonly telemetry: Telemetry;
  readonly authority: Authority;
  /** Failure-injection hook for tests and the demo: called at each durable boundary. */
  readonly crashAt?: (point: CrashPoint, command: HostCommand) => void;
}

export type CrashPoint = 'after-wait' | 'after-dispatch';
export type RunOutcome = { status: 'completed' | 'failed'; checkpoint: RunCheckpoint } | { status: 'waiting'; checkpoint: RunCheckpoint; operationKey: string };

interface Dispatched {
  response: HostResponse;
  resultRef?: string;
  result?: Record<string, unknown>;
}

export async function runAssignment({ assignment, program }: VerifiedAssignment, deps: HostDeps): Promise<RunOutcome> {
  const { control, clock, telemetry, authority } = deps;
  const fence = { runId: assignment.run.runId, assignmentId: assignment.assignmentId, fencingToken: assignment.lease.fencingToken };
  const driver = new Driver(program, clock);
  const state = await control.loadRun(fence.runId, fence.assignmentId, fence.fencingToken);
  if (!validate('runState', state).ok || state.runId !== fence.runId) throw new RuntimeError('RESULT_INVALID', 'Run state failed its schema.');

  // A duplicate assignment loads the existing run; only a brand-new run starts the interpreter.
  let checkpoint = (state.checkpoint as RunCheckpoint | undefined) ?? (await driver.start({ deploymentRevision: assignment.run.deploymentRevision, triggerId: assignment.run.triggerId, sourceEventKey: assignment.run.sourceEventKey }));
  if (checkpoint.runId !== fence.runId) throw new RuntimeError('ASSIGNMENT_INVALID', 'Assignment run ID does not match the interpreter run identity.');
  const observationRefs = [...state.observationRefs];
  let response: HostResponse | undefined = state.recorded && checkpoint.waiting ? toResponse(checkpoint.waiting.key, state.recorded) : undefined;

  for (;;) {
    authority.assertActive();
    const { checkpoint: next, command } = await driver.advance(checkpoint, response);
    checkpoint = next;
    if (!command) {
      authority.assertActive();
      if (checkpoint.status !== 'completed' && checkpoint.status !== 'failed') throw new RuntimeError('HOST_BUG', 'Interpreter stopped without a command or terminal state.');
      await control.complete({ schemaVersion: 'run-complete/1', ...fence, checkpoint });
      telemetry.emit({ at: clock.now(), event: 'run.terminal', runId: fence.runId, outcome: checkpoint.status, ...(checkpoint.error ? { code: checkpoint.error.code, nodeId: checkpoint.error.nodeId } : {}) });
      return { status: checkpoint.status, checkpoint };
    }

    const operationKey = await keyFor(assignment, command);
    // Checkpoint-before-dispatch: nothing leaves this process until the API holds the waiting state and key.
    await control.wait({ schemaVersion: 'run-wait/1', ...fence, checkpoint, operation: { operationKey, kind: command.kind, nodeId: command.nodeId, iterationPath: [...command.iterationPath] } });
    deps.crashAt?.('after-wait', command);
    authority.assertActive();
    telemetry.emit({ at: clock.now(), event: 'operation.dispatch', runId: fence.runId, nodeId: command.nodeId, operationKey, kind: command.kind });

    const dispatched = await dispatch(assignment, command, operationKey, observationRefs, deps, fence);
    deps.crashAt?.('after-dispatch', command);
    const { response: answer, resultRef, result } = dispatched;
    await control.result({
      schemaVersion: 'run-result/1', ...fence, operationKey, outcome: answer.outcome,
      ...(resultRef ? { resultRef } : {}), ...(result ? { result } : {}), ...(answer.receivedAt ? { receivedAt: answer.receivedAt } : {}),
    });
    telemetry.emit({ at: clock.now(), event: 'operation.result', runId: fence.runId, nodeId: command.nodeId, operationKey, kind: command.kind, outcome: answer.outcome });
    if (resultRef && answer.outcome === 'recorded' && !observationRefs.includes(resultRef)) observationRefs.push(resultRef);
    if (answer.outcome === 'pending') return { status: 'waiting', checkpoint, operationKey };
    response = answer;
  }
}

/** Map a recorded run-state result back to the interpreter's own key and response shape. */
function toResponse(key: string, recorded: NonNullable<import('@monad-hack/contracts').RunState['recorded']>): HostResponse {
  return { key, outcome: recorded.outcome, ...(recorded.result ? { result: recorded.result } : {}), ...(recorded.receivedAt ? { receivedAt: recorded.receivedAt } : {}) };
}

async function dispatch(
  assignment: RuntimeAssignment, command: HostCommand, operationKey: string, observationRefs: readonly string[], deps: HostDeps,
  fence: { runId: string; assignmentId: string; fencingToken: string },
): Promise<Dispatched> {
  const key = command.key;
  if (command.kind === 'notify') {
    await deps.control.timeline({ schemaVersion: 'timeline-entry/1', ...fence, operationKey, nodeId: command.nodeId, message: command.message, inputs: command.inputs as never });
    return { response: { key, outcome: 'acknowledged' } };
  }
  if (command.kind === 'swap.exactInput') {
    const intent = await actionIntentFor(assignment, command, observationRefs);
    const answer = await deps.executor.submit(intent);
    const checked = validate('intentResult', answer);
    if (!checked.ok || answer.logicalKey !== intent.logicalKey || answer.mode !== assignment.deployment.mode) throw new RuntimeError('RESULT_INVALID', 'Executor answer failed its schema, key or mode check.');
    const outcome = answer.state === 'settled' ? 'settled' : answer.state === 'rejected' || answer.state === 'cancelled' ? 'rejected' : answer.state === 'failed' ? 'failed' : 'pending';
    return { response: { key, outcome }, resultRef: answer.intentId };
  }
  const request = command.kind === 'read'
    ? { schemaVersion: 'broker-request/1' as const, operationKey, runId: command.runId, nodeId: command.nodeId, iterationPath: [...command.iterationPath], kind: 'read' as const, connectorRef: command.connectorRef, operation: command.operation, arguments: command.arguments as never }
    : { schemaVersion: 'broker-request/1' as const, operationKey, runId: command.runId, nodeId: command.nodeId, iterationPath: [...command.iterationPath], kind: 'ai.decide' as const, modelProfileRef: command.modelProfileRef, prompt: command.prompt, inputs: command.inputs as never, outputSchemaRef: command.outputSchemaRef, timeoutSeconds: command.timeoutSeconds, maxOutputTokens: command.maxOutputTokens };
  const answer = await deps.broker.request(request);
  if (!validate('brokerResult', answer).ok || answer.operationKey !== operationKey) throw new RuntimeError('RESULT_INVALID', 'Broker answer failed its schema or key check.');
  switch (answer.disposition) {
    case 'completed':
      return { response: { key, outcome: 'recorded', result: answer.value, receivedAt: answer.receivedAt! }, resultRef: answer.resultId!, result: answer.value! };
    case 'pending':
    case 'unknown':
      // Never a fresh billable call: the broker reconciles the same operation and the API schedules a resume.
      return { response: { key, outcome: 'pending' } };
    case 'refused': {
      const timedOut = answer.reason?.code === 'BROKER_TIMEOUT';
      if (command.kind === 'read') return { response: { key, outcome: timedOut ? 'timeout' : 'rejected' } };
      return { response: { key, outcome: timedOut ? 'timeout' : 'refused' } };
    }
  }
}
