import canonicalize from 'canonicalize';
import { checkStrategyShape } from '@monad-hack/contracts';
import type { Strategy, Expression, Statement } from '@monad-hack/contracts';
import { parseSource } from './json.ts';
import { LanguageError } from './errors.ts';
import { atomic, decimal, expressionType, timestamp } from './expression.ts';
export interface Catalog {
  readonly assets: Readonly<Record<string, { readonly networkRef: string; readonly mode: 'paper' | 'live'; readonly decimals: number; readonly native?: true }>>;
  readonly feeds: Readonly<Record<string, { readonly baseAssetRef: string; readonly quoteUnit: string; readonly source: 'poolTwap'; readonly connectorRef: string; readonly windowSeconds: number; readonly finality: 'finalized' }>>;
  readonly connectors: Readonly<Record<string, { readonly networkRef: string; readonly mode: 'paper' | 'live'; readonly version: string; readonly venue: 'uniswap-v3' | 'kuru'; readonly actions: readonly string[] }>>;
}
export interface Bounds { steps: number; intents: number; aiCalls: number }
export interface CompiledStrategy { readonly strategy: Strategy; readonly canonicalJson: string; readonly hash: string; readonly bounds: Readonly<Bounds> }
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
  const expression = (e: Expression, depth: number): number => {
    count(depth); expressionType(e);
    if (e.kind === 'literal') {
      if (e.valueType === 'Money') asset(e.value.assetRef);
      if (e.valueType === 'Price') asset(e.value.baseAssetRef);
      return 1;
    }
    if (e.kind === 'logical') return 1 + e.operands.reduce((n, child) => n + expression(child, depth + 1), 0);
    if (e.kind === 'compare' || e.kind === 'arithmetic') return 1 + expression(e.left, depth + 1) + expression(e.right, depth + 1);
    return 1; // resolver above rejects unbound refs/fields
  };
  const sequence = (body: Statement[], depth: number, repeats: number): Bounds => {
    const total: Bounds = { steps: 0, intents: 0, aiCalls: 0 };
    for (const node of body) {
      try {
        count(depth); identify(node.id);
        let bound: Bounds = { steps: 1, intents: 0, aiCalls: 0 };
        switch (node.type) {
          case 'if': {
            if (expressionType(node.condition) !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'if needs a Boolean condition.');
            bound.steps += expression(node.condition, depth + 1);
            const a = sequence(node.then, depth + 1, repeats); const b = sequence(node.else, depth + 1, repeats);
            bound.steps += Math.max(a.steps, b.steps); bound.intents = Math.max(a.intents, b.intents); break;
          }
          case 'repeat': {
            if (repeats >= 2) throw new LanguageError('LIMIT_EXCEEDED', 'At most two nested repeats.');
            const inner = sequence(node.body, depth + 1, repeats + 1);
            bound.steps += node.count * (1 + inner.steps); bound.intents = node.count * inner.intents; break;
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
          case 'notify': for (const e of Object.values(node.inputs)) bound.steps += expression(e, depth + 1); break;
          case 'stop': break;
          default: throw new LanguageError('UNSUPPORTED_CAPABILITY', `${node.type} requires the next catalog/host milestone; it is not executable yet.`);
        }
        total.steps += bound.steps; total.intents += bound.intents;
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
    const b = sequence(trigger.body, 2, 0); b.steps += 1; // trigger dispatch
    bounds.steps = Math.max(bounds.steps, b.steps); bounds.intents = Math.max(bounds.intents, b.intents);
  }
  if (bounds.steps > strategy.limits.maxStepsPerRun || bounds.intents > strategy.limits.maxIntentsPerRun) throw new LanguageError('LIMIT_EXCEEDED', 'Worst-case execution exceeds the strategy limits.');
  const canonicalJson = canonicalize(strategy);
  if (!canonicalJson) throw new LanguageError('SCHEMA_INVALID', 'Cannot canonicalize strategy.');
  const result = freeze({ strategy, canonicalJson, hash: await sha256(canonicalJson), bounds });
  compiled.add(result); return result;
}
export const syntheticCatalog: Catalog = freeze({
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
} satisfies Catalog);
