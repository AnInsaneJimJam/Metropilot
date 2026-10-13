// HyperSyncChain (E10) against stubbed HyperSync and JSON-RPC endpoints: the index picks blocks, RPC supplies
// every value; balance bisection finds contract-forwarded MON without a trace index; partial ranges never pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonRpcChain, NATIVE_TOKEN, TRANSFER_TOPIC, topicFor } from './chain.ts';
import { HyperSyncChain } from './hypersync.ts';

const WALLET = '0x83874dbad11513d46b4b0a455e7832804d19c130';
const OTHER = '0x00000000000000000000000000000000000000cc';
const TOKEN = '0x534b2f3a21130d7a60830c2df862319e593943a3';
const TOKEN_SECRET = 'test-token-not-a-secret';
const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const txh = (n: number) => `0x${'f'.repeat(56)}${n.toString(16).padStart(8, '0')}`;

interface Scenario {
  /** Balance changes of WALLET by block. */
  readonly balance: Record<number, bigint>;
  /** Blocks with a transaction sent by WALLET. */
  readonly sent: number[];
  /** Internal transfers into WALLET by block (traced). */
  readonly internal: Record<number, bigint>;
  /** Sent transactions HyperSync reports (default: all). */
  readonly indexedSent?: number[];
  readonly pages?: number;
  readonly stallAt?: number;
  readonly wrongChain?: boolean;
  readonly rateLimitOnce?: boolean;
}

function stub(s: Scenario) {
  const traced: number[] = [];
  const queries: unknown[] = [];
  let limited = !s.rateLimitOnce;
  const at = (h: bigint, ledger: Record<number, bigint> | number[]): bigint => {
    let total = 0n;
    if (Array.isArray(ledger)) for (const b of ledger) total += BigInt(b) <= h ? 1n : 0n;
    else for (const [b, v] of Object.entries(ledger)) total += BigInt(b) <= h ? v : 0n;
    return total;
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (url.includes('hypersync')) {
      assert.equal(headers['authorization'], `Bearer ${TOKEN_SECRET}`);
      assert.ok(!url.includes(TOKEN_SECRET));
      if (!limited) {
        limited = true;
        return new Response('slow down', { status: 429 });
      }
      if (url.endsWith('/height')) return new Response(JSON.stringify({ height: 1000 }));
      const q = JSON.parse(init.body as string) as { from_block: number; to_block: number; transactions?: unknown; logs?: unknown; include_all_blocks?: boolean };
      queries.push(q);
      if (s.stallAt !== undefined && !q.include_all_blocks && q.from_block >= s.stallAt) return new Response(JSON.stringify({ next_block: q.from_block, archive_height: s.stallAt, data: [] }));
      const span = Math.max(1, Math.ceil((q.to_block - q.from_block) / (s.pages ?? 1)));
      const end = Math.min(q.to_block, q.from_block + span, s.stallAt !== undefined && !q.include_all_blocks ? s.stallAt : Infinity);
      const inRange = (b: number) => b >= q.from_block && b < end;
      const data: Record<string, unknown> = {};
      if (q.include_all_blocks) data['blocks'] = [{ number: q.from_block, hash: s.wrongChain ? hash(1n) : hash(BigInt(q.from_block)) }];
      if (q.transactions) data['transactions'] = (s.indexedSent ?? s.sent).filter(inRange).map((b) => ({ block_number: b, from: WALLET, to: OTHER }));
      if (q.logs) data['logs'] = [104].filter(inRange).map((b) => ({ block_number: `0x${b.toString(16)}` }));
      return new Response(JSON.stringify({ next_block: end, archive_height: 1000, data: [data] }));
    }
    const { id, method, params } = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const height = () => BigInt(params[1] as string);
    if (method === 'eth_getBalance') return reply(`0x${at(height(), s.balance).toString(16)}`);
    if (method === 'eth_getTransactionCount') return reply(`0x${at(height(), s.sent).toString(16)}`);
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string;
      const n = tag === 'finalized' || tag === 'latest' ? 900n : BigInt(tag);
      return reply({ number: `0x${n.toString(16)}`, hash: hash(n), transactions: [] });
    }
    if (method === 'debug_traceBlockByNumber') {
      const n = Number(BigInt(params[0] as string));
      traced.push(n);
      const frames = [];
      if (s.sent.includes(n)) frames.push({ txHash: txh(n), result: { type: 'CALL', from: WALLET, to: OTHER, value: '0x2' } });
      if (s.internal[n]) frames.push({ txHash: txh(n + 1), result: { type: 'CALL', from: OTHER, to: OTHER, value: '0x0', calls: [{ type: 'CALL', from: OTHER, to: WALLET, value: `0x${s.internal[n].toString(16)}` }] } });
      return reply(frames);
    }
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      assert.equal(filter.fromBlock, filter.toBlock, 'RPC re-reads one candidate block at a time');
      return reply([{ transactionHash: txh(7), logIndex: '0x3', address: TOKEN, topics: [TRANSFER_TOPIC, topicFor(OTHER), topicFor(WALLET)], data: '0x64', blockHash: hash(BigInt(filter.fromBlock)), blockNumber: filter.fromBlock }]);
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as typeof globalThis.fetch;
  const rpc = new JsonRpcChain({ endpoint: 'https://rpc.example', chainId: 10143, fetch });
  const chain = new HyperSyncChain(rpc, { url: 'https://10143.hypersync.xyz', apiToken: TOKEN_SECRET, fetch });
  return { chain, traced, queries };
}

