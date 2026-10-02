import { checkCheckpointShape } from '@monad-hack/contracts';
import type { RunCheckpoint, Statement, Frame, Amount } from '@monad-hack/contracts';
import { assertCompiled, sha256 } from './compile.ts';
import type { CompiledStrategy } from './compile.ts';
import { LanguageError } from './errors.ts';
import { evaluateExpression } from './expression.ts';
import type { Value } from './expression.ts';
export interface SwapCommand { kind: 'swap.exactInput'; key: string; runId: string; nodeId: string; iterationPath: number[]; connectorRef: string; tokenInRef: string; tokenOutRef: string; amount: Amount; maxSlippageBps: number }
export interface NotifyCommand { kind: 'notify'; key: string; runId: string; nodeId: string; iterationPath: number[]; message: string; inputs: Record<string, Value> }
export type HostCommand = SwapCommand | NotifyCommand;
export interface HostResponse { key: string; outcome: 'pending' | 'settled' | 'rejected' | 'failed' | 'acknowledged' }
export interface AdvanceResult { checkpoint: RunCheckpoint; command?: HostCommand }
export async function startRun(program: CompiledStrategy, context: { deploymentRevision: string; triggerId: string; sourceEventKey: string }): Promise<RunCheckpoint> {
  assertCompiled(program);
  if (!program.strategy.triggers.some(t => t.id === context.triggerId) || !context.deploymentRevision || context.deploymentRevision.length > 120 || !context.sourceEventKey || context.sourceEventKey.length > 1024) throw new LanguageError('UNKNOWN_REFERENCE', 'Provide an accepted trigger, deployment revision and bounded source event key.');
  return { schemaVersion: 'strategy-run/1', strategyHash: program.hash, runId: await sha256(JSON.stringify([context.deploymentRevision, context.triggerId, context.sourceEventKey])), ...context, frames: [{ ownerId: context.triggerId, branch: 'body', index: 0, iteration: -1 }], steps: 1, intents: 0, activeMillis: 0, status: 'running' };
}
// Return commands as data. A durable host saves this checkpoint before dispatch and deduplicates key.
export async function advanceRun(program: CompiledStrategy, input: RunCheckpoint, response?: HostResponse, activeMillis = 0): Promise<AdvanceResult> {
  assertCompiled(program);
  if (!checkCheckpointShape(input)) throw new LanguageError('SCHEMA_INVALID', 'Invalid versioned checkpoint.');
  const checkpoint: RunCheckpoint = structuredClone(input);
  const expectedRunId = await sha256(JSON.stringify([checkpoint.deploymentRevision, checkpoint.triggerId, checkpoint.sourceEventKey]));
  if (checkpoint.strategyHash !== program.hash || checkpoint.runId !== expectedRunId) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint does not match this strategy/run.');
  const nodes = new Map<string, Statement>();
  const collect = (body: Statement[]): void => { for (const n of body) { nodes.set(n.id, n); if (n.type === 'if') { collect(n.then); collect(n.else); } else if (n.type === 'repeat') collect(n.body); } };
  const trigger = program.strategy.triggers.find(t => t.id === checkpoint.triggerId);
  if (!trigger) throw new LanguageError('UNKNOWN_REFERENCE', 'Checkpoint trigger is unavailable.');
  collect(trigger.body);
  const bodyFor = (frame: Frame): Statement[] => {
    if (frame.ownerId === trigger.id && frame.branch === 'body' && frame.iteration === -1) return trigger.body;
    const owner = nodes.get(frame.ownerId);
    if (owner?.type === 'if' && frame.branch !== 'body' && frame.iteration === -1) return owner[frame.branch];
    if (owner?.type === 'repeat' && frame.branch === 'body' && frame.iteration >= 0 && frame.iteration < owner.count) return owner.body;
    throw new LanguageError('SCHEMA_INVALID', 'Invalid continuation frame.');
  };
  for (let i = 0; i < checkpoint.frames.length; i++) {
    const frame = checkpoint.frames[i]!; const body = bodyFor(frame);
    if (frame.index > body.length) throw new LanguageError('SCHEMA_INVALID', 'Continuation index is out of bounds.');
    if (i === 0 && frame.ownerId !== trigger.id) throw new LanguageError('SCHEMA_INVALID', 'Continuation must start at its trigger.');
    if (i > 0) {
      const parent = checkpoint.frames[i - 1]!;
      const owner = bodyFor(parent)[parent.index - 1];
      if (owner?.id !== frame.ownerId) throw new LanguageError('SCHEMA_INVALID', 'Continuation is not a legal nested path.');
      if (owner.type === 'if') {
        const condition = evaluateExpression(owner.condition);
        if (condition.valueType !== 'Boolean' || frame.branch !== (condition.value ? 'then' : 'else')) throw new LanguageError('SCHEMA_INVALID', 'Continuation branch disagrees with the authored condition.');
      }
    }
  }
  if ((checkpoint.status === 'waiting') !== Boolean(checkpoint.waiting) || (['completed','failed'].includes(checkpoint.status) && checkpoint.frames.length !== 0) || (['running','waiting'].includes(checkpoint.status) && checkpoint.frames.length === 0)) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint state and continuation disagree.');
  if (checkpoint.steps > program.strategy.limits.maxStepsPerRun || checkpoint.intents > program.strategy.limits.maxIntentsPerRun || Boolean(checkpoint.error) !== (checkpoint.status === 'failed')) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint counters/error state are invalid.');
  if (!Number.isSafeInteger(activeMillis) || activeMillis < 0) throw new LanguageError('LIMIT_EXCEEDED', 'Supply nonnegative measured active milliseconds.');
  const fail = (error: LanguageError, nodeId = trigger.id): AdvanceResult => {
    checkpoint.status = 'failed'; checkpoint.frames = []; delete checkpoint.waiting;
    checkpoint.error = { code: error.code, message: error.message, nodeId: error.nodeId ?? nodeId }; return { checkpoint };
  };
  const step = (): void => {
    if (checkpoint.steps >= program.strategy.limits.maxStepsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Run step limit reached.');
    checkpoint.steps++;
  };
  const commandFor = (node: Statement, iterationPath: number[], key: string): HostCommand => {
    const common = { key, runId: checkpoint.runId, nodeId: node.id, iterationPath };
    if (node.type === 'swap.exactInput') return { kind: 'swap.exactInput', ...common, connectorRef: node.connectorRef, tokenInRef: node.tokenInRef, tokenOutRef: node.tokenOutRef, amount: structuredClone(node.amount), maxSlippageBps: node.maxSlippageBps };
    if (node.type === 'notify') return { kind: 'notify', ...common, message: node.message, inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, expr]) => [name, evaluateExpression(expr)])) };
    throw new LanguageError('SCHEMA_INVALID', 'Waiting node is not a host operation.');
  };
  if (checkpoint.status === 'completed' || checkpoint.status === 'failed') {
    if (response) throw new LanguageError('SCHEMA_INVALID', 'Terminal runs cannot accept responses.');
    return { checkpoint };
  }
  if (activeMillis > program.strategy.limits.maxActiveSecondsPerRun * 1000 - checkpoint.activeMillis) return fail(new LanguageError('LIMIT_EXCEEDED', 'Active execution time exceeded.'));
  checkpoint.activeMillis += activeMillis;
  if (checkpoint.waiting) {
    const waiting = checkpoint.waiting; const frame = checkpoint.frames.at(-1)!;
    const node = bodyFor(frame)[frame.index - 1]; const path = checkpoint.frames.filter(f => f.iteration >= 0).map(f => f.iteration);
    const key = JSON.stringify([checkpoint.runId, waiting.nodeId, path]);
    if (!node || node.id !== waiting.nodeId || node.type !== waiting.kind || key !== waiting.key || JSON.stringify(path) !== JSON.stringify(waiting.iterationPath)) throw new LanguageError('SCHEMA_INVALID', 'Waiting command does not match its continuation.');
    const command = commandFor(node, path, key);
    if (response && response.key !== key) throw new LanguageError('SCHEMA_INVALID', 'Response key does not match pending operation.');
    if (!response || response.outcome === 'pending') return { checkpoint, command };
    if (response.outcome === 'failed' || response.outcome === 'rejected') return fail(new LanguageError('POLICY_DENIED', 'Host operation failed or was rejected.', node.id));
    if ((waiting.kind === 'swap.exactInput' && response.outcome !== 'settled') || (waiting.kind === 'notify' && response.outcome !== 'acknowledged')) throw new LanguageError('SCHEMA_INVALID', 'Response outcome is incompatible with the host command.');
    delete checkpoint.waiting; checkpoint.status = 'running';
  } else if (response) throw new LanguageError('SCHEMA_INVALID', 'Run is not waiting for a response.');
  let currentNodeId = trigger.id;
  try {
    while (checkpoint.frames.length) {
      const frame = checkpoint.frames.at(-1)!; const body = bodyFor(frame);
      if (frame.index === body.length) {
        const owner = nodes.get(frame.ownerId);
        if (owner?.type === 'repeat' && frame.iteration + 1 < owner.count) { step(); frame.iteration++; frame.index = 0; }
        else checkpoint.frames.pop();
        continue;
      }
      const node = body[frame.index++]!; currentNodeId = node.id; step();
      if (node.type === 'if') {
        const value = evaluateExpression(node.condition, step);
        if (value.valueType !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'if needs Boolean.');
        checkpoint.frames.push({ ownerId: node.id, branch: value.value ? 'then' : 'else', index: 0, iteration: -1 });
      } else if (node.type === 'repeat') {
        step(); checkpoint.frames.push({ ownerId: node.id, branch: 'body', index: 0, iteration: 0 });
      } else if (node.type === 'stop') { checkpoint.frames = []; }
      else if (node.type === 'notify' || node.type === 'swap.exactInput') {
        const path = checkpoint.frames.filter(f => f.iteration >= 0).map(f => f.iteration); const key = JSON.stringify([checkpoint.runId, node.id, path]);
        if (node.type === 'notify') for (const expr of Object.values(node.inputs)) evaluateExpression(expr, step);
        else {
          if (checkpoint.intents >= program.strategy.limits.maxIntentsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Intent limit reached.');
          checkpoint.intents++;
        }
        const command = commandFor(node, path, key);
        checkpoint.waiting = { kind: command.kind, nodeId: node.id, iterationPath: path, key }; checkpoint.status = 'waiting';
        return { checkpoint, command };
      } else throw new LanguageError('UNSUPPORTED_CAPABILITY', 'Host capability is unavailable.');
    }
    checkpoint.status = 'completed'; return { checkpoint };
  } catch (error) {
    if (error instanceof LanguageError) return fail(error, currentNodeId);
    throw error;
  }
}
