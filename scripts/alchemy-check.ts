// D60 acceptance for Alchemy as the second custody witness and the market transport. Read-only: no database, no
// transactions.
//   node --env-file=.env scripts/alchemy-check.ts
// Needs CUSTODY_RPC_SECONDARY (Monad testnet, e.g. https://monad-testnet.g.alchemy.com/v2/<key>); optional
// CUSTODY_RPC (reference, default the public testnet RPC), MARKET_RPC_URL and MARKET_WS_URL (Monad mainnet).
// Checks the secondary against the reference through CrossCheckedChain, exactly as custody uses it:
//   1. both endpoints serve chain 10143;
//   2. finalized heights are within a small lag, and block hashes agree for the last 20 finalized blocks;
//   3. receipts agree for the recorded E03 deposit and withdrawal (status, block hash, fee, logs);
//   4. native and ERC-20 balances agree for the E03 wallet at the finalized height and ~1000 blocks back;
//   5. the market RPC serves chain 143 and agrees with the public mainnet RPC on a finalized block hash;
//   6. WSS eth_subscribe newHeads delivers a head within 10 s.
// Prints host names only, never the URL path (where Alchemy keeps the key). Dated output is D60 evidence.
import { ChainError, CrossCheckedChain, JsonRpcChain } from '../packages/custody/src/index.ts';

const secondaryUrl = process.env['CUSTODY_RPC_SECONDARY'];
if (!secondaryUrl) {
  console.log('D60 check skipped: set CUSTODY_RPC_SECONDARY in .env (an Alchemy Monad testnet URL).');
  process.exit(0);
}
const CHAIN = 10143;
const MAINNET = 143;
const host = (url: string) => new URL(url).host;
const referenceUrl = process.env['CUSTODY_RPC'] ?? 'https://testnet-rpc.monad.xyz';
const reference = new JsonRpcChain({ endpoint: referenceUrl, chainId: CHAIN });
const secondary = new JsonRpcChain({ endpoint: secondaryUrl, chainId: CHAIN });
const chain = new CrossCheckedChain(reference, secondary);

// Recorded E03 testnet evidence (docs/decisions.md): the credited deposit, the withdrawal and the agent wallet.
const WALLET = '0x83874dbad11513d46b4b0a455e7832804d19c130';
const TXS = ['0x91e92af957ad31624b9c86ada062a2f839893d4afcf5671f088f9dbed3f75870', '0x39cdd0fb1deefcbb59046eebb5a5d2ef32e56c2deb4bc0d38c134f45ee514c8b'];
const USDC = '0x534b2f3a21130d7a60830c2df862319e593943a3';
const MAX_LAG = 30n;
const SPAN = 20n;

const secrets = [secondaryUrl, process.env['MARKET_RPC_URL'], process.env['MARKET_WS_URL']].flatMap((u) => {
  try { return u ? new URL(u).pathname.split('/').filter((s) => s.length >= 8) : []; } catch { return []; }
});
// ChainError messages are written without endpoints; anything else is reduced to its name. Redact regardless.
const safe = (error: unknown): string => {
  const text = error instanceof ChainError ? error.message : error instanceof Error ? error.name : 'failed';
  return secrets.reduce((t, s) => t.split(s).join('<redacted>'), text);
};
const results: { check: string; pass: boolean }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${detail}`);
};
const attempt = async (check: string, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (error) {
    record(check, false, safe(error));
  }
};

console.log(`reference ${host(referenceUrl)}, secondary ${host(secondaryUrl)}`);

await attempt('chain', async () => {
  await Promise.all([reference.verifyChainId(), secondary.verifyChainId()]);
  record('chain', true, `both endpoints serve chain ${CHAIN}`);
});

let finalized = 0n;
await attempt('finality', async () => {
  const [a, b] = await Promise.all([reference.finalizedHeight(), secondary.finalizedHeight()]);
  finalized = a < b ? a : b; // what CrossCheckedChain.finalizedHeight returns
  const lag = a > b ? a - b : b - a;
  for (let h = finalized - SPAN + 1n; h <= finalized; h++) {
    if (!(await chain.blockHashAt(h))) throw new ChainError(`no block at ${h}`);
  }
  record('finality', lag <= MAX_LAG, `finalized ${a} vs ${b} (lag ${lag}); hashes agree for blocks ${finalized - SPAN + 1n}..${finalized}`);
});

await attempt('receipts', async () => {
  for (const tx of TXS) {
    const r = await chain.receipt(tx);
    if (!r) throw new ChainError(`receipt ${tx.slice(0, 10)} missing on one endpoint`);
  }
  record('receipts', true, `${TXS.length} E03 receipts agree (status, block hash, fee, logs)`);
});

await attempt('balances', async () => {
  if (!finalized) finalized = await chain.finalizedHeight();
  const past = finalized - 1_000n;
  const [mon, usdc, monPast, usdcPast] = [await chain.nativeBalance(WALLET, finalized), await chain.erc20Balance(USDC, WALLET, finalized),
    await chain.nativeBalance(WALLET, past), await chain.erc20Balance(USDC, WALLET, past)];
  record('balances', true, `MON ${mon} / USDC ${usdc} at ${finalized}; MON ${monPast} / USDC ${usdcPast} at ${past} (historical state)`);
});

const marketUrl = process.env['MARKET_RPC_URL'];
if (marketUrl) {
  await attempt('market rpc', async () => {
    const market = new JsonRpcChain({ endpoint: marketUrl, chainId: MAINNET });
    const pub = new JsonRpcChain({ endpoint: 'https://rpc.monad.xyz', chainId: MAINNET });
    await market.verifyChainId();
    const both = new CrossCheckedChain(pub, market);
    const height = await both.finalizedHeight();
    await both.blockHashAt(height);
    record('market rpc', true, `${host(marketUrl)} serves chain ${MAINNET}; finalized block ${height} hash matches rpc.monad.xyz`);
  });
} else {
  console.log('skip  market rpc: MARKET_RPC_URL not set');
}

// Defaults to the secondary's WSS twin (Alchemy serves both on the same path).
const wsUrl = process.env['MARKET_WS_URL'] ?? secondaryUrl.replace(/^https:/, 'wss:');
await attempt('wss newHeads', () => new Promise<void>((resolve, reject) => {
  const url = new URL(wsUrl);
  if (url.protocol !== 'wss:') return reject(new ChainError('WebSocket URL must use WSS.'));
  const started = performance.now();
  const socket = new WebSocket(url);
  let subscribed = false;
  const done = (error?: Error) => {
    clearTimeout(timer);
    socket.onclose = null;
    socket.close();
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => done(new ChainError(subscribed ? 'no head within 10 s' : 'no subscription within 10 s')), 10_000);
  socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
  socket.onerror = () => done(new ChainError('WebSocket error.'));
  socket.onclose = () => done(new ChainError('WebSocket closed.'));
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: string; error?: unknown; method?: string; params?: { result?: { number?: string } } };
      if (message.error) return done(new ChainError('eth_subscribe refused.'));
      if (message.id === 1 && typeof message.result === 'string') subscribed = true;
      const number = message.params?.result?.number;
      if (message.method === 'eth_subscription' && number) {
        record('wss newHeads', true, `${url.host} pushed head ${BigInt(number)} after ${Math.round(performance.now() - started)} ms`);
        done();
      }
    } catch {
      done(new ChainError('Malformed WebSocket message.'));
    }
  };
}));

const passed = results.filter((r) => r.pass).length;
console.log(`\nD60 Alchemy check ${new Date().toISOString()}: ${passed}/${results.length} PASS`);
process.exit(passed === results.length ? 0 : 1);
