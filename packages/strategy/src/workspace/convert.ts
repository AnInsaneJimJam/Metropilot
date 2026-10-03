import type { Strategy, Trigger, Statement, Expression } from '@monad-hack/contracts';
import { compileStrategy } from '../compile.ts';
import type { Catalog, CompiledStrategy } from '../compile.ts';
import { LanguageError } from '../errors.ts';
import { toAtomic, fromAtomic, toPriceDecimal, toLanguageDecimal, percentToBps, bpsToPercent } from './units.ts';
import { AMOUNT_KIND, BLOCK, EDITOR_FORMAT, FIELD, INPUT, NODE_ID, VALUE_TYPES, literalBlock, newNodeId, parsePriceUnitKey, priceUnitKey } from './vocabulary.ts';
import type { ValueType } from './vocabulary.ts';

// Blockly workspace JSON ↔ strategy document. A pure walk over `Blockly.serialization.workspaces.save` output:
// no Blockly, no DOM. Canvas coordinates, collapse/inline state and comments never reach the strategy.

/** What the editor stores and submits next to the strategy document (D14). */
export interface WorkspaceEnvelope { readonly editorFormat: typeof EDITOR_FORMAT; readonly blockly: unknown }
/** Strategy JSON Pointer (`''`, `/triggers/0/body/1/condition/left`, …) → the block that produced it. */
export type SourceMap = Readonly<Record<string, string>>;
/** `strategy` is converted but not yet validated; `compileStrategy` (or `compileWorkspaceProgram`) is authoritative. */
export interface WorkspaceConversion { readonly strategy: Strategy; readonly sourceMap: SourceMap }
export const MAX_WORKSPACE_BYTES = 1024 * 1024;
const MAX_BLOCKS = 100; // the AST node limit; every block except the root becomes one AST node

type Role = 'root' | 'trigger' | 'statement' | 'expression';
const ROLE: Readonly<Record<string, Role>> = {
  [BLOCK.root]: 'root',
  [BLOCK.schedule]: 'trigger', [BLOCK.crossesAbove]: 'trigger', [BLOCK.crossesBelow]: 'trigger',
  [BLOCK.if]: 'statement', [BLOCK.repeat]: 'statement', [BLOCK.swap]: 'statement', [BLOCK.notify]: 'statement', [BLOCK.stop]: 'statement',
  [BLOCK.read]: 'statement', [BLOCK.aiDecide]: 'statement',
  [BLOCK.compare]: 'expression', [BLOCK.logical]: 'expression', [BLOCK.not]: 'expression', [BLOCK.arithmetic]: 'expression',
  ...Object.fromEntries(VALUE_TYPES.map(type => [literalBlock(type), 'expression'])),
};
const WHERE: Readonly<Record<Role, string>> = { root: 'the canvas', trigger: 'a trigger slot', statement: 'an action slot', expression: 'a value slot' };
const crossing = [FIELD.threshold, FIELD.feed, FIELD.maxAge, FIELD.cooldown];
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  [BLOCK.root]: [FIELD.name, FIELD.maxSteps, FIELD.maxAiCalls, FIELD.maxIntents, FIELD.maxActiveSeconds],
  [BLOCK.schedule]: [FIELD.interval, FIELD.anchor], [BLOCK.crossesAbove]: crossing, [BLOCK.crossesBelow]: crossing,
  [BLOCK.if]: [], [BLOCK.repeat]: [FIELD.count],
  [BLOCK.swap]: [FIELD.amount, FIELD.amountKind, FIELD.tokenIn, FIELD.tokenOut, FIELD.connector, FIELD.slippage],
  [BLOCK.notify]: [FIELD.message], [BLOCK.stop]: [FIELD.reason],
  [BLOCK.read]: [FIELD.operation, FIELD.connector, FIELD.bind],
  [BLOCK.aiDecide]: [FIELD.prompt, FIELD.outputSchema, FIELD.bind, FIELD.timeout, FIELD.maxOutputTokens],
  [BLOCK.compare]: [FIELD.operator], [BLOCK.logical]: [FIELD.operator], [BLOCK.not]: [], [BLOCK.arithmetic]: [FIELD.operator],
  ...Object.fromEntries(VALUE_TYPES.map(type => [literalBlock(type), type === 'Money' ? [FIELD.value, FIELD.asset] : type === 'Price' ? [FIELD.value, FIELD.priceUnit] : [FIELD.value]])),
};
const BLOCK_KEYS = new Set(['type', 'id', 'x', 'y', 'collapsed', 'deletable', 'movable', 'editable', 'enabled', 'disabledReasons', 'inline', 'data', 'extraState', 'icons', 'fields', 'inputs', 'next']);

