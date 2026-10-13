// Application sessions for hosted mode (API-1, issue #16, D56). A verified provider token is exchanged once for
// an opaque HTTP-only cookie; the tenant is always derived from the stored session, never from the request.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { ControlError, newId } from "../control.ts";
import { AuthError, type IdentityVerifier } from "./verifier.ts";

export const SESSION_COOKIE = "__Host-monad_session";
const TOKEN = /^[0-9a-f]{64}$/;
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();

export function sessionToken(cookie: string | undefined): string | undefined {
  const value = cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return value && TOKEN.test(value) ? value : undefined;
}

export interface SessionOptions {
  pool: pg.Pool;
  verifier: IdentityVerifier;
  /** Application session lifetime; independent of the provider token's own (short) expiry. */
  ttlSeconds?: number;
}

export class SessionService {
  readonly #pool: pg.Pool;
  readonly #verifier: IdentityVerifier;
  readonly #ttl: number;
  constructor(options: SessionOptions) {
    this.#pool = options.pool;
    this.#verifier = options.verifier;
    this.#ttl = options.ttlSeconds ?? 8 * 60 * 60;
  }

  /** Verify a provider token and open a session. The first login creates the tenant and identity together. */
  async login(providerToken: string): Promise<{ tenant: string; cookie: string; expiresAt: string }> {
    let identity;
    try {
      identity = await this.#verifier.verify(providerToken);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      throw new ControlError(401, "UNAUTHENTICATED", "Sign-in could not be verified. Sign in again.");
    }
    const token = randomBytes(32).toString("hex");
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`identity:${identity.provider}:${identity.subject}`]);
      let tenant = (await client.query<{ tenant_id: string }>(
        "select tenant_id from identities where provider=$1 and subject=$2",
        [identity.provider, identity.subject],
      )).rows[0]?.tenant_id;
      if (!tenant) {
        tenant = (await client.query<{ id: string }>(
          "insert into tenants(id,auth_subject) values($1,$2) returning id",
          [newId(), `${identity.provider}:${identity.subject}`],
        )).rows[0]!.id;
        await client.query("insert into identities(provider,subject,tenant_id) values($1,$2,$3)", [identity.provider, identity.subject, tenant]);
      }
      const state = (await client.query<{ state: string }>("select state from tenants where id=$1", [tenant])).rows[0]?.state;
      if (state !== "active") throw new ControlError(403, "FORBIDDEN", "This account is suspended.");
      const expires = (await client.query<{ expires_at: Date }>(
        `insert into sessions(token_hash,tenant_id,provider,subject,expires_at)
        values($1,$2,$3,$4,now() + make_interval(secs => $5)) returning expires_at`,
        [hash(token), tenant, identity.provider, identity.subject, this.#ttl],
      )).rows[0]!.expires_at;
      await client.query("commit");
      return {
        tenant,
        cookie: `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${this.#ttl}`,
        expiresAt: expires.toISOString(),
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The tenant of a live, unrevoked session, or undefined. Suspension is checked by the API on every request. */
  async authenticate(cookie: string | undefined): Promise<string | undefined> {
    const token = sessionToken(cookie);
    if (!token) return undefined;
    const { rows } = await this.#pool.query<{ tenant_id: string }>(
      "select tenant_id from sessions where token_hash=$1 and revoked_at is null and expires_at > now()",
      [hash(token)],
    );
    return rows[0]?.tenant_id;
  }

  /** Revoke the presented session (idempotent) and return a cookie that clears it. */
  async logout(cookie: string | undefined): Promise<string> {
    const token = sessionToken(cookie);
    if (token)
      await this.#pool.query("update sessions set revoked_at=now() where token_hash=$1 and revoked_at is null", [hash(token)]);
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
  }
}
