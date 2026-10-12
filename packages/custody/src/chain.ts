// Chain reads for finality, receipts, transfer logs and balances (E04/E06). JsonRpcChain speaks plain Ethereum
// JSON-RPC over fetch; CrossCheckedChain requires two endpoints to agree on finalized block hashes before any
// credit or settlement, and throws on disagreement so settlement pauses instead of guessing.
import { isHex } from './provider.ts';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface Receipt {
  readonly txHash: string;
  readonly succeeded: boolean;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  /** Native fee actually paid: gasUsed × effectiveGasPrice. */
  readonly feeAtomic: bigint;
}

export interface TransferLog {
  readonly chainId: number;
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenAddress: string;
  readonly sender: string;
  readonly destination: string;
  readonly amount: bigint;
  readonly blockHash: string;
  readonly blockNumber: bigint;
}

export interface ChainReader {
  readonly chainId: number;
  latestHeight(): Promise<bigint>;
  finalizedHeight(): Promise<bigint>;
  blockHashAt(height: bigint): Promise<string | undefined>;
  receipt(txHash: string): Promise<Receipt | undefined>;
  transferLogs(token: string, destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  /** Plain native-value transfers to the destinations (logIndex is the transaction index). */
  nativeTransfers(destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  erc20Balance(token: string, owner: string, height: bigint): Promise<bigint>;
  nativeBalance(owner: string, height: bigint): Promise<bigint>;
}

/** Sentinel token address for native-value deposits (no ERC-20 contract). */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

const q = (n: bigint): string => `0x${n.toString(16)}`;
const topicFor = (address: string): string => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const addressFromTopic = (topic: string): string => `0x${topic.slice(-40)}`.toLowerCase();

export interface JsonRpcOptions {
  readonly endpoint: string;
  readonly chainId: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
  /** Parallel block reads for native-transfer scans. */
  readonly concurrency?: number;
}

export class JsonRpcChain implements ChainReader {
  readonly chainId: number;
  readonly #endpoint: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeout: number;
  readonly #concurrency: number;
  /** Use call traces for native transfers; switched off if the endpoint lacks the trace API. */
  #traces = true;
  #id = 0;

  constructor(options: JsonRpcOptions) {
    const url = new URL(options.endpoint);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new ChainError('RPC endpoints use HTTPS.');
    this.chainId = options.chainId;
    this.#endpoint = url.toString();
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeoutMillis ?? 10_000;
    this.#concurrency = options.concurrency ?? 8;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    // Reads are idempotent: retry rate limits and transient failures a bounded number of times.
    let last = `RPC ${method} failed.`;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 100));
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.#timeout),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
        });
      } catch {
        last = `RPC ${method} unreachable.`;
        continue;
      }
      const json = (await response.json().catch(() => ({}))) as { result?: T; error?: { code?: number; message?: string } };
      if (response.status === 429 || response.status >= 500 || json.error?.code === -32005 || json.error?.code === -32007) {
        last = `RPC ${method} rate-limited or unavailable (${response.status}).`;
        continue;
      }
      if (!response.ok || json.error) throw new ChainError(`RPC ${method} failed (${response.status}${json.error?.code !== undefined ? ` ${json.error.code}` : ''}).`);
      return json.result as T;
    }
    throw new ChainError(last);
  }

  async verifyChainId(): Promise<void> {
    const id = BigInt(await this.call<string>('eth_chainId', []));
    if (id !== BigInt(this.chainId)) throw new ChainError(`RPC serves chain ${id}, expected ${this.chainId}.`);
  }

  async latestHeight(): Promise<bigint> {
    return BigInt(await this.call<string>('eth_blockNumber', []));
  }

  async finalizedHeight(): Promise<bigint> {
    const block = await this.call<{ number: string } | null>('eth_getBlockByNumber', ['finalized', false]);
    if (!block) throw new ChainError('No finalized block.');
    return BigInt(block.number);
  }

  async blockHashAt(height: bigint): Promise<string | undefined> {
    const block = await this.call<{ hash: string } | null>('eth_getBlockByNumber', [q(height), false]);
    return block?.hash.toLowerCase();
  }

  async receipt(txHash: string): Promise<Receipt | undefined> {
    const r = await this.call<{ status: string; blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice?: string } | null>('eth_getTransactionReceipt', [txHash]);
    if (!r) return undefined;
    return {
      txHash: txHash.toLowerCase(), succeeded: r.status === '0x1', blockNumber: BigInt(r.blockNumber), blockHash: r.blockHash.toLowerCase(),
      feeAtomic: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? '0x0'),
    };
  }

  async transferLogs(token: string, destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    if (!destinations.length || toBlock < fromBlock) return [];
    const logs = await this.call<{ transactionHash: string; logIndex: string; address: string; topics: string[]; data: string; blockHash: string; blockNumber: string; removed?: boolean }[]>(
      'eth_getLogs', [{ address: token.toLowerCase(), fromBlock: q(fromBlock), toBlock: q(toBlock), topics: [TRANSFER_TOPIC, null, destinations.map(topicFor)] }]);
    return logs.filter((l) => !l.removed && l.topics.length === 3 && isHex(l.data.toLowerCase())).map((l) => ({
      chainId: this.chainId, txHash: l.transactionHash.toLowerCase(), logIndex: Number(BigInt(l.logIndex)), tokenAddress: l.address.toLowerCase(),
      sender: addressFromTopic(l.topics[1]!), destination: addressFromTopic(l.topics[2]!), amount: BigInt(l.data === '0x' ? '0x0' : l.data),
      blockHash: l.blockHash.toLowerCase(), blockNumber: BigInt(l.blockNumber),
    }));
  }

  /**
   * Native MON into the destinations: plain sends and contract-forwarded (internal) value transfers, from
   * `debug_traceBlockByNumber` call traces. Reverted frames (and their children) and delegatecalls move no value
   * and are skipped. logIndex = transactionIndex × 10_000 + pre-order frame ordinal (0 = the transaction itself),
   * so each transfer has a stable unique key. Falls back to scanning transaction recipients (top-level sends only)
   * when the endpoint has no trace API.
   */
  async nativeTransfers(destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    const want = new Set(destinations.map((d) => d.toLowerCase()));
    const heights: bigint[] = [];
    for (let n = fromBlock; n <= toBlock; n++) heights.push(n);
    const out: TransferLog[][] = new Array(heights.length);
    let next = 0;
    const worker = async () => {
      while (next < heights.length) {
        const i = next++;
        out[i] = await this.#nativeInBlock(heights[i]!, want);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, heights.length) }, worker));
    return out.flat();
  }

  async #nativeInBlock(height: bigint, want: ReadonlySet<string>): Promise<TransferLog[]> {
    type Frame = { from: string; to?: string; type: string; value?: string; error?: string; calls?: Frame[] };
    const block = await this.call<{ hash: string; transactions: { hash: string; from: string; to: string | null; value: string; transactionIndex: string }[] } | null>('eth_getBlockByNumber', [q(height), !this.#traces]);
    if (!block) return [];
    const blockHash = block.hash.toLowerCase();
    const found: TransferLog[] = [];
    if (this.#traces) {
      let traces: { txHash: string; result: Frame }[];
      try {
        traces = await this.call<{ txHash: string; result: Frame }[]>('debug_traceBlockByNumber', [q(height), { tracer: 'callTracer' }]);
      } catch (error) {
        if (!(error instanceof ChainError) || !/-32601|-32602/.test(error.message)) throw error;
        this.#traces = false; // endpoint without a trace API: top-level sends only
        return this.#nativeInBlock(height, want);
      }
      traces.forEach((t, txIndex) => {
        let ordinal = 0;
        const walk = (f: Frame): void => {
          const index = ordinal++;
          if (f.error) return; // reverted: this frame and its children moved nothing
          const value = BigInt(f.value ?? '0x0');
          const type = f.type.toUpperCase();
          if (value > 0n && f.to && want.has(f.to.toLowerCase()) && type !== 'DELEGATECALL' && type !== 'CALLCODE' && type !== 'STATICCALL') {
            found.push({ chainId: this.chainId, txHash: t.txHash.toLowerCase(), logIndex: txIndex * 10_000 + index, tokenAddress: NATIVE_TOKEN, sender: f.from.toLowerCase(), destination: f.to.toLowerCase(), amount: value, blockHash, blockNumber: height });
          }
          for (const child of f.calls ?? []) walk(child);
        };
        walk(t.result);
      });
      return found;
    }
    for (const t of block.transactions) {
      if (!t.to || !want.has(t.to.toLowerCase()) || BigInt(t.value) === 0n) continue;
      found.push({ chainId: this.chainId, txHash: t.hash.toLowerCase(), logIndex: Number(BigInt(t.transactionIndex)) * 10_000, tokenAddress: NATIVE_TOKEN, sender: t.from.toLowerCase(), destination: t.to.toLowerCase(), amount: BigInt(t.value), blockHash, blockNumber: height });
    }
    return found;
  }

  async erc20Balance(token: string, owner: string, height: bigint): Promise<bigint> {
    const data = `0x70a08231${topicFor(owner).slice(2)}`;
    return BigInt(await this.call<string>('eth_call', [{ to: token.toLowerCase(), data }, q(height)]));
  }

  async nativeBalance(owner: string, height: bigint): Promise<bigint> {
    return BigInt(await this.call<string>('eth_getBalance', [owner.toLowerCase(), q(height)]));
  }
}

/** Two independent endpoints must agree on everything that can credit or settle funds. */
export class CrossCheckedChain implements ChainReader {
  readonly chainId: number;
  readonly primary: ChainReader;
  readonly secondary: ChainReader;
  constructor(primary: ChainReader, secondary: ChainReader) {
    this.primary = primary;
    this.secondary = secondary;
    if (primary.chainId !== secondary.chainId) throw new ChainError('Endpoints serve different chains.');
    this.chainId = primary.chainId;
  }
  latestHeight(): Promise<bigint> {
    return this.primary.latestHeight();
  }
  async finalizedHeight(): Promise<bigint> {
    const [a, b] = await Promise.all([this.primary.finalizedHeight(), this.secondary.finalizedHeight()]);
    return a < b ? a : b;
  }
  async blockHashAt(height: bigint): Promise<string | undefined> {
    const [a, b] = await Promise.all([this.primary.blockHashAt(height), this.secondary.blockHashAt(height)]);
    if (a !== b) throw new ChainError(`Endpoints disagree on block ${height}.`);
    return a;
  }
  async receipt(txHash: string): Promise<Receipt | undefined> {
    const [a, b] = await Promise.all([this.primary.receipt(txHash), this.secondary.receipt(txHash)]);
    if (!a || !b) return undefined;
    if (a.blockHash !== b.blockHash || a.succeeded !== b.succeeded || a.feeAtomic !== b.feeAtomic) throw new ChainError('Endpoints disagree on a receipt.');
    return a;
  }
  transferLogs(token: string, destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    // Observation only creates pending records; finality is cross-checked before credit.
    return this.primary.transferLogs(token, destinations, fromBlock, toBlock);
  }
  nativeTransfers(destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    return this.primary.nativeTransfers(destinations, fromBlock, toBlock);
  }
  async erc20Balance(token: string, owner: string, height: bigint): Promise<bigint> {
    const [a, b] = await Promise.all([this.primary.erc20Balance(token, owner, height), this.secondary.erc20Balance(token, owner, height)]);
    if (a !== b) throw new ChainError('Endpoints disagree on a balance.');
    return a;
  }
  async nativeBalance(owner: string, height: bigint): Promise<bigint> {
    const [a, b] = await Promise.all([this.primary.nativeBalance(owner, height), this.secondary.nativeBalance(owner, height)]);
    if (a !== b) throw new ChainError('Endpoints disagree on a balance.');
    return a;
  }
}
