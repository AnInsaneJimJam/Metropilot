// The single status/error-1 → runtime code mapping (docs/integration/runtime-http-clients.md §3).
import { RuntimeError } from '../errors.ts';
import type { RuntimeErrorCode } from '../errors.ts';

/** Where the failing call went: a missing artifact is an invalid assignment, a missing run a conflict. */
export type CallKind = 'artifact' | 'other';

export function runtimeCodeFor(status: number, code: string | undefined, call: CallKind = 'other'): RuntimeErrorCode {
  if (status === 409 && code === 'LEASE_FENCED') return 'FENCED';
  if (status === 409 && code === 'GENERATION_REVOKED') return 'REVOKED';
  if (status === 409) return 'CONFLICT';
  if (status === 401 || status === 403) return 'REVOKED';
  if (status === 404) return call === 'artifact' ? 'ASSIGNMENT_INVALID' : 'CONFLICT';
  if (status === 400 || status === 422) return 'RESULT_INVALID';
  if (status === 500 && code === 'INTERNAL_ERROR') return 'RESULT_INVALID';
  if (status === 429 || status >= 500) return 'UNAVAILABLE';
  return 'RESULT_INVALID';
}

export function runtimeErrorFor(status: number, code: string | undefined, call: CallKind = 'other'): RuntimeError {
  // Safe message only: status and stable code, never the server's message or body.
  return new RuntimeError(runtimeCodeFor(status, code, call), `Control plane answered ${status}${code ? ` ${code}` : ''}.`);
}
