import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sample, classify, review } from './transport.ts';

const input = { identity: 'fixture', action: { tool: 'write', path: 'target.txt' }, evidence: '{}', systemPrompt: 'Preserve existing file contents.', complete: true };
function context(responses: any[], captures: any[] = []): any {
  return { cwd: '/tmp', sessionManager: { getSessionId: () => 'fixture' }, modelRegistry: {
    find: (_p: string, id: string) => ({ id, provider: 'synthetic', api: 'openai-completions' }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic' }),
    getProvider: () => ({ streamSimple: (_model: any, request: any) => {
      captures.push({ ...request, messages: structuredClone(request.messages), tools: request.tools.map((tool: any) => ({ name: tool.name })) });
      const response = responses.shift();
      if (!response) throw new Error('unexpected model request');
      return { async *[Symbol.asyncIterator]() { for (const delta of response.deltas ?? []) yield { type: 'text_delta', delta }; }, result: async () => response };
    } }),
  } };
}

test('classifier returns first delta and never interprets followup output as revised approval', async () => {
  assert.equal(await classify(context([{ deltas: ['high', 'low'] }]), 'test/luna', input, new AbortController().signal), 'high');
  await assert.rejects(classify(context([{ deltas: ['l', 'ow'] }]), 'test/luna', input, new AbortController().signal));
});

test('synchronous reviewer can inspect a real local file but cannot run shell or extension tools', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sentinel-inspection-'));
  const captures: any[] = [];
  try {
    await writeFile(join(home, 'target.txt'), 'SYNTHETIC important data');
    const responses = [
      { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'target.txt' } }] },
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"outcome":"deny","rationale":"Existing file."}' }] },
    ];
    const output = await sample(context(responses, captures), 'test/reviewer', 'reviewer', { ...input, cwd: home }, new AbortController().signal);
    assert.equal(JSON.parse(output).outcome, 'deny');
    assert.match(captures[1].messages.at(-1).content[0].text, /SYNTHETIC important data/);
    assert.deepEqual(captures[0].tools.map((t: any) => t.name), ['read', 'grep', 'find', 'ls']);
    for (const name of ['bash', 'mcp', 'write']) {
      await assert.rejects(sample(context([{ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'bad', name, arguments: {} }] }]), 'test/reviewer', 'reviewer', input, new AbortController().signal), /forbidden/);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('malformed inspection arguments produce an error result rather than executing', async () => {
  const captures: any[] = [];
  await sample(context([
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'bad', name: 'read', arguments: { path: 42 } }] },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"outcome":"deny"}' }] },
  ], captures), 'test/reviewer', 'reviewer', input, new AbortController().signal);
  assert.equal(captures[1].messages.at(-1).isError, true);
});

test('reviewer accepts fenced JSON but rejects malformed objects; truncated and aborted responses never approve', async () => {
  const response = (text: string, stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] });
  assert.deepEqual(await review(context([response('```json\n{"outcome":"allow"}\n```')]), 'test/reviewer', input, new AbortController().signal), { outcome: 'allow' });
  await assert.rejects(review(context([response('not json')]), 'test/reviewer', input, new AbortController().signal));
  for (const stop of ['length', 'aborted']) await assert.rejects(sample(context([response('{"outcome":"allow"}', stop)]), 'test/reviewer', 'reviewer', input, new AbortController().signal));
});

test('transport failure gets one bounded retry, invalid classifications are not retried', async () => {
  const captures: any[] = [];
  const label = await classify(context([
    { stopReason: 'error', content: [] }, { deltas: ['low'] },
  ], captures), 'test/luna', input, new AbortController().signal);
  assert.equal(label, 'low'); assert.equal(captures.length, 2);
  const invalid: any[] = [];
  await assert.rejects(classify(context([{ deltas: ['bad'] }], invalid), 'test/luna', input, new AbortController().signal));
  assert.equal(invalid.length, 1);
});
