// G1 exit: strategy rules the schema leaves to the language core (strategy-language.md section 9) still fail.
// Each case passes schema validation, then is rejected through the strategy package's public exports.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { validate, type Expression } from '../packages/contracts/src/index.ts';
import { compileStrategy, evaluateExpression, syntheticCatalog } from '../packages/strategy/src/index.ts';

const bool = (value: boolean): Expression => ({ kind: 'literal', valueType: 'Boolean', value });
const decimal = (value: string): Expression => ({ kind: 'literal', valueType: 'Decimal', value });

const expressionCases: [string, Expression][] = [
  ['and needs at least two operands', { kind: 'logical', operator: 'and', operands: [bool(true)] }],
  ['not takes exactly one operand', { kind: 'logical', operator: 'not', operands: [bool(true), bool(false)] }],
  ['-0 is not a canonical decimal', { kind: 'arithmetic', operator: 'add', left: decimal('-0'), right: decimal('1') }],
];

for (const [name, expression] of expressionCases) {
  test(`semantic: ${name}`, () => {
    assert.throws(() => evaluateExpression(expression), { code: 'TYPE_MISMATCH' });
  });
}

test('semantic: calendar-invalid schedule anchor passes the schema and fails compilation', async () => {
  const path = join(import.meta.dirname, '..', 'packages', 'contracts', 'fixtures', 'strategy', 'semantic', 'schedule-anchor-feb-30.json');
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as { document: unknown };
  assert.ok(validate('strategy', fixture.document).ok);
  await assert.rejects(compileStrategy(JSON.stringify(fixture.document), syntheticCatalog), { code: 'TYPE_MISMATCH' });
});
