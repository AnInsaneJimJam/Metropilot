// Provider token verification and hosted configuration (issue #16). No database: tokens are signed here with a
// throwaway P-256 key, exactly as Privy signs access tokens; the session/tenant checks run in tests/hosted-auth.test.ts.
import assert from "node:assert/strict";
import { generateKeyPairSync, createHmac, sign } from "node:crypto";
import { describe, test } from "node:test";
import pg from "pg";
import { syntheticCatalog } from "@monad-hack/strategy";
import { ConfigError } from "../config.ts";
import { createApp } from "../app.ts";
import { createHostedApp, hostedConfig } from "../hosted.ts";
import { ControlStore } from "../store.ts";
import { AuthError, PrivyVerifier, es256Key } from "./verifier.ts";
import { sessionToken, SESSION_COOKIE } from "./sessions.ts";

const APP_ID = "test-privy-app-0001";
const SUBJECT = "did:privy:cm0testsubject0001";
const NOW = 1_800_000_000;
const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keys = pair();
const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(claims: Record<string, unknown>, options: { key?: ReturnType<typeof pair>["privateKey"]; header?: Record<string, unknown> } = {}): string {
  const input = `${b64(options.header ?? { alg: "ES256", typ: "JWT" })}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), { key: options.key ?? keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}
const claims = (overrides: Record<string, unknown> = {}) => ({ iss: "privy.io", aud: APP_ID, sub: SUBJECT, sid: "s1", iat: NOW - 10, exp: NOW + 3600, ...overrides });
const verifier = new PrivyVerifier({ appId: APP_ID, verificationKey: pem, now: () => NOW * 1000 });

describe("Privy access-token verification", () => {
  test("a correctly signed token yields the provider identity", async () => {
    assert.deepEqual(await verifier.verify(signToken(claims())), { provider: "privy", subject: SUBJECT });
    // Privy may send an audience array; the app ID must be in it.
    assert.equal((await verifier.verify(signToken(claims({ aud: ["other", APP_ID] })))).subject, SUBJECT);
  });

  test("several published keys (rotation): a token signed by any of them verifies, others are refused", async () => {
    const second = pair();
    const both = new PrivyVerifier({ appId: APP_ID, verificationKey: `${pem}\n${second.publicKey.export({ type: "spki", format: "pem" }).toString()}`, now: () => NOW * 1000 });
    assert.equal((await both.verify(signToken(claims(), { key: second.privateKey }))).subject, SUBJECT);
    assert.equal((await both.verify(signToken(claims()))).subject, SUBJECT);
    await assert.rejects(both.verify(signToken(claims(), { key: pair().privateKey })), AuthError);
  });

  test("forged, tampered, foreign and expired tokens are refused", async () => {
    const good = signToken(claims());
    const [h, , s] = good.split(".");
    const forged = [
      ["another key", signToken(claims(), { key: pair().privateKey })],
      ["tampered claims", `${h}.${b64(claims({ sub: "did:privy:cm0attacker000001" }))}.${s}`],
      ["alg none", `${b64({ alg: "none" })}.${b64(claims())}.`],
      // Algorithm confusion: an HMAC over the token keyed with the public key must not verify.
      ["alg HS256", (() => { const i = `${b64({ alg: "HS256" })}.${b64(claims())}`; return `${i}.${createHmac("sha256", pem).update(i).digest("base64url")}`; })()],
      ["critical header", signToken(claims(), { header: { alg: "ES256", crit: ["x"] } })],
      ["wrong issuer", signToken(claims({ iss: "evil.example" }))],
      ["wrong audience", signToken(claims({ aud: "another-app-0001" }))],
      ["expired", signToken(claims({ exp: NOW - 60 }))],
      ["missing expiry", signToken(claims({ exp: undefined }))],
      ["issued in the future", signToken(claims({ iat: NOW + 600 }))],
      ["not yet valid", signToken(claims({ nbf: NOW + 600 }))],
      ["malformed subject", signToken(claims({ sub: "tenant:0195a000-0000-7000-8000-000000000001" }))],
      ["not a JWT", "not-a-token-at-all-really"],
      ["oversized", `${"a".repeat(9000)}.b.c`],
      ["truncated signature", `${h}.${good.split(".")[1]}.${s!.slice(0, 20)}`],
    ] as const;
    for (const [label, token] of forged)
      await assert.rejects(verifier.verify(token), AuthError, label);
  });

  test("the configured key must be an ES256 (P-256) public key", () => {
    assert.throws(() => es256Key("not a key"), AuthError);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const key of [rsa, ed, p384]) assert.throws(() => es256Key(key), AuthError);
    // A key pasted into an env file with literal \n sequences still loads.
    assert.equal(es256Key(pem.replaceAll("\n", "\\n")).asymmetricKeyType, "ec");
    assert.throws(() => new PrivyVerifier({ appId: "bad id!", verificationKey: pem }), AuthError);
  });

  test("only a well-formed session cookie is read", () => {
    const token = "ab".repeat(32);
    assert.equal(sessionToken(`a=1; ${SESSION_COOKIE}=${token}`), token);
    for (const cookie of [undefined, `monad_session=${token}`, `${SESSION_COOKIE}=xyz`, `${SESSION_COOKIE}=${token}00`]) assert.equal(sessionToken(cookie), undefined);
  });
});

describe("hosted entry point", () => {
  const env = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://monad:pw@db.internal:5432/monad",
    PUBLIC_ORIGIN: "https://studio.example",
    PRIVY_APP_ID: APP_ID,
    PRIVY_VERIFICATION_KEY: pem,
    RUNTIME_IMAGE_DIGEST: "0x" + "5a".repeat(32),
  };

  test("refuses development, plain-HTTP and incomplete configuration without echoing values", () => {
    assert.equal(hostedConfig(env).origin, "https://studio.example");
    const bad: Record<string, string | undefined>[] = [
      { NODE_ENV: "development" },
      { LOCAL_WORKSPACE: "1" },
      { PUBLIC_ORIGIN: "http://studio.example" },
      { PUBLIC_ORIGIN: "https://studio.example/app" },
      { PRIVY_APP_ID: undefined },
      { PRIVY_VERIFICATION_KEY: undefined },
      { RUNTIME_IMAGE_DIGEST: "latest" },
      { PORT: "99999" },
    ];
    for (const change of bad)
      assert.throws(() => hostedConfig({ ...env, ...change }), (error: Error) => error instanceof ConfigError && !error.message.includes(pem.slice(30, 60)), JSON.stringify(change));
    const pool = new pg.Pool();
    try {
      assert.throws(() => createHostedApp(pool, hostedConfig({ ...env, PRIVY_VERIFICATION_KEY: "-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----" })), ConfigError);
    } finally {
      void pool.end();
    }
  });

  test("has no development session, requires an Origin on mutations and limits sign-in attempts", async () => {
    const pool = new pg.Pool();
    const app = createHostedApp(pool, hostedConfig(env));
    try {
      const session = await app.inject({ url: "/v1/session" });
      assert.equal(session.statusCode, 401);
      assert.equal(session.headers["set-cookie"], undefined);
      // A forged token is refused before any database access, so this needs no database.
      const forged = signToken(claims(), { key: pair().privateKey });
      const noOrigin = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { token: forged } });
      assert.equal(noOrigin.statusCode, 403);
      const headers = { origin: "https://studio.example" };
      assert.equal((await app.inject({ method: "POST", url: "/v1/auth/session", headers: { origin: "https://evil.example" }, payload: { token: forged } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/v1/auth/session", headers, payload: { token: forged, tenantId: "x" } })).statusCode, 400);
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await app.inject({ method: "POST", url: "/v1/auth/session", headers, payload: { token: forged } })).statusCode);
      assert.deepEqual(statuses, [...Array(10).fill(401), 429, 429]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  test("a server cannot combine the development session with a hosted identity provider", () => {
    const store = new ControlStore(new pg.Pool());
    assert.throws(() => createApp({
      store,
      catalog: async () => syntheticCatalog,
      origin: "https://studio.example",
      authenticate: async () => undefined,
      localSession: async () => ({ tenant: "t", cookie: "c" }),
      identity: { login: async () => ({ cookie: "c", expiresAt: "" }), logout: async () => "c" },
    }), /cannot be combined/);
    void store.pool.end();
  });
});
