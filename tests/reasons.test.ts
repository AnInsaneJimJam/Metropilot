// Every reason code a producer can put in front of a user has vocabulary text (issue #19). Typed producers
// (executor denials, error-1 bodies, run-control errors) are already checked by the compiler; this scan covers the
// string-typed ones: language errors (run failures), user API errors (operation failures) and audit reasonCodes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reasons } from '../packages/contracts/src/index.ts';

const root = join(import.meta.dirname, '..');
const producers = ['apps/api/src', 'apps/executor/src', 'apps/runtime/src', 'packages/strategy/src', 'packages/policy/src'];
const patterns = [/LanguageError\(\s*'([A-Z][A-Z0-9_]*)'/g, /ControlError\(\s*\d{3},\s*["']([A-Z][A-Z0-9_]*)["']/g, /reasonCode: '([A-Z][A-Z0-9_]*)'/g];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) yield path;
  }
}

test('every string-typed reason code a producer emits has vocabulary text', () => {
  const emitted = new Map<string, string>();
  for (const file of producers.flatMap((dir) => [...sources(dir)])) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) emitted.set(match[1]!, file);
  }
  // The scan must see the producers it guards, or a refactor could silently empty it.
  for (const code of ['TYPE_MISMATCH', 'NOT_FOUND', 'GENERATION_REVOKED', 'CURSOR_EXPIRED']) assert.ok(emitted.has(code), `scan found ${code}`);
  const missing = [...emitted].filter(([code]) => !Object.hasOwn(reasons, code)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(missing, []);
});
