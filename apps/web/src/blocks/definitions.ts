import * as Blockly from 'blockly/core';
import { BLOCK, CHECK, FIELD, INPUT, AMOUNT_KIND, DEFAULTS, NUMERIC_TYPES, VALUE_TYPES, literalBlock, toAtomic, percentToBps, LanguageError } from '@monad-hack/strategy';
import type { ValueType } from '@monad-hack/strategy';
import { asset, assetOptions, assetSymbol, connectorOptions, feedOptions, feedQuoteLabel, priceUnitOptions } from '../catalog.ts';
import { bindName, currentMinute, humanAmount, humanDecimal, humanPrice, text, utcTimestamp } from './fields.ts';

export const COLOUR = { root: 260, trigger: 30, action: 210, logic: 120, value: 160, soon: '#8a8d93' } as const;
/** Warning ID for checks the block can make on its own fields. Phase 5 adds compiler errors under another ID. */
export const LOCAL_WARNING = 'local';
type Block = Blockly.BlockSvg;
const num = (value: number, min: number, max: number) => new Blockly.FieldNumber(value, min, max, 1);
const message = (error: unknown) => error instanceof LanguageError ? error.message : String(error);
function warnLocally(block: Block, warning: string | null): void {
  if (block.isInFlyout || block.isDeadOrDying()) return;
  block.setWarningText(warning, LOCAL_WARNING);
}
const statement = (block: Block, colour: number | string, tooltip: string): void => {
  block.setPreviousStatement(true, CHECK.statement); block.setNextStatement(true, CHECK.statement);
  block.setColour(colour); block.setTooltip(tooltip);
};
const trigger = (block: Block, tooltip: string): void => {
  block.appendStatementInput(INPUT.body).setCheck(CHECK.statement).appendField('do');
  block.setPreviousStatement(true, CHECK.trigger); block.setNextStatement(true, CHECK.trigger);
  block.setColour(COLOUR.trigger); block.setTooltip(tooltip);
};
const value = (block: Block, output: string | readonly string[], tooltip: string): void => {
  block.setOutput(true, typeof output === 'string' ? output : [...output]);
  block.setColour(COLOUR.value); block.setTooltip(tooltip);
};
/** Named value inputs (notify/ai.decide `inputs`) kept in extraState so imported documents round-trip. */
const namedInputs = {
  saveExtraState(this: Block & { inputNames?: string[] }) { return this.inputNames?.length ? { inputs: [...this.inputNames] } : null; },
  loadExtraState(this: Block & { inputNames?: string[] }, state: { inputs?: unknown }) {
    const names = Array.isArray(state.inputs) ? state.inputs.filter((n): n is string => typeof n === 'string' && bindName(n) === n) : [];
    this.inputNames = names;
    for (const name of names) this.appendValueInput(INPUT.notifyInput(name)).setAlign(Blockly.inputs.Align.RIGHT).appendField(name);
  },
};

function swapWarning(block: Block): string | null {
  const tokenIn = block.getFieldValue(FIELD.tokenIn) as string; const tokenOut = block.getFieldValue(FIELD.tokenOut) as string;
  const kind = block.getFieldValue(FIELD.amountKind) as string; const amount = block.getFieldValue(FIELD.amount) as string;
  const input = asset(tokenIn);
  if (tokenIn === tokenOut) return 'Choose two different assets.';
  try {
    if (kind === AMOUNT_KIND.fixed) {
      if (input && toAtomic(amount, input.decimals) === '0') return 'Amount must be more than 0.';
    } else if (percentToBps(amount) === 10000 && input?.native) return `Keep some ${assetSymbol(tokenIn)} for gas: sell less than 100%.`;
  } catch (error) { return message(error); }
  if (Number(block.getFieldValue(FIELD.slippage)) > 100) return 'The platform allows at most 100 bps (1%) slippage.';
  if (input?.native) return `${assetSymbol(tokenIn)} pays network gas; the executor keeps a reserve back.`;
  return null;
}

