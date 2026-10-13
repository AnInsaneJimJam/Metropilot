#!/usr/bin/env node
// Write the stack's env file (git-ignored, 0600; default infra/stack/.env.server, or ENV_OUT) for docker compose.
// Values: the repository .env (Privy, Envio, Alchemy, AI Gateway), generated secrets kept across runs (a redeploy never rotates
// the database password or capability secrets), Privy's published signing keys (PEM, from its JWKS) and, on the first
// run, the Monad mainnet finalized height so deposit scanning starts now instead of block 0. Never prints values.
//   node infra/stack/render-env.mjs <api-host> <image> <runtime-digest>
import { createPublicKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = process.env['ENV_OUT'] || join(here, '.env.server');
const [apiHost, image, digest] = process.argv.slice(2);
if (!apiHost || !image || !/^0x[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('usage: render-env.mjs <api-host> <image> <0x runtime digest>');

const read = (path) => Object.fromEntries(existsSync(path) ? readFileSync(path, 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]) : []);
const repo = read(join(root, '.env'));
const current = read(out);
for (const name of ['PRIVY_APP_ID', 'PRIVY_APP_SECRET', 'PRIVY_AUTHORIZATION_KEY']) {
  if (!repo[name]) throw new Error(`${name} is missing from .env`);
}
const hex = () => randomBytes(32).toString('hex');
const keep = (name, make) => current[name] || make();

// Privy signs access tokens with the keys it publishes; all of them are accepted (rotation overlaps).
const jwks = await (await fetch(`https://auth.privy.io/api/v1/apps/${repo.PRIVY_APP_ID}/jwks.json`)).json();
const pems = jwks.keys.map((k) => createPublicKey({ key: k, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString().trim());
if (!pems.length) throw new Error('Privy published no verification keys.');

const rpc = repo.MAINNET_RPC || 'https://rpc.monad.xyz';
let startHeight = current.CUSTODY_START_HEIGHT;
if (!startHeight) {
  const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }) });
  startHeight = String(BigInt((await res.json()).result.number));
}
const password = keep('POSTGRES_PASSWORD', hex);
// Alchemy (D60), optional: the second custody witness and the market transport, paced for its free tier.
const alchemy = repo.MARKET_RPC_URL ? { span: '10', rps: '15', push: '2500' } : { span: '100', rps: '0', push: '0' };
const env = {
  APP_IMAGE: image,
  API_HOST: apiHost,
  PUBLIC_ORIGIN: repo.PUBLIC_ORIGIN || current.PUBLIC_ORIGIN || 'https://metropilot.vercel.app',
  RUNTIME_IMAGE_DIGEST: digest,
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgres://monad:${password}@postgres:5432/monad`,
  EXECUTOR_CAPABILITY_SECRET: keep('EXECUTOR_CAPABILITY_SECRET', hex),
  BROKER_CAPABILITY_SECRET: keep('BROKER_CAPABILITY_SECRET', hex),
  RUNTIME_WORKLOAD_SECRET: keep('RUNTIME_WORKLOAD_SECRET', hex),
  PRIVY_APP_ID: repo.PRIVY_APP_ID,
  PRIVY_APP_SECRET: repo.PRIVY_APP_SECRET,
  PRIVY_AUTHORIZATION_KEY: repo.PRIVY_AUTHORIZATION_KEY,
  PRIVY_VERIFICATION_KEY: pems.join('\n').replaceAll('\n', '\\n'),
  ENVIO_API_TOKEN: repo.ENVIO_API_TOKEN ?? '',
  AI_GATEWAY_API_KEY: repo.AI_GATEWAY_API_KEY ?? '',
  // JSON holds quotes, which compose env files cannot carry: passed base64-encoded (infra/container/entry.sh).
  KIMI_VERIFICATION_B64: current.KIMI_VERIFICATION_B64 || (repo.KIMI_VERIFICATION_JSON ? Buffer.from(repo.KIMI_VERIFICATION_JSON).toString('base64') : ''),
  CUSTODY_PROVIDER: 'privy',
  CUSTODY_CHAIN_ID: '143',
  CUSTODY_NETWORK_REF: 'monad-mainnet',
  CUSTODY_RPC: rpc,
  CUSTODY_START_HEIGHT: startHeight,
  CUSTODY_RPC_SECONDARY: repo.CUSTODY_RPC_SECONDARY ?? '',
  MARKET_RPC_URL: repo.MARKET_RPC_URL || 'https://rpc.monad.xyz',
  MARKET_WS_URL: repo.MARKET_WS_URL || 'wss://rpc.monad.xyz',
  MARKET_LOG_SPAN: repo.MARKET_LOG_SPAN || alchemy.span,
  MARKET_RPC_MAX_RPS: repo.MARKET_RPC_MAX_RPS || alchemy.rps,
  MARKET_PUSH_MIN_MILLIS: repo.MARKET_PUSH_MIN_MILLIS || alchemy.push,
  // Real-money switches stay off until the first capped trade is approved (docs/hosting/LIGHTSAIL.md).
  LIVE_OUTFLOWS: current.LIVE_OUTFLOWS ?? '0',
  LIVE_LAUNCH: current.LIVE_LAUNCH ?? '0',
  EXECUTOR_LIVE: current.EXECUTOR_LIVE ?? '0',
};
for (const [k, v] of Object.entries(env)) if (/[\n$"'`]/.test(String(v))) throw new Error(`${k} has a character docker compose would reinterpret.`);
writeFileSync(out, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`wrote ${out} (${Object.keys(env).length} values; start height ${startHeight}; ${pems.length} Privy keys)`);
