// Envio HyperSync as the deposit index (E10). HyperSync only decides which blocks to look at; every value that can
// credit funds still comes from JSON-RPC: transfer logs are re-read per candidate block with eth_getLogs, native MON
// comes from the existing call-trace path, and finality, block hashes, receipts and balances stay on RPC.
//
// Monad testnet has no HyperSync trace endpoint, so contract-forwarded MON is found from balances instead: an
// agent wallet's balance only goes down through its own transactions, so between two of its outgoing transactions
// (indexed by HyperSync, checked against the RPC nonce) the balance never decreases. An unchanged balance across
// such a segment means nothing arrived; a higher one is bisected to the blocks where it rose, and only those blocks
// (plus the wallet's own transaction blocks) are traced. A segment that breaks the rule is traced block by block.
import { ChainError, TRANSFER_TOPIC, topicFor } from './chain.ts';
import type { ChainReader, JsonRpcChain, Receipt, TransferLog } from './chain.ts';

export interface HyperSyncOptions {
  /** For example https://10143.hypersync.xyz (Monad testnet). */
  readonly url: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
  /** Parallel RPC reads for the balance checks. */
  readonly concurrency?: number;
}

type Row = Record<string, unknown>;
interface Page {
  readonly next_block: number | string;
  readonly archive_height?: number | string | null;
  readonly data?: Row | Row[];
}

const big = (v: unknown): bigint => BigInt(v as string | number);
const lower = (v: unknown): string => String(v).toLowerCase();

/** Monad testnet default from the HyperSync network list. */
export const hyperSyncUrlFor = (chainId: number): string => `https://${chainId}.hypersync.xyz`;

export class HyperSyncChain implements ChainReader {
  readonly chainId: number;
  /** Finality, hashes, receipts and balances (may be cross-checked). */
  readonly base: ChainReader;
  /** Per-block traces, logs, balances and nonces for confirmation. */
  readonly rpc: JsonRpcChain;
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #concurrency: number;
  #verified: Promise<void> | undefined;

  constructor(rpc: JsonRpcChain, options: HyperSyncOptions, base: ChainReader = rpc) {
    const url = new URL(options.url);
    if (url.protocol !== 'https:') throw new ChainError('HyperSync endpoints use HTTPS.');
    if (!options.apiToken) throw new ChainError('HyperSync needs an API token.');
    if (base.chainId !== rpc.chainId) throw new ChainError('Readers serve different chains.');
    this.chainId = rpc.chainId;
    this.rpc = rpc;
    this.base = base;
    this.#url = url.origin;
    this.#token = options.apiToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMillis ?? 20_000;
    this.#concurrency = options.concurrency ?? 8;
  }

