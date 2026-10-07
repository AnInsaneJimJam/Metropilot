// Generated types are build artifacts. The JSON Schemas are the only wire-shape source.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(await readFile(new URL('./strategy.schema.json', import.meta.url), 'utf8'));
await writeFile(new URL('./generated.ts', import.meta.url), await compile(schema, 'Strategy', { additionalProperties: false, unreachableDefinitions: true, ignoreMinAndMaxItems: true }));

// Non-strategy contracts in ../schemas. One root keyed by kind gives every named definition one declaration.
// Keep these refs in step with contractRefs in index.ts; strategy is typed from generated.ts above.
const refs = {
  controlSave: 'control-workspace-1.schema.json#/$defs/SaveStrategy',
  controlAgent: 'control-workspace-1.schema.json#/$defs/SavedAgent',
  deploymentRequest: 'deployment-request-1.schema.json',
  error: 'error-1.schema.json',
  event: 'event-1.schema.json',
  auditEvent: 'audit-event-1.schema.json',
  assetIdentity: 'common.schema.json#/$defs/assetIdentity',
};
const root = {
  title: 'GeneratedContractMap',
  type: 'object',
  additionalProperties: false,
  required: Object.keys(refs),
  properties: Object.fromEntries(Object.entries(refs).map(([kind, ref]) => [kind, { $ref: ref }])),
};
await writeFile(new URL('./generated-contracts.ts', import.meta.url), await compile(root, 'GeneratedContractMap', {
  cwd: fileURLToPath(new URL('../schemas/', import.meta.url)),
  strictIndexSignatures: true,
  maxItems: -1,
  $refOptions: { resolve: { http: false } },
}));
