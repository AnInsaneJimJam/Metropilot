import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { validate } from '@monad-hack/contracts';
import { compileStrategy, MARKET_PRESETS, workspaceFromStrategy, compileWorkspaceProgram } from '@monad-hack/strategy';
import { checkedObservation, tickPrice, meanTick, decimal, MARKETS, MANIFESTS, marketCatalog, AAVE_RESERVES, rayToApr, pacedFetch } from './index.ts';
const fixture = (protocol: string) => JSON.parse(readFileSync(new URL(`../../contracts/fixtures/priceObservation/valid/${protocol}.json`, import.meta.url), 'utf8'));
test('native oracle arithmetic keeps token units and rounds negative mean ticks down', () => {
  assert.equal(meanTick(0n, -31n, 30), -2);
  assert.equal(meanTick(0n, 31n, 30), 1);
  assert.equal(tickPrice(0,18,6,false),'1000000000000');
  assert.equal(tickPrice(0,6,18,true),'0.000000000001');
  assert.equal(tickPrice(1,6,6,false),'1.000099999999999999');
  assert.equal(decimal(10n**18n, 10n**18n),'1');
  assert.throws(()=>tickPrice(887273,18,6,false));
});
test('reviewed manifests and catalogs agree and paper effects are explicit', async () => {
  for (const m of MARKETS) {
    const manifest=MANIFESTS.find(x=>x.ref===m.connectorRef)!;
    assert.ok(validate('connectorManifest',manifest).ok);
    assert.equal(marketCatalog.connectors[m.connectorRef]!.version,manifest.version);
    assert.equal(marketCatalog.feeds[m.feedRef]!.connectorRef,manifest.ref);
    assert.equal(manifest.mode,'paper');
    assert.equal(manifest.sourceChainId,143);
  }
  for (const preset of MARKET_PRESETS) {
    const program=await compileStrategy(JSON.stringify(preset.strategy),marketCatalog);
    const workspace=workspaceFromStrategy(program.strategy,marketCatalog);
    assert.equal((await compileWorkspaceProgram(workspace,marketCatalog)).program.hash,program.hash);
  }
});
test('normalization refuses wrong protocol, units, pool, future time and provisional data', () => {
  for (const m of MARKETS) {
    const o=fixture(m.protocol);
    assert.equal(checkedObservation(o).feedRef,m.feedRef);
    for (const patch of [{finality:'proposed'}, {method:'sampled-arithmetic-twap'}, {poolAddress:'0x'+'ab'.repeat(20)}, {sourceEventKey:'invented'}, {receivedAt:'2099-01-01T00:00:00.000Z'}, {price:{...o.price,quoteUnit:'USD'}}]) {
      assert.throws(()=>checkedObservation({...o,...patch}));
    }
  }
});

test('Aave native USD prices retain exact reserve rays, distinguish APR from APY, and expose no swap action', () => {
  assert.equal(rayToApr('50000000000000000000000000'),'0.05');
  assert.equal(rayToApr('0'),'0');
  assert.equal(marketCatalog.connectors['paper.aave']!.actions.includes('swap.exactInput'),false);
  for (const m of AAVE_RESERVES) {
    const o=JSON.parse(readFileSync(new URL(`../../contracts/fixtures/priceObservation/valid/aave-${m.base.toLowerCase()}.json`,import.meta.url),'utf8'));
    assert.equal(checkedObservation(o).price.quoteUnit,'USD');
    assert.equal(o.reserve.priceUpdateTimeAvailable,false);
    assert.throws(()=>checkedObservation({...o,reserve:{...o.reserve,assetAddress:'0x'+'ab'.repeat(20)}}));
  }
});

test('pacedFetch spaces requests to the configured rate (D60)', async () => {
  const sent: number[] = [];
  const paced = pacedFetch(50, (async () => { sent.push(performance.now()); return new Response('{}'); }) as unknown as typeof globalThis.fetch);
  const started = performance.now();
  await Promise.all(Array.from({ length: 5 }, () => paced('https://rpc.example')));
  assert.equal(sent.length, 5);
  assert.ok(sent[4]! - started >= 75, `five requests at 50/s span at least 80 ms (got ${Math.round(sent[4]! - started)})`);
  assert.throws(() => pacedFetch(0), /positive/);
});
