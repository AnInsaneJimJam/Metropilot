// CON-1..3: schemas accept every valid fixture (including the normative spec examples verbatim)
// and reject every invalid fixture with its declared field path and keyword.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contractRefs, maxDocumentBytes, parse, schemaDocuments, validate, type ContractKind } from './index.ts';

const packageDir = join(import.meta.dirname, '..');
const repoRoot = join(packageDir, '..', '..');
const kinds = Object.keys(contractRefs) as ContractKind[];

type InvalidFixture = {
  description: string;
  expect: { fieldPath: string; keyword: string };
  document: unknown;
};

const fixtureFiles = (kind: ContractKind, validity: 'valid' | 'invalid'): string[] => {
  const dir = join(packageDir, 'fixtures', kind, validity);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => join(dir, file));
};
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

for (const kind of kinds) {
  describe(`${kind} fixtures`, () => {
    test('has valid and invalid fixtures', () => {
      assert.ok(fixtureFiles(kind, 'valid').length > 0);
      assert.ok(fixtureFiles(kind, 'invalid').length > 0);
    });

    for (const path of fixtureFiles(kind, 'valid')) {
      test(`accepts valid/${name(path)}`, () => {
        const result = validate(kind, readJson(path));
        assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
      });
    }

    for (const path of fixtureFiles(kind, 'invalid')) {
      const fixture = readJson(path) as InvalidFixture;
      test(`rejects invalid/${name(path)}: ${fixture.description}`, () => {
        const result = validate(kind, fixture.document);
        assert.equal(result.ok, false, 'fixture unexpectedly validated');
        assert.ok(!result.ok);
        const issues = result.issues.map(({ code, fieldPath, keyword }) => ({ code, fieldPath, keyword }));
        if (kind === 'strategy') {
          // The language schema uses undiscriminated oneOf, so Ajv also reports failed branches at parent
          // paths with branch keywords. Require only an issue at or below the expected field.
          assert.ok(issues.some((issue) => issue.fieldPath.startsWith(fixture.expect.fieldPath)), JSON.stringify(issues));
          return;
        }
        // anyOf also reports each failed branch; all issues must still point at the expected field.
        assert.ok(
          issues.some((issue) => issue.fieldPath === fixture.expect.fieldPath && issue.keyword === fixture.expect.keyword),
          JSON.stringify(issues),
        );
        for (const issue of issues) {
          assert.equal(issue.code, 'SCHEMA_INVALID');
          assert.ok(issue.fieldPath.startsWith(fixture.expect.fieldPath), JSON.stringify(issue));
        }
      });
    }
  });
}

describe('normative spec examples', () => {
  const examples: [string, ContractKind, string][] = [
    ['docs/specs/strategy-language.md', 'strategy', 'spec-threshold-sale.json'],
    ['docs/specs/api-and-data.md', 'deploymentRequest', 'spec-paper-request.json'],
  ];
  for (const [doc, kind, fixture] of examples) {
    test(`${doc} example is the ${kind} fixture and parses`, () => {
      const blocks = [...readFileSync(join(repoRoot, doc), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)];
      assert.equal(blocks.length, 1, `${doc} should contain exactly one JSON example`);
      const text = blocks[0]![1]!;
      assert.deepEqual(JSON.parse(text), readJson(join(packageDir, 'fixtures', kind, 'valid', fixture)));
      const result = parse(kind, text);
      assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    });
  }
});

