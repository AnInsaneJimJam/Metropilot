// Read-only public-chain probe. Emits normalized observations; never emits endpoint credentials.
import { MainnetMarkets, SOURCES, rpcClient } from '../packages/connectors/src/index.ts';
const started = performance.now();
try {
  const markets = new MainnetMarkets(rpcClient(process.env.MARKET_RPC_URL));
  const head = await markets.client.getBlock({ blockTag: 'finalized' });
  if (head.number === null) throw new Error('Missing finalized block');
  const observations = await Promise.all(SOURCES.map(async (market) => {
    await markets.verify(market, head.number);
    return markets.observe(market, head.number);
  }));
  console.log(JSON.stringify({ probedAt: new Date().toISOString(), elapsedMillis: Math.round(performance.now() - started), observations }, null, 2));
} catch (error) {
  console.error(`Market probe failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
  process.exitCode = 1;
}