interface Connection { block?: unknown; shadow?: unknown }
interface BlockState {
  readonly type: string; readonly id: string; readonly pointer: string;
  readonly fields: Readonly<Record<string, unknown>>; readonly inputs: Readonly<Record<string, Connection>>;
  readonly next: Connection | undefined; readonly extraState: unknown;
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code: string, message: string, blockId?: string, pointer = ''): never => { throw new LanguageError(code, message, blockId, pointer); };

/** Converts a workspace envelope (JSON text or parsed object, at most 1 MiB) to a strategy document and source map. */
export function compileWorkspace(workspace: unknown, catalog: Catalog): WorkspaceConversion {
  const text = typeof workspace === 'string' ? workspace : JSON.stringify(workspace) ?? '';
  if (new TextEncoder().encode(text).length > MAX_WORKSPACE_BYTES) fail('LIMIT_EXCEEDED', 'The workspace exceeds 1 MiB.');
  let envelope: unknown = workspace;
  if (typeof workspace === 'string') {
    try { envelope = JSON.parse(workspace); } catch (error) { fail(error instanceof RangeError ? 'LIMIT_EXCEEDED' : 'SCHEMA_INVALID', 'The workspace is not valid JSON.'); }
  }
  if (!isObject(envelope) || envelope.editorFormat !== EDITOR_FORMAT || Object.keys(envelope).some(k => k !== 'editorFormat' && k !== 'blockly')) fail('SCHEMA_INVALID', `Use a {editorFormat: "${EDITOR_FORMAT}", blockly} workspace envelope.`);
  const blockly = (envelope as Record<string, unknown>).blockly;
  if (!isObject(blockly) || Object.keys(blockly).some(k => k !== 'blocks' && k !== 'variables')) fail('SCHEMA_INVALID', 'Unsupported Blockly workspace content.');
  const { blocks, variables } = blockly as Record<string, unknown>;
  if (variables !== undefined && !(Array.isArray(variables) && variables.length === 0)) fail('SCHEMA_INVALID', 'Workspace variables are not part of the strategy language.');
  const top = isObject(blocks) && blocks.languageVersion === 0 && Array.isArray(blocks.blocks) ? blocks.blocks as unknown[] : fail('SCHEMA_INVALID', 'The workspace has no block list.');
  return new Walker(catalog).strategy(top);
}

class Walker {
  private readonly map: Record<string, string> = {};
  private readonly seen = new Set<string>();
  private readonly catalog: Catalog;
  constructor(catalog: Catalog) { this.catalog = catalog; }

  strategy(top: readonly unknown[]): WorkspaceConversion {
    const roots = top.filter(b => isObject(b) && b.type === BLOCK.root);
    if (roots.length !== 1) fail('SCHEMA_INVALID', 'The workspace needs exactly one Strategy block.');
    const loose = top.find(b => b !== roots[0]);
    if (loose !== undefined) fail('SCHEMA_INVALID', 'Attach this block inside the Strategy block, or delete it.', isObject(loose) && typeof loose.id === 'string' ? loose.id : undefined);
    const root = this.block(roots[0], '', 'root');
    if (root.next) fail('SCHEMA_INVALID', 'Nothing can follow the Strategy block.', root.id);
    this.inputs(root, [INPUT.triggers]);
    const strategy: Strategy = {
      schemaVersion: 'strategy/1', id: root.id, name: this.text(root, FIELD.name),
      triggers: this.chain(root, INPUT.triggers, '/triggers', 'trigger', b => this.trigger(b)),
      limits: {
        maxStepsPerRun: this.integer(root, FIELD.maxSteps), maxAiCallsPerRun: this.integer(root, FIELD.maxAiCalls),
        maxIntentsPerRun: this.integer(root, FIELD.maxIntents), maxActiveSecondsPerRun: this.integer(root, FIELD.maxActiveSeconds),
      },
    };
    if (strategy.triggers.length === 0) fail('SCHEMA_INVALID', 'Add at least one trigger to the Strategy block.', root.id, '/triggers');
    return { strategy, sourceMap: Object.freeze({ ...this.map }) };
  }

