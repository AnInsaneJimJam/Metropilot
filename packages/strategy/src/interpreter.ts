import canonicalize from 'canonicalize';
import { checkCheckpointShape } from '@monad-hack/contracts';
import type { RunCheckpoint, Statement, Frame, Amount, Binding, Expression } from '@monad-hack/contracts';
import { assertCompiled, sha256 } from './compile.ts';
import type { CompiledStrategy } from './compile.ts';
import { LanguageError } from './errors.ts';
import { evaluateExpression, timestamp, validateLiteral } from './expression.ts';
import type { BoundValue, RecordType, ValueScope } from './expression.ts';
interface CommandBase { key: string; runId: string; nodeId: string; iterationPath: number[] }
export interface SwapCommand extends CommandBase { kind: 'swap.exactInput'; connectorRef: string; tokenInRef: string; tokenOutRef: string; amount: Amount; maxSlippageBps: number }
export interface NotifyCommand extends CommandBase { kind: 'notify'; message: string; inputs: Record<string, BoundValue> }
export interface ReadCommand extends CommandBase { kind: 'read'; connectorRef: string; operation: string; arguments: Record<string, BoundValue> }
export interface AiCommand extends CommandBase { kind: 'ai.decide'; modelProfileRef: string; prompt: string; inputs: Record<string, BoundValue>; outputSchemaRef: 'decision/1' | 'summary/1'; timeoutSeconds: number; maxOutputTokens: number }
export type HostCommand = SwapCommand | NotifyCommand | ReadCommand | AiCommand;
/**
 * A definitive or pending host result. Reads and AI calls answer `recorded` with `result`: the plain record
 * (`{price: {baseAssetRef, quoteUnit, decimal}, observedAt}`, `{decision, summary}`). Reads also give `receivedAt`.
 * Replays pass the recorded response again; the core never asks for a fresh one.
 */
