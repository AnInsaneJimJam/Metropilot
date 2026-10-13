// Failure-reason vocabulary (issue #19): exactly the schema codes plus the control-plane reasons, each with
// complete readable text; unknown codes still render.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import errorSchema from '../schemas/error-1.schema.json' with { type: 'json' };
import intentResultSchema from '../schemas/intent-result-1.schema.json' with { type: 'json' };
import { describeReason, reasons } from './index.ts';

const errorCodes: string[] = errorSchema.$defs.errorCode.enum;
const intentReasonCodes: string[] = intentResultSchema.properties.reason.properties.code.enum;
const controlReasonCodes = ['TRIGGER_COOLDOWN', 'STOP_DRAINING', 'QUOTA_CONCURRENCY', 'QUOTA_SESSION', 'QUOTA_DAILY', 'ADMISSION_FULL', 'HOSTING_BUDGET_EXHAUSTED', 'UNEXPECTED_TRADE_EFFECTS'];

test('the vocabulary covers every error-1 and intent-result-1 reason code and nothing else', () => {
  assert.deepEqual(Object.keys(reasons).sort(), [...errorCodes, ...intentReasonCodes, ...controlReasonCodes].sort());
});

test('every reason has a short title and full sentences without the raw code', () => {
  for (const [code, text] of Object.entries(reasons)) {
    assert.ok(text.title.length > 0 && text.title.length <= 32, `${code} title`);
    for (const sentence of [text.explanation, text.userAction]) {
      assert.match(sentence, /^[A-Z].{9,159}\.$/, `${code}: ${sentence}`);
      assert.ok(!sentence.includes(code) && !/[A-Z]{2,}_[A-Z]/.test(sentence), `${code} leaks a code: ${sentence}`);
    }
  }
});

test('describeReason marks known codes and gives unknown ones generic text with the code kept', () => {
  assert.deepEqual(describeReason('STALE_DATA'), { code: 'STALE_DATA', known: true, ...reasons.STALE_DATA });
  const unknown = describeReason('SOMETHING_NEW');
  assert.equal(unknown.known, false);
  assert.equal(unknown.code, 'SOMETHING_NEW');
  assert.ok(unknown.title && unknown.explanation && unknown.userAction);
  // Inherited object keys are not reasons.
  assert.equal(describeReason('toString').known, false);
});