  /** Validates one saved block, records it in the source map and checks it sits in a slot of the right kind. */
  private block(raw: unknown, pointer: string, role: Role): BlockState {
    if (!isObject(raw)) return fail('SCHEMA_INVALID', 'Malformed block.', undefined, pointer);
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    if (!id || !NODE_ID.test(id)) return fail('SCHEMA_INVALID', 'Every block needs a legal ID (a letter, then up to 63 letters, digits, _ or -).', id, pointer);
    if (this.seen.has(id)) fail('SCHEMA_INVALID', 'Block IDs must be unique.', id, pointer);
    this.seen.add(id);
    if (this.seen.size > MAX_BLOCKS + 1) fail('LIMIT_EXCEEDED', `Use at most ${MAX_BLOCKS} blocks inside the strategy.`, id, pointer);
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (!Object.hasOwn(ROLE, type)) fail('UNKNOWN_BLOCK', `Unknown block type ${JSON.stringify(type)}.`, id, pointer);
    if (ROLE[type] !== role) fail('SCHEMA_INVALID', `This block cannot go in ${WHERE[role]}.`, id, pointer);
    const unknownKey = Object.keys(raw).find(k => !BLOCK_KEYS.has(k));
    if (unknownKey) fail('SCHEMA_INVALID', `Unsupported block property ${unknownKey}.`, id, pointer);
    if (raw.enabled === false || (Array.isArray(raw.disabledReasons) && raw.disabledReasons.length > 0)) fail('SCHEMA_INVALID', 'Disabled blocks are not allowed; delete the block instead.', id, pointer);
    const fields = raw.fields ?? {}; const inputs = raw.inputs ?? {};
    if (!isObject(fields) || !isObject(inputs) || (raw.next !== undefined && !isObject(raw.next))) fail('SCHEMA_INVALID', 'Malformed block fields or connections.', id, pointer);
    const extra = Object.keys(fields as object).filter(k => !FIELDS[type]!.includes(k));
    if (extra.length) fail('SCHEMA_INVALID', `Unexpected field ${extra[0]}.`, id, pointer);
    for (const connection of [...Object.values(inputs as object), raw.next]) {
      if (connection === undefined) continue;
      if (!isObject(connection) || connection.shadow !== undefined || Object.keys(connection).some(k => k !== 'block')) fail('SCHEMA_INVALID', 'Shadow or malformed connections are not supported.', id, pointer);
    }
    if (raw.extraState !== undefined && type !== BLOCK.logical && type !== BLOCK.notify) fail('SCHEMA_INVALID', 'Unexpected block state.', id, pointer);
    this.map[pointer] = id;
    return { type, id, pointer, fields: fields as Record<string, unknown>, inputs: inputs as Record<string, Connection>, next: raw.next as Connection | undefined, extraState: raw.extraState };
  }
  private inputs(block: BlockState, allowed: readonly string[]): void {
    const extra = Object.keys(block.inputs).find(k => !allowed.includes(k));
    if (extra) fail('SCHEMA_INVALID', `Unexpected input ${extra}.`, block.id, block.pointer);
  }
  private chain<T>(parent: BlockState, input: string, pointer: string, role: 'trigger' | 'statement', convert: (b: BlockState) => T): T[] {
    const out: T[] = [];
    let raw = parent.inputs[input]?.block;
    while (raw !== undefined) {
      const block = this.block(raw, `${pointer}/${out.length}`, role);
      out.push(convert(block));
      raw = block.next?.block;
    }
    return out;
  }
  private field(block: BlockState, name: string): unknown {
    if (!Object.hasOwn(block.fields, name)) fail('SCHEMA_INVALID', `Missing field ${name}.`, block.id, block.pointer);
    return block.fields[name];
  }
  private text(block: BlockState, name: string): string {
    const value = this.field(block, name);
    return typeof value === 'string' ? value : fail('SCHEMA_INVALID', `Field ${name} must be text.`, block.id, block.pointer);
  }
  private integer(block: BlockState, name: string): number {
    const value = this.field(block, name);
    return Number.isSafeInteger(value) ? value as number : fail('SCHEMA_INVALID', `Field ${name} must be a whole number.`, block.id, block.pointer);
  }
  /** Runs a unit conversion and attributes its error to this block. */
  private convert<T>(block: BlockState, fn: () => T): T {
    try { return fn(); } catch (error) {
      if (error instanceof LanguageError) fail(error.code, error.message, block.id, block.pointer);
      throw error;
    }
  }
  private decimals(block: BlockState, assetRef: string): number {
    const asset = Object.hasOwn(this.catalog.assets, assetRef) ? this.catalog.assets[assetRef] : undefined;
    return asset ? asset.decimals : fail('UNKNOWN_REFERENCE', `Select a known catalog asset: ${assetRef}.`, block.id, block.pointer);
  }
  private body(block: BlockState, input: string, key: string): Statement[] {
    return this.chain(block, input, `${block.pointer}/${key}`, 'statement', b => this.statement(b));
  }
  private value(block: BlockState, input: string, key: string): Expression {
    const raw = block.inputs[input]?.block;
    if (raw === undefined) fail('SCHEMA_INVALID', 'Attach a value to every empty slot.', block.id, `${block.pointer}/${key}`);
    return this.expression(this.block(raw, `${block.pointer}/${key}`, 'expression'));
  }

