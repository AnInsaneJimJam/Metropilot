import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from './strategy.schema.json' with { type: 'json' };
import type { Strategy } from './generated.ts';
export type { Strategy, Expression, Statement, Trigger, Price, Money, Amount, RunCheckpoint, Frame, Waiting } from './generated.ts';
export { schema as strategySchema };
const validate = new Ajv2020({ strict: true, allErrors: false, ownProperties: true }).compile<Strategy>(schema);
export function checkStrategyShape(value: unknown): { valid: true; strategy: Strategy } | { valid: false; path: string; message: string } {
  if (validate(value)) return { valid: true, strategy: value };
  const errors = validate.errors ?? [];
  const useful = errors.filter(e => !['const', 'oneOf', 'required'].includes(e.keyword));
  const error = (useful.length ? useful : errors).toSorted((a, b) => b.instancePath.split('/').length - a.instancePath.split('/').length)[0];
  return { valid: false, path: error?.instancePath ?? '', message: error?.message ?? 'Invalid strategy' };
}

const validateCheckpoint = new Ajv2020({ strict: true, ownProperties: true }).compile({ $defs: schema.$defs, $ref: "#/$defs/RunCheckpoint" });
export function checkCheckpointShape(value: unknown): boolean { return validateCheckpoint(value); }
