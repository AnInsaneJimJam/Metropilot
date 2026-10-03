// Block type, field and input names shared by the Blockly editor and the workspace converter.
// The converter walks Blockly's save JSON by these names, so both sides must import them from here.
export const EDITOR_FORMAT = 'blocks/1';
export const BLOCK = {
  root: 'strategy',
  schedule: 'schedule',
  crossesAbove: 'price.crossesAbove',
  crossesBelow: 'price.crossesBelow',
  if: 'if',
  repeat: 'repeat',
  swap: 'swap.exactInput',
  notify: 'notify',
  stop: 'stop',
  read: 'read',
  aiDecide: 'ai.decide',
  compare: 'compare',
  logical: 'logical',
  not: 'logical.not',
  arithmetic: 'arithmetic',
} as const;
export const VALUE_TYPES = ['Boolean', 'Integer', 'Decimal', 'Money', 'Price', 'Timestamp', 'Enum'] as const;
export type ValueType = typeof VALUE_TYPES[number];
export const NUMERIC_TYPES: readonly ValueType[] = ['Integer', 'Decimal', 'Money', 'Price'];
export const literalBlock = (type: ValueType): string => `literal.${type}`;
/** Blockly connection checks: trigger stacks, statement stacks, and value types named after the language's value types. */
export const CHECK = { trigger: 'Trigger', statement: 'Statement' } as const;
export const FIELD = {
  name: 'NAME', maxSteps: 'MAX_STEPS', maxAiCalls: 'MAX_AI_CALLS', maxIntents: 'MAX_INTENTS', maxActiveSeconds: 'MAX_ACTIVE_SECONDS',
  interval: 'INTERVAL', anchor: 'ANCHOR',
  feed: 'FEED', threshold: 'THRESHOLD', maxAge: 'MAX_AGE', cooldown: 'COOLDOWN',
  count: 'COUNT',
  connector: 'CONNECTOR', tokenIn: 'TOKEN_IN', tokenOut: 'TOKEN_OUT', amountKind: 'AMOUNT_KIND', amount: 'AMOUNT', slippage: 'SLIPPAGE',
  message: 'MESSAGE', reason: 'REASON',
  operation: 'OPERATION', bind: 'BIND', prompt: 'PROMPT', outputSchema: 'OUTPUT_SCHEMA', timeout: 'TIMEOUT', maxOutputTokens: 'MAX_OUTPUT_TOKENS',
  operator: 'OP', value: 'VALUE', asset: 'ASSET', priceUnit: 'UNIT',
} as const;
export const INPUT = {
  triggers: 'TRIGGERS', body: 'BODY', condition: 'CONDITION', then: 'THEN', else: 'ELSE',
  left: 'LEFT', right: 'RIGHT', operand: (i: number): string => `OPERAND${i}`, notifyInput: (name: string): string => `INPUT_${name}`,
} as const;
/** Swap amount modes: a fixed human amount of tokenIn, or a percentage of the available position. */
export const AMOUNT_KIND = { fixed: 'fixed', percent: 'positionPercent' } as const;
export const DEFAULTS = {
  limits: { maxStepsPerRun: 100, maxAiCallsPerRun: 1, maxIntentsPerRun: 1, maxActiveSecondsPerRun: 60 },
  slippageBps: 30,
  scheduleSeconds: 60,
  maxAgeSeconds: 30,
  cooldownSeconds: 3600,
} as const;
/** Price units travel through one dropdown as `baseAssetRef/quoteUnit`; neither grammar allows '/'. */
export const priceUnitKey = (baseAssetRef: string, quoteUnit: string): string => `${baseAssetRef}/${quoteUnit}`;
export function parsePriceUnitKey(key: string): { baseAssetRef: string; quoteUnit: string } | undefined {
  const parts = key.split('/');
  return parts.length === 2 && parts[0] && parts[1] ? { baseAssetRef: parts[0], quoteUnit: parts[1] } : undefined;
}
export const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A legal node ID: `b` + 10 random base36 characters. Used as the Blockly block ID so one ID names the node everywhere. */
export function newNodeId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return 'b' + Array.from(bytes, byte => (byte % 36).toString(36)).join('');
}