  private trigger(b: BlockState): Trigger {
    this.inputs(b, [INPUT.body]);
    const body = this.body(b, INPUT.body, 'body');
    if (body.length === 0) fail('SCHEMA_INVALID', 'Add at least one action to this trigger.', b.id, `${b.pointer}/body`);
    if (b.type === BLOCK.schedule) return { id: b.id, type: 'schedule', intervalSeconds: this.integer(b, FIELD.interval), anchorAt: this.text(b, FIELD.anchor), body };
    const feedRef = this.text(b, FIELD.feed);
    const feed = Object.hasOwn(this.catalog.feeds, feedRef) ? this.catalog.feeds[feedRef]! : fail('UNKNOWN_REFERENCE', `Select a known price feed: ${feedRef}.`, b.id, b.pointer);
    return {
      id: b.id, type: b.type === BLOCK.crossesAbove ? 'price.crossesAbove' : 'price.crossesBelow', feedRef,
      threshold: { baseAssetRef: feed.baseAssetRef, quoteUnit: feed.quoteUnit, decimal: this.convert(b, () => toPriceDecimal(this.text(b, FIELD.threshold))) },
      maxAgeSeconds: this.integer(b, FIELD.maxAge), cooldownSeconds: this.integer(b, FIELD.cooldown), body,
    };
  }

  private statement(b: BlockState): Statement {
    switch (b.type) {
      case BLOCK.if:
        this.inputs(b, [INPUT.condition, INPUT.then, INPUT.else]);
        return { id: b.id, type: 'if', condition: this.value(b, INPUT.condition, 'condition'), then: this.body(b, INPUT.then, 'then'), else: this.body(b, INPUT.else, 'else') };
      case BLOCK.repeat:
        this.inputs(b, [INPUT.body]);
        return { id: b.id, type: 'repeat', count: this.integer(b, FIELD.count), body: this.body(b, INPUT.body, 'body') };
      case BLOCK.swap: {
        this.inputs(b, []);
        const tokenInRef = this.text(b, FIELD.tokenIn); const kind = this.text(b, FIELD.amountKind); const amount = this.text(b, FIELD.amount);
        if (kind !== AMOUNT_KIND.fixed && kind !== AMOUNT_KIND.percent) fail('SCHEMA_INVALID', 'Choose a fixed amount or a percentage.', b.id, b.pointer);
        return {
          id: b.id, type: 'swap.exactInput', connectorRef: this.text(b, FIELD.connector), tokenInRef, tokenOutRef: this.text(b, FIELD.tokenOut),
          amount: kind === AMOUNT_KIND.fixed
            ? { kind: 'fixed', atomic: this.convert(b, () => toAtomic(amount, this.decimals(b, tokenInRef))) }
            : { kind: 'positionBps', bps: this.convert(b, () => percentToBps(amount)) },
          maxSlippageBps: this.integer(b, FIELD.slippage),
        };
      }
      case BLOCK.notify: {
        const names = this.extraNames(b);
        this.inputs(b, names.map(INPUT.notifyInput));
        return { id: b.id, type: 'notify', message: this.text(b, FIELD.message), inputs: Object.fromEntries(names.map(n => [n, this.value(b, INPUT.notifyInput(n), `inputs/${n}`)])) };
      }
      case BLOCK.stop:
        this.inputs(b, []);
        if (b.next) fail('SCHEMA_INVALID', 'Nothing can follow a stop block.', b.id, b.pointer);
        return { id: b.id, type: 'stop', reason: this.text(b, FIELD.reason) };
      default: // read, ai.decide
        return fail('UNSUPPORTED_CAPABILITY', 'This block is coming soon and cannot be used yet.', b.id, b.pointer);
    }
  }
  private extraNames(b: BlockState): string[] {
    if (b.extraState === undefined) return [];
    const names = isObject(b.extraState) && Array.isArray(b.extraState.inputs) ? b.extraState.inputs : fail('SCHEMA_INVALID', 'Malformed notify inputs.', b.id, b.pointer);
    if (names.some(n => typeof n !== 'string' || !NODE_ID.test(n)) || new Set(names).size !== names.length) fail('SCHEMA_INVALID', 'Input names must be unique legal names.', b.id, b.pointer);
    return names as string[];
  }