  async #post<T>(path: string, body?: unknown): Promise<T> {
    let last = `HyperSync ${path} failed.`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 100));
      let response: Response;
      try {
        response = await this.#fetch(`${this.#url}${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#timeout),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        last = `HyperSync ${path} unreachable.`;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        last = `HyperSync ${path} rate-limited or unavailable (${response.status}).`;
        continue;
      }
      // Never echo the response body: error messages can describe the token.
      if (!response.ok) throw new ChainError(`HyperSync ${path} failed (${response.status}).`);
      return (await response.json()) as T;
    }
    throw new ChainError(last);
  }

  /** Last block HyperSync has indexed. */
  async indexedHeight(): Promise<bigint> {
    const { height } = await this.#post<{ height: number | string }>('/height');
    return big(height) - 1n; // treat the reported height as a count; one block of margin costs nothing
  }

  /** Every row of the selection over [fromBlock, toBlock] (inclusive), following next_block; never a partial range. */
  async #collect(selection: Row, fromBlock: bigint, toBlock: bigint): Promise<{ logs: Row[]; transactions: Row[]; blocks: Row[] }> {
    const out = { logs: [] as Row[], transactions: [] as Row[], blocks: [] as Row[] };
    let from = fromBlock;
    const end = toBlock + 1n; // to_block is exclusive
    while (from < end) {
      const page = await this.#post<Page>('/query', { ...selection, from_block: Number(from), to_block: Number(end) });
      for (const d of Array.isArray(page.data) ? page.data : page.data ? [page.data] : []) {
        out.logs.push(...((d['logs'] as Row[] | undefined) ?? []));
        out.transactions.push(...((d['transactions'] as Row[] | undefined) ?? []));
        out.blocks.push(...((d['blocks'] as Row[] | undefined) ?? []));
      }
      const next = big(page.next_block);
      if (next <= from) {
        const archive = page.archive_height === undefined || page.archive_height === null ? 'unknown' : String(page.archive_height);
        throw new ChainError(`HyperSync has not indexed block ${from} yet (archive height ${archive}).`);
      }
      from = next;
    }
    return out;
  }

  /** The index must serve this chain: one block hash has to match RPC. Checked once, before the first scan. */
  verify(): Promise<void> {
    this.#verified ??= (async () => {
      const [indexed, finalized] = await Promise.all([this.indexedHeight(), this.base.finalizedHeight()]);
      const height = indexed < finalized ? indexed : finalized;
      const { blocks } = await this.#collect({ include_all_blocks: true, field_selection: { block: ['number', 'hash'] } }, height, height);
      const indexHash = blocks.find((b) => big(b['number']) === height)?.['hash'];
      if (indexHash === undefined || lower(indexHash) !== (await this.base.blockHashAt(height))) {
        throw new ChainError(`HyperSync does not serve chain ${this.chainId} (block ${height} differs).`);
      }
    })().catch((error: unknown) => {
      this.#verified = undefined;
      throw error;
    });
    return this.#verified;
  }

  // Heights are capped at what HyperSync has indexed, so the scanner never records an unindexed block as empty.
  async latestHeight(): Promise<bigint> {
    const [a, b] = await Promise.all([this.base.latestHeight(), this.indexedHeight()]);
    return a < b ? a : b;
  }
  async finalizedHeight(): Promise<bigint> {
    const [a, b] = await Promise.all([this.base.finalizedHeight(), this.indexedHeight()]);
    return a < b ? a : b;
  }
  blockHashAt(height: bigint): Promise<string | undefined> {
    return this.base.blockHashAt(height);
  }
  receipt(txHash: string): Promise<Receipt | undefined> {
    return this.base.receipt(txHash);
  }
  erc20Balance(token: string, owner: string, height: bigint): Promise<bigint> {
    return this.base.erc20Balance(token, owner, height);
  }
  nativeBalance(owner: string, height: bigint): Promise<bigint> {
    return this.base.nativeBalance(owner, height);
  }

  async transferLogs(token: string, destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    if (!destinations.length || toBlock < fromBlock) return [];
    await this.verify();
    const { logs } = await this.#collect({
      logs: [{ address: [token.toLowerCase()], topics: [[TRANSFER_TOPIC], [], destinations.map(topicFor)] }],
      field_selection: { log: ['block_number'] },
    }, fromBlock, toBlock);
    const blocks = [...new Set(logs.map((l) => big(l['block_number'])))].sort((a, b) => (a < b ? -1 : 1));
    // RPC re-reads each candidate block, so amounts, senders and indexes are exactly what JsonRpcChain reports.
    return (await this.#map(blocks, (h) => this.rpc.transferLogs(token, destinations, h, h))).flat();
  }

  async nativeTransfers(destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    if (!destinations.length || toBlock < fromBlock) return [];
    await this.verify();
    const wallets = [...new Set(destinations.map((d) => d.toLowerCase()))];
    const { transactions } = await this.#collect({
      transactions: [{ from: wallets }, { to: wallets }],
      field_selection: { transaction: ['block_number', 'from', 'to'] },
    }, fromBlock, toBlock);
    const candidates = new Set<bigint>(transactions.map((t) => big(t['block_number'])));
    const outflows = new Map<string, bigint[]>(wallets.map((w) => [w, []]));
    for (const t of transactions) outflows.get(lower(t['from']))?.push(big(t['block_number']));
    for (const w of wallets) {
      for (const h of await this.#risesIn(w, outflows.get(w)!, fromBlock, toBlock)) candidates.add(h);
    }
    const blocks = [...candidates].filter((h) => h >= fromBlock && h <= toBlock).sort((a, b) => (a < b ? -1 : 1));
    return (await this.#map(blocks, (h) => this.rpc.nativeInBlock(h, wallets))).flat();
  }

  /** Blocks in [from, to] where the wallet's balance rose outside its own transaction blocks. */
  async #risesIn(wallet: string, outflowBlocks: readonly bigint[], from: bigint, to: bigint): Promise<bigint[]> {
    const own = [...new Set(outflowBlocks)].sort((a, b) => (a < b ? -1 : 1));
    const segments: [bigint, bigint][] = [];
    let start = from;
    for (const o of own) {
      if (o > start) segments.push([start, o - 1n]);
      start = o + 1n;
    }
    if (start <= to) segments.push([start, to]);
    const found = await this.#map(segments, async ([a, b]) => {
      const before = a > 0n ? a - 1n : undefined;
      const [balA, balB, nonceA, nonceB] = await Promise.all([
        before === undefined ? 0n : this.rpc.nativeBalance(wallet, before), this.rpc.nativeBalance(wallet, b),
        before === undefined ? 0n : this.rpc.transactionCount(wallet, before), this.rpc.transactionCount(wallet, b),
      ]);
      // A transaction the index missed, or a balance that fell without one: the rule does not hold here, so every
      // block of the segment is traced.
      if (nonceA !== nonceB || balB < balA) return range(a, b);
      return balB === balA ? [] : this.#bisect(wallet, a, b, balA, balB);
    });
    return found.flat();
  }

  async #bisect(wallet: string, a: bigint, b: bigint, balBefore: bigint, balAfter: bigint): Promise<bigint[]> {
    if (balAfter === balBefore) return [];
    if (a === b) return [a];
    const mid = (a + b) / 2n;
    const balMid = await this.rpc.nativeBalance(wallet, mid);
    const [left, right] = await Promise.all([this.#bisect(wallet, a, mid, balBefore, balMid), this.#bisect(wallet, mid + 1n, b, balMid, balAfter)]);
    return [...left, ...right];
  }

  async #map<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, items.length) }, worker));
    return out;
  }
}

function range(a: bigint, b: bigint): bigint[] {
  const out: bigint[] = [];
  for (let h = a; h <= b; h++) out.push(h);
  return out;
}