// +5 forwarded at 103, the wallet's own send at 108 (−2 and gas), +3 forwarded at 112.
const base: Scenario = { balance: { 103: 5n, 108: -2n, 112: 3n }, sent: [108], internal: { 103: 5n, 112: 3n } };

test('contract-forwarded MON is found by balance bisection; only rising blocks and own sends are traced', async () => {
  const { chain, traced } = stub(base);
  const found = await chain.nativeTransfers([WALLET], 100n, 115n);
  assert.deepEqual(found.map((f) => [f.blockNumber, f.amount, f.tokenAddress, f.logIndex]), [[103n, 5n, NATIVE_TOKEN, 1], [112n, 3n, NATIVE_TOKEN, 1]]);
  assert.deepEqual([...new Set(traced)].sort((a, b) => a - b), [103, 108, 112]);
});

test('an outgoing transaction the index missed falls back to tracing that whole segment', async () => {
  const { chain, traced } = stub({ ...base, indexedSent: [] });
  const found = await chain.nativeTransfers([WALLET], 100n, 115n);
  assert.deepEqual(found.map((f) => [f.blockNumber, f.amount]), [[103n, 5n], [112n, 3n]]);
  assert.equal(new Set(traced).size, 16, 'every block of 100..115 traced');
});

test('an unchanged balance with no own sends traces nothing', async () => {
  const { chain, traced } = stub({ balance: {}, sent: [], internal: {} });
  assert.deepEqual(await chain.nativeTransfers([WALLET], 100n, 600n), []);
  assert.deepEqual(traced, []);
});

test('pages follow next_block; a stalled page (block not indexed yet) throws instead of returning a partial range', async () => {
  const paged = stub({ ...base, pages: 4 });
  assert.equal((await paged.chain.nativeTransfers([WALLET], 100n, 115n)).length, 2);
  assert.ok(paged.queries.length > 4);
  const stalled = stub({ ...base, stallAt: 110 });
  await assert.rejects(stalled.chain.nativeTransfers([WALLET], 100n, 115n), /not indexed block 110/);
});

test('token transfers: HyperSync names the block, RPC supplies the log', async () => {
  const { chain } = stub(base);
  const logs = await chain.transferLogs(TOKEN, [WALLET], 100n, 115n);
  assert.deepEqual(logs.map((l) => [l.blockNumber, l.amount, l.logIndex, l.destination, l.tokenAddress]), [[104n, 100n, 3, WALLET, TOKEN]]);
});

test('heights are capped at the index; a different chain behind the URL is refused; 429 is retried', async () => {
  const { chain } = stub({ ...base, rateLimitOnce: true });
  assert.equal(await chain.finalizedHeight(), 900n);
  const wrong = stub({ ...base, wrongChain: true });
  await assert.rejects(wrong.chain.nativeTransfers([WALLET], 100n, 115n), /does not serve chain 10143/);
  assert.throws(() => new HyperSyncChain(new JsonRpcChain({ endpoint: 'https://rpc.example', chainId: 10143 }), { url: 'http://10143.hypersync.xyz', apiToken: 'x' }), /HTTPS/);
});