  private expression(b: BlockState): Expression {
    if (b.next) fail('SCHEMA_INVALID', 'Malformed value block.', b.id, b.pointer);
    switch (b.type) {
      case BLOCK.compare: case BLOCK.arithmetic: {
        this.inputs(b, [INPUT.left, INPUT.right]);
        const operator = this.text(b, FIELD.operator); const left = this.value(b, INPUT.left, 'left'); const right = this.value(b, INPUT.right, 'right');
        return b.type === BLOCK.compare
          ? { kind: 'compare', operator: operator as Extract<Expression, { kind: 'compare' }>['operator'], left, right }
          : { kind: 'arithmetic', operator: operator as Extract<Expression, { kind: 'arithmetic' }>['operator'], left, right };
      }
      case BLOCK.logical: {
        const state = b.extraState;
        const count = state === undefined ? 2 : isObject(state) && Number.isInteger(state.operands) && (state.operands as number) >= 2 && (state.operands as number) <= 8 ? state.operands as number : fail('SCHEMA_INVALID', 'Malformed and/or operand count.', b.id, b.pointer);
        const names = Array.from({ length: count }, (_, i) => INPUT.operand(i));
        this.inputs(b, names);
        const operator = this.text(b, FIELD.operator);
        if (operator !== 'and' && operator !== 'or') fail('SCHEMA_INVALID', 'Choose and or or.', b.id, b.pointer);
        return { kind: 'logical', operator: operator as 'and' | 'or', operands: names.map((name, i) => this.value(b, name, `operands/${i}`)) };
      }
      case BLOCK.not:
        this.inputs(b, [INPUT.operand(0)]);
        return { kind: 'logical', operator: 'not', operands: [this.value(b, INPUT.operand(0), 'operands/0')] };
    }
    this.inputs(b, []);
    const type = b.type.slice('literal.'.length) as ValueType;
    switch (type) {
      case 'Boolean': {
        const value = this.text(b, FIELD.value);
        return value === 'true' || value === 'false' ? { kind: 'literal', valueType: 'Boolean', value: value === 'true' } : fail('SCHEMA_INVALID', 'Choose true or false.', b.id, b.pointer);
      }
      case 'Integer': return { kind: 'literal', valueType: 'Integer', value: this.integer(b, FIELD.value) };
      case 'Decimal': return { kind: 'literal', valueType: 'Decimal', value: this.convert(b, () => toLanguageDecimal(this.text(b, FIELD.value))) };
      case 'Money': {
        const assetRef = this.text(b, FIELD.asset);
        return { kind: 'literal', valueType: 'Money', value: { assetRef, atomic: this.convert(b, () => toAtomic(this.text(b, FIELD.value), this.decimals(b, assetRef))) } };
      }
      case 'Price': {
        const unit = parsePriceUnitKey(this.text(b, FIELD.priceUnit)) ?? fail('SCHEMA_INVALID', 'Choose a price unit.', b.id, b.pointer);
        return { kind: 'literal', valueType: 'Price', value: { ...unit, decimal: this.convert(b, () => toPriceDecimal(this.text(b, FIELD.value))) } };
      }
      case 'Timestamp': return { kind: 'literal', valueType: 'Timestamp', value: this.text(b, FIELD.value) };
      case 'Enum': return { kind: 'literal', valueType: 'Enum', value: this.text(b, FIELD.value) as 'allow' | 'skip' };
    }
  }
}

