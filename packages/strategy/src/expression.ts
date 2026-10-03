import type { Expression } from '@monad-hack/contracts';
import { LanguageError } from './errors.ts';
export type Value = Extract<Expression, { kind: 'literal' }>;
/** Bounded text that only a recorded host result (an AI summary) can produce. It can be shown or passed on, never compared. */
export interface TextValue { kind: 'literal'; valueType: 'Text'; value: string }
export type BoundValue = Value | TextValue;
/** Declared type of one field of a bound record (catalog read results, AI output schemas). */
export type FieldType =
  | { readonly valueType: 'Price'; readonly baseAssetRef: string; readonly quoteUnit: string }
  | { readonly valueType: 'Money'; readonly assetRef: string }
  | { readonly valueType: 'Boolean' | 'Integer' | 'Decimal' | 'Timestamp' | 'Enum' | 'Text' };
export type RecordType = Readonly<Record<string, FieldType>>;
/** Lexical scope at compile time (name → record type) and at run time (name → recorded values). */
export type TypeScope = (name: string) => RecordType | undefined;
export type ValueScope = (name: string) => Readonly<Record<string, BoundValue>> | undefined;
const MAX_TEXT = 500;
const SCALE = 10n ** 18n;
const UINT256 = (1n << 256n) - 1n;
export function atomic(text: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 78 || BigInt(text) > UINT256) throw new LanguageError('INVALID_AMOUNT', 'Atomic amount must fit uint256.');
  return BigInt(text);
}
export function decimal(text: string): bigint {
  if (text.length > 100 || !/^-?(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/.test(text) || text === '-0') throw new LanguageError('TYPE_MISMATCH', 'Use a canonical decimal with at most 18 places.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (value.toString().length > 96) throw new LanguageError('LIMIT_EXCEEDED', 'Decimal overflow.');
  return negative ? -value : value;
}
function formatDecimal(n: bigint): string {
  const sign = n < 0n ? '-' : ''; const positive = n < 0n ? -n : n;
  const fraction = (positive % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  const result = sign + (positive / SCALE).toString() + (fraction ? '.' + fraction : '');
  decimal(result); return result;
}
export function validateLiteral(value: BoundValue): void {
  switch (value.valueType) {
    case 'Text': if (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > MAX_TEXT || !value.value.isWellFormed()) throw new LanguageError('TYPE_MISMATCH', `Text must be 1–${MAX_TEXT} characters.`); break;
    case 'Decimal': decimal(value.value); break;
    case 'Money': atomic(value.value.atomic); break;
    case 'Price': if (decimal(value.value.decimal) <= 0n) throw new LanguageError('TYPE_MISMATCH', 'Price must be positive.'); break;
    case 'Timestamp': timestamp(value.value); break;
    case 'Integer': if (!Number.isSafeInteger(value.value)) throw new LanguageError('TYPE_MISMATCH', 'Integer must be safe.'); break;
  }
}
export function timestamp(text: string): number {
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) throw new LanguageError('TYPE_MISMATCH', 'Use a valid UTC timestamp with milliseconds.');
  return time;
}
function compatible(a: Value, b: Value): boolean {
  if (a.valueType !== b.valueType) return false;
  if (a.valueType === 'Money' && b.valueType === 'Money') return a.value.assetRef === b.value.assetRef;
  if (a.valueType === 'Price' && b.valueType === 'Price') return a.value.baseAssetRef === b.value.baseAssetRef && a.value.quoteUnit === b.value.quoteUnit;
  return true;
}
function scalar(a: Value): bigint | number | string | boolean {
  switch (a.valueType) {
    case 'Decimal': return decimal(a.value);
    case 'Money': return atomic(a.value.atomic);
    case 'Price': return decimal(a.value.decimal);
    case 'Timestamp': return timestamp(a.value);
    default: return a.value;
  }
}
function arithmeticValue(template: Value, n: bigint): Value {
  switch (template.valueType) {
    case 'Decimal': return { kind: 'literal', valueType: 'Decimal', value: formatDecimal(n) };
    case 'Price': {
      const value = { kind: 'literal', valueType: 'Price', value: { ...template.value, decimal: formatDecimal(n) } } as const;
      validateLiteral(value); return value;
    }
    case 'Money': { const value = n.toString(); atomic(value); return { kind: 'literal', valueType: 'Money', value: { ...template.value, atomic: value } }; }
    case 'Integer': if (n < BigInt(Number.MIN_SAFE_INTEGER) || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new LanguageError('TYPE_MISMATCH', 'Integer overflow.'); return { kind: 'literal', valueType: 'Integer', value: Number(n) };
    default: throw new LanguageError('TYPE_MISMATCH', 'Arithmetic needs a numeric value.');
  }
}
function numeric(a: Value): bigint {
  if (a.valueType === 'Integer') return BigInt(a.value);
  const n = scalar(a); if (typeof n !== 'bigint') throw new LanguageError('TYPE_MISMATCH', 'Arithmetic needs a numeric value.'); return n;
}
export const fieldUnit = (type: FieldType): string =>
  type.valueType === 'Money' ? 'Money:' + type.assetRef : type.valueType === 'Price' ? 'Price:' + JSON.stringify([type.baseAssetRef, type.quoteUnit]) : type.valueType;
const noScope = (): undefined => undefined;
/** Bindings hold records; `ref` names a whole record, so only `field` can read a value out of one. */
function lookupField<T>(expr: Extract<Expression, { kind: 'ref' | 'field' }>, record: Readonly<Record<string, T>> | undefined): T {
  if (!record) throw new LanguageError('UNKNOWN_REFERENCE', `No earlier read or AI block named ${expr.name} is in scope here.`);
  if (expr.kind === 'ref') throw new LanguageError('TYPE_MISMATCH', `${expr.name} is a record; choose one of its fields: ${Object.keys(record).join(', ')}.`);
  if (!Object.hasOwn(record, expr.field)) throw new LanguageError('UNKNOWN_REFERENCE', `${expr.name} has no field ${expr.field}; choose one of: ${Object.keys(record).join(', ')}.`);
  return record[expr.field]!;
}
/** Type plus unit (asset, price pair) of an expression, e.g. `Price:["paper.WETH","USD"]`. */
export function unit(expr: Expression, scope: TypeScope = noScope): string {
  if (expr.kind === 'literal') {
    if (expr.valueType === 'Money') return 'Money:' + expr.value.assetRef;
    if (expr.valueType === 'Price') return 'Price:' + JSON.stringify([expr.value.baseAssetRef, expr.value.quoteUnit]);
    return expr.valueType;
  }
  if (expr.kind === 'ref' || expr.kind === 'field') return fieldUnit(lookupField(expr, scope(expr.name)));
  return expr.kind === 'arithmetic' ? unit(expr.left, scope) : expressionType(expr, scope);
}
export function expressionType(expr: Expression, scope: TypeScope = noScope): BoundValue['valueType'] {
  if (expr.kind === 'literal') { validateLiteral(expr); return expr.valueType; }
  if (expr.kind === 'ref' || expr.kind === 'field') return lookupField(expr, scope(expr.name)).valueType;
  if (expr.kind === 'logical') {
    if ((expr.operator === 'not' && expr.operands.length !== 1) || (expr.operator !== 'not' && expr.operands.length < 2)) throw new LanguageError('TYPE_MISMATCH', 'not needs one operand; and/or need 2–8.');
    for (const operand of expr.operands) if (expressionType(operand, scope) !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'Logical operands must be Boolean.');
    return 'Boolean';
  }
  const left = expressionType(expr.left, scope); const right = expressionType(expr.right, scope);
  if (expr.kind === 'compare') {
    if (left === 'Text' || right === 'Text') throw new LanguageError('TYPE_MISMATCH', 'Text cannot be compared; branch on an AI decision instead.');
    if (left !== right || ((left === 'Boolean' || left === 'Enum') && !['eq', 'ne'].includes(expr.operator))) throw new LanguageError('TYPE_MISMATCH', 'Comparison types or operator are incompatible.');
    // Unit compatibility is checked on exact pure values below, including unreachable branches.
    if (unit(expr.left, scope) !== unit(expr.right, scope)) throw new LanguageError('TYPE_MISMATCH', 'Comparison units differ.');
    return 'Boolean';
  }
  if (!['Integer','Decimal','Money','Price'].includes(left)) throw new LanguageError('TYPE_MISMATCH', 'Arithmetic needs numeric operands.');
  if (expr.operator === 'add' || expr.operator === 'subtract') {
    if (left !== right || unit(expr.left, scope) !== unit(expr.right, scope)) throw new LanguageError('TYPE_MISMATCH', 'Arithmetic units differ.');
  } else if (right !== 'Decimal') throw new LanguageError('TYPE_MISMATCH', 'Scaling requires a dimensionless Decimal on the right.');
  return left;
}
export function evaluateExpression(expr: Expression, visit: () => void = () => {}, scope: ValueScope = noScope): BoundValue {
  visit();
  if (expr.kind === 'literal') { validateLiteral(expr); return expr; }
  if (expr.kind === 'ref' || expr.kind === 'field') { const value = lookupField(expr, scope(expr.name)); validateLiteral(value); return value; }
  if (expr.kind === 'logical') {
    if ((expr.operator === 'not' && expr.operands.length !== 1) || (expr.operator !== 'not' && expr.operands.length < 2)) throw new LanguageError('TYPE_MISMATCH', 'Invalid logical arity.');
    let result = expr.operator === 'and';
    for (const operand of expr.operands) {
      const value = evaluateExpression(operand, visit, scope);
      if (value.valueType !== 'Boolean') throw new LanguageError('TYPE_MISMATCH', 'Logical operands must be Boolean.');
      if (expr.operator === 'not') result = !value.value;
      else { result = value.value; if ((expr.operator === 'and' && !result) || (expr.operator === 'or' && result)) break; }
    }
    return { kind: 'literal', valueType: 'Boolean', value: result };
  }
  const left = evaluateExpression(expr.left, visit, scope); const right = evaluateExpression(expr.right, visit, scope);
  if (left.valueType === 'Text' || right.valueType === 'Text') throw new LanguageError('TYPE_MISMATCH', 'Text cannot be compared or used in arithmetic.');
  if (expr.kind === 'compare') {
    if (!compatible(left, right) || ((left.valueType === 'Boolean' || left.valueType === 'Enum') && !['eq','ne'].includes(expr.operator))) throw new LanguageError('TYPE_MISMATCH', 'Comparison units or operator are incompatible.');
    const a = scalar(left); const b = scalar(right);
    const value = expr.operator === 'eq' ? a === b : expr.operator === 'ne' ? a !== b : expr.operator === 'lt' ? a < b : expr.operator === 'lte' ? a <= b : expr.operator === 'gt' ? a > b : a >= b;
    return { kind: 'literal', valueType: 'Boolean', value };
  }
  const a = numeric(left); let result: bigint;
  if (expr.operator === 'add' || expr.operator === 'subtract') {
    if (!compatible(left, right)) throw new LanguageError('TYPE_MISMATCH', 'Arithmetic units differ.');
    result = expr.operator === 'add' ? a + numeric(right) : a - numeric(right);
  } else {
    if (right.valueType !== 'Decimal') throw new LanguageError('TYPE_MISMATCH', 'Scaling requires a dimensionless Decimal on the right.');
    const b = decimal(right.value);
    if (expr.operator === 'divide' && b === 0n) throw new LanguageError('INVALID_AMOUNT', 'Division by zero.');
    const numerator = expr.operator === 'multiply' ? a * b : a * SCALE;
    const denominator = expr.operator === 'multiply' ? SCALE : b;
    if (numerator % denominator !== 0n) throw new LanguageError('INVALID_AMOUNT', 'Result cannot be represented exactly; use fewer fractional places.');
    result = numerator / denominator;
  }
  return arithmeticValue(left, result);
}
