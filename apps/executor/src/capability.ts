// Executor-audience runtime capability (docs/specs/agent-runtime.md section 6, executor.md section 2).
// Compact HS256 JWS with closed claims and at most five minutes of lifetime. The issuer is the control API;
// the signing secret is shared only between issuer and executor and never reaches a runtime.
// The claim set is executor-private until packages/contracts defines a capability contract
// (docs/integration/runtime-http-clients.md section 5); keep both sides equal to this file until then.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CAPABILITY_AUDIENCE = 'executor';
export const MAX_CAPABILITY_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;

export interface Capability {
  readonly aud: typeof CAPABILITY_AUDIENCE;
  readonly tenantId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  /** Positive base-10 integer string, as in intent-key/1. */
  readonly generation: string;
  readonly mode: 'paper' | 'live';
  readonly actions: readonly string[];
  /** Pinned connector versions from the immutable manifest. */
  readonly connectors: Readonly<Record<string, string>>;
  /** When present, the capability is valid for this run only. */
  readonly runId?: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export class CapabilityError extends Error {
  override name = 'CapabilityError';
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH32 = /^0x[0-9a-f]{64}$/;
const REF = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;
const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const CLAIMS = new Set(['aud', 'tenantId', 'agentId', 'deploymentId', 'generation', 'mode', 'actions', 'connectors', 'runId', 'iat', 'exp', 'jti']);

const mac = (input: string, secret: Uint8Array): Buffer => createHmac('sha256', secret).update(input).digest();

/** Issue a capability (control API side, and tests). Claims are checked exactly as on receipt. */
export function signCapability(claims: Capability, secret: Uint8Array): string {
  checkClaims(claims);
  const body = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${mac(body, secret).toString('base64url')}`;
}

/** Verify signature, closed claims, audience and lifetime. Messages never include the token. */
export function verifyCapability(token: string, secret: Uint8Array, nowSeconds: number): Capability {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) throw new CapabilityError('capability is not an HS256 compact token');
  const signature = Buffer.from(parts[2]!, 'base64url');
  const expected = mac(`${parts[0]}.${parts[1]}`, secret);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new CapabilityError('capability signature is invalid');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new CapabilityError('capability claims are not JSON');
  }
  checkClaims(claims);
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new CapabilityError('capability is not yet valid');
  if (claims.exp <= nowSeconds) throw new CapabilityError('capability has expired');
  return claims;
}

function checkClaims(value: unknown): asserts value is Capability {
  const fail = (what: string): never => {
    throw new CapabilityError(`capability claim ${what} is invalid`);
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('set');
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!CLAIMS.has(key)) fail(key);
  if (c['aud'] !== CAPABILITY_AUDIENCE) fail('aud');
  for (const key of ['tenantId', 'agentId', 'deploymentId', 'jti']) if (typeof c[key] !== 'string' || !UUID7.test(c[key] as string)) fail(key);
  if (typeof c['generation'] !== 'string' || !/^[1-9][0-9]{0,18}$/.test(c['generation'])) fail('generation');
  if (c['mode'] !== 'paper' && c['mode'] !== 'live') fail('mode');
  const actions = c['actions'];
  if (!Array.isArray(actions) || actions.length > 8 || !actions.every((a) => typeof a === 'string' && REF.test(a))) fail('actions');
  const connectors = c['connectors'];
  if (typeof connectors !== 'object' || connectors === null || Array.isArray(connectors)) fail('connectors');
  const pins = Object.entries(connectors as Record<string, unknown>);
  if (pins.length > 16 || !pins.every(([ref, version]) => REF.test(ref) && ref.length <= 128 && typeof version === 'string' && SEMVER.test(version))) fail('connectors');
  if (c['runId'] !== undefined && (typeof c['runId'] !== 'string' || !HASH32.test(c['runId']))) fail('runId');
  if (!Number.isSafeInteger(c['iat']) || !Number.isSafeInteger(c['exp'])) fail('iat/exp');
  const lifetime = (c['exp'] as number) - (c['iat'] as number);
  if (lifetime <= 0 || lifetime > MAX_CAPABILITY_SECONDS) fail('lifetime');
}
