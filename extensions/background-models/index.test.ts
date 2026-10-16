import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import backgroundModels from './index.ts';
import { withPi } from '../../tests/pi-session.ts';

test('background Codex calls omit temperature, default Luna low, and preserve explicit effort and request options', async () => {
  const requests: any[] = [];
  const provider = fauxProvider({ provider: 'background-test', api: 'openai-codex-responses', tokensPerSecond: Infinity,
    models: [{ id: 'gpt-6-luna', reasoning: true }, { id: 'gpt-6.1-sol', reasoning: true }] });
  provider.setResponses(Array.from({ length: 6 }, () => (_context: unknown, options: unknown) => {
    requests.push(options); return fauxAssistantMessage('synthetic reply');
  }));
  await withPi({ extensions: [backgroundModels], configure({ modelRuntime }) {
    modelRuntime.registerNativeProvider(provider.provider);
    return {};
  } }, async ({ runner, runtime }) => {
    const registry = runner!.createContext().modelRegistry;
    const luna = registry.find('background-test', 'gpt-6-luna')!;
    const sol = registry.find('background-test', 'gpt-6.1-sol')!;
    const context = { messages: [{ role: 'user' as const, content: 'synthetic request', timestamp: Date.now() }] };
    const controller = new AbortController();
    await registry.complete(luna, context, { temperature: 0, maxTokens: 77, signal: controller.signal });
    assert.equal(requests[0].reasoningEffort, 'low');
    assert.equal(requests[0].temperature, undefined);
    assert.equal(requests[0].maxTokens, 77);
    assert.ok(requests[0].signal instanceof AbortSignal);
    await registry.stream(luna, context, { temperature: 0.5, reasoningEffort: 'high' }).result();
    assert.equal(requests[1].reasoningEffort, 'high');
    assert.equal(requests[1].temperature, undefined);
    await registry.complete(sol, context, { temperature: 0.5 });
    assert.equal(requests[2].reasoningEffort, undefined);
    assert.equal(requests[2].temperature, undefined);
    await runtime.services.modelRuntime.complete(luna, context, { temperature: 0.5 });
    assert.equal(requests[3].reasoningEffort, undefined, 'the main model runtime retains its own options');
    assert.equal(requests[3].temperature, 0.5);
    await runner!.emit({ type: 'session_start', reason: 'reload' });
    await registry.complete(luna, context);
    assert.equal(requests[4].reasoningEffort, 'low');
    assert.equal(requests.length, 5, 'rebinding does not duplicate requests');
    await runner!.emit({ type: 'session_shutdown', reason: 'reload' });
    await registry.complete(luna, context, { temperature: 0.5 });
    assert.equal(requests[5].reasoningEffort, undefined);
    assert.equal(requests[5].temperature, 0.5, 'unloading restores the registry defaults');
  });
});

test('other background providers retain their temperature and effort settings', async () => withPi({ extensions: [backgroundModels], responses: [(_context, options) => {
  assert.equal(options?.temperature, 0.7);
  assert.equal((options as any).reasoningEffort, undefined);
  return fauxAssistantMessage('synthetic reply');
}] }, async ({ runner, provider }) => {
  await runner!.createContext().modelRegistry.complete(provider.getModel(), {
    messages: [{ role: 'user', content: 'synthetic request', timestamp: Date.now() }],
  }, { temperature: 0.7 });
}));
