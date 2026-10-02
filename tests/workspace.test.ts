// G1 workspace baseline: manifests stay pinned, private and in the declared dependency direction.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

type Manifest = {
  name?: string;
  private?: boolean;
  type?: string;
  packageManager?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = join(import.meta.dirname, '..');
const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as Manifest;
const children = (parent: string): string[] =>
  readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);

const apps = children('apps');
const packages = children('packages');
const allDeps = (m: Manifest): Record<string, string> => ({ ...m.dependencies, ...m.devDependencies });

test('every app and package has a private ESM manifest with its scoped name', () => {
  for (const dir of [...apps, ...packages]) {
    const manifest = readManifest(dir);
    assert.equal(manifest.name, `@monad-hack/${dir.split('/')[1]}`, dir);
    assert.equal(manifest.private, true, dir);
    assert.equal(manifest.type, 'module', dir);
  }
});

test('external dependency versions are exact', () => {
  for (const dir of ['.', ...apps, ...packages]) {
    for (const [name, version] of Object.entries(allDeps(readManifest(dir)))) {
      if (version.startsWith('workspace:')) continue;
      assert.match(version, /^\d+\.\d+\.\d+$/, `${dir}: ${name}@${version}`);
    }
  }
});

test('packages never depend on apps', () => {
  const appNames = new Set(apps.map((dir) => readManifest(dir).name));
  for (const dir of packages) {
    for (const name of Object.keys(allDeps(readManifest(dir)))) {
      assert.ok(!appNames.has(name), `${dir} depends on app ${name}`);
    }
  }
});

test('Node and pnpm pins are exact and agree with the engines range', () => {
  const pinned = readFileSync(join(root, '.node-version'), 'utf8').trim();
  assert.match(pinned, /^24\.\d+\.\d+$/);
  assert.equal(readManifest('.').engines?.node, `>=${pinned} <25`);
  assert.match(readManifest('.').packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/);
});
