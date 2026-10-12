// Catalog resolution from catalog_versions (issue #18) against a real, seeded PostgreSQL database.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import { syntheticCatalog } from '@monad-hack/strategy';
import { CatalogResolver, wellFormed, type CatalogKind } from './catalog.ts';
import { ControlError } from './control.ts';
import { migrate } from './db/migrate.ts';
import { seedPaper } from './db/seed.ts';

const url = process.env['DATABASE_URL'];
if (!url && process.env['REQUIRE_DB'] === '1') throw new Error('DATABASE_URL required for catalog tests');

describe('catalog resolution / real PostgreSQL', { skip: !url }, () => {
  const dbName = `catalog_test_${randomBytes(8).toString('hex')}`;
  const resolver = new CatalogResolver();
  let admin: pg.Client;
  let pool: pg.Pool;
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  const disable = (ref: string, version: string, reason: string | null) =>
    pool.query('update catalog_versions set disabled_reason = $3 where ref = $1 and version = $2', [ref, version, reason]);
  const refusal = async (work: Promise<unknown>, code: string, needle: string) => {
    await assert.rejects(work, (error: unknown) => {
      assert.ok(error instanceof ControlError, String(error));
      assert.equal(error.code, code);
      assert.ok(error.message.includes(needle), error.message);
      return true;
    });
  };

  before(async () => {
    admin = new pg.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString() });
    pool.on('connect', (client) => client.on('error', () => {}));
    pool.on('error', () => {});
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await migrate(c);
    await seedPaper(c);
    await c.end();
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    }
  });

  test('the seeded 1.1.0 rows are complete; the 1.0.0 rows predate the format', async () => {
    const { rows } = await pool.query<{ kind: CatalogKind; version: string; definition: unknown }>('select kind, version, definition from catalog_versions');
    for (const row of rows) {
      // Asset identities and resource profiles had a complete shape from the start; nothing else did at 1.0.0.
      const expected = row.version === '1.1.0' || row.kind === 'asset' || row.kind === 'resourceProfile';
      assert.equal(wellFormed(row.kind, row.definition, 'paper'), expected, `${row.kind} ${row.version}`);
    }
  });

  test('a draft resolve reproduces the synthetic catalog from the database rows', async () => {
    const { catalog, pins } = await resolver.resolve(pool, { mode: 'paper' });
    assert.deepEqual(plain(catalog), plain(syntheticCatalog));
    assert.ok(pins.every((p) => p.version === '1.1.0'), JSON.stringify(pins));
    assert.equal(pins.length, 9, 'network, three assets, two connectors, two feeds, one model profile');
  });

  test('a launch resolve pins selections, the network and the resource profile', async () => {
    const { pins, capabilities } = await resolver.resolve(pool, {
      mode: 'paper', networkRef: 'paper-monad', connectors: { 'paper.uniswap': '1.1.0' }, modelProfiles: {}, resourceProfileRef: 'paper-small-v1',
    });
    for (const pin of pins) {
      const { rows } = await pool.query<{ content_hash: string }>('select content_hash from catalog_versions where kind = $1 and ref = $2 and version = $3', [pin.kind, pin.ref, pin.version]);
      assert.equal(rows[0]?.content_hash, pin.contentHash);
    }
    assert.ok(pins.some((p) => p.kind === 'resourceProfile' && p.ref === 'paper-small-v1' && p.version === '1.0.0'));
    assert.deepEqual(capabilities['paper.uniswap'], ['price.read', 'swap.quote', 'swap.exactInput']);
    await refusal(resolver.resolve(pool, { mode: 'paper', networkRef: 'paper-elsewhere' }), 'UNSUPPORTED_CAPABILITY', 'paper-elsewhere is not an enabled paper network');
    await refusal(resolver.resolve(pool, { mode: 'paper', resourceProfileRef: 'paper-huge-v9' }), 'UNSUPPORTED_CAPABILITY', 'paper-huge-v9 is not an enabled paper resource profile');
    await refusal(resolver.resolve(pool, { mode: 'paper', modelProfiles: { 'paper.kimi': '1.0.0' } }), 'UNSUPPORTED_CAPABILITY', 'paper.kimi@1.0.0 predates');
    await refusal(resolver.resolve(pool, { mode: 'live' , connectors: { 'paper.uniswap': '1.1.0' } }), 'UNSUPPORTED_CAPABILITY', 'not an enabled live connector');
  });

  test('a disabled newest version is left out rather than replaced by an older, incomplete one', async () => {
    await disable('paper.kuru', '1.1.0', 'Venue withdrawn.');
    try {
      const { catalog, pins } = await resolver.resolve(pool, { mode: 'paper' });
      assert.equal(catalog.connectors['paper.kuru'], undefined);
      assert.equal(catalog.reads['paper.kuru'], undefined);
      assert.equal(catalog.feeds['paper.weth-usd-kuru'], undefined, 'a feed whose connector is gone is dropped');
      assert.ok(catalog.feeds['paper.weth-usd']);
      assert.ok(!pins.some((p) => p.ref === 'paper.kuru' || p.ref === 'paper.weth-usd-kuru'));
      assert.deepEqual((await resolver.latestVersions(pool, 'paper')).connectors, { 'paper.uniswap': '1.1.0' });
      await refusal(resolver.resolve(pool, { mode: 'paper', connectors: { 'paper.kuru': '1.1.0' } }), 'UNSUPPORTED_CAPABILITY', 'paper.kuru@1.1.0 is disabled: Venue withdrawn.');
    } finally {
      await disable('paper.kuru', '1.1.0', null);
    }
  });

  test('checkPins refuses disabled, missing or changed pins and accepts manifest/1 pins without hashes', async () => {
    const { pins } = await resolver.resolve(pool, { mode: 'paper', networkRef: 'paper-monad', connectors: { 'paper.uniswap': '1.1.0' } });
    await resolver.checkPins(pool, 'paper', pins);
    await resolver.checkPins(pool, 'paper', [{ kind: 'connector', ref: 'paper.uniswap', version: '1.0.0' }]);
    await refusal(resolver.checkPins(pool, 'paper', [{ kind: 'connector', ref: 'paper.gone', version: '1.0.0' }]), 'UNSUPPORTED_CAPABILITY', 'no longer in the paper catalog');
    await refusal(resolver.checkPins(pool, 'live', pins), 'UNSUPPORTED_CAPABILITY', 'no longer in the live catalog');
    const changed = pins.map((p) => (p.ref === 'paper.uniswap' ? { ...p, contentHash: '0x' + '00'.repeat(32) } : p));
    await refusal(resolver.checkPins(pool, 'paper', changed), 'INTERNAL_ERROR', 'no longer matches its recorded hash');
    await disable('paper.WETH', '1.1.0', 'Asset delisted.');
    try {
      await refusal(resolver.checkPins(pool, 'paper', pins), 'UNSUPPORTED_CAPABILITY', 'asset paper.WETH@1.1.0 was disabled: Asset delisted.');
    } finally {
      await disable('paper.WETH', '1.1.0', null);
    }
  });

  test('a row whose definition no longer matches its content hash stops resolution', async () => {
    const live = { blockMillis: 400, finalityBlocks: 2 };
    await pool.query("insert into catalog_versions (kind, ref, version, modes, content_hash, definition) values ('network', 'monad-test', '1.0.0', '{live}', $1, $2)", [await contentHash(live), live]);
    await pool.query('alter table catalog_versions disable trigger catalog_versions_immutable');
    try {
      await pool.query(`update catalog_versions set definition = '{"blockMillis": 1, "finalityBlocks": 0}' where ref = 'monad-test'`);
    } finally {
      await pool.query('alter table catalog_versions enable trigger catalog_versions_immutable');
    }
    await refusal(resolver.resolve(pool, { mode: 'live' }), 'INTERNAL_ERROR', 'monad-test@1.0.0 failed its integrity check');
    await resolver.resolve(pool, { mode: 'paper' }); // the tampered live row is outside the paper registry
  });
});
