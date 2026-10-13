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

test('the API mixed synthetic and Gateway catalog keeps both clearly labelled model choices', () => {
  const models = {
    'paper.kimi': { mode: 'paper', provider: 'synthetic', modelId: 'kimi-synthetic', maxTimeoutSeconds: 30, maxOutputTokens: 1024 },
    'paper.kimi-vercel': { mode: 'paper', provider: 'kimi', modelId: 'moonshotai/kimi-k2.7-code', maxTimeoutSeconds: 30, maxOutputTokens: 1024 },
  };
  try {
    setEditorModels(models);
    assert.deepEqual(modelOptions(), [
      ['kimi-synthetic (synthetic)', 'paper.kimi'],
      ['moonshotai/kimi-k2.7-code', 'paper.kimi-vercel'],
    ]);
    assert.equal(editorCatalog.modelProfiles['paper.kimi']?.provider, 'synthetic');
    assert.equal(editorCatalog.modelProfiles['paper.kimi-vercel']?.provider, 'kimi');
    const accepted = editorCatalog;
    for (const patch of [
      { provider: 'kimi' }, { modelId: 'moonshotai/kimi-k2.7-code' },
      { mode: 'live' }, { maxOutputTokens: 999999 }, { endpoint: 'https://untrusted.invalid' },
    ]) {
      assert.throws(() => setEditorModels({ 'paper.kimi-vercel': models['paper.kimi-vercel'], 'paper.kimi': { ...models['paper.kimi'], ...patch } }));
      assert.equal(editorCatalog, accepted, 'a rejected catalog cannot partially replace the active one');
    }
  } finally { setEditorModels({}); }
});
