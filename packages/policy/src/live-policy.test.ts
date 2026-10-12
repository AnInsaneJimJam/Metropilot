// POL-2..POL-5: live context blocks, malicious and missing context, stale generation and limit boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineLimits, evaluateAction, mergeVerdicts } from './index.ts';
import type { ActionContext, ActionLimits } from './index.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const WALLET = '0x00000000000000000000000000000000000000a1';
const ROUTER = '0x00000000000000000000000000000000000000b2';
const T = '019a0000-0000-7000-8000-000000000000';
const A = '019a0000-0000-7000-8000-0000000000a1';
const D = '019a0000-0000-7000-8000-0000000000d1';

const limits: ActionLimits = {
  maxSlippageBps: 50, maxInputAtomic: 1000n, dailyActionCount: 10, dailyNotionalUsdMicros: 5_000_000n, maxQuoteAgeSeconds: 10,
  maxReferenceDeviationBps: 100, maxGasAtomic: 500n, minNativeReserveAtomic: 100n, maxApprovalAtomic: 1000n,
  allowedRecipients: [WALLET], allowedSpenders: [ROUTER], allowedChainIds: [10143],
};

const live: ActionContext = {
  mode: 'live', deploymentActive: true, connectorEnabled: true, assetsAllowed: true, requestedSlippageBps: 50, limits: [limits],
  resolvedInputAtomic: 1000n, availableInputAtomic: 1000n, actionsInWindow: 9,
  valuation: { observedAtMillis: NOW - 1000, maxAgeSeconds: 60 }, nowMillis: NOW,
  identity: { capabilityTenantId: T, capabilityAgentId: A, capabilityDeploymentId: D, capabilityGeneration: '3', tenantId: T, agentId: A, deploymentId: D, currentGeneration: '3', fundingOwnerAgentId: A },
  chain: { chainId: 10143, recipient: WALLET, agentWallet: WALLET },
  // 50 bps of 10_000 = 50: min output exactly at the slippage limit; expected exactly 100 bps from the reference.
  quote: { quotedAtMillis: NOW - 10_000, expiresAtMillis: NOW + 1, inputAtomic: 1000n, expectedOutputAtomic: 10_000n, minOutputAtomic: 9_950n, referenceOutputAtomic: 10_101n },
  gas: { ceilingAtomic: 500n, availableNativeAtomic: 600n },
  allowance: { required: true, spender: ROUTER.toUpperCase().replace('0X', '0x'), approvalAtomic: 1000n },
  notional: { notionalUsdMicros: 1_000_000n, windowNotionalUsdMicros: 4_000_000n },
  branchEvidenceVerified: true, signerReady: true, reconciliationOpen: false,
};

const codes = (change: Partial<ActionContext>): string[] => {
  const v = evaluateAction({ ...live, ...change });
  return v.allow ? [] : [...new Set(v.denials.map((d) => d.code))];
};

test('a live action exactly at every limit boundary is allowed', () => {
  assert.deepEqual(evaluateAction(live), { allow: true, policyVersion: 'action-policy/2' });
});

