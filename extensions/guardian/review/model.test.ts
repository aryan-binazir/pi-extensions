import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { resolveReviewer } from './model.ts';

function registry(available: string[]) {
  const asked: string[] = [];
  return {
    asked,
    find: (provider: string, model: string) => {
      asked.push(`${provider}/${model}`);
      return available.includes(`${provider}/${model}`) ? ({ provider, id: model } as unknown as Model<never>) : undefined;
    },
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'k' }),
    getProvider: () => ({ streamSimple: () => ({ result: async () => ({}) }) }),
  } as never;
}

test('a fast alias falls back to the plain model, so children without Fast mode still review', () => {
  const withoutFastMode = registry(['openai-codex/gpt-6-luna']);
  const resolved = resolveReviewer(withoutFastMode, { provider: 'openai-codex', model: 'gpt-6-luna~fast', reasoning: 'low' }, 's');
  assert.equal(resolved.ok, true);
  assert.deepEqual((withoutFastMode as unknown as { asked: string[] }).asked, ['openai-codex/gpt-6-luna~fast', 'openai-codex/gpt-6-luna']);
});

test('the fast alias is preferred when it does resolve', () => {
  const withFastMode = registry(['openai-codex/gpt-6-luna~fast', 'openai-codex/gpt-6-luna']);
  assert.equal(resolveReviewer(withFastMode, { provider: 'openai-codex', model: 'gpt-6-luna~fast', reasoning: 'low' }, 's').ok, true);
  assert.deepEqual((withFastMode as unknown as { asked: string[] }).asked, ['openai-codex/gpt-6-luna~fast']);
});

test('an unavailable model names the setting to change', () => {
  const resolved = resolveReviewer(registry([]), { provider: 'nowhere', model: 'missing', reasoning: 'low' }, 's');
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? '' : resolved.message, /nowhere\/missing is not available; set reviewer in Guardian's config\.json/);
});
