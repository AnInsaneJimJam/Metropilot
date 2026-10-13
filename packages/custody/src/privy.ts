// Privy server wallets over REST (verified against docs.privy.io API reference, 2026-10-12):
//   POST /v1/policies, POST /v1/wallets, POST /v1/wallets/{id}/rpc (eth_sendTransaction), POST /v1/wallets/{id}/export.
// Basic auth (app ID : app secret) plus privy-app-id. Wallets are owned by our P-256 authorization key, so every
// signing or policy request also needs privy-authorization-signature: ECDSA P-256 / SHA-256 over the RFC 8785
// canonical JSON of {version: 1, method, url, body, headers: privy-* headers}, DER then base64.
// The authorization key is read from configuration (wallet-auth:<base64 PKCS#8>) and never logged.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { canonicalize } from '@monad-hack/contracts';
import { ProviderError, toQuantity } from './provider.ts';
import type { CreateWalletRequest, CustodyProvider, CustodyWallet, SendRequest, SendResult } from './provider.ts';

export interface PrivyOptions {
  readonly appId: string;
  readonly appSecret: string;
  /** wallet-auth:<base64 PKCS#8 P-256 private key>. */
  readonly authorizationKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
}

export function parseAuthorizationKey(value: string): KeyObject {
  const body = value.startsWith('wallet-auth:') ? value.slice('wallet-auth:'.length) : value;
  const key = createPrivateKey({ key: Buffer.from(body, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('The Privy authorization key must be a P-256 key.');
  return key;
}

/** Base64 DER SPKI public key, the form Privy takes for owner.public_key. */
export const publicKeyOf = (key: KeyObject): string => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');

export function authorizationSignature(key: KeyObject, method: string, url: string, body: unknown, headers: Record<string, string>): string {
  const privy = Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('privy-') && k !== 'privy-authorization-signature'));
  const payload = canonicalize({ version: 1, method, url: url.replace(/\/$/, ''), body, headers: privy });
  return sign('sha256', Buffer.from(payload), { key, dsaEncoding: 'der' }).toString('base64');
}

type Json = Record<string, unknown>;

export class PrivyCustody implements CustodyProvider {
  readonly name = 'privy' as const;
  readonly #o: PrivyOptions;
  readonly #key: KeyObject;
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: string;

  constructor(options: PrivyOptions) {
    if (!options.appId || !options.appSecret) throw new Error('Privy app ID and secret are required.');
    this.#o = options;
    this.#key = parseAuthorizationKey(options.authorizationKey);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = (options.baseUrl ?? 'https://api.privy.io').replace(/\/$/, '');
  }

  get ownerPublicKey(): string {
    return publicKeyOf(this.#key);
  }

  /** One request. signed adds the authorization signature; idempotencyKey adds privy-idempotency-key. */
  async request(method: 'GET' | 'POST' | 'PATCH', path: string, body: Json | undefined, opts: { signed?: boolean; idempotencyKey?: string } = {}): Promise<{ status: number; json: Json }> {
    const url = `${this.#base}${path}`;
    const headers: Record<string, string> = { 'privy-app-id': this.#o.appId };
    if (opts.idempotencyKey) headers['privy-idempotency-key'] = opts.idempotencyKey;
    if (opts.signed) headers['privy-authorization-signature'] = authorizationSignature(this.#key, method, url, body ?? {}, headers);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.#o.timeoutMillis ?? 15_000),
        headers: { ...headers, authorization: `Basic ${Buffer.from(`${this.#o.appId}:${this.#o.appSecret}`).toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProviderError('unavailable', 'Privy was unreachable or timed out.');
    }
    const text = await response.text();
    let json: Json = {};
    try { json = text ? (JSON.parse(text) as Json) : {}; } catch { json = {}; }
    return { status: response.status, json };
  }

  #fail(status: number, what: string): never {
    // 408/429/5xx: the outcome is unknown. Other 4xx: refused before any broadcast.
    if (status === 408 || status === 429 || status >= 500) throw new ProviderError('unavailable', `Privy ${what} is unavailable (${status}).`, status);
    throw new ProviderError('refused', `Privy refused ${what} (${status}).`, status);
  }

  #rules(chainId: number, allowedTo: readonly string[]) {
    return [
      {
        name: 'Allow approved destinations', method: 'eth_sendTransaction', action: 'ALLOW',
        conditions: [
          { field_source: 'ethereum_transaction', field: 'to', operator: 'in', value: allowedTo.map((a) => a.toLowerCase()) },
          { field_source: 'ethereum_transaction', field: 'chain_id', operator: 'eq', value: String(chainId) },
        ],
      },
    ];
  }

  async allowDestinations(_providerWalletId: string, policyId: string | undefined, policy: { chainId: number; allowedTo: readonly string[] }): Promise<void> {
    if (!policyId) throw new ProviderError('refused', 'This wallet has no provider policy to update.');
    // The policy is owned by our authorization key, so the update is signed.
    const { status } = await this.request('PATCH', `/v1/policies/${encodeURIComponent(policyId)}`, { rules: this.#rules(policy.chainId, policy.allowedTo) }, { signed: true });
    if (status !== 200) this.#fail(status, 'the policy update');
  }

  async createPolicy(name: string, chainId: number, allowedTo: readonly string[], idempotencyKey: string): Promise<string> {
    const body = {
      version: '1.0', name: name.slice(0, 50), chain_type: 'ethereum', owner: { public_key: this.ownerPublicKey },
      rules: this.#rules(chainId, allowedTo),
    };
    const { status, json } = await this.request('POST', '/v1/policies', body, { idempotencyKey });
    if (status !== 200 || typeof json['id'] !== 'string') this.#fail(status, 'policy creation');
    return json['id'] as string;
  }

  async createWallet(request: CreateWalletRequest): Promise<CustodyWallet> {
    const policyId = await this.createPolicy(`agent ${request.agentId.slice(-12)}`, request.policy.chainId, request.policy.allowedTo, `${request.idempotencyKey}-policy`);
    const body = { chain_type: 'ethereum', owner: { public_key: this.ownerPublicKey }, policy_ids: [policyId], external_id: request.agentId };
    const { status, json } = await this.request('POST', '/v1/wallets', body, { idempotencyKey: request.idempotencyKey });
    if (status !== 200 || typeof json['id'] !== 'string' || typeof json['address'] !== 'string') this.#fail(status, 'wallet creation');
    return { providerWalletId: json['id'] as string, address: (json['address'] as string).toLowerCase(), policyId };
  }

  async send(request: SendRequest): Promise<SendResult> {
    const body = {
      method: 'eth_sendTransaction', caip2: `eip155:${request.chainId}`, chain_type: 'ethereum', reference_id: request.idempotencyKey.slice(0, 64),
      params: { transaction: { to: request.to.toLowerCase(), data: request.data, value: toQuantity(request.value), chain_id: request.chainId, ...(request.gasLimit ? { gas_limit: toQuantity(request.gasLimit) } : {}) } },
    };
    const { status, json } = await this.request('POST', `/v1/wallets/${encodeURIComponent(request.providerWalletId)}/rpc`, body, { signed: true, idempotencyKey: request.idempotencyKey });
    const hash = (json['data'] as Json | undefined)?.['hash'];
    if (status !== 200) this.#fail(status, 'the transaction');
    // A 200 means broadcast; an empty hash (sponsored flow) is not used here and is an unknown outcome.
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ProviderError('unavailable', 'Privy accepted the transaction without a hash.', status);
    return { txHash: hash.toLowerCase() };
  }
}
