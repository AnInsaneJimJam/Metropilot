import { readFileSync } from 'node:fs';
import { KIMI_MODEL, KIMI_RATES } from './kimi-adapter.ts';

/** Operator-provided evidence, deliberately absent from normal local/CI configuration. */
export function kimiVerified(env: Readonly<Record<string, string | undefined>>, now = new Date()): boolean {
  const path = env['KIMI_VERIFICATION_FILE'];
  if (!path) return false;
  const bytes = readFileSync(path);
  if (bytes.byteLength > 4096) throw new Error('Kimi verification evidence exceeds its limit.');
  const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const keys = ['boundedBillingVerified','cachedInputUsdMicrosPerMillion','evidenceRef','inputUsdMicrosPerMillion','model','outputUsdMicrosPerMillion','rateVersion','verifiedAt'];
  const verifiedAt = typeof raw?.verifiedAt === 'string' ? Date.parse(raw.verifiedAt) : NaN;
  if (!raw || Object.keys(raw).sort().join() !== keys.sort().join() || raw.boundedBillingVerified !== true || raw.model !== KIMI_MODEL || raw.rateVersion !== KIMI_RATES.version || raw.inputUsdMicrosPerMillion !== KIMI_RATES.input.toString() || raw.cachedInputUsdMicrosPerMillion !== KIMI_RATES.cachedInput.toString() || raw.outputUsdMicrosPerMillion !== KIMI_RATES.output.toString() || !Number.isFinite(verifiedAt) || verifiedAt > now.getTime() || now.getTime() - verifiedAt > 7*86400000 || typeof raw.evidenceRef !== 'string' || !raw.evidenceRef || raw.evidenceRef.length > 500 || !env['AI_GATEWAY_API_KEY']) throw new Error('Current verified Kimi billing evidence and broker credential are required.');
  return true;
}