describe('normative examples in multi-example specs', () => {
  // These specs hold several JSON blocks; the example is the block that declares the given schemaVersion.
  const examples: [string, ContractKind, string, string][] = [
    ['docs/specs/executor.md', 'actionIntent', 'action-intent/1', 'spec-swap-fixed.json'],
    ['docs/specs/agent-runtime.md', 'runtimeAssignment', 'runtime-assignment/1', 'paper-price-crossing.json'],
  ];
  for (const [doc, kind, version, fixture] of examples) {
    test(`${doc} ${version} example is the ${kind} fixture and parses`, () => {
      const blocks = [...readFileSync(join(repoRoot, doc), 'utf8').matchAll(/```json\n([\s\S]*?)```/g)]
        .map((match) => match[1]!)
        .filter((text) => text.includes(`"schemaVersion": "${version}"`));
      assert.equal(blocks.length, 1, `${doc} should contain exactly one ${version} example`);
      assert.deepEqual(JSON.parse(blocks[0]!), readJson(join(packageDir, 'fixtures', kind, 'valid', fixture)));
      const result = parse(kind, blocks[0]!);
      assert.ok(result.ok, JSON.stringify(!result.ok && result.issues));
    });
  }
});

describe('parse', () => {
  const example = readFileSync(join(packageDir, 'fixtures', 'strategy', 'valid', 'spec-threshold-sale.json'), 'utf8');

  test('rejects a strategy over 256 KiB before parsing', () => {
    const padded = example.replace('{', '{' + ' '.repeat(maxDocumentBytes.strategy));
    assert.deepEqual(parse('strategy', padded), {
      ok: false,
      issues: [
        {
          code: 'LIMIT_EXCEEDED',
          fieldPath: '',
          keyword: 'maxBytes',
          message: `document is ${padded.length} bytes; limit is 262144`,
        },
      ],
    });
  });

  test('counts UTF-8 bytes, not UTF-16 code units', () => {
    const name = 'é'.repeat(100); // 100 characters, 200 bytes; within the 120-character name limit
    const filler = ' '.repeat(maxDocumentBytes.strategy - example.length - 150);
    const text = example.replace('"Paper threshold partial sale"', `"${name}"${filler}`);
    assert.ok(text.length <= maxDocumentBytes.strategy);
    assert.equal(parse('strategy', text).ok, false);
  });

  test('rejects an oversized event payload', () => {
    const event = readJson(join(packageDir, 'fixtures', 'event', 'valid', 'chain-log-finalized.json')) as Record<string, unknown>;
    event['payload'] = { blob: 'x'.repeat(maxDocumentBytes.event) };
    const result = parse('event', JSON.stringify(event));
    assert.ok(!result.ok && result.issues[0]?.code === 'LIMIT_EXCEEDED');
  });

  test('reports malformed JSON without echoing input', () => {
    assert.deepEqual(parse('deploymentRequest', '{"schemaVersion": "deployment/1",'), {
      ok: false,
      issues: [{ code: 'MALFORMED_REQUEST', fieldPath: '', keyword: 'json', message: 'not valid JSON' }],
    });
  });
});

