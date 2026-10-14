import assert from 'node:assert/strict';
import test from 'node:test';
import { streamSimple as piMessagesStream } from '@earendil-works/pi-ai/api/pi-messages';
import { zstdDecompressSync } from 'node:zlib';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { sideCompletion } from '../extensions/side-completion.ts';
import type { SideCompletionRequest } from '../extensions/side-completion.ts';

function fixture(events: any[]) {
  const calls: any[] = [];
  const controller = new AbortController();
  const request: SideCompletionRequest = {
    model: {provider: 'fixture', id: 'fixture', maxTokens: 8192} as any,
    registry: {
      getApiKeyAndHeaders: async () => ({ok: true, apiKey: 'synthetic-key'}),
      getProvider: () => ({streamSimple: (...args: any[]) => {
        calls.push(args);
        return (async function* () { yield* events; })();
      }}) as any,
    },
    systemPrompt: 'System instructions', messages: [{role: 'user', content: 'Untrusted question', timestamp: 1}],
    limits: {characters: 10, tokens: 1024}, signal: controller.signal,
  };
  return {request, calls, controller};
}

test('returns complete final text and preserves inert user content with no tools', async () => {
  const f = fixture([
    {type: 'text_delta', delta: 'draft'},
    {type: 'done', reason: 'stop', message: {content: [{type: 'text', text: 'Final'}]}},
  ]);
  assert.deepEqual(await sideCompletion(f.request), {ok: true, text: 'Final'});
  const [, context, options] = f.calls[0];
  assert.equal(context.messages[0].role, 'system');
  assert.equal(context.messages[0].content, 'System instructions');
  assert.equal(context.messages[0].toolsAdded, undefined);
  assert.equal(context.messages[1].content, 'Untrusted question');
  assert.equal(options.maxTokens, 1024);
  assert.equal(options.cacheRetention, 'none');
});

test('caps deltas at the limit, aborts transport and returns bounded partial text', async () => {
  const f = fixture([{type: 'text_delta', delta: '123456789012345'}, {type: 'text_delta', delta: 'after cap'}]);
  const updates: string[] = [];
  f.request.onText = text => updates.push(text);
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'limit', text: '1234567890'});
  assert.deepEqual(updates, ['1234567890']);
  assert.equal(f.calls[0][2].signal.aborted, true);
  assert.equal(f.controller.signal.aborted, false);
});

test('bounds authoritative final text across blocks without aborting completed transport', async () => {
  const f = fixture([{type: 'done', reason: 'length', message: {content: [
    {type: 'text', text: '12345'}, {type: 'thinking', thinking: 'private'}, {type: 'text', text: '6789012345'},
  ]}}]);
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'limit', text: '1234567890'});
  assert.equal(f.calls[0][2].signal.aborted, false);
});

test('returns typed provider errors with the partial draft, never finalized failure text', async () => {
  const f = fixture([{type: 'text_delta', delta: 'draft'}, {type: 'error', error: {errorMessage: 'synthetic failure', content: [{type: 'text', text: 'invalid'}]}}]);
  const result = await sideCompletion(f.request);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, 'provider'); assert.equal(result.text, 'draft');
  assert.ok(result.error instanceof Error); assert.equal(result.error.message, 'synthetic failure');
});

test('refuses tool use before final-text cap and preserves bounded explanatory text', async () => {
  const f = fixture([{type: 'done', reason: 'toolUse', message: {content: [
    {type: 'text', text: '123456789012345'}, {type: 'toolCall', name: 'bash', arguments: {command: 'never run'}},
  ]}}]);
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'tool-use', text: '1234567890'});
});