/** The block a language error belongs to: the deepest block on its JSON Pointer, else its node ID, else the root. */
export function locateBlock(error: LanguageError, sourceMap: SourceMap): string | undefined {
  if (error.fieldPath.startsWith('/') && !error.fieldPath.startsWith('/nodes/')) {
    for (let pointer = error.fieldPath; ; pointer = pointer.slice(0, pointer.lastIndexOf('/'))) {
      if (Object.hasOwn(sourceMap, pointer)) return sourceMap[pointer];
      if (pointer === '') break;
    }
  }
  if (error.nodeId && Object.values(sourceMap).includes(error.nodeId)) return error.nodeId;
  return sourceMap[''];
}

/** Workspace → validated, hashed program. Errors carry the ID of the block to highlight as `nodeId`. */
export async function compileWorkspaceProgram(workspace: unknown, catalog: Catalog): Promise<{ program: CompiledStrategy; sourceMap: SourceMap }> {
  const { strategy, sourceMap } = compileWorkspace(workspace, catalog);
  try {
    return { program: await compileStrategy(JSON.stringify(strategy), catalog), sourceMap };
  } catch (error) {
    if (error instanceof LanguageError) throw new LanguageError(error.code, error.message, locateBlock(error, sourceMap), error.fieldPath);
    throw error;
  }
}

// ── strategy → workspace ──────────────────────────────────────────────────────────────────────────────

type Saved = Record<string, unknown>;
const chainOf = (blocks: Saved[]): { block: Saved } | undefined =>
  blocks.reduceRight<{ block: Saved } | undefined>((next, block) => ({ block: next ? { ...block, next } : block }), undefined);
const withInputs = (inputs: Record<string, { block: Saved } | undefined>): Saved | undefined => {
  const present = Object.entries(inputs).filter(([, v]) => v !== undefined);
  return present.length ? Object.fromEntries(present) : undefined;
};
const block = (type: string, id: string, fields: Saved, inputs: Record<string, { block: Saved } | undefined> = {}, extraState?: unknown): Saved => {
  const saved: Saved = { type, id };
  if (extraState !== undefined) saved.extraState = extraState;
  if (Object.keys(fields).length) saved.fields = fields;
  const connected = withInputs(inputs);
  if (connected) saved.inputs = connected;
  return saved;
};

/**
 * Renders a strategy document as an editor workspace with a generated vertical layout (one root at the origin;
 * Blockly lays out nested stacks). Strategy, trigger and statement IDs are kept; expression blocks get fresh IDs.
 */
