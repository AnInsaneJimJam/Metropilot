// Privy REST client shapes and the authorization signature, against a recording fetch (no network, no account).
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize } from '@monad-hack/contracts';
import { PrivyCustody, authorizationSignature } from './privy.ts';
import { ProviderError } from './provider.ts';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const authorizationKey = `wallet-auth:${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`;

function recorder(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test('authorization signatures verify against the owner public key over the canonical payload', () => {
  const headers = { 'privy-app-id': 'app', 'privy-idempotency-key': 'k', authorization: 'Basic x' };
  const body = { b: 1, a: [2] };
  const sig = authorizationSignature(privateKey, 'POST', 'https://api.privy.io/v1/wallets/w/rpc/', body, headers);
  const payload = canonicalize({ version: 1, method: 'POST', url: 'https://api.privy.io/v1/wallets/w/rpc', body, headers: { 'privy-app-id': 'app', 'privy-idempotency-key': 'k' } });
  assert.equal(verify('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'der' }, Buffer.from(sig, 'base64')), true);
});

test('wallet creation attaches an owned policy limited to approved destinations, with idempotency keys', async () => {
  const r = recorder([{ status: 200, body: { id: 'pol_123456789012345678901234' } }, { status: 200, body: { id: 'wal_1', address: '0xABCDEF0000000000000000000000000000000001' } }]);
  const privy = new PrivyCustody({ appId: 'app', appSecret: 'secret', authorizationKey, fetch: r.fetch });
  const w = await privy.createWallet({ idempotencyKey: 'wallet-agent-1', agentId: '019a0000-0000-7000-8000-0000000000a1', policy: { chainId: 10143, allowedTo: ['0xAA00000000000000000000000000000000000000'] } });
  assert.deepEqual(w, { providerWalletId: 'wal_1', address: '0xabcdef0000000000000000000000000000000001', policyId: 'pol_123456789012345678901234' });
  assert.equal(r.calls[0]!.url, 'https://api.privy.io/v1/policies');
  const policy = JSON.parse(r.calls[0]!.init.body as string);
  assert.equal(policy.owner.public_key, privy.ownerPublicKey);
  assert.deepEqual(policy.rules[0].conditions[0], { field_source: 'ethereum_transaction', field: 'to', operator: 'in', value: ['0xaa00000000000000000000000000000000000000'] });
  const wallet = JSON.parse(r.calls[1]!.init.body as string);
  assert.deepEqual(wallet.policy_ids, ['pol_123456789012345678901234']);
  const headers = r.calls[1]!.init.headers as Record<string, string>;
  assert.equal(headers['privy-idempotency-key'], 'wallet-agent-1');
  assert.equal(headers['authorization'], `Basic ${Buffer.from('app:secret').toString('base64')}`);
});

test('send signs the request; a 4xx is refused (not sent) and a 5xx or timeout is an unknown outcome', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const r = recorder([{ status: 200, body: { method: 'eth_sendTransaction', data: { hash, caip2: 'eip155:10143' } } }, { status: 400, body: {} }, { status: 503, body: {} }]);
  const privy = new PrivyCustody({ appId: 'app', appSecret: 'secret', authorizationKey, fetch: r.fetch });
  const req = { providerWalletId: 'wal_1', idempotencyKey: 'wd-1', chainId: 10143, to: '0xaa00000000000000000000000000000000000000', data: '0x', value: 5n };
  assert.deepEqual(await privy.send(req), { txHash: hash });
  const body = JSON.parse(r.calls[0]!.init.body as string);
  assert.deepEqual(body.params.transaction, { to: req.to, data: '0x', value: '0x5', chain_id: 10143 });
  assert.ok((r.calls[0]!.init.headers as Record<string, string>)['privy-authorization-signature']);
  await assert.rejects(privy.send(req), (e: unknown) => e instanceof ProviderError && e.kind === 'refused');
  await assert.rejects(privy.send(req), (e: unknown) => e instanceof ProviderError && e.kind === 'unavailable');
});