const blocks: Record<string, object> = {
  [BLOCK.root]: {
    init(this: Block) {
      this.appendDummyInput().appendField('Strategy').appendField(new Blockly.FieldTextInput('My strategy', text(120)), FIELD.name);
      this.appendDummyInput().appendField('per run: max steps').appendField(num(DEFAULTS.limits.maxStepsPerRun, 1, 1000), FIELD.maxSteps)
        .appendField('AI calls').appendField(num(DEFAULTS.limits.maxAiCallsPerRun, 0, 3), FIELD.maxAiCalls)
        .appendField('trades').appendField(num(DEFAULTS.limits.maxIntentsPerRun, 0, 3), FIELD.maxIntents)
        .appendField('active seconds').appendField(num(DEFAULTS.limits.maxActiveSecondsPerRun, 1, 60), FIELD.maxActiveSeconds);
      this.appendStatementInput(INPUT.triggers).setCheck(CHECK.trigger).appendField('when');
      this.setDeletable(false); this.setColour(COLOUR.root);
      this.setTooltip('The strategy. Triggers are checked top to bottom; where blocks sit on the canvas never changes behaviour.');
    },
  },
  [BLOCK.schedule]: {
    init(this: Block) {
      this.appendDummyInput().appendField('every').appendField(num(DEFAULTS.scheduleSeconds, 10, 31_536_000), FIELD.interval).appendField('seconds');
      this.appendDummyInput().appendField('starting at (UTC)').appendField(new Blockly.FieldTextInput(currentMinute(), utcTimestamp), FIELD.anchor);
      trigger(this, 'Runs on a fixed schedule. 10–59 s is for paper advanced only; rookie and live need at least 60 s.');
    },
    onchange(this: Block) {
      warnLocally(this, Number(this.getFieldValue(FIELD.interval)) < 60 ? 'Under 60 s is allowed only for paper advanced strategies.' : null);
    },
  },
  ...Object.fromEntries((['crossesAbove', 'crossesBelow'] as const).map(kind => [BLOCK[kind], {
    init(this: Block) {
      this.appendDummyInput().appendField(`when price crosses ${kind === 'crossesAbove' ? 'above' : 'below'}`).appendField(new Blockly.FieldTextInput('2500', humanPrice), FIELD.threshold).appendField('', 'UNIT_LABEL');
      this.appendDummyInput().appendField('feed').appendField(new Blockly.FieldDropdown(feedOptions, function (this: Blockly.FieldDropdown, feed: string) {
        this.getSourceBlock()?.setFieldValue(feedQuoteLabel(feed), 'UNIT_LABEL'); return undefined;
      }), FIELD.feed);
      this.setFieldValue(feedQuoteLabel(this.getFieldValue(FIELD.feed) as string), 'UNIT_LABEL');
      this.appendDummyInput().appendField('ignore prices older than').appendField(num(DEFAULTS.maxAgeSeconds, 1, 86_400), FIELD.maxAge).appendField('s, then wait')
        .appendField(num(DEFAULTS.cooldownSeconds, 0, 31_536_000), FIELD.cooldown).appendField('s before firing again');
      trigger(this, 'Fires once when the 30 s pool TWAP over finalized Monad blocks moves across the threshold.');
    },
  }])),
  [BLOCK.if]: {
    init(this: Block) {
      this.appendValueInput(INPUT.condition).setCheck('Boolean').appendField('if');
      this.appendStatementInput(INPUT.then).setCheck(CHECK.statement).appendField('then');
      this.appendStatementInput(INPUT.else).setCheck(CHECK.statement).appendField('else');
      statement(this, COLOUR.logic, 'Runs the first branch when the condition is true, otherwise the second.');
    },
  },
  [BLOCK.repeat]: {
    init(this: Block) {
      this.appendDummyInput().appendField('repeat').appendField(num(2, 1, 10), FIELD.count).appendField('times');
      this.appendStatementInput(INPUT.body).setCheck(CHECK.statement).appendField('do');
      statement(this, COLOUR.logic, 'Repeats 1–10 times. At most two repeats can be nested.');
    },
  },
  [BLOCK.swap]: {
    init(this: Block) {
      this.appendDummyInput().appendField('swap').appendField(new Blockly.FieldTextInput('10', humanAmount), FIELD.amount)
        .appendField(new Blockly.FieldDropdown([['% of available', AMOUNT_KIND.percent], ['units of', AMOUNT_KIND.fixed]]), FIELD.amountKind)
        .appendField(new Blockly.FieldDropdown(assetOptions), FIELD.tokenIn);
      this.appendDummyInput().appendField('for').appendField(new Blockly.FieldDropdown(assetOptions), FIELD.tokenOut)
        .appendField('on').appendField(new Blockly.FieldDropdown(() => connectorOptions('swap.exactInput')), FIELD.connector);
      this.appendDummyInput().appendField('max slippage').appendField(num(DEFAULTS.slippageBps, 0, 10_000), FIELD.slippage).appendField('bps');
      statement(this, COLOUR.action, 'Proposes an exact-input swap. The executor checks budgets and policy before any fill.');
      const assets = assetOptions();
      if (assets.length > 1) { this.setFieldValue(assets[1]![1], FIELD.tokenIn); this.setFieldValue(assets[assets.length - 1]![1], FIELD.tokenOut); }
    },
    onchange(this: Block) { warnLocally(this, swapWarning(this)); },
  },
  [BLOCK.notify]: {
    init(this: Block) {
      this.appendDummyInput().appendField('notify').appendField(new Blockly.FieldTextInput('Strategy update', text(1000)), FIELD.message);
      statement(this, COLOUR.action, 'Records a message in the run history.');
    },
    ...namedInputs,
  },
  [BLOCK.stop]: {
    init(this: Block) {
      this.appendDummyInput().appendField('stop this run:').appendField(new Blockly.FieldTextInput('Done', text(500)), FIELD.reason);
      this.setPreviousStatement(true, CHECK.statement); this.setColour(COLOUR.action);
      this.setTooltip('Ends this run only. Pausing or stopping the agent is an app control, not a block.');
    },
  },
  [BLOCK.read]: {
    init(this: Block) {
      this.appendDummyInput().appendField('read').appendField(new Blockly.FieldDropdown([['price', 'price.read']]), FIELD.operation)
        .appendField('from').appendField(new Blockly.FieldDropdown(() => connectorOptions('price.read')), FIELD.connector)
        .appendField('as').appendField(new Blockly.FieldTextInput('price', bindName), FIELD.bind);
      statement(this, COLOUR.soon, 'Coming soon: reads a curated value and names it for later blocks.');
    },
  },
  [BLOCK.aiDecide]: {
    init(this: Block) {
      this.appendDummyInput().appendField('ask AI').appendField(new Blockly.FieldTextInput('Should I buy now?', text(4000)), FIELD.prompt);
      this.appendDummyInput().appendField('answer as').appendField(new Blockly.FieldDropdown([['allow/skip decision', 'decision/1'], ['summary', 'summary/1']]), FIELD.outputSchema)
        .appendField('named').appendField(new Blockly.FieldTextInput('decision', bindName), FIELD.bind);
      this.appendDummyInput().appendField('timeout').appendField(num(20, 1, 60), FIELD.timeout).appendField('s, max tokens').appendField(num(512, 1, 8192), FIELD.maxOutputTokens);
      statement(this, COLOUR.soon, 'Coming soon: a bounded, metered AI call whose answer is validated before use.');
    },
    ...namedInputs,
  },
  [BLOCK.compare]: {
    init(this: Block) {
      this.appendValueInput(INPUT.left);
      this.appendValueInput(INPUT.right).appendField(new Blockly.FieldDropdown([['=', 'eq'], ['≠', 'ne'], ['<', 'lt'], ['≤', 'lte'], ['>', 'gt'], ['≥', 'gte']]), FIELD.operator);
      this.setInputsInline(true); value(this, 'Boolean', 'Compares two values of the same type and unit.');
      this.setColour(COLOUR.logic);
    },
  },
  [BLOCK.logical]: {
    init(this: Block & { operands?: number }) {
      this.operands = 2;
      this.appendValueInput(INPUT.operand(0)).setCheck('Boolean');
      this.appendValueInput(INPUT.operand(1)).setCheck('Boolean').appendField(new Blockly.FieldDropdown([['and', 'and'], ['or', 'or']], function (this: Blockly.FieldDropdown, operator: string) {
        const block = this.getSourceBlock();
        for (let i = 2; block?.getField(`OP_LABEL${i}`); i++) block.setFieldValue(operator, `OP_LABEL${i}`);
        return undefined;
      }), FIELD.operator);
      this.setInputsInline(true); value(this, 'Boolean', 'True when all (and) or any (or) of the conditions are true.');
      this.setColour(COLOUR.logic);
    },
    saveExtraState(this: Block & { operands?: number }) { return this.operands && this.operands > 2 ? { operands: this.operands } : null; },
    loadExtraState(this: Block & { operands?: number }, state: { operands?: unknown }) {
      const count = typeof state.operands === 'number' && Number.isInteger(state.operands) ? Math.min(8, Math.max(2, state.operands)) : 2;
      // Extra state loads before fields; the operator dropdown's validator relabels these when it loads.
      for (let i = this.operands ?? 2; i < count; i++) this.appendValueInput(INPUT.operand(i)).setCheck('Boolean').appendField(new Blockly.FieldLabel(this.getFieldValue(FIELD.operator) as string), `OP_LABEL${i}`);
      this.operands = count;
    },
  },
  [BLOCK.not]: {
    init(this: Block) {
      this.appendValueInput(INPUT.operand(0)).setCheck('Boolean').appendField('not');
      value(this, 'Boolean', 'True when the condition is false.'); this.setColour(COLOUR.logic);
    },
  },
  [BLOCK.arithmetic]: {
    init(this: Block) {
      this.appendValueInput(INPUT.left).setCheck([...NUMERIC_TYPES]);
      this.appendValueInput(INPUT.right).setCheck([...NUMERIC_TYPES]).appendField(new Blockly.FieldDropdown([['+', 'add'], ['−', 'subtract'], ['×', 'multiply'], ['÷', 'divide']]), FIELD.operator);
      this.setInputsInline(true);
      value(this, NUMERIC_TYPES, 'Exact arithmetic. + and − need matching units; × and ÷ need a plain Decimal on the right. Nothing is rounded.');
    },
  },
};

