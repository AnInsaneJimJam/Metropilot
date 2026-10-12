// Wallet-provider port (docs/specs/executor.md, funds-and-budgets.md section 1). The provider holds signing keys;
// the platform holds provider wallet IDs and addresses only. A refused request was definitively not sent; an
// unavailable one may have been, so the caller reconciles from the chain and never sends a new transfer.

export interface WalletPolicy {
  readonly chainId: number;
  /** Contracts and addresses the wallet may send transactions to (token contracts, routers, verified destinations). */
  readonly allowedTo: readonly string[];
}

export interface CreateWalletRequest {
  /** Same key, same wallet: provisioning retries never create a second wallet. */
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly policy: WalletPolicy;
}

export interface CustodyWallet {
  readonly providerWalletId: string;
  /** Lower-case 0x address. */
  readonly address: string;
  readonly policyId: string | undefined;
}

export interface SendRequest {
  readonly providerWalletId: string;
  /** Stable per financial operation; the provider deduplicates on it. */
  readonly idempotencyKey: string;
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
}

export interface SendResult {
  readonly txHash: string;
}

export class ProviderError extends Error {
  /** refused: definitively not broadcast. unavailable: outcome unknown, reconcile. */
  readonly kind: 'refused' | 'unavailable';
  readonly status: number | undefined;
  constructor(kind: 'refused' | 'unavailable', message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export interface CustodyProvider {
  readonly name: 'privy' | 'local';
  createWallet(request: CreateWalletRequest): Promise<CustodyWallet>;
  /** Replace the wallet policy's approved destinations (token contracts plus verified native recipients). */
  allowDestinations(providerWalletId: string, policyId: string | undefined, policy: WalletPolicy): Promise<void>;
  send(request: SendRequest): Promise<SendResult>;
}

const HEX = /^0x[0-9a-f]*$/;
const pad = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');

/** ERC-20 transfer(address,uint256) calldata. */
export function erc20TransferData(to: string, amount: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || amount < 0n) throw new Error('Invalid transfer.');
  return `0xa9059cbb${pad(to.toLowerCase())}${pad(amount.toString(16))}`;
}

export const toQuantity = (n: bigint): string => `0x${n.toString(16)}`;
export const isHex = (s: string): boolean => HEX.test(s);
