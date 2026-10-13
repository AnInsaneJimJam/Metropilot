// Provider token verification (API-1, issue #16, D56). Tokens are untrusted input: the algorithm is pinned,
// the key comes from configuration (never from the token), and issuer, audience, subject and times are checked
// before any claim is used. No JWT library: node:crypto verifies ES256 against one configured P-256 key.
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface VerifiedIdentity {
  provider: string;
  subject: string;
}

export interface IdentityVerifier {
  readonly provider: string;
  /** Resolves the verified identity or throws AuthError; never returns an unverified claim. */
  verify(token: string): Promise<VerifiedIdentity>;
}

export class AuthError extends Error {
  override name = "AuthError";
}

const MAX_TOKEN_BYTES = 8192;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJson(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AuthError("token segment is not an object");
  return value as Record<string, unknown>;
}

/** Load an ES256 (P-256) verification key from SPKI PEM; refuses any other key type at startup. */
export function es256Key(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem.replaceAll("\\n", "\n"));
  } catch {
    throw new AuthError("the verification key is not a PEM public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new AuthError("the verification key must be an ES256 (P-256) public key");
  return key;
}

export interface Es256Options {
  key: KeyObject;
  issuer: string;
  audience: string;
  subject: RegExp;
  /** Seconds of clock difference tolerated on exp/iat/nbf. */
  skewSeconds?: number;
  now?: () => number;
}

/** Verify a compact ES256 JWT and return its subject. Every failure is an AuthError with a non-secret reason. */
export function verifyEs256(token: string, options: Es256Options): string {
  if (typeof token !== "string" || token.length > MAX_TOKEN_BYTES) throw new AuthError("token missing or too large");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) throw new AuthError("token is not a compact JWT");
  const [head, body, signature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(head);
    claims = decodeJson(body);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("token segments are not JSON");
  }
  // Pin the algorithm before touching the signature: "none", HS256 and other algorithms are refused.
  if (header["alg"] !== "ES256") throw new AuthError("token algorithm is not ES256");
  if (header["crit"] !== undefined) throw new AuthError("token has unsupported critical headers");
  const raw = Buffer.from(signature, "base64url");
  if (raw.length !== 64) throw new AuthError("token signature has the wrong length");
  const signed = verify("sha256", Buffer.from(`${head}.${body}`, "ascii"), { key: options.key, dsaEncoding: "ieee-p1363" }, raw);
  if (!signed) throw new AuthError("token signature is invalid");

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const skew = options.skewSeconds ?? 30;
  if (claims["iss"] !== options.issuer) throw new AuthError("token issuer is not accepted");
  const aud = claims["aud"];
  if (!(aud === options.audience || (Array.isArray(aud) && aud.includes(options.audience)))) throw new AuthError("token audience is not this application");
  const exp = claims["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now - skew) throw new AuthError("token has expired");
  const iat = claims["iat"];
  if (iat !== undefined && (typeof iat !== "number" || iat > now + skew)) throw new AuthError("token is issued in the future");
  const nbf = claims["nbf"];
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + skew)) throw new AuthError("token is not yet valid");
  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.length > 255 || !options.subject.test(sub)) throw new AuthError("token subject is malformed");
  return sub;
}

export interface PrivyConfig {
  appId: string;
  /** The app's verification key (SPKI PEM) from the Privy dashboard. Rotating it is a configuration change. */
  verificationKey: string;
  now?: () => number;
}

/**
 * Privy access tokens: ES256, `iss` "privy.io", `aud` the app ID, `sub` the user's Privy DID
 * (docs.privy.io/authentication/user-authentication/access-tokens, rechecked 2026-10-13).
 */
export class PrivyVerifier implements IdentityVerifier {
  readonly provider = "privy";
  readonly #key: KeyObject;
  readonly #config: PrivyConfig;
  constructor(config: PrivyConfig) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(config.appId)) throw new AuthError("PRIVY_APP_ID is malformed");
    this.#key = es256Key(config.verificationKey);
    this.#config = config;
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    const subject = verifyEs256(token, {
      key: this.#key,
      issuer: "privy.io",
      audience: this.#config.appId,
      subject: /^did:privy:[A-Za-z0-9]{8,64}$/,
      ...(this.#config.now ? { now: this.#config.now } : {}),
    });
    return { provider: this.provider, subject };
  }
}