test('abort settles a provider that ignores its signal and suppresses late text', {timeout: 1000}, async () => {
  const f = fixture([]);
  let release!: (value: any) => void;
  const updates: string[] = [];
  f.request.onText = text => updates.push(text);
  f.request.registry.getProvider = () => ({streamSimple: (_model: any, _context: any, options: any) => {
    f.calls.push(options);
    return {[Symbol.asyncIterator]: () => ({next: () => new Promise(resolve => {release = resolve;})})};
  }}) as any;
  const pending = sideCompletion(f.request);
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error('deadline exceeded');
  f.controller.abort(reason);
  const result = await pending;
  assert.deepEqual(result, {ok: false, kind: 'aborted', text: '', error: reason});
  assert.equal(f.calls[0].signal.aborted, true);
  release({done: false, value: {type: 'text_delta', delta: 'late'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates, []);
});

test('auth cancellation settles before credentials arrive and never opens a stream', async () => {
  const f = fixture([]);
  let release!: (value: any) => void;
  f.request.registry.getApiKeyAndHeaders = () => new Promise(resolve => {release = resolve;});
  const pending = sideCompletion(f.request);
  f.controller.abort(new Error('closed'));
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'aborted');
  release({ok: true, apiKey: 'late'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
});

test('refuses incomplete streams but carries bounded partial text for caller policy', async () => {
  const f = fixture([{type: 'text_delta', delta: 'partial'}]);
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'incomplete', text: 'partial'});
  assert.equal(f.calls[0][2].signal.aborted, false);
});

test('empty final text clears a draft and is a typed failure', async () => {
  const f = fixture([{type: 'text_delta', delta: 'draft'}, {type: 'done', reason: 'stop', message: {content: []}}]);
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'empty', text: ''});
});

test('delta consumers keep their report rather than replacing it from final blocks', async () => {
  const f = fixture([{type: 'text_delta', delta: 'Observed'}, {type: 'done', reason: 'stop', message: {content: [{type: 'text', text: 'different'}]}}]);
  f.request.textSource = 'deltas'; f.request.reasoning = 'medium';
  assert.deepEqual(await sideCompletion(f.request), {ok: true, text: 'Observed'});
  assert.equal(f.calls[0][2].reasoning, 'medium');
});

for (const provider of ['fixture', 'claude-bridge']) {
  test(`${provider} hides auth, endpoint and cache policy while preserving the supplied system prompt`, async () => {
    const f = fixture([{type: 'done', reason: 'stop', message: {content: [{type: 'text', text: 'answer'}]}}]);
    f.request.model = {...f.request.model, provider};
    f.request.systemPrompt = 'Full prompt\n' + 'x'.repeat(96000) + '\nCaptured tail';
    f.request.sessionId = 'side-session';
    f.request.registry.getApiKeyAndHeaders = async () => ({ok: true, apiKey: 'key', headers: {'x-test': 'yes'}, env: {FIXTURE: 'value'}, baseUrl: 'https://synthetic.invalid/v1'});
    assert.deepEqual(await sideCompletion(f.request), {ok: true, text: 'answer'});
    const [model, context, options] = f.calls[0];
    assert.equal(model.baseUrl, 'https://synthetic.invalid/v1');
    assert.equal(context.messages[0].content, f.request.systemPrompt);
    assert.equal(options.apiKey, 'key'); assert.deepEqual(options.headers, {'x-test': 'yes'});
    assert.deepEqual(options.env, {FIXTURE: 'value'}); assert.equal(options.sessionId, 'side-session');
    assert.equal(options.cacheRetention, provider === 'claude-bridge' ? 'short' : 'none');
  });
}

test('auth and missing provider failures are typed without fallback', async () => {
  const f = fixture([]);
  f.request.registry.getApiKeyAndHeaders = async () => ({ok: false, error: 'no credentials'});
  const result = await sideCompletion(f.request);
  assert.equal(result.ok, false);
  if (!result.ok) {assert.equal(result.kind, 'auth'); assert.ok(result.error instanceof Error); assert.equal(result.error.message, 'no credentials');}
  f.request.registry.getApiKeyAndHeaders = async () => ({ok: true});
  f.request.registry.getProvider = () => undefined;
  assert.deepEqual(await sideCompletion(f.request), {ok: false, kind: 'provider-unavailable', text: ''});
});

for (const maxTokens of [128, 0, NaN]) {
  test(`bounds requested tokens against usable model limit ${maxTokens}`, async () => {
    const f = fixture([{type: 'done', reason: 'stop', message: {content: [{type: 'text', text: 'answer'}]}}]);
    f.request.model = {...f.request.model, maxTokens};
    await sideCompletion(f.request);
    assert.equal(f.calls[0][2].maxTokens, maxTokens === 128 ? 128 : 1024);
  });
}

