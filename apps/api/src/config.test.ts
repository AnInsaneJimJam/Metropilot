// Configuration never echoes secret values and the startup preflight catches common .env mistakes.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, databaseUrl, isLoopback, redactUrl } from './config.ts';
import { preflight } from './db/cli.ts';

const secret = 'pw-' + 'x'.repeat(12);

test('missing or malformed DATABASE_URL errors name the variable, never the value', () => {
  assert.throws(() => databaseUrl({}), (error: Error) => error instanceof ConfigError && /DATABASE_URL is not set/.test(error.message));
  for (const bad of [`not a url ${secret}`, `mysql://u:${secret}@127.0.0.1/db`]) {
    assert.throws(() => databaseUrl({ DATABASE_URL: bad }), (error: Error) => error instanceof ConfigError && !error.message.includes(secret));
  }
});

test('redactUrl hides the password', () => {
  const url = databaseUrl({ DATABASE_URL: `postgres://monad:${secret}@127.0.0.1:5432/monad_dev` });
  assert.equal(redactUrl(url), 'postgres://monad:***@127.0.0.1:5432/monad_dev');
  assert.ok(isLoopback(url));
  assert.ok(!isLoopback(new URL('postgres://u:p@db.example.com/x')));
});

function repo(withEnvFile: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'));
  writeFileSync(join(root, '.node-version'), `${process.versions.node}\n`);
  if (withEnvFile) writeFileSync(join(root, '.env'), '');
  return root;
}
const goodEnv = { POSTGRES_USER: 'monad', POSTGRES_PASSWORD: secret, DATABASE_URL: `postgres://monad:${secret}@127.0.0.1:5432/monad_dev` };

test('preflight passes a correct local setup', () => {
  assert.deepEqual(preflight(goodEnv, repo(true)), []);
});

test('preflight reports each setup mistake without printing secrets', () => {
  const cases: [Record<string, string>, boolean, RegExp][] = [
    [goodEnv, false, /\.env is missing/],
    [{ ...goodEnv, POSTGRES_PASSWORD: 'change-me-local-only' }, true, /example value/],
    [{ ...goodEnv, DATABASE_URL: `postgres://monad:other@127.0.0.1:5432/monad_dev` }, true, /does not match POSTGRES_PASSWORD/],
    [{ ...goodEnv, DATABASE_URL: `postgres://monad:${secret}@db.example.com:5432/monad_dev` }, true, /local database/],
    [{ POSTGRES_PASSWORD: secret }, true, /DATABASE_URL is not set/],
  ];
  for (const [env, withEnvFile, expected] of cases) {
    const problems = preflight(env, repo(withEnvFile)).join('\n');
    assert.match(problems, expected);
    assert.ok(!problems.includes(secret));
  }
});
