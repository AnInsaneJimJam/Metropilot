// Stable accounting failure codes. Callers map them to the shared API vocabulary (INSUFFICIENT_BUDGET,
// RECONCILIATION_REQUIRED, IDEMPOTENCY_CONFLICT, REVISION_CONFLICT) or to executor reason codes.
export type AccountingCode =
  | 'INSUFFICIENT_BUDGET'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'RECONCILIATION_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'STATE_CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID';

export class AccountingError extends Error {
  readonly code: AccountingCode;
  readonly details: Readonly<Record<string, string>>;
  constructor(code: AccountingCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'AccountingError';
    this.code = code;
    this.details = details;
  }
}

export function invalid(message: string): never {
  throw new AccountingError('INVALID', message);
}
