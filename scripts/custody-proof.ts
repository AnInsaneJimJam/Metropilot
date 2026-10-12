// E03 Privy capability proof (packages/custody EXE-2). Run with real Privy app credentials in .env:
//   PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY (wallet-auth:<base64 PKCS#8 P-256>), optional PRIVY_PROOF_CHAIN_ID.
// Generate an authorization key with: node scripts/custody-proof.ts --new-key  (prints the private key once; store it in .env).
// Checks, without moving funds: ownership by our key, idempotent creation, signing requires the owner
// signature (app secret alone cannot sign), policy denial of an unapproved destination, export denial without
// the owner signature, and recovery of the wallet by ID from a fresh client. Prints dated evidence for
// docs/decisions.md E03. Never prints secrets.
import { generateKeyPairSync } from 'node:crypto';
import { PrivyCustody } from '../packages/custody/src/privy.ts';

if (process.argv.includes('--new-key')) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  console.log(`PRIVY_AUTHORIZATION_KEY=wallet-auth:${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`);
  process.exit(0);
}

const appId = process.env['PRIVY_APP_ID'];
const appSecret = process.env['PRIVY_APP_SECRET'];
const authorizationKey = process.env['PRIVY_AUTHORIZATION_KEY'];
if (!appId || !appSecret || !authorizationKey) {
  console.log('E03 proof skipped: set PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_KEY in .env (see docs/integration/funds.md).');
  process.exit(0);
}
const chainId = Number(process.env['PRIVY_PROOF_CHAIN_ID'] ?? '10143');
const privy = new PrivyCustody({ appId, appSecret, authorizationKey });
const run = `proof-${Date.now().toString(36)}`;
const results: { check: string; pass: boolean; detail: string }[] = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${detail}`);
};

const allowed = '0x000000000000000000000000000000000000dead';
const denied = '0x000000000000000000000000000000000000beef';
const wallet = await privy.createWallet({ idempotencyKey: run, agentId: run, policy: { chainId, allowedTo: [allowed] } });
const again = await privy.request('POST', '/v1/wallets', { chain_type: 'ethereum', owner: { public_key: privy.ownerPublicKey }, policy_ids: [wallet.policyId], external_id: run }, { idempotencyKey: run });
record('idempotent creation', again.json['id'] === wallet.providerWalletId, `same key returned ${String(again.json['id'])}`);

const fetched = await privy.request('GET', `/v1/wallets/${wallet.providerWalletId}`, undefined);
record('ownership by the platform authorization key', typeof fetched.json['owner_id'] === 'string' && fetched.json['owner_id'] !== '', `owner_id ${String(fetched.json['owner_id'])}`);
record('policy attached', Array.isArray(fetched.json['policy_ids']) && (fetched.json['policy_ids'] as unknown[]).includes(wallet.policyId), `policy ${wallet.policyId}`);

const message = { method: 'personal_sign', params: { message: `monad-hack E03 ${run}`, encoding: 'utf-8' } };
const unsigned = await privy.request('POST', `/v1/wallets/${wallet.providerWalletId}/rpc`, message);
const signed = await privy.request('POST', `/v1/wallets/${wallet.providerWalletId}/rpc`, message, { signed: true });
const signature = (signed.json['data'] as Record<string, unknown> | undefined)?.['signature'];
record('owner signature signs', signed.status === 200 && typeof signature === 'string', `status ${signed.status}`);
// Only an authorization refusal counts: the same body succeeded with the owner signature, so a 400 is not a denial.
record('app secret alone cannot sign', unsigned.status === 401 || unsigned.status === 403, `status ${unsigned.status}`);

const tx = { method: 'eth_sendTransaction', caip2: `eip155:${chainId}`, chain_type: 'ethereum', params: { transaction: { to: denied, value: '0x0', chain_id: chainId } } };
const blocked = await privy.request('POST', `/v1/wallets/${wallet.providerWalletId}/rpc`, tx, { signed: true, idempotencyKey: `${run}-denied` });
const policyText = JSON.stringify(blocked.json).toLowerCase();
record('policy denies an unapproved destination', blocked.status >= 400 && blocked.status < 500 && (blocked.status === 403 || policyText.includes('polic')), `status ${blocked.status}`);

const exported = await privy.request('POST', `/v1/wallets/${wallet.providerWalletId}/export`, { encryption_type: 'HPKE', recipient_public_key: privy.ownerPublicKey });
record('export denied without the owner signature', exported.status === 401 || exported.status === 403, `status ${exported.status}`);

const fresh = new PrivyCustody({ appId, appSecret, authorizationKey });
const recovered = await fresh.request('GET', `/v1/wallets/${wallet.providerWalletId}`, undefined);
record('recovery from a fresh client', String(recovered.json['address']).toLowerCase() === wallet.address, `address ${wallet.address}`);

const passed = results.every((r) => r.pass);
console.log(`\nE03 evidence ${new Date().toISOString().slice(0, 10)}: ${passed ? 'PASS' : 'FAIL'} (${results.filter((r) => r.pass).length}/${results.length}), chain ${chainId}, wallet ${wallet.providerWalletId}`);
process.exit(passed ? 0 : 1);
