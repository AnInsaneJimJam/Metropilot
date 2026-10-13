// Pure rate-card and runway arithmetic (ACC-4). The oracle is the worked example in funds-and-budgets.md section 6.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountingError } from './errors.ts';
import { balancedSplit, ceilDiv, hostingPerDay, modelCallCeiling, modelCallCharge, recommendForDays, usdMicrosToAtomic } from './rates.ts';
import type { RateCard } from './rates.ts';

const U = 1_000_000n; // one display unit of a six-decimal token
const at = new Date('2026-10-12T00:00:00Z');

test('balanced split reproduces the spec example: O=29 → hosting 19.33, API 9.67, about 19.3 days; 20% margin about 16.1 days', () => {
  const base = { depositAtomic: 100n * U, minTradingAtomic: 70n * U, gasAtomic: 1n * U, hostingPerDayAtomic: 1n * U, apiPerDayAtomic: U / 2n };
  const plain = balancedSplit({ ...base, marginBps: 0 });
  assert.equal(plain.operatingAtomic, 29n * U);
  assert.equal(plain.hostingAtomic, 19_333_333n);
  assert.equal(plain.apiAtomic, 9_666_667n);
  assert.equal(plain.hostingAtomic + plain.apiAtomic, 29n * U, 'rounding reconciled to exactly O');
  assert.equal(Number(plain.runwaySeconds!) / 86_400 > 19.3 && Number(plain.runwaySeconds!) / 86_400 < 19.34, true);
  const margin = balancedSplit({ ...base, marginBps: 2000 });
  const days = Number(margin.runwaySeconds!) / 86_400;
  assert.ok(days > 16.1 && days < 16.12, String(days));
  // a = 0: all operating funds to hosting; API does not constrain runway.
  const noAi = balancedSplit({ ...base, apiPerDayAtomic: 0n, marginBps: 0 });
  assert.deepEqual([noAi.hostingAtomic, noAi.apiAtomic, noAi.runwaySeconds], [29n * U, 0n, 29n * 86_400n]);
  assert.equal(balancedSplit({ ...base, minTradingAtomic: 100n * U, marginBps: 0 }).feasible, false);
});

test('days-first recommendation: H = ceil(T·h·(1+m)), A likewise, trading = D − H − A; infeasible below K + G is reported, not cut', () => {
  const plan = recommendForDays({ depositAtomic: 100n * U, operatingDaysMilli: 10_000n, minTradingAtomic: 70n * U, gasAtomic: U, hostingPerDayAtomic: U, apiPerDayAtomic: U / 2n, marginBps: 2000 });
  assert.deepEqual([plan.hostingAtomic, plan.apiAtomic, plan.tradingAtomic, plan.feasible], [12n * U, 6n * U, 82n * U, true]);
  const tight = recommendForDays({ depositAtomic: 100n * U, operatingDaysMilli: 30_000n, minTradingAtomic: 70n * U, gasAtomic: U, hostingPerDayAtomic: U, apiPerDayAtomic: U / 2n, marginBps: 2000 });
  assert.equal(tight.feasible, false);
  assert.equal(tight.shortfallAtomic, 71n * U - tight.tradingAtomic);
});

test('model ceilings round up, refuse unknown prices, and cap actual usage at the hold', () => {
  const card: RateCard = { version: 'model.test/1', kind: 'model', profileRef: 'paper.kimi', assetRef: 'test.USD', inputAtomicPerMillion: 600_000n, outputAtomicPerMillion: 2_500_000n, atomicPerRequest: 1n, marginBps: 1500, effectiveFrom: at };
  const ceiling = modelCallCeiling(card, { maxInputTokens: 3001, maxOutputTokens: 1000, requests: 1 });
  assert.equal(ceiling, ceilDiv(3001n * 600_000n + 1000n * 2_500_000n, 1_000_000n) + 1n);
  assert.deepEqual(modelCallCharge(card, { inputTokens: 100, outputTokens: 10, requests: 1 }, ceiling), { charge: 86n, excess: 0n });
  assert.deepEqual(modelCallCharge(card, { inputTokens: 9000, outputTokens: 9000, requests: 1 }, ceiling).charge, ceiling);
  assert.throws(() => modelCallCeiling({ ...card, outputAtomicPerMillion: undefined } as unknown as RateCard, { maxInputTokens: 1, maxOutputTokens: 1, requests: 1 }), AccountingError);
});

test('hosting per day and explicit USD conversion round up so holds cover charges', () => {
  const card: RateCard = { version: 'hosting.small/1', kind: 'hosting', profileRef: 'runtime.small', assetRef: 'test.USD', sliceSeconds: 60, atomicPerSlice: 7n, marginBps: 2000, effectiveFrom: at };
  assert.equal(hostingPerDay(card), 7n * 1440n);
  assert.equal(usdMicrosToAtomic(1n, { assetRef: 'test.USD', atomicPerUsd: 999_000n, quotedAt: at, source: 'test' }), 1n);
});
