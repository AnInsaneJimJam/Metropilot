// Local development stand-ins: an in-memory chain with finality depth and a custody provider that "signs" by
// appending transfers to it. Labelled local everywhere; nothing here touches a real network, key or token.
// Used by tests and `pnpm stack:dev`; production wiring refuses them (see apps/api server configuration).
import { createHash } from 'node:crypto';
import { ChainError, NATIVE_TOKEN } from './chain.ts';
import type { ChainReader, Receipt, TransferLog } from './chain.ts';
import { ProviderError } from './provider.ts';
import type { CreateWalletRequest, CustodyProvider, CustodyWallet, SendRequest, SendResult } from './provider.ts';

const h = (s: string): string => `0x${createHash('sha256').update(s).digest('hex')}`;
export const NATIVE = 'native';

interface Tx {
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly token: string;
  readonly amount: bigint;
  readonly succeeded: boolean;
  readonly fee: bigint;
  /** Minted from outside the simulated economy (a test deposit): nothing is debited. */
  readonly external: boolean;
}

export class LocalChain implements ChainReader {
  readonly chainId: number;
  readonly finalityDepth: number;
  readonly #blocks: { hash: string; txs: Tx[] }[] = [{ hash: h('genesis'), txs: [] }];
  #pending: Tx[] = [];
  readonly #balances = new Map<string, bigint>();
  #salt = 0;
  feePerTx = 21_000n * 1_000_000_000n;
  /** When set, a transfer to this destination reverts (still paying the fee). */
  revertTo: string | undefined;

  constructor(chainId = 31_337, finalityDepth = 2) {
    this.chainId = chainId;
    this.finalityDepth = finalityDepth;
  }