test('one past each boundary denies with its stable reason', () => {
  assert.deepEqual(codes({ resolvedInputAtomic: 1001n, availableInputAtomic: 2000n, quote: { ...live.quote!, inputAtomic: 1001n }, allowance: { ...live.allowance!, approvalAtomic: 1001n } }), ['EXECUTOR_AMOUNT_EXCEEDED', 'EXECUTOR_ALLOWANCE_UNSAFE']);
  assert.deepEqual(codes({ actionsInWindow: 10 }), ['EXECUTOR_DAILY_LIMIT_EXCEEDED']);
  assert.deepEqual(codes({ notional: { notionalUsdMicros: 1_000_001n, windowNotionalUsdMicros: 4_000_000n } }), ['EXECUTOR_DAILY_LIMIT_EXCEEDED']);
  assert.deepEqual(codes({ quote: { ...live.quote!, quotedAtMillis: NOW - 10_001 } }), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(codes({ quote: { ...live.quote!, expiresAtMillis: NOW } }), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(codes({ quote: { ...live.quote!, minOutputAtomic: 9_949n } }), ['EXECUTOR_SLIPPAGE_EXCEEDED']);
  assert.deepEqual(codes({ quote: { ...live.quote!, referenceOutputAtomic: 10_102n } }), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(codes({ gas: { ceilingAtomic: 501n, availableNativeAtomic: 10_000n } }), ['EXECUTOR_GAS_LIMIT_EXCEEDED']);
  assert.deepEqual(codes({ gas: { ceilingAtomic: 500n, availableNativeAtomic: 599n } }), ['EXECUTOR_NATIVE_RESERVE_LOW']);
});

test('malicious context: stale generation, foreign capability or wallet, wrong recipient, chain, spender or unlimited approval', () => {
  assert.deepEqual(codes({ identity: { ...live.identity!, currentGeneration: '4' } }), ['EXECUTOR_STALE_GENERATION']);
  assert.deepEqual(codes({ identity: { ...live.identity!, capabilityAgentId: '019a0000-0000-7000-8000-0000000000ff' } }), ['EXECUTOR_CAPABILITY_INVALID']);
  assert.deepEqual(codes({ identity: { ...live.identity!, fundingOwnerAgentId: '019a0000-0000-7000-8000-0000000000ff' } }), ['EXECUTOR_CAPABILITY_INVALID']);
  assert.deepEqual(codes({ chain: { ...live.chain!, recipient: '0x00000000000000000000000000000000000000c3' } }), ['EXECUTOR_ASSET_NOT_ALLOWED']);
  assert.deepEqual(codes({ chain: { ...live.chain!, chainId: 1 } }), ['EXECUTOR_ASSET_NOT_ALLOWED']);
  assert.deepEqual(codes({ allowance: { required: true, spender: '0x00000000000000000000000000000000000000c3', approvalAtomic: 1000n } }), ['EXECUTOR_ALLOWANCE_UNSAFE']);
  assert.deepEqual(codes({ allowance: { required: true, spender: ROUTER, approvalAtomic: 1000n, unlimited: true } }), ['EXECUTOR_ALLOWANCE_UNSAFE']);
  assert.deepEqual(codes({ allowance: { required: true, spender: ROUTER, approvalAtomic: 1000n, permit: true } }), ['EXECUTOR_ALLOWANCE_UNSAFE']);
  assert.deepEqual(codes({ quote: { ...live.quote!, minOutputAtomic: 10_001n } }), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(codes({ quote: { ...live.quote!, quotedAtMillis: NOW + 1 } }), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(codes({ reconciliationOpen: true }), ['EXECUTOR_RECONCILIATION_REQUIRED']);
  assert.deepEqual(codes({ branchEvidenceVerified: false }), ['EXECUTOR_AST_MISMATCH']);
  assert.deepEqual(codes({ signerReady: false }), ['EXECUTOR_PROVIDER_UNAVAILABLE']);
});

test('each missing live block denies instead of defaulting; paper keeps its behaviour without them', () => {
  const without = (key: keyof ActionContext): string[] => {
    const { [key]: _, ...rest } = live;
    const v = evaluateAction(rest as ActionContext);
    return v.allow ? [] : [...new Set(v.denials.map((d) => d.code))];
  };
  assert.deepEqual(without('identity'), ['EXECUTOR_CAPABILITY_INVALID']);
  assert.deepEqual(without('chain'), ['EXECUTOR_ASSET_NOT_ALLOWED']);
  assert.deepEqual(without('quote'), ['EXECUTOR_QUOTE_INVALID']);
  assert.deepEqual(without('gas'), ['EXECUTOR_GAS_LIMIT_EXCEEDED']);
  assert.deepEqual(without('allowance'), ['EXECUTOR_ALLOWANCE_UNSAFE']);
  assert.deepEqual(without('notional'), ['EXECUTOR_DAILY_LIMIT_EXCEEDED']);
  assert.deepEqual(without('branchEvidenceVerified'), ['EXECUTOR_AST_MISMATCH']);
  assert.deepEqual(without('signerReady'), ['EXECUTOR_PROVIDER_UNAVAILABLE']);
  // Missing limits in live: no gas, quote-age, reference, chain, notional or input bound means deny.
  assert.deepEqual(codes({ limits: [{ maxSlippageBps: 50, dailyActionCount: 10 }] }).sort(), [
    'EXECUTOR_ALLOWANCE_UNSAFE', 'EXECUTOR_AMOUNT_EXCEEDED', 'EXECUTOR_ASSET_NOT_ALLOWED', 'EXECUTOR_DAILY_LIMIT_EXCEEDED',
    'EXECUTOR_GAS_LIMIT_EXCEEDED', 'EXECUTOR_QUOTE_INVALID',
  ]);
  const paper: ActionContext = {
    mode: 'paper', deploymentActive: true, connectorEnabled: true, assetsAllowed: true, requestedSlippageBps: 50, limits: [{ maxSlippageBps: 50, dailyActionCount: 10 }],
    resolvedInputAtomic: 1n, availableInputAtomic: 1n, actionsInWindow: 0, valuation: { observedAtMillis: NOW, maxAgeSeconds: 60 }, nowMillis: NOW,
  };
  assert.equal(evaluateAction(paper).allow, true);
  // Supplied paper context is still checked.
  assert.equal(evaluateAction({ ...paper, identity: { ...live.identity!, currentGeneration: '9' } }).allow, false);
});

test('limits combine by the most restrictive value: minima, the largest reserve, intersected allowlists', () => {
  const combined = combineLimits([
    { maxGasAtomic: 900n, minNativeReserveAtomic: 50n, allowedSpenders: [ROUTER, WALLET], allowedChainIds: [10143, 143], maxQuoteAgeSeconds: 30 },
    { maxGasAtomic: 500n, minNativeReserveAtomic: 100n, allowedSpenders: [ROUTER.toUpperCase().replace('0X', '0x')], allowedChainIds: [10143], maxReferenceDeviationBps: 100 },
    { maxQuoteAgeSeconds: 10 },
  ]);
  assert.deepEqual(combined, { maxGasAtomic: 500n, minNativeReserveAtomic: 100n, allowedSpenders: [ROUTER], allowedChainIds: [10143], maxQuoteAgeSeconds: 10, maxReferenceDeviationBps: 100 });
  // A source that lists no spender leaves none approved.
  assert.deepEqual(combineLimits([{ allowedSpenders: [ROUTER] }, { allowedSpenders: [] }]).allowedSpenders, []);
});

test('later phases add denials and never erase an earlier one', () => {
  const admission = evaluateAction({ ...live, actionsInWindow: 10 });
  const signing = evaluateAction(live);
  const merged = mergeVerdicts(admission, signing);
  assert.equal(merged.allow, false);
  assert.deepEqual(merged.allow ? [] : merged.denials.map((d) => d.code), ['EXECUTOR_DAILY_LIMIT_EXCEEDED']);
});
