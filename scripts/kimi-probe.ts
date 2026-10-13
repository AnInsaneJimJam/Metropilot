// One explicitly opted-in, synthetic-input Gateway call. Never runs as part of CI.
// The exclusive journal prevents an ambiguous dispatch from being repeated on restart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { BrokerRequest } from '@monad-hack/contracts';
import { KimiAdapter, KIMI_MODEL, KIMI_RATES, usageCost } from '../apps/api/src/kimi-adapter.ts';

if (process.argv.slice(2).join() !== '--allow-credit-use') throw new Error('Pass --allow-credit-use to authorize one capped Gateway call.');
const apiKey = process.env['AI_GATEWAY_API_KEY'];
if (!apiKey?.trim()) throw new Error('Save AI_GATEWAY_API_KEY in the ignored .env first.');
const request = JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/brokerRequest/valid/ai-decision.json', import.meta.url), 'utf8')) as BrokerRequest;
request.prompt = 'Synthetic verification only. The authored rule requires skipping when the signal is uncertain. Return decision skip and a short summary.';
request.inputs = {};
request.maxOutputTokens = 256;
request.timeoutSeconds = 30;
const adapter = new KimiAdapter({ apiKey, verified: true });
const plan = adapter.prepare(request);
if (plan.reservedUsdMicros > 2000n) throw new Error('Probe exceeds the $0.002 token-cost ceiling.');
mkdirSync('.secrets', { recursive: true, mode: 0o700 });
const path = '.secrets/kimi-probe.json';
const record = { model: KIMI_MODEL, rateVersion: KIMI_RATES.version, authorizedAt: new Date().toISOString(), reservedUsdMicros: plan.reservedUsdMicros.toString() };
writeFileSync(path, JSON.stringify({ ...record, state: 'dispatched' }, null, 2), { flag: 'wx', mode: 0o600 });
const answer = await adapter.call(request, plan);
const evidence = {
  ...record,
  state: answer.usage ? 'reported' : 'unknown',
  disposition: answer.result.disposition,
  reasonCode: answer.result.reason?.code,
  providerRequestId: answer.providerRequestId,
  usage: answer.usage,
  reportedUsdMicros: answer.usage ? usageCost(answer.usage).toString() : undefined,
  decision: answer.result.value?.decision,
};
writeFileSync(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence, null, 2));
console.log('Compare this request with Vercel Gateway Logs before recording billing verification. No verification gate was opened.');
if (answer.result.disposition !== 'completed' || answer.result.value?.decision !== 'skip') process.exitCode = 1;