for (const provider of [openaiProvider(), openaiCodexProvider()]) {
  test(`native ${provider.id} wire preserves instructions, user messages, auth and endpoint override`, async () => {
    const f = fixture([]);
    const model = provider.getModels().find(model => model.id === (provider.id === 'openai' ? 'gpt-5.5' : 'gpt-6-luna'));
    assert.ok(model);
    f.request.model = model;
    f.request.reasoning = 'medium';
    const token = provider.id === 'openai' ? 'synthetic-key' : 'fixture.' + Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': {chatgpt_account_id: 'fixture-account'},
    })).toString('base64url') + '.fixture';
    f.request.registry.getApiKeyAndHeaders = async () => ({ok: true, apiKey: token, headers: {'x-fixture': 'side'}, baseUrl: 'https://synthetic.invalid/v1'});
    let payload: any;
    f.request.registry.getProvider = () => ({...provider, streamSimple: (model: any, context: any, options: any) =>
      provider.streamSimple(model, context, {...options, transport: 'sse', maxRetries: 0,
        fetch: async (url: any, init: any) => {
          assert.ok(String(url).startsWith('https://synthetic.invalid/v1/'));
          const headers = new Headers(init?.headers);
          assert.equal(headers.get('authorization'), `Bearer ${token}`);
          assert.equal(headers.get('x-fixture'), 'side');
          const body = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString() : String(init.body);
          payload = JSON.parse(body);
          const item = {type: 'message', id: 'fixture-answer', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'Answer', annotations: []}]};
          const events = [
            {type: 'response.output_item.added', output_index: 0, item: {...item, content: []}},
            {type: 'response.output_text.delta', output_index: 0, delta: 'Answer'},
            {type: 'response.output_item.done', output_index: 0, item},
            {type: 'response.completed', response: {status: 'completed', output: [item], usage: {input_tokens: 0, output_tokens: 0}}},
          ];
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
        },
      }),
    });
    assert.deepEqual(await sideCompletion(f.request), {ok: true, text: 'Answer'});
    assert.ok(payload, 'the native provider serialized the request');
    assert.equal(payload.model, model.id);
    const question = {role: 'user', content: [{type: 'input_text', text: 'Untrusted question'}]};
    if (provider.id === 'openai') {
      assert.deepEqual(payload.input, [{role: 'developer', content: 'System instructions'}, question]);
    } else {
      assert.equal(payload.instructions, 'System instructions'); assert.deepEqual(payload.input, [question]);
    }
    assert.equal(payload.tools, undefined);
    assert.equal(payload.reasoning.effort, 'medium');
  });
}

const usage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}};
for (const scenario of [
  {name: 'final text', events: [
    {type: 'text_start', contentIndex: 0}, {type: 'text_delta', contentIndex: 0, delta: 'draft'},
    {type: 'text_end', contentIndex: 0, content: 'Final'}, {type: 'done', reason: 'stop', usage},
  ], expected: {ok: true, text: 'Final'}},
  {name: 'cap', events: [
    {type: 'text_start', contentIndex: 0}, {type: 'text_delta', contentIndex: 0, delta: '123456789012345'},
    {type: 'done', reason: 'stop', usage},
  ], expected: {ok: false, kind: 'limit', text: '1234567890'}},
  {name: 'error', events: [
    {type: 'text_start', contentIndex: 0}, {type: 'text_delta', contentIndex: 0, delta: 'draft'},
    {type: 'error', reason: 'error', usage, errorMessage: 'wire failure'},
  ], expected: {ok: false, kind: 'provider', text: 'draft'}},
  {name: 'tool use', events: [
    {type: 'text_start', contentIndex: 0}, {type: 'text_end', contentIndex: 0, content: 'Refused'},
    {type: 'toolcall_start', contentIndex: 1, id: 'fixture', toolName: 'bash'},
    {type: 'toolcall_end', contentIndex: 1, toolCall: {type: 'toolCall', id: 'fixture', name: 'bash', arguments: {command: 'never run'}}},
    {type: 'done', reason: 'toolUse', usage},
  ], expected: {ok: false, kind: 'tool-use', text: 'Refused'}},
]) {
  test(`pi-messages wire ${scenario.name} through the module interface`, async () => {
    const f = fixture([]);
    f.request.model = {...f.request.model, name: 'Fixture', api: 'pi-messages', baseUrl: 'https://synthetic.invalid',
      reasoning: false, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 64000};
    f.request.registry.getProvider = () => ({streamSimple: (model: any, context: any, options: any) =>
      piMessagesStream(model, context, {...options, fetch: async () => new Response(
        [{type: 'start'}, ...scenario.events].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        {headers: {'content-type': 'text/event-stream'}},
      )}),
    }) as any;
    const result = await sideCompletion(f.request);
    assert.deepEqual(result.ok ? result : {ok: result.ok, kind: result.kind, text: result.text}, scenario.expected);
    if (!result.ok && result.kind === 'provider') {assert.ok(result.error instanceof Error); assert.equal(result.error.message, 'wire failure');}
  });
}
