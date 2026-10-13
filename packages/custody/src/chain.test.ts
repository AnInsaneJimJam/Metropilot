// Native deposit detection from call traces (JsonRpcChain.nativeTransfers) against a recorded JSON-RPC stub, and
// that provider keys carried in the endpoint path (Alchemy, D60) never reach an error message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChainError, CrossCheckedChain, JsonRpcChain, NATIVE_TOKEN } from './chain.ts';

const WALLET = '0x83874dbad11513d46b4b0a455e7832804d19c130';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function rpc(traces: boolean) {
  return (async (_url: string, init: RequestInit) => {
    const { id, method } = JSON.parse(init.body as string) as { id: number; method: string };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'eth_getBlockByNumber') {
      return reply({ hash: BLOCK_HASH, transactions: [{ hash: tx(1), from: '0x01', to: WALLET, value: '0x5', transactionIndex: '0x0' }, { hash: tx(2), from: '0x02', to: '0xcc', value: '0x9', transactionIndex: '0x1' }] });
    }
    if (method === 'debug_traceBlockByNumber') {
      if (!traces) return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }));
      return reply([
        { txHash: tx(1), result: { type: 'CALL', from: '0x01', to: WALLET, value: '0x5' } },
        { txHash: tx(2), result: { type: 'CALL', from: '0x02', to: '0xcc', value: '0x9', calls: [
          { type: 'CALL', from: '0xcc', to: WALLET, value: '0x7' },
          { type: 'CALL', from: '0xcc', to: '0xdd', value: '0x0', error: 'execution reverted', calls: [{ type: 'CALL', from: '0xdd', to: WALLET, value: '0x8' }] },
          { type: 'DELEGATECALL', from: '0xcc', to: WALLET, value: '0x9' },
        ] } },
      ]);
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as typeof globalThis.fetch;
}

test('call traces find plain and contract-forwarded MON, skipping reverted frames and delegatecalls', async () => {
  const chain = new JsonRpcChain({ endpoint: 'https://rpc.example', chainId: 10143, fetch: rpc(true) });
  const found = await chain.nativeTransfers([WALLET], 5n, 5n);
  assert.deepEqual(found.map((f) => [f.txHash, f.logIndex, f.amount, f.tokenAddress]), [[tx(1), 0, 5n, NATIVE_TOKEN], [tx(2), 10_001, 7n, NATIVE_TOKEN]]);
});

test('without a trace API the reader falls back to top-level sends only', async () => {
  const chain = new JsonRpcChain({ endpoint: 'https://rpc.example', chainId: 10143, fetch: rpc(false) });
  const found = await chain.nativeTransfers([WALLET], 5n, 5n);
  assert.deepEqual(found.map((f) => [f.txHash, f.logIndex, f.amount]), [[tx(1), 0, 5n]]);
});

const KEY = 'alchemy-fake-key-5f3c9a1e7b2d4c6f';
const KEYED = `https://monad-testnet.g.alchemy.com/v2/${KEY}`;
const leaks = (error: unknown) => error instanceof Error && (error.message.includes(KEY) || String(error.stack).includes(KEY));

test('RPC failures never echo the keyed endpoint', async (t) => {
  // Skip the retry backoff; the request timeout uses AbortSignal, not setTimeout.
  const later = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((fn: () => void) => later(fn, 0)) as typeof globalThis.setTimeout);
  const failures: (typeof globalThis.fetch)[] = [
    (async () => { throw new TypeError(`fetch failed: ${KEYED}`); }) as unknown as typeof globalThis.fetch,
    (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `bad key ${KEY}` } }), { status: 401 })) as unknown as typeof globalThis.fetch,
    (async () => new Response(`<html>${KEYED}</html>`, { status: 429 })) as unknown as typeof globalThis.fetch,
  ];
  for (const fetch of failures) {
    const chain = new JsonRpcChain({ endpoint: KEYED, chainId: 10143, fetch });
    const error = await chain.finalizedHeight().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ChainError, 'a failure surfaces as ChainError');
    assert.equal(leaks(error), false, (error as Error).message);
  }
});

test('cross-check disagreements name the block, not either endpoint', async () => {
  const at = (hash: string, balance: string) => (async (_url: string, init: RequestInit) => {
    const { id, method } = JSON.parse(init.body as string) as { id: number; method: string };
    const result = method === 'eth_getBlockByNumber' ? { hash, number: '0x5' } : balance;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }) as unknown as typeof globalThis.fetch;
  const primary = new JsonRpcChain({ endpoint: 'https://testnet-rpc.monad.xyz', chainId: 10143, fetch: at(BLOCK_HASH, '0x1') });
  const secondary = new JsonRpcChain({ endpoint: KEYED, chainId: 10143, fetch: at(`0x${'cd'.repeat(32)}`, '0x2') });
  const chain = new CrossCheckedChain(primary, secondary);
  for (const read of [() => chain.blockHashAt(5n), () => chain.nativeBalance(WALLET, 5n), () => chain.erc20Balance(WALLET, WALLET, 5n)]) {
    const error = await read().then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ChainError && /disagree/.test(error.message));
    assert.equal(leaks(error), false, (error as Error).message);
  }
});
