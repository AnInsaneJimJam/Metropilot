// Relative links in Markdown resolve to files or directories that exist in the working tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

test('relative Markdown links resolve', () => {
  const markdown = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(markdown.length > 0);
  const broken: string[] = [];
  for (const file of markdown) {
    // Ignore fenced code so examples are not treated as links.
    const text = readFileSync(join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = decodeURIComponent(target.split('#')[0]!);
      if (!existsSync(join(root, dirname(file), path))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