const literal: Record<ValueType, (block: Block) => void> = {
  Boolean: b => b.appendDummyInput().appendField(new Blockly.FieldDropdown([['true', 'true'], ['false', 'false']]), FIELD.value),
  Integer: b => b.appendDummyInput().appendField(new Blockly.FieldNumber(0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1), FIELD.value),
  Decimal: b => b.appendDummyInput().appendField(new Blockly.FieldTextInput('1', humanDecimal), FIELD.value),
  Money: b => b.appendDummyInput().appendField(new Blockly.FieldTextInput('1', humanAmount), FIELD.value).appendField(new Blockly.FieldDropdown(assetOptions), FIELD.asset),
  Price: b => b.appendDummyInput().appendField(new Blockly.FieldTextInput('2500', humanPrice), FIELD.value).appendField(new Blockly.FieldDropdown(priceUnitOptions), FIELD.priceUnit),
  Timestamp: b => b.appendDummyInput().appendField(new Blockly.FieldTextInput(currentMinute(), utcTimestamp), FIELD.value).appendField('UTC'),
  Enum: b => b.appendDummyInput().appendField(new Blockly.FieldDropdown([['allow', 'allow'], ['skip', 'skip']]), FIELD.value),
};
for (const type of VALUE_TYPES) {
  blocks[literalBlock(type)] = {
    init(this: Block) { literal[type](this); value(this, type, `A fixed ${type} value.`); },
    ...(type === 'Money' ? {
      onchange(this: Block) {
        const a = asset(this.getFieldValue(FIELD.asset) as string);
        try { if (a) toAtomic(this.getFieldValue(FIELD.value) as string, a.decimals); warnLocally(this, null); } catch (error) { warnLocally(this, message(error)); }
      },
    } : {}),
  };
}

let defined = false;
export function defineStrategyBlocks(): void {
  if (defined) return;
  Blockly.common.defineBlocks(blocks); defined = true;
}