export interface HostResponse { key: string; outcome: 'pending' | 'settled' | 'rejected' | 'failed' | 'acknowledged' | 'recorded' | 'timeout' | 'refused'; result?: unknown; receivedAt?: string }
export interface AdvanceResult { checkpoint: RunCheckpoint; command?: HostCommand }
const EXPECTED = { 'swap.exactInput': 'settled', notify: 'acknowledged', read: 'recorded', 'ai.decide': 'recorded' } as const;
/** The run identity every host and control plane must use: SHA-256 over the UTF-8 JSON tuple. */
export function runIdentity(deploymentRevision: string, triggerId: string, sourceEventKey: string): Promise<string> {
  return sha256(JSON.stringify([deploymentRevision, triggerId, sourceEventKey]));
}
export async function startRun(program: CompiledStrategy, context: { deploymentRevision: string; triggerId: string; sourceEventKey: string }): Promise<RunCheckpoint> {
  assertCompiled(program);
  if (!program.strategy.triggers.some(t => t.id === context.triggerId) || !context.deploymentRevision || context.deploymentRevision.length > 120 || !context.sourceEventKey || context.sourceEventKey.length > 1024) throw new LanguageError('UNKNOWN_REFERENCE', 'Provide an accepted trigger, deployment revision and bounded source event key.');
  return { schemaVersion: 'strategy-run/2', strategyHash: program.hash, runId: await runIdentity(context.deploymentRevision, context.triggerId, context.sourceEventKey), ...context, frames: [{ ownerId: context.triggerId, branch: 'body', index: 0, iteration: -1 }], steps: 1, intents: 0, aiCalls: 0, activeMillis: 0, bindings: [], status: 'running' };
}
/** Checks a plain host record against its declared type and returns it as typed values. Errors use `code`. */
function recordOf(type: RecordType, raw: unknown, code: string): Record<string, BoundValue> {
  const bad = (detail: string): never => { throw new LanguageError(code, `The recorded result is invalid: ${detail}.`); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('expected a record');
  const extra = Object.keys(raw).find(k => !Object.hasOwn(type, k));
  if (extra) bad(`unexpected field ${extra}`);
  const out: Record<string, BoundValue> = {};
  for (const [name, field] of Object.entries(type)) {
    if (!Object.hasOwn(raw, name)) bad(`missing ${name}`);
    const value = (raw as Record<string, unknown>)[name];
    let typed: BoundValue;
    if (field.valueType === 'Price') {
      const price = value as Record<string, unknown> | null;
      if (price === null || typeof price !== 'object' || Object.keys(price).sort().join() !== 'baseAssetRef,decimal,quoteUnit' || price.baseAssetRef !== field.baseAssetRef || price.quoteUnit !== field.quoteUnit || typeof price.decimal !== 'string') return bad(`${name} must be a ${field.quoteUnit} per ${field.baseAssetRef} price`);
      typed = { kind: 'literal', valueType: 'Price', value: { baseAssetRef: field.baseAssetRef, quoteUnit: field.quoteUnit, decimal: price.decimal } };
    } else if (field.valueType === 'Money') {
      const money = value as Record<string, unknown> | null;
      if (money === null || typeof money !== 'object' || Object.keys(money).sort().join() !== 'assetRef,atomic' || money.assetRef !== field.assetRef || typeof money.atomic !== 'string') return bad(`${name} must be ${field.assetRef} money`);
      typed = { kind: 'literal', valueType: 'Money', value: { assetRef: field.assetRef, atomic: money.atomic } };
    } else if (field.valueType === 'Enum') {
      if (value !== 'allow' && value !== 'skip') return bad(`${name} must be allow or skip`);
      typed = { kind: 'literal', valueType: 'Enum', value };
    } else if (field.valueType === 'Boolean') {
      if (typeof value !== 'boolean') return bad(`${name} must be true or false`);
      typed = { kind: 'literal', valueType: 'Boolean', value };
    } else if (field.valueType === 'Integer') {
      if (typeof value !== 'number') return bad(`${name} must be a whole number`);
      typed = { kind: 'literal', valueType: 'Integer', value };
    } else {
      if (typeof value !== 'string') return bad(`${name} must be text`);
      typed = { kind: 'literal', valueType: field.valueType, value };
    }
    try { validateLiteral(typed); } catch { bad(`${name} is out of range`); }
    out[name] = typed;
  }
  return out;
}
const plain = (record: Readonly<Record<string, BoundValue>>): Record<string, unknown> => Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v.value]));
// Return commands as data. A durable host saves this checkpoint before dispatch and deduplicates key.
export async function advanceRun(program: CompiledStrategy, input: RunCheckpoint, response?: HostResponse, activeMillis = 0): Promise<AdvanceResult> {
  assertCompiled(program);
  if (!checkCheckpointShape(input)) throw new LanguageError('SCHEMA_INVALID', 'Invalid versioned checkpoint.');
  const checkpoint: RunCheckpoint = structuredClone(input);
  const expectedRunId = await runIdentity(checkpoint.deploymentRevision, checkpoint.triggerId, checkpoint.sourceEventKey);
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
  // Lexical scope from the continuation: the recorded results of read/AI nodes already passed in each open body,
  // at that body's iteration path. Popped branches and earlier repeat iterations drop out on their own.
  const visible = (frames: readonly Frame[]): Binding[] => {
    const found: Binding[] = [];
    frames.forEach((frame, depth) => {
      const path = JSON.stringify(frames.slice(0, depth + 1).filter(f => f.iteration >= 0).map(f => f.iteration));
      for (const node of bodyFor(frame).slice(0, frame.index)) {
        const binding = checkpoint.bindings.find(b => b.nodeId === node.id && JSON.stringify(b.iterationPath) === path);
        if (binding) found.push(binding);
      }
    });
    return found;
  };
  const scopeOf = (frames: readonly Frame[]): ValueScope => {
    const bindings = visible(frames);
    return name => bindings.find(b => b.name === name)?.value as Readonly<Record<string, BoundValue>> | undefined;
  };
  for (const binding of checkpoint.bindings) {
    const node = nodes.get(binding.nodeId); const spec = program.bindings[binding.nodeId];
    if (!node || !spec || (node.type !== 'read' && node.type !== 'ai.decide') || node.bind !== binding.name) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint binding does not match a read or AI node.');
    const value = binding.value as Record<string, BoundValue>;
    let restored: Record<string, BoundValue>;
    try { restored = recordOf(spec.result, plain(value), 'SCHEMA_INVALID'); } catch { throw new LanguageError('SCHEMA_INVALID', 'Checkpoint binding value does not match its declared type.'); }
    if (canonicalize(restored) !== canonicalize(value)) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint binding value does not match its declared type.');
  }
  for (let i = 0; i < checkpoint.frames.length; i++) {
    const frame = checkpoint.frames[i]!; const body = bodyFor(frame);
    if (frame.index > body.length) throw new LanguageError('SCHEMA_INVALID', 'Continuation index is out of bounds.');
    if (i === 0 && frame.ownerId !== trigger.id) throw new LanguageError('SCHEMA_INVALID', 'Continuation must start at its trigger.');
    if (i > 0) {
      const parent = checkpoint.frames[i - 1]!;
      const owner = bodyFor(parent)[parent.index - 1];
      if (owner?.id !== frame.ownerId) throw new LanguageError('SCHEMA_INVALID', 'Continuation is not a legal nested path.');
      if (owner.type === 'if') {
        const condition = evaluateExpression(owner.condition, undefined, scopeOf(checkpoint.frames.slice(0, i)));
        if (condition.valueType !== 'Boolean' || frame.branch !== (condition.value ? 'then' : 'else')) throw new LanguageError('SCHEMA_INVALID', 'Continuation branch disagrees with the authored condition.');
      }
    }
  }
  if (visible(checkpoint.frames).length !== checkpoint.bindings.length) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint bindings are not all in scope.');
  if ((checkpoint.status === 'waiting') !== Boolean(checkpoint.waiting) || (['completed','failed'].includes(checkpoint.status) && checkpoint.frames.length !== 0) || (['running','waiting'].includes(checkpoint.status) && checkpoint.frames.length === 0)) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint state and continuation disagree.');
  if (checkpoint.steps > program.strategy.limits.maxStepsPerRun || checkpoint.intents > program.strategy.limits.maxIntentsPerRun || checkpoint.aiCalls > program.strategy.limits.maxAiCallsPerRun || Boolean(checkpoint.error) !== (checkpoint.status === 'failed')) throw new LanguageError('SCHEMA_INVALID', 'Checkpoint counters/error state are invalid.');
  if (!Number.isSafeInteger(activeMillis) || activeMillis < 0) throw new LanguageError('LIMIT_EXCEEDED', 'Supply nonnegative measured active milliseconds.');
  // Every returned checkpoint keeps only the bindings still in scope, so it stays small and restorable.
  const done = (result: AdvanceResult): AdvanceResult => { result.checkpoint.bindings = visible(result.checkpoint.frames); return result; };
  const fail = (error: LanguageError, nodeId = trigger.id): AdvanceResult => {
    checkpoint.status = 'failed'; checkpoint.frames = []; delete checkpoint.waiting;
    checkpoint.error = { code: error.code, message: error.message, nodeId: error.nodeId ?? nodeId }; return done({ checkpoint });
  };
  const step = (): void => {
    if (checkpoint.steps >= program.strategy.limits.maxStepsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Run step limit reached.');
    checkpoint.steps++;
  };
  const evaluateAll = (exprs: Record<string, Expression>, scope: ValueScope, visit?: () => void): Record<string, BoundValue> =>
    Object.fromEntries(Object.entries(exprs).map(([name, expr]) => [name, evaluateExpression(expr, visit, scope)]));
  const commandFor = (node: Statement, iterationPath: number[], key: string, scope: ValueScope): HostCommand => {
    const common = { key, runId: checkpoint.runId, nodeId: node.id, iterationPath };
    if (node.type === 'swap.exactInput') return { kind: 'swap.exactInput', ...common, connectorRef: node.connectorRef, tokenInRef: node.tokenInRef, tokenOutRef: node.tokenOutRef, amount: structuredClone(node.amount), maxSlippageBps: node.maxSlippageBps };
    if (node.type === 'notify') return { kind: 'notify', ...common, message: node.message, inputs: evaluateAll(node.inputs, scope) };
    if (node.type === 'read') return { kind: 'read', ...common, connectorRef: node.connectorRef, operation: node.operation, arguments: evaluateAll(node.arguments, scope) };
    if (node.type === 'ai.decide') return { kind: 'ai.decide', ...common, modelProfileRef: node.modelProfileRef, prompt: node.prompt, inputs: evaluateAll(node.inputs, scope), outputSchemaRef: node.outputSchemaRef, timeoutSeconds: node.timeoutSeconds, maxOutputTokens: node.maxOutputTokens };
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
    const command = commandFor(node, path, key, scopeOf(checkpoint.frames));
    if (response && response.key !== key) throw new LanguageError('SCHEMA_INVALID', 'Response key does not match pending operation.');
    if (!response || response.outcome === 'pending') return done({ checkpoint, command });
    const { outcome } = response;
    // Fail closed: a missing read never becomes a default value, and a failed AI call never falls through to a trade.
    if (node.type === 'read' && (outcome === 'failed' || outcome === 'rejected' || outcome === 'timeout')) return fail(new LanguageError('STALE_DATA', `The read ${outcome === 'timeout' ? 'timed out' : 'returned no data'}, so the run stops.`, node.id));
    if (node.type === 'ai.decide' && (outcome === 'timeout' || outcome === 'refused')) return fail(new LanguageError('MODEL_OUTPUT_INVALID', `The AI call ${outcome === 'timeout' ? 'timed out' : 'was refused'}; the run stops without trading.`, node.id));
    if (node.type === 'ai.decide' && (outcome === 'failed' || outcome === 'rejected')) return fail(new LanguageError('MODEL_UNAVAILABLE', 'The AI call failed or was not admitted; the run stops without trading.', node.id));
    if (outcome === 'failed' || outcome === 'rejected') return fail(new LanguageError('POLICY_DENIED', 'Host operation failed or was rejected.', node.id));
    if (outcome !== EXPECTED[waiting.kind]) throw new LanguageError('SCHEMA_INVALID', 'Response outcome is incompatible with the host command.');
    if (node.type === 'read' || node.type === 'ai.decide') {
      const spec = program.bindings[node.id]!;
      try {
        const value = recordOf(spec.result, response.result, node.type === 'read' ? 'STALE_DATA' : 'MODEL_OUTPUT_INVALID');
        if (node.type === 'read') {
          if (!response.receivedAt) throw new LanguageError('SCHEMA_INVALID', 'A recorded read needs its receivedAt time.');
          const received = timestamp(response.receivedAt); const observedAt = value.observedAt;
          const observed = observedAt?.valueType === 'Timestamp' ? timestamp(observedAt.value) : received;
          if (observed > received) throw new LanguageError('STALE_DATA', 'Future-dated read is not accepted, so the run stops.');
          if (spec.maxAgeSeconds !== undefined && received - observed > spec.maxAgeSeconds * 1000) throw new LanguageError('STALE_DATA', `The read is older than ${spec.maxAgeSeconds} s, so the run stops.`);
        }
        checkpoint.bindings.push({ nodeId: node.id, iterationPath: path, name: node.bind, value });
      } catch (error) {
        if (error instanceof LanguageError && error.code !== 'SCHEMA_INVALID') return fail(new LanguageError(error.code, error.message, node.id));
        throw error;
      }
    }
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
        const value = evaluateExpression(node.condition, step, scopeOf(checkpoint.frames));
        if (value.valueType !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'if needs Boolean.');
        checkpoint.frames.push({ ownerId: node.id, branch: value.value ? 'then' : 'else', index: 0, iteration: -1 });
      } else if (node.type === 'repeat') {
        step(); checkpoint.frames.push({ ownerId: node.id, branch: 'body', index: 0, iteration: 0 });
      } else if (node.type === 'stop') { checkpoint.frames = []; }
      else {
        const path = checkpoint.frames.filter(f => f.iteration >= 0).map(f => f.iteration); const key = JSON.stringify([checkpoint.runId, node.id, path]);
        const scope = scopeOf(checkpoint.frames);
        if (node.type === 'swap.exactInput') {
          if (checkpoint.intents >= program.strategy.limits.maxIntentsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Intent limit reached.');
          checkpoint.intents++;
        } else {
          if (node.type === 'ai.decide') {
            if (checkpoint.aiCalls >= program.strategy.limits.maxAiCallsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'AI call limit reached.');
            checkpoint.aiCalls++;
          }
          evaluateAll(node.type === 'read' ? node.arguments : node.inputs, scope, step);
        }
        const command = commandFor(node, path, key, scope);
        checkpoint.waiting = { kind: command.kind, nodeId: node.id, iterationPath: path, key }; checkpoint.status = 'waiting';
        return done({ checkpoint, command });
      }
    }
    checkpoint.status = 'completed'; return done({ checkpoint });
  } catch (error) {
    if (error instanceof LanguageError) return fail(error, currentNodeId);
    throw error;
  }
}
