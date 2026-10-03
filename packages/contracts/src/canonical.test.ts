// RFC 8785 canonicalization: key order, number form, rejection of non-JSON values, stable hashes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalize, contentHash } from './index.ts';

test('sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 example)', () => {
  const keys = ['\u20ac', '\r', '\ufb33', '1', '\ud83d\ude00', '\u0080', '\u00f6'];
  const object = Object.fromEntries(keys.map((key, index) => [key, index]));
  assert.equal(canonicalize(object), '{"\\r":1,"1":3,"\u0080":5,"\u00f6":6,"\u20ac":0,"\ud83d\ude00":4,"\ufb33":2}');
});

test('nested objects, arrays and whitespace-free output', () => {
  assert.equal(canonicalize({ b: [3, { y: true, x: null }], a: 'é' }), '{"a":"é","b":[3,{"x":null,"y":true}]}');
});

test('numbers use ECMAScript serialization', () => {
  assert.equal(canonicalize([1e21, 0.1, -0, 1e-7, 100]), '[1e+21,0.1,0,1e-7,100]');
});

test('reordered keys hash identically; a changed value does not', async () => {
  const a = await contentHash({ schemaVersion: 'strategy/1', id: 'x' });
  assert.equal(a, await contentHash({ id: 'x', schemaVersion: 'strategy/1' }));
  assert.notEqual(a, await contentHash({ id: 'y', schemaVersion: 'strategy/1' }));
  assert.equal(a, `0x${createHash('sha256').update('{"id":"x","schemaVersion":"strategy/1"}').digest('hex')}`);
});

test('rejects values JSON cannot represent', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '\ud800', undefined, 1n, new Date(0), { nested: () => 1 }]) {
    assert.throws(() => canonicalize(bad), TypeError);
  }
});
