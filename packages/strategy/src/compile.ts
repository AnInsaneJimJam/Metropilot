import canonicalize from 'canonicalize';
import { checkStrategyShape } from '@monad-hack/contracts';
import type { Strategy, Expression, Statement } from '@monad-hack/contracts';
import { parseSource } from './json.ts';
import { LanguageError } from './errors.ts';
import { atomic, decimal, expressionType, fieldUnit, timestamp, unit } from './expression.ts';
import type { FieldType, RecordType } from './expression.ts';
export interface Catalog {
  // Block cadence per network: rehearsal and event ingestion read it here instead of hard-coding it.
  readonly networks: Readonly<Record<string, { readonly blockMillis: number; readonly finalityBlocks: number }>>;
  readonly assets: Readonly<Record<string, { readonly networkRef: string; readonly mode: 'paper' | 'live'; readonly decimals: number; readonly native?: true }>>;
  readonly feeds: Readonly<Record<string, { readonly baseAssetRef: string; readonly quoteUnit: string; readonly source: 'poolTwap' | 'poolEma' | 'nativeOracle'; readonly connectorRef: string; readonly windowSeconds: number; readonly finality: 'finalized' }>>;
  readonly connectors: Readonly<Record<string, { readonly networkRef: string; readonly mode: 'paper' | 'live'; readonly version: string; readonly venue: 'uniswap-v3' | 'kuru' | 'curve' | 'aave'; readonly actions: readonly string[] }>>;
  /** Allowlisted reads per connector and operation: typed arguments, the record they bind and how old its data may be. */
  readonly reads: Readonly<Record<string, Readonly<Record<string, { readonly arguments: RecordType; readonly result: RecordType; readonly maxAgeSeconds: number }>>>>;
  /** Model profiles an ai.decide block may name; the broker resolves provider credentials at deployment, never here. */
  readonly modelProfiles: Readonly<Record<string, { readonly mode: 'paper' | 'live'; readonly provider: string; readonly modelId: string; readonly maxTimeoutSeconds: number; readonly maxOutputTokens: number }>>;
}
/** The v1 AI output schemas (§6). A decision is used only through an explicit if block. */
export const OUTPUT_SCHEMAS: Readonly<Record<'decision/1' | 'summary/1', RecordType>> = {
  'decision/1': { decision: { valueType: 'Enum' }, summary: { valueType: 'Text' } },
  'summary/1': { summary: { valueType: 'Text' } },
};
export interface Bounds { steps: number; intents: number; aiCalls: number }
/** What a read or ai.decide node binds: its name, the record type and, for reads, the freshness limit. */
export interface BindingSpec { readonly name: string; readonly result: RecordType; readonly maxAgeSeconds?: number }
export interface CompiledStrategy { readonly strategy: Strategy; readonly canonicalJson: string; readonly hash: string; readonly bounds: Readonly<Bounds>; readonly bindings: Readonly<Record<string, BindingSpec>> }
const compiled = new WeakSet<object>();
export function assertCompiled(program: CompiledStrategy): void {
  if (!compiled.has(program)) throw new LanguageError('SCHEMA_INVALID', 'Compile and validate the strategy before execution.');
}
export async function sha256(text: string): Promise<string> {
  return '0x' + Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export async function compileStrategy(source: string, catalog: Catalog): Promise<CompiledStrategy> {
  const raw = parseSource(source);
  const shape = checkStrategyShape(raw);
  if (!shape.valid) {
    let cursor: unknown = raw; let nodeId: string | undefined;
    for (const part of ['', ...shape.path.split('/').slice(1)]) {
      if (part && cursor !== null && typeof cursor === 'object') cursor = (cursor as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (cursor !== null && typeof cursor === 'object' && Object.hasOwn(cursor, 'id') && typeof (cursor as { id: unknown }).id === 'string') nodeId = (cursor as { id: string }).id;
    }
    throw new LanguageError('SCHEMA_INVALID', shape.message, nodeId, shape.path);
  }
  const strategy = shape.strategy;
  const ids = new Set<string>([strategy.id]); let nodes = 0;
  const count = (depth: number): void => { if (++nodes > 100 || depth > 12) throw new LanguageError('LIMIT_EXCEEDED', 'Reduce strategy nodes (100) or depth (12).'); };
  const identify = (id: string): void => { if (ids.has(id)) throw new LanguageError('SCHEMA_INVALID', 'Each strategy/trigger/statement ID must be unique.', id); ids.add(id); };
  function lookup<T>(table: Readonly<Record<string, T>>, key: string): T {
    if (!Object.hasOwn(table, key)) throw new LanguageError('UNKNOWN_REFERENCE', `Select a known catalog reference: ${key}.`);
    return table[key]!;
  }
  const asset = (ref: string) => lookup(catalog.assets, ref);
  const bindings: Record<string, BindingSpec> = {};
  // Scopes are immutable maps: a binding is visible to later statements of its body and their children only.
  type Scope = ReadonlyMap<string, RecordType>;
  const bind = (scope: Scope, nodeId: string, spec: BindingSpec): Scope => {
    if (scope.has(spec.name)) throw new LanguageError('SCHEMA_INVALID', `The name ${spec.name} is already in use here; choose another name.`, nodeId, `/nodes/${nodeId}/bind`);
    bindings[nodeId] = structuredClone(spec);
    return new Map(scope).set(spec.name, spec.result);
  };
  const typed = (e: Expression, expected: FieldType, scope: Scope): void => {
    if (unit(e, name => scope.get(name)) !== fieldUnit(expected)) throw new LanguageError('TYPE_MISMATCH', `Argument must be ${expected.valueType}${expected.valueType === 'Price' ? ` in ${expected.quoteUnit} per ${expected.baseAssetRef}` : expected.valueType === 'Money' ? ` of ${expected.assetRef}` : ''}.`);
  };
  const expression = (e: Expression, depth: number, scope: Scope): number => {
    count(depth); expressionType(e, name => scope.get(name));
    if (e.kind === 'literal') {
      if (e.valueType === 'Money') asset(e.value.assetRef);
      if (e.valueType === 'Price') asset(e.value.baseAssetRef);
      return 1;
    }
    if (e.kind === 'logical') return 1 + e.operands.reduce((n, child) => n + expression(child, depth + 1, scope), 0);
    if (e.kind === 'compare' || e.kind === 'arithmetic') return 1 + expression(e.left, depth + 1, scope) + expression(e.right, depth + 1, scope);
    return 1; // expressionType above rejects refs/fields that are not in scope
  };
  const sequence = (body: Statement[], depth: number, repeats: number, outer: Scope): Bounds => {
    const total: Bounds = { steps: 0, intents: 0, aiCalls: 0 };
    let scope = outer;
    for (const node of body) {
      try {
        count(depth); identify(node.id);
        let bound: Bounds = { steps: 1, intents: 0, aiCalls: 0 };
        switch (node.type) {
          case 'if': {
            if (expressionType(node.condition, name => scope.get(name)) !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'if needs a Boolean condition.');
            bound.steps += expression(node.condition, depth + 1, scope);
            // Branch bindings do not escape: each branch starts from this scope and its additions are dropped.
            const a = sequence(node.then, depth + 1, repeats, scope); const b = sequence(node.else, depth + 1, repeats, scope);
            bound.steps += Math.max(a.steps, b.steps); bound.intents = Math.max(a.intents, b.intents); bound.aiCalls = Math.max(a.aiCalls, b.aiCalls); break;
          }
          case 'repeat': {
            if (repeats >= 2) throw new LanguageError('LIMIT_EXCEEDED', 'At most two nested repeats.');
            const inner = sequence(node.body, depth + 1, repeats + 1, scope); // repeat-local bindings reset each iteration
            bound.steps += node.count * (1 + inner.steps); bound.intents = node.count * inner.intents; bound.aiCalls = node.count * inner.aiCalls; break;
          }
          case 'read': {
            const connector = lookup(catalog.connectors, node.connectorRef);
            const reads = Object.hasOwn(catalog.reads, node.connectorRef) ? catalog.reads[node.connectorRef]! : {};
            if (!connector.actions.includes(node.operation) || !Object.hasOwn(reads, node.operation)) throw new LanguageError('UNSUPPORTED_CAPABILITY', `Connector ${node.connectorRef} has no allowlisted read ${node.operation}.`);
            const spec = reads[node.operation]!;
            const names = Object.keys(node.arguments); const expected = Object.keys(spec.arguments);
            const unexpected = names.find(n => !Object.hasOwn(spec.arguments, n)); const missing = expected.find(n => !Object.hasOwn(node.arguments, n));
            if (unexpected || missing) throw new LanguageError('SCHEMA_INVALID', unexpected ? `Read ${node.operation} takes no argument ${unexpected}.` : `Read ${node.operation} needs argument ${missing}.`, node.id, `/nodes/${node.id}/arguments`);
            for (const name of names) { typed(node.arguments[name]!, spec.arguments[name]!, scope); bound.steps += expression(node.arguments[name]!, depth + 1, scope); }
            scope = bind(scope, node.id, { name: node.bind, result: spec.result, maxAgeSeconds: spec.maxAgeSeconds }); break;
          }
          case 'ai.decide': {
            const profile = lookup(catalog.modelProfiles, node.modelProfileRef);
            if (node.timeoutSeconds > profile.maxTimeoutSeconds || node.maxOutputTokens > profile.maxOutputTokens) throw new LanguageError('LIMIT_EXCEEDED', `Model ${node.modelProfileRef} allows at most ${profile.maxTimeoutSeconds} s and ${profile.maxOutputTokens} output tokens.`);
            for (const e of Object.values(node.inputs)) bound.steps += expression(e, depth + 1, scope);
            bound.aiCalls = 1;
            scope = bind(scope, node.id, { name: node.bind, result: OUTPUT_SCHEMAS[node.outputSchemaRef] }); break;
          }
          case 'swap.exactInput': {
            const connector = lookup(catalog.connectors, node.connectorRef);
            const a = asset(node.tokenInRef); const b = asset(node.tokenOutRef);
            if (!connector.actions.includes('swap.exactInput')) throw new LanguageError('UNSUPPORTED_CAPABILITY', 'Connector does not support exact-input swaps.');
            if (node.tokenInRef === node.tokenOutRef || a.networkRef !== b.networkRef || a.mode !== b.mode || connector.networkRef !== a.networkRef || connector.mode !== a.mode) throw new LanguageError('TYPE_MISMATCH', 'Swap assets and connector must share network/mode and have distinct assets.');
            if (node.amount.kind === 'fixed' && atomic(node.amount.atomic) === 0n) throw new LanguageError('INVALID_AMOUNT', 'Swap amount must be positive.');
            if (a.native && node.amount.kind === 'positionBps' && node.amount.bps === 10000) throw new LanguageError('POLICY_DENIED', 'Keep some native MON for gas; sell less than 100%.');
            bound.intents = 1; break;
          }
          case 'notify': for (const e of Object.values(node.inputs)) bound.steps += expression(e, depth + 1, scope); break;
          case 'stop': break;
        }
        total.steps += bound.steps; total.intents += bound.intents; total.aiCalls += bound.aiCalls;
      } catch (error) {
        if (error instanceof LanguageError) throw new LanguageError(error.code, error.message, error.nodeId ?? node.id, error.fieldPath || `/nodes/${node.id}`);
        throw error;
      }
    }
    return total;
  };
  const bounds: Bounds = { steps: 0, intents: 0, aiCalls: 0 };
  for (const trigger of strategy.triggers) {
    count(1); identify(trigger.id);
    if (trigger.body.length === 0) throw new LanguageError('SCHEMA_INVALID', 'Add at least one action to the trigger body.', trigger.id, `/nodes/${trigger.id}/body`);
    if (trigger.type === 'connector.event') throw new LanguageError('UNSUPPORTED_CAPABILITY', 'Connector events require the next catalog/host milestone.', trigger.id);
    if (trigger.type === 'schedule') timestamp(trigger.anchorAt);
    else {
      const feed = lookup(catalog.feeds, trigger.feedRef); asset(trigger.threshold.baseAssetRef);
      if (feed.baseAssetRef !== trigger.threshold.baseAssetRef || feed.quoteUnit !== trigger.threshold.quoteUnit || decimal(trigger.threshold.decimal) <= 0n) throw new LanguageError('TYPE_MISMATCH', 'Threshold must be positive and match the feed units.', trigger.id);
    }
    const b = sequence(trigger.body, 2, 0, new Map()); b.steps += 1; // trigger dispatch
    bounds.steps = Math.max(bounds.steps, b.steps); bounds.intents = Math.max(bounds.intents, b.intents); bounds.aiCalls = Math.max(bounds.aiCalls, b.aiCalls);
  }
  if (bounds.steps > strategy.limits.maxStepsPerRun || bounds.intents > strategy.limits.maxIntentsPerRun || bounds.aiCalls > strategy.limits.maxAiCallsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Worst-case execution exceeds the strategy limits.');
  const canonicalJson = canonicalize(strategy);
  if (!canonicalJson) throw new LanguageError('SCHEMA_INVALID', 'Cannot canonicalize strategy.');
  const result = freeze({ strategy, canonicalJson, hash: await sha256(canonicalJson), bounds, bindings });
  compiled.add(result); return result;
}
export const syntheticCatalog: Catalog = freeze({
  // Monad: 300 ms minimum block time, finalized 2 blocks later (docs.monad.xyz MonadBFT page, rechecked 2026-10-03).
  networks: { 'paper-monad': { blockMillis: 300, finalityBlocks: 2 } },
  assets: {
    'paper.MON': { networkRef: 'paper-monad', mode: 'paper', decimals: 18, native: true },
    'paper.WETH': { networkRef: 'paper-monad', mode: 'paper', decimals: 18 },
    'paper.USD': { networkRef: 'paper-monad', mode: 'paper', decimals: 6 },
  },
  feeds: {
    'paper.weth-usd': { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', source: 'poolTwap', connectorRef: 'paper.uniswap', windowSeconds: 30, finality: 'finalized' },
    'paper.weth-usd-kuru': { baseAssetRef: 'paper.WETH', quoteUnit: 'USD', source: 'poolTwap', connectorRef: 'paper.kuru', windowSeconds: 30, finality: 'finalized' },
  },
  connectors: {
    'paper.uniswap': { networkRef: 'paper-monad', mode: 'paper', version: 'paper-uniswap-v3/1', venue: 'uniswap-v3', actions: ['swap.exactInput', 'price.read'] },
    'paper.kuru': { networkRef: 'paper-monad', mode: 'paper', version: 'paper-kuru/1', venue: 'kuru', actions: ['swap.exactInput', 'price.read'] },
  },
  // price.read returns the venue's 30 s pool TWAP over finalized blocks, like the feeds, and when it was observed.
  reads: {
    'paper.uniswap': { 'price.read': { arguments: {}, result: { price: { valueType: 'Price', baseAssetRef: 'paper.WETH', quoteUnit: 'USD' }, observedAt: { valueType: 'Timestamp' } }, maxAgeSeconds: 30 } },
    'paper.kuru': { 'price.read': { arguments: {}, result: { price: { valueType: 'Price', baseAssetRef: 'paper.WETH', quoteUnit: 'USD' }, observedAt: { valueType: 'Timestamp' } }, maxAgeSeconds: 30 } },
  },
  // Synthetic profile: no provider, no credentials. Rehearsal answers it from a script.
  modelProfiles: {
    'paper.kimi': { mode: 'paper', provider: 'synthetic', modelId: 'kimi-synthetic', maxTimeoutSeconds: 30, maxOutputTokens: 1024 },
  },
} satisfies Catalog);
