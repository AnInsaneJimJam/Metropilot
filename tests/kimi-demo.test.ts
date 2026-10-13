import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentHash } from '../packages/contracts/src/index.ts';
import { marketCatalog } from '../packages/connectors/src/registry.ts';
import { brokerHarness } from './broker-harness.ts';
import { KIMI_MODEL } from '../apps/api/src/kimi-adapter.ts';
import { kimiDemoCatalog, KIMI_DEMO_REF, registerKimiDemo } from '../apps/api/src/kimi-demo.ts';

test('Kimi demo opt-in adds only a separate paper profile and leaves the base catalog intact', () => {
  assert.equal(kimiDemoCatalog(marketCatalog, false), marketCatalog);
  const catalog = kimiDemoCatalog(marketCatalog, true);
  assert.deepEqual(marketCatalog.modelProfiles, {});
  assert.equal(catalog.connectors, marketCatalog.connectors);
  assert.equal(catalog.modelProfiles[KIMI_DEMO_REF]?.modelId, KIMI_MODEL);
  assert.equal(catalog.modelProfiles[KIMI_DEMO_REF]?.provider, 'kimi');
  assert.equal(catalog.modelProfiles[KIMI_DEMO_REF]?.mode, 'paper');
});

test('demo registration is idempotent and refuses an operator-disabled immutable profile', { skip: !process.env['DATABASE_URL'] }, async () => {
  const h = await brokerHarness();
  const synthetic = { provider: 'synthetic' };
  await h.pool.query("insert into catalog_versions(kind,ref,version,modes,content_hash,definition) values('modelProfile','paper.kimi','1.0.0',array['paper'],$1,$2)", [await contentHash(synthetic), synthetic]);
  await registerKimiDemo(h.pool);
  await registerKimiDemo(h.pool);
  const rows = (await h.pool.query('select * from catalog_versions where ref=$1', [KIMI_DEMO_REF])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1.0.0');
  assert.deepEqual(rows[0].modes, ['paper']);
  await h.pool.query("update catalog_versions set disabled_reason='test kill switch' where ref=$1", [KIMI_DEMO_REF]);
  await assert.rejects(registerKimiDemo(h.pool), /disabled or differs/);
  assert.equal((await h.pool.query("select definition->>'provider' as provider from catalog_versions where ref='paper.kimi'")).rows[0].provider, 'synthetic');
});