describe('schema hygiene', () => {
  type Node = Record<string, unknown>;
  const walk = (node: unknown, path: string, visit: (node: Node, path: string) => void): void => {
    if (Array.isArray(node)) node.forEach((child, i) => walk(child, `${path}/${i}`, visit));
    else if (node !== null && typeof node === 'object') {
      visit(node as Node, path);
      for (const [key, child] of Object.entries(node)) walk(child, `${path}/${key}`, visit);
    }
  };
  const all = schemaDocuments as Node[];

  test('every object schema is closed, a bounded map, or a discriminated union', () => {
    // Untrusted data payloads, typed by connector schemas (CON-4) and bounded by byte ceilings.
    const openPayloads = new Set([
      'https://monad-hack.example/schemas/event-1.schema.json#/properties/payload',
      'https://monad-hack.example/schemas/audit-event-1.schema.json#/properties/payload',
      'https://monad-hack.example/schemas/audit-event-2.schema.json#/properties/payload',
      // Recorded read/AI records: typed by the interpreter against the node's declared result (recordOf).
      'https://monad-hack.example/schemas/run-result-1.schema.json#/properties/result',
      'https://monad-hack.example/schemas/run-state-1.schema.json#/properties/recorded/properties/result',
      'https://monad-hack.example/schemas/broker-result-1.schema.json#/properties/value',
    ]);
    const open: string[] = [];
    for (const schema of all) {
      walk(schema, `${String(schema['$id'])}#`, (node, path) => {
        if (node['type'] !== 'object' || 'additionalProperties' in node || 'oneOf' in node) return;
        if (path.endsWith('/if')) return; // a condition, not an instance shape
        if (!openPayloads.has(path)) open.push(path);
      });
    }
    assert.deepEqual(open, []);
  });

  test('maps declare a key pattern and a size bound', () => {
    for (const schema of all) {
      walk(schema, `${String(schema['$id'])}#`, (node, path) => {
        if (typeof node['additionalProperties'] !== 'object') return;
        assert.ok('propertyNames' in node, `${path} lacks propertyNames`);
        assert.ok('maxProperties' in node, `${path} lacks maxProperties`);
      });
    }
  });

  test('strings and arrays are bounded', () => {
    for (const schema of all) {
      walk(schema, `${String(schema['$id'])}#`, (node, path) => {
        if (node['type'] === 'string' && !['maxLength', 'pattern', 'enum', 'const'].some((k) => k in node))
          assert.fail(`${path} is an unbounded string`);
        if (node['type'] === 'string' && 'pattern' in node && !('maxLength' in node)) {
          // A pattern bounds length only when every repetition is bounded.
          assert.doesNotMatch(String(node['pattern']), /[*+](?![^[]*\])/, `${path} pattern is unbounded`);
        }
        // then/else refine an array already bounded by the enclosing properties.
        if (node['type'] === 'array' && !/\/(then|else)\//.test(path))
          assert.ok('maxItems' in node, `${path} is an unbounded array`);
      });
    }
  });

  test('no field names for secrets, raw signing data or executable content', () => {
    const forbidden = new Set(
      'private secret mnemonic seed password api credential credentials calldata signature signed script eval command url uri endpoint'.split(' '),
    );
    for (const schema of all) {
      walk(schema, `${String(schema['$id'])}#`, (node, path) => {
        for (const key of Object.keys((node['properties'] as Node | undefined) ?? {})) {
          const words = key.split(/(?=[A-Z])/).map((word) => word.toLowerCase());
          assert.ok(!words.some((word) => forbidden.has(word)), `${path}/properties/${key}`);
        }
      });
    }
  });

  test('every document schema pins its schemaVersion with const', () => {
    const versioned: Node[] = [];
    for (const schema of all) {
      walk(schema, `${String(schema['$id'])}#`, (node) => {
        if ((node['properties'] as Node | undefined)?.['schemaVersion']) versioned.push(node);
      });
    }
    assert.deepEqual(
      versioned.map((schema) => ((schema['properties'] as Node)['schemaVersion'] as Node)['const']).sort(),
      [
        'action-intent/1',
        'agent-deployment/1',
        'agent-funds/1',
        'artifact/1',
        'assignment-offer/1',
        'assignment-offer/2',
        'assignment-poll/1',
        'audience-capability/1',
        'audit-event/1',
        'audit-event/2',
        'broker-request/1',
        'broker-result/1',
        'connector-manifest/1',
        'control-agent/1',
        'control-workspace/1',
        'deployment-manifest/1',
        'deployment-manifest/2',
        'deployment-operation/1',
        'deployment/1',
        'event/1',
        'funding-quote/1',
        'intent-result/1',
        'live-estimate/1',
        'paper-estimate/1',
        'paper-quota/1',
        'persisted-broker-result/1',
        'price-observation/1',
        'run-complete/1',
        'run-detail/1',
        'run-result/1',
        'run-state/1',
        'run-summary/1',
        'run-wait/1',
        'runtime-assignment/1',
        'runtime-heartbeat/1',
        'runtime-lease/1',
        'strategy-run/2',
        'strategy/1',
        'timeline-entry/1',
        'withdrawal/1',
      ],
    );
    for (const schema of versioned) assert.ok((schema['required'] as string[]).includes('schemaVersion'));
  });
});
