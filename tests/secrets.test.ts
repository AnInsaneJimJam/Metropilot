// G1 secrets handling: no credential-shaped content in tracked or new (non-ignored) files, and .env stays local.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

// Synthetic values that are documented as non-secret placeholders.
const allowedValues = new Set(['change-me-local-only', 'ci-config-check-only', 'ci-only-not-a-secret', '***']);
const configExtensions = new Set(['.env', '.example', '.yml', '.yaml', '.json', '.toml']);

const tokenPatterns: [string, RegExp][] = [
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key ID', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['provider API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['hex private key or seed', /(?:private[_-]?key|mnemonic|seed[_-]?phrase)["']?\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{64}\b/i],
];
// Passwords under 8 characters are treated as test placeholders.
const urlPassword = /\bpostgres(?:ql)?:\/\/[^:/\s]+:([^@\s]{8,})@/g;
const assignment = /(?<![A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?token)\s*[:=]\s*["']?([^\s"'#,]{8,})/gi;

const allowed = (value: string): boolean => allowedValues.has(value) || value.startsWith('${');

/** Returns a description per finding; never the matched value itself. */
export function findSecrets(path: string, text: string): string[] {
  const findings = tokenPatterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${path}: ${label}`);
  for (const match of text.matchAll(urlPassword)) if (!allowed(match[1]!)) findings.push(`${path}: password in database URL`);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (configExtensions.has(extname(name)) || name.startsWith('.env')) {
    for (const match of text.matchAll(assignment)) if (!allowed(match[1]!)) findings.push(`${path}: credential assignment`);
  }
  return findings;
}

const candidateFiles = (): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '' && !/\.(png|jpe?g|gif|ico|pdf|woff2?)$/i.test(path));

test('the secret detector flags credential shapes and allows documented placeholders', () => {
  const pem = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
  const positives = [
    `key = "${pem}"`,
    `id=${'AKIA'}${'Q'.repeat(16)}`,
    `token: ${'ghp'}_${'a'.repeat(36)}`,
    `KIMI_KEY=${'sk'}-${'b'.repeat(32)}`,
    `privateKey: "0x${'1'.repeat(64)}"`,
    `DATABASE_URL=postgres://monad:${'real'}Password1@127.0.0.1/db`,
  ];
  for (const text of positives) assert.ok(findSecrets('sample.env', text).length > 0, text.slice(0, 12));
  assert.ok(findSecrets('ci.yml', `POSTGRES_PASSWORD: ${'hunter'}2hunter2`).length > 0);
  const negatives = [
    `provenanceHash: "0x${'c'.repeat(64)}"`,
    'DATABASE_URL=postgres://monad:change-me-local-only@127.0.0.1:5432/monad_dev',
    'POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it}',
  ];
  for (const text of negatives) assert.deepEqual(findSecrets('sample.env', text), [], text);
  // Assignment heuristics apply to config files only, so ordinary code is not flagged.
  assert.deepEqual(findSecrets('config.ts', 'const password = requireEnv(env, "POSTGRES_PASSWORD");'), []);
});

test('no tracked or new file contains secret-shaped content', () => {
  const findings: string[] = [];
  for (const path of candidateFiles()) {
    const full = join(root, path);
    if (statSync(full, { throwIfNoEntry: false })?.isFile() !== true) continue;
    findings.push(...findSecrets(path, readFileSync(full, 'utf8')));
  }
  assert.deepEqual(findings, []);
});

test('.env files stay ignored and untracked', () => {
  const tracked = execFileSync('git', ['ls-files', '--', '.env', '*.env', '.env.*'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(tracked, ['.env.example']);
  for (const path of ['.env', 'apps/api/.env']) execFileSync('git', ['check-ignore', '--quiet', path], { cwd: root });
});
