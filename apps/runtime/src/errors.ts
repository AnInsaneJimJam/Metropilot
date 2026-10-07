// Stable runtime error codes (agent-runtime.md section 11). Messages are safe: no tokens, prompts or payloads.
export type RuntimeErrorCode =
  | 'ASSIGNMENT_INVALID' // malformed, expired, wrong mode/image/version or hash mismatch: never retried
  | 'FENCED' // a newer lease owns this run: stop writes and dispatch immediately
  | 'REVOKED' // generation paused, stopped or replaced: drain, dispatch nothing new
  | 'DRAINING' // this process is draining: start no new step or dispatch
  | 'CONFLICT' // same logical key presented with a different body or outcome
  | 'RESULT_INVALID' // a service answer failed its schema: fail closed, never pass it to the interpreter
  | 'UNAVAILABLE' // dependency unreachable; retry boundedly with the same logical identity
  | 'HOST_BUG'; // interpreter refused the host's own checkpoint/response: a runtime defect, not a run failure

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

/** Codes after which this process must stop working on the assignment and stop all dispatch. */
export const LOSES_AUTHORITY: ReadonlySet<RuntimeErrorCode> = new Set(['FENCED', 'REVOKED', 'DRAINING']);
