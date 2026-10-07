// Closed runtime configuration (agent-runtime.md section 15). The process refuses to start when any
// credential-shaped variable is present: a runtime must never hold database, model, wallet or cloud secrets.
import { RuntimeError } from './errors.ts';

export interface RuntimeConfig {
  readonly runtimeId: string;
  readonly mode: 'paper' | 'live';
  /** Digest of the image this process runs; assignments for another image are refused. */
  readonly imageDigest: string;
  readonly heartbeatMillis: number;
  readonly pollWaitSeconds: number;
}

const FORBIDDEN = [
  /^DATABASE_URL$/, /^PG[A-Z]*$/, /^AWS_/, /^ALIBABA_/, /^GOOGLE_APPLICATION_CREDENTIALS$/,
  /^PRIVY_/, /(^|_)(API|SECRET|PRIVATE|SIGNING|ACCESS)_?KEY$/, /(^|_)TOKEN$/, /(^|_)PASSWORD$/, /MNEMONIC/, /^RPC_URL/, /^KIMI_/, /^QWEN_/, /^OPENAI_/, /^ANTHROPIC_/,
];

export function parseConfig(env: Readonly<Record<string, string | undefined>>): RuntimeConfig {
  const present = Object.keys(env).filter((name) => env[name] !== undefined && FORBIDDEN.some((rule) => rule.test(name)));
  // Name the variables, never their values.
  if (present.length) throw new RuntimeError('ASSIGNMENT_INVALID', `Forbidden credential-shaped variables are set: ${present.sort().join(', ')}.`);
  const id = env['RUNTIME_ID'];
  if (!id || !/^[!-~]{1,128}$/.test(id)) throw new RuntimeError('ASSIGNMENT_INVALID', 'RUNTIME_ID must be 1-128 printable characters.');
  const mode = env['RUNTIME_MODE'];
  if (mode !== 'paper' && mode !== 'live') throw new RuntimeError('ASSIGNMENT_INVALID', 'RUNTIME_MODE must be paper or live.');
  const imageDigest = env['RUNTIME_IMAGE_DIGEST'];
  if (!imageDigest || !/^0x[0-9a-f]{64}$/.test(imageDigest)) throw new RuntimeError('ASSIGNMENT_INVALID', 'RUNTIME_IMAGE_DIGEST must be a 0x SHA-256 digest.');
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RuntimeError('ASSIGNMENT_INVALID', `${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  return { runtimeId: id, mode, imageDigest, heartbeatMillis: int('RUNTIME_HEARTBEAT_MS', 10_000, 100, 30_000), pollWaitSeconds: int('RUNTIME_POLL_WAIT_SECONDS', 25, 0, 30) };
}
