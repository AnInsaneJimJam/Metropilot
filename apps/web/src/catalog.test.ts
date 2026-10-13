import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorCatalog, modelOptions, setEditorModels } from './catalog.ts';

test('editor accepts approved Kimi metadata, rejects executable or live extensions and can clear it', () => {
  const profile = { mode: 'paper', provider: 'kimi', modelId: 'moonshotai/kimi-k2.7-code', maxTimeoutSeconds: 30, maxOutputTokens: 1024 };
  setEditorModels({ 'paper.kimi-vercel': profile });
  assert.deepEqual(modelOptions(), [['moonshotai/kimi-k2.7-code', 'paper.kimi-vercel']]);
  const accepted = editorCatalog;
  for (const raw of [null, [], { arbitrary: profile },
    { 'paper.kimi-vercel': { ...profile, mode: 'live' } },
    { 'paper.kimi-vercel': { ...profile, endpoint: 'https://untrusted.invalid' } },
    { 'paper.kimi-vercel': { ...profile, maxOutputTokens: 999999 } },
  ]) {
    assert.throws(() => setEditorModels(raw));
    assert.equal(editorCatalog, accepted);
  }
  setEditorModels({});
  assert.deepEqual(modelOptions(), [['(none in catalog)', '']]);
});