  #key = (token: string, owner: string): string => `${token.toLowerCase()}:${owner.toLowerCase()}`;
  balanceOf(token: string, owner: string): bigint {
    return this.#balances.get(this.#key(token, owner)) ?? 0n;
  }
  #move(token: string, from: string | undefined, to: string, amount: bigint): void {
    if (from) this.#balances.set(this.#key(token, from), this.balanceOf(token, from) - amount);
    this.#balances.set(this.#key(token, to), this.balanceOf(token, to) + amount);
  }

  /** Mint test tokens to an address in the next block (a deposit from an outside sender). */
  fund(token: string, to: string, amount: bigint, from = '0x000000000000000000000000000000000000f00d'): string {
    const hash = h(`fund:${++this.#salt}:${token}:${to}`);
    this.#pending.push({ hash, from, to: to.toLowerCase(), token: token.toLowerCase(), amount, succeeded: true, fee: 0n, external: true });
    return hash;
  }

  submit(from: string, to: string, token: string, amount: bigint, key: string): string {
    const hash = h(`tx:${key}`);
    if (this.#pending.some((t) => t.hash === hash) || this.#blocks.some((b) => b.txs.some((t) => t.hash === hash))) return hash;
    const native = this.balanceOf(NATIVE, from);
    if (native < this.feePerTx) throw new ProviderError('refused', 'Insufficient native balance for gas.');
    const succeeded = this.revertTo !== to.toLowerCase() && this.balanceOf(token, from) >= amount + (token === NATIVE ? this.feePerTx : 0n);
    this.#pending.push({ hash, from: from.toLowerCase(), to: to.toLowerCase(), token: token.toLowerCase(), amount, succeeded, fee: this.feePerTx, external: false });
    return hash;
  }

  #apply(txs: readonly Tx[]): void {
    for (const t of txs) {
      if (!t.external) this.#balances.set(this.#key(NATIVE, t.from), this.balanceOf(NATIVE, t.from) - t.fee);
      if (t.succeeded) this.#move(t.token, t.external ? undefined : t.from, t.to, t.amount);
    }
  }

  /** Produce blocks; the first one includes every pending transaction. */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) {
      const txs = this.#pending;
      this.#pending = [];
      this.#apply(txs);
      this.#blocks.push({ hash: h(`block:${this.#blocks.length}:${++this.#salt}`), txs });
    }
  }

  /** Replace the last n unfinalized blocks with empty ones (their transactions are dropped); balances replay. */
  reorg(n: number): void {
    if (n > this.finalityDepth) throw new ChainError('Cannot reorg finalized blocks.');
    this.#blocks.splice(this.#blocks.length - n);
    for (let i = 0; i < n; i++) this.#blocks.push({ hash: h(`reorg:${this.#blocks.length}:${++this.#salt}`), txs: [] });
    this.#balances.clear();
    for (const b of this.#blocks) this.#apply(b.txs);
  }

  async latestHeight(): Promise<bigint> {
    return BigInt(this.#blocks.length - 1);
  }
  async finalizedHeight(): Promise<bigint> {
    return BigInt(Math.max(0, this.#blocks.length - 1 - this.finalityDepth));
  }
  async blockHashAt(height: bigint): Promise<string | undefined> {
    return this.#blocks[Number(height)]?.hash;
  }
  async receipt(txHash: string): Promise<Receipt | undefined> {
    for (let n = 0; n < this.#blocks.length; n++) {
      const t = this.#blocks[n]!.txs.find((x) => x.hash === txHash.toLowerCase());
      if (t) return { txHash: t.hash, succeeded: t.succeeded, blockNumber: BigInt(n), blockHash: this.#blocks[n]!.hash, feeAtomic: t.fee };
    }
    return undefined;
  }
  async transferLogs(token: string, destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    const want = new Set(destinations.map((d) => d.toLowerCase()));
    const out: TransferLog[] = [];
    for (let n = Number(fromBlock); n <= Number(toBlock) && n < this.#blocks.length; n++) {
      this.#blocks[n]!.txs.forEach((t, i) => {
        if (t.succeeded && t.token === token.toLowerCase() && want.has(t.to)) {
          out.push({ chainId: this.chainId, txHash: t.hash, logIndex: i, tokenAddress: t.token, sender: t.from, destination: t.to, amount: t.amount, blockHash: this.#blocks[n]!.hash, blockNumber: BigInt(n) });
        }
      });
    }
    return out;
  }
  async nativeTransfers(destinations: readonly string[], fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]> {
    const want = new Set(destinations.map((d) => d.toLowerCase()));
    const out: TransferLog[] = [];
    for (let n = Number(fromBlock); n <= Number(toBlock) && n < this.#blocks.length; n++) {
      this.#blocks[n]!.txs.forEach((t, i) => {
        if (t.succeeded && t.token === NATIVE && want.has(t.to) && t.amount > 0n) {
          out.push({ chainId: this.chainId, txHash: t.hash, logIndex: i, tokenAddress: NATIVE_TOKEN, sender: t.from, destination: t.to, amount: t.amount, blockHash: this.#blocks[n]!.hash, blockNumber: BigInt(n) });
        }
      });
    }
    return out;
  }
  /** Balance as of a block height, replayed from the blocks (like an archive RPC read at that height). */
  #balanceAt(token: string, owner: string, height: bigint): bigint {
    let balance = 0n;
    const t = token.toLowerCase();
    const o = owner.toLowerCase();
    for (let n = 0; n <= Number(height) && n < this.#blocks.length; n++) {
      for (const tx of this.#blocks[n]!.txs) {
        if (!tx.external && tx.from === o && t === NATIVE) balance -= tx.fee;
        if (!tx.succeeded || tx.token !== t) continue;
        if (tx.to === o) balance += tx.amount;
        if (!tx.external && tx.from === o) balance -= tx.amount;
      }
    }
    return balance;
  }
  async erc20Balance(token: string, owner: string, height: bigint): Promise<bigint> {
    return this.#balanceAt(token, owner, height);
  }
  async nativeBalance(owner: string, height: bigint): Promise<bigint> {
    return this.#balanceAt(NATIVE, owner, height);
  }
}

/** Deterministic local wallets; "sending" decodes the ERC-20 transfer or native value onto the LocalChain. */
export class LocalCustody implements CustodyProvider {
  readonly name = 'local' as const;
  readonly wallets = new Map<string, { address: string; allowedTo: Set<string> }>();
  unavailable = false;
  readonly chain: LocalChain;
  constructor(chain: LocalChain) {
    this.chain = chain;
  }

  async createWallet(request: CreateWalletRequest): Promise<CustodyWallet> {
    const id = `local-${h(request.idempotencyKey).slice(2, 26)}`;
    const address = `0x${h(`wallet:${request.agentId}`).slice(-40)}`;
    this.wallets.set(id, { address, allowedTo: new Set(request.policy.allowedTo.map((a) => a.toLowerCase())) });
    return { providerWalletId: id, address, policyId: `local-policy-${id.slice(6, 18)}` };
  }

  async allowDestinations(providerWalletId: string, _policyId: string | undefined, policy: { allowedTo: readonly string[] }): Promise<void> {
    const wallet = this.wallets.get(providerWalletId);
    if (!wallet) throw new ProviderError('refused', 'Unknown wallet.');
    wallet.allowedTo = new Set(policy.allowedTo.map((a) => a.toLowerCase()));
  }

  async send(request: SendRequest): Promise<SendResult> {
    if (this.unavailable) throw new ProviderError('unavailable', 'Local provider unavailable (test).');
    const wallet = this.wallets.get(request.providerWalletId);
    if (!wallet) throw new ProviderError('refused', 'Unknown wallet.');
    // Provider policy (defense in depth): only approved destinations.
    if (!wallet.allowedTo.has(request.to.toLowerCase())) throw new ProviderError('refused', 'Destination denied by wallet policy.');
    if (request.data.startsWith('0xa9059cbb')) {
      const to = `0x${request.data.slice(10 + 24, 10 + 64)}`;
      const amount = BigInt(`0x${request.data.slice(10 + 64)}`);
      return { txHash: this.chain.submit(wallet.address, to, request.to, amount, request.idempotencyKey) };
    }
    return { txHash: this.chain.submit(wallet.address, request.to, NATIVE, request.value, request.idempotencyKey) };
  }
}
