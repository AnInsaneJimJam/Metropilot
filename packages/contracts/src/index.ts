// Contract validation for untrusted input. The JSON Schemas (strategy.schema.json and ../schemas) are the
// source of truth; generated.ts and generated-contracts.ts are derived from them by `pnpm generate`.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import schema from './strategy.schema.json' with { type: 'json' };
import common from '../schemas/common.schema.json' with { type: 'json' };
import deploymentRequest from '../schemas/deployment-request-1.schema.json' with { type: 'json' };
import errorBody from '../schemas/error-1.schema.json' with { type: 'json' };
import event from '../schemas/event-1.schema.json' with { type: 'json' };
import auditEvent from '../schemas/audit-event-1.schema.json' with { type: 'json' };
import type { Strategy } from './generated.ts';
import type { ErrorCode, GeneratedContractMap } from './generated-contracts.ts';
export type { Strategy, Expression, Statement, Trigger, Price, Money, Amount, RunCheckpoint, Frame, Waiting } from './generated.ts';
export type * from './generated-contracts.ts';
export { schema as strategySchema };
export { canonicalize, contentHash } from './canonical.ts';

export type ContractDocumentMap = GeneratedContractMap & { strategy: Strategy };
export type ContractKind = keyof ContractDocumentMap;

export const schemaBaseUri = 'https://monad-hack.example/schemas/';
export const schemaDocuments: readonly object[] = [schema, common, deploymentRequest, errorBody, event, auditEvent];

/** Schema reference per kind; strategy is absolute because its schema lives beside the language core. */
export const contractRefs = {
  strategy: schema.$id,
  deploymentRequest: schemaBaseUri + 'deployment-request-1.schema.json',
  error: schemaBaseUri + 'error-1.schema.json',
  event: schemaBaseUri + 'event-1.schema.json',
  auditEvent: schemaBaseUri + 'audit-event-1.schema.json',
  assetIdentity: schemaBaseUri + 'common.schema.json#/$defs/assetIdentity',
} as const satisfies Record<ContractKind, string>;

/** UTF-8 byte ceilings checked before JSON parsing (strategy-language.md section 7, runtime.md limits). */
export const maxDocumentBytes: Readonly<Record<ContractKind, number>> = {
  strategy: 256 * 1024,
  deploymentRequest: 1024 * 1024,
  error: 16 * 1024,
  event: 64 * 1024,
  auditEvent: 64 * 1024,
  assetIdentity: 4 * 1024,
};

export type ContractIssueCode = Extract<ErrorCode, 'SCHEMA_INVALID' | 'LIMIT_EXCEEDED' | 'MALFORMED_REQUEST'>;

export interface ContractIssue {
  code: ContractIssueCode;
  /** RFC 6901 pointer to the offending value; for missing or unknown fields, to that field. */
  fieldPath: string;
  keyword: string;
  message: string;
}

export type ContractResult<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

const UINT256_MAX = 2n ** 256n - 1n;

const addFormats = (ajv: Ajv2020): Ajv2020 => {
  // CommonJS interop: the plugin is the module's default export property.
  ajvFormats.default(ajv, ['date-time']);
  return ajv.addFormat('uint256', {
    type: 'string',
    validate: (value: string) => /^[0-9]{1,78}$/.test(value) && BigInt(value) <= UINT256_MAX,
  });
};

// strictRequired is off because discriminated-union wrappers require a tag their branches define.
const ajv = addFormats(new Ajv2020({ strict: true, strictRequired: false, discriminator: true, allErrors: false, ownProperties: true }));
for (const document of schemaDocuments) ajv.addSchema(document);

const validators = new Map<ContractKind, ValidateFunction>();
const validatorFor = (kind: ContractKind): ValidateFunction => {
  let validator = validators.get(kind);
  if (!validator) {
    validator = ajv.getSchema(contractRefs[kind]);
    if (!validator) throw new Error(`no schema registered for contract kind ${kind}`);
    validators.set(kind, validator);
  }
  return validator;
};

const pointerSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');

const toIssue = (error: ErrorObject): ContractIssue => {
  const field =
    error.keyword === 'required'
      ? (error.params as { missingProperty: string }).missingProperty
      : error.keyword === 'additionalProperties'
        ? (error.params as { additionalProperty: string }).additionalProperty
        : undefined;
  return {
    code: 'SCHEMA_INVALID',
    fieldPath: field === undefined ? error.instancePath : `${error.instancePath}/${pointerSegment(field)}`,
    keyword: error.keyword,
    message: error.message ?? 'invalid',
  };
};

/** Validate an already-parsed value. Never casts: the value is typed only when ok is true. */
export function validate<K extends ContractKind>(kind: K, value: unknown): ContractResult<ContractDocumentMap[K]> {
  const validator = validatorFor(kind);
  if (validator(value)) return { ok: true, value: value as ContractDocumentMap[K] };
  return { ok: false, issues: (validator.errors ?? []).map(toIssue) };
}

/** Enforce the byte ceiling, parse JSON text and validate. Duplicate keys are rejected later by JCS canonicalization. */
export function parse<K extends ContractKind>(kind: K, text: string): ContractResult<ContractDocumentMap[K]> {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxDocumentBytes[kind]) {
    return {
      ok: false,
      issues: [
        {
          code: 'LIMIT_EXCEEDED',
          fieldPath: '',
          keyword: 'maxBytes',
          message: `document is ${bytes} bytes; limit is ${maxDocumentBytes[kind]}`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: 'MALFORMED_REQUEST', fieldPath: '', keyword: 'json', message: 'not valid JSON' }] };
  }
  return validate(kind, value);
}

// Language-core validators: one most-specific error for editor and compiler messages.
const strategyAjv = addFormats(new Ajv2020({ strict: true, allErrors: false, ownProperties: true }));
const validateStrategy = strategyAjv.compile<Strategy>(schema);
export function checkStrategyShape(value: unknown): { valid: true; strategy: Strategy } | { valid: false; path: string; message: string } {
  if (validateStrategy(value)) return { valid: true, strategy: value };
  const errors = validateStrategy.errors ?? [];
  const useful = errors.filter(e => !['const', 'oneOf', 'required'].includes(e.keyword));
  const error = (useful.length ? useful : errors).toSorted((a, b) => b.instancePath.split('/').length - a.instancePath.split('/').length)[0];
  return { valid: false, path: error?.instancePath ?? '', message: error?.message ?? 'Invalid strategy' };
}

const validateCheckpoint = strategyAjv.compile({ $defs: schema.$defs, $ref: "#/$defs/RunCheckpoint" });
export function checkCheckpointShape(value: unknown): boolean { return validateCheckpoint(value); }
