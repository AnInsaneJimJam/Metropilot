// Generated types are build artifacts. The JSON Schema is the only wire-shape source.
import { readFile, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(await readFile(new URL('./strategy.schema.json', import.meta.url), 'utf8'));
await writeFile(new URL('./generated.ts', import.meta.url), await compile(schema, 'Strategy', { additionalProperties: false, unreachableDefinitions: true, ignoreMinAndMaxItems: true }));