export function workspaceFromStrategy(strategy: Strategy, catalog: Catalog): WorkspaceEnvelope {
  const decimals = (assetRef: string): number => {
    const asset = Object.hasOwn(catalog.assets, assetRef) ? catalog.assets[assetRef] : undefined;
    return asset ? asset.decimals : fail('UNKNOWN_REFERENCE', `Select a known catalog asset: ${assetRef}.`);
  };
  const expression = (e: Expression): Saved => {
    const id = newNodeId();
    switch (e.kind) {
      case 'literal': {
        const type = literalBlock(e.valueType);
        switch (e.valueType) {
          case 'Boolean': return block(type, id, { [FIELD.value]: String(e.value) });
          case 'Money': return block(type, id, { [FIELD.value]: fromAtomic(e.value.atomic, decimals(e.value.assetRef)), [FIELD.asset]: e.value.assetRef });
          case 'Price': return block(type, id, { [FIELD.value]: e.value.decimal, [FIELD.priceUnit]: priceUnitKey(e.value.baseAssetRef, e.value.quoteUnit) });
          default: return block(type, id, { [FIELD.value]: e.value });
        }
      }
      case 'compare': case 'arithmetic':
        return block(e.kind === 'compare' ? BLOCK.compare : BLOCK.arithmetic, id, { [FIELD.operator]: e.operator }, { [INPUT.left]: { block: expression(e.left) }, [INPUT.right]: { block: expression(e.right) } });
      case 'logical': {
        const inputs = Object.fromEntries(e.operands.map((o, i) => [INPUT.operand(i), { block: expression(o) }]));
        if (e.operator === 'not') return block(BLOCK.not, id, {}, inputs);
        return block(BLOCK.logical, id, { [FIELD.operator]: e.operator }, inputs, e.operands.length > 2 ? { operands: e.operands.length } : undefined);
      }
      default: return fail('UNSUPPORTED_CAPABILITY', 'Named values arrive with read and AI blocks; this strategy cannot be shown as blocks yet.');
    }
  };
  const statement = (s: Statement): Saved => {
    switch (s.type) {
      case 'if': return block(BLOCK.if, s.id, {}, { [INPUT.condition]: { block: expression(s.condition) }, [INPUT.then]: chainOf(s.then.map(statement)), [INPUT.else]: chainOf(s.else.map(statement)) });
      case 'repeat': return block(BLOCK.repeat, s.id, { [FIELD.count]: s.count }, { [INPUT.body]: chainOf(s.body.map(statement)) });
      case 'swap.exactInput': return block(BLOCK.swap, s.id, {
        [FIELD.amount]: s.amount.kind === 'fixed' ? fromAtomic(s.amount.atomic, decimals(s.tokenInRef)) : bpsToPercent(s.amount.bps),
        [FIELD.amountKind]: s.amount.kind === 'fixed' ? AMOUNT_KIND.fixed : AMOUNT_KIND.percent,
        [FIELD.tokenIn]: s.tokenInRef, [FIELD.tokenOut]: s.tokenOutRef, [FIELD.connector]: s.connectorRef, [FIELD.slippage]: s.maxSlippageBps,
      });
      case 'notify': {
        const names = Object.keys(s.inputs);
        return block(BLOCK.notify, s.id, { [FIELD.message]: s.message }, Object.fromEntries(names.map(n => [INPUT.notifyInput(n), { block: expression(s.inputs[n]!) }])), names.length ? { inputs: names } : undefined);
      }
      case 'stop': return block(BLOCK.stop, s.id, { [FIELD.reason]: s.reason });
      default: return fail('UNSUPPORTED_CAPABILITY', 'Read and AI blocks are coming soon; this strategy cannot be shown as blocks yet.', s.id);
    }
  };
  const trigger = (t: Trigger): Saved => {
    const body = { [INPUT.body]: chainOf(t.body.map(statement)) };
    switch (t.type) {
      case 'schedule': return block(BLOCK.schedule, t.id, { [FIELD.interval]: t.intervalSeconds, [FIELD.anchor]: t.anchorAt }, body);
      case 'price.crossesAbove': case 'price.crossesBelow':
        return block(t.type === 'price.crossesAbove' ? BLOCK.crossesAbove : BLOCK.crossesBelow, t.id, {
          [FIELD.threshold]: t.threshold.decimal, [FIELD.feed]: t.feedRef, [FIELD.maxAge]: t.maxAgeSeconds, [FIELD.cooldown]: t.cooldownSeconds,
        }, body);
      default: return fail('UNSUPPORTED_CAPABILITY', 'Connector events are not available as blocks yet.', t.id);
    }
  };
  const root = block(BLOCK.root, strategy.id, {
    [FIELD.name]: strategy.name, [FIELD.maxSteps]: strategy.limits.maxStepsPerRun, [FIELD.maxAiCalls]: strategy.limits.maxAiCallsPerRun,
    [FIELD.maxIntents]: strategy.limits.maxIntentsPerRun, [FIELD.maxActiveSeconds]: strategy.limits.maxActiveSecondsPerRun,
  }, { [INPUT.triggers]: chainOf(strategy.triggers.map(trigger)) });
  return { editorFormat: EDITOR_FORMAT, blockly: { blocks: { languageVersion: 0, blocks: [{ ...root, x: 24, y: 24 }] } } };
}
