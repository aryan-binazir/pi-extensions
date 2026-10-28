import assert from 'node:assert/strict';
import test from 'node:test';
import { fauxAssistantMessage, fauxProvider, type Model } from '@earendil-works/pi-ai';
import { withPi } from '../../../tests/pi-session.ts';
import { resolveReviewer } from './model.ts';
import { runReviewerTurn } from './reviewer.ts';

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

for (const stop of ['cancelled', 'timeout'] as const) {
  test(`a ${stop} review prevents provider execution when uncancellable Pi authentication returns`, { timeout: 10_000 }, async () => {
    const provider = fauxProvider({ provider: 'guardian-review-auth', tokensPerSecond: Infinity });
    provider.setResponses([fauxAssistantMessage('{"outcome":"allow"}')]);
    let releaseAuth!: () => void;
    const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
    let authStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>(resolve => { authStarted = resolve; });
    let armed = false;
    await withPi({ configure: ({ modelRuntime }, main) => {
      modelRuntime.registerNativeProvider({ ...provider.provider, auth: { apiKey: {
        name: 'Synthetic delayed auth', resolve: async ({ signal }) => {
          if (armed) { authStarted(signal); await authGate; }
          return { auth: {} };
        },
      } } });
      return { model: main.getModel() };
    } }, async ({ runner, cwd }) => {
      const registry = runner.createContext().modelRegistry;
      await registry.getAvailableOfType('chat', provider.provider.id);
      armed = true;
      const model = provider.getModel();
      const reviewer = resolveReviewer(registry, { provider: model.provider, model: model.id, reasoning: 'low' }, 'auth-cancellation');
      assert.ok(reviewer.ok);
      const controller = new AbortController();
      let completion!: Promise<unknown>;
      try {
        const pending = runReviewerTurn({ cwd, systemPrompt: 'Offline review', userContent: ['Synthetic request'],
          deadline: Date.now() + (stop === 'timeout' ? 500 : 5_000), signal: controller.signal,
          complete: (context, signal) => {
            const result = reviewer.complete(context, signal);
            completion = result.then(() => undefined, () => undefined);
            return result;
          },
          runCommand: async () => { throw new Error('No command expected'); },
        });
        const authSignal = await started;
        if (stop === 'cancelled') controller.abort();
        const outcome = await pending;
        const authAborted = authSignal.aborted;
        releaseAuth();
        await completion;
        assert.deepEqual(outcome, { type: 'error', error: { type: stop } });
        assert.deepEqual({ authAborted, providerEntries: provider.state.callCount }, { authAborted: false, providerEntries: 0 });
      } finally {
        controller.abort();
        releaseAuth();
        await completion;
      }
    });
  });
}

test('an authenticated Pi review preserves auth, provider options and its assessment', async () => {
  const provider = fauxProvider({ provider: 'guardian-auth-success', tokensPerSecond: Infinity });
  let authSignal: AbortSignal | undefined;
  let reviewSignal: AbortSignal | undefined;
  provider.setResponses([(_context, options, _state, model) => {
    assert.equal(options?.apiKey, 'synthetic-key');
    assert.deepEqual(options?.headers, { 'x-synthetic-auth': 'present' });
    assert.deepEqual(options?.env, { GUARDIAN_SYNTHETIC_ENV: 'present' });
    assert.equal(model.baseUrl, 'https://guardian.invalid/offline');
    assert.equal(options?.sessionId, 'normal-auth');
    assert.equal(options?.reasoning, 'low');
    assert.equal(options?.signal, reviewSignal);
    assert.equal(authSignal?.aborted, false);
    assert.equal(options?.signal?.aborted, false);
    return fauxAssistantMessage('{"outcome":"allow"}');
  }]);
  await withPi({ configure: ({ modelRuntime }, main) => {
    modelRuntime.registerNativeProvider({ ...provider.provider, auth: { apiKey: {
      name: 'Synthetic auth', resolve: async ({ signal }) => {
        authSignal = signal;
        return { auth: { apiKey: 'synthetic-key', headers: { 'x-synthetic-auth': 'present' }, baseUrl: 'https://guardian.invalid/offline' },
          env: { GUARDIAN_SYNTHETIC_ENV: 'present' } };
      },
    } } });
    return { model: main.getModel() };
  } }, async ({ runner, cwd }) => {
    const model = provider.getModel();
    const reviewer = resolveReviewer(runner.createContext().modelRegistry, { provider: model.provider, model: model.id, reasoning: 'low' }, 'normal-auth');
    assert.ok(reviewer.ok);
    const outcome = await runReviewerTurn({ cwd, systemPrompt: 'Offline review', userContent: ['Synthetic request'], deadline: Date.now() + 5_000,
      complete: (context, signal) => { reviewSignal = signal; return reviewer.complete(context, signal); },
      runCommand: async () => { throw new Error('No command expected'); } });
    assert.equal(outcome.type, 'completed');
    if (outcome.type === 'completed') assert.equal(outcome.assessment.outcome, 'allow');
    assert.equal(provider.state.callCount, 1);
  });
});

test('Pi authentication failures retain their cause and transient retry classification', async () => {
  const provider = fauxProvider({ provider: 'guardian-auth-error', tokensPerSecond: Infinity });
  let failure: string | undefined;
  await withPi({ configure: ({ modelRuntime }, main) => {
    modelRuntime.registerNativeProvider({ ...provider.provider, auth: { apiKey: {
      name: 'Synthetic failing auth', resolve: async () => {
        if (failure) throw new Error(failure);
        return { auth: {} };
      },
    } } });
    return { model: main.getModel() };
  } }, async ({ runner, cwd }) => {
    const registry = runner.createContext().modelRegistry;
    await registry.getAvailableOfType('chat', provider.provider.id);
    const model = provider.getModel();
    const reviewer = resolveReviewer(registry, { provider: model.provider, model: model.id, reasoning: 'low' }, 'failed-auth');
    assert.ok(reviewer.ok);
    for (const [message, transient] of [['fetch failed', true], ['Invalid credential', false]] as const) {
      failure = message;
      const outcome = await runReviewerTurn({ cwd, systemPrompt: 'Offline review', userContent: ['Synthetic request'], deadline: Date.now() + 5_000,
        complete: reviewer.complete, runCommand: async () => { throw new Error('No command expected'); } });
      assert.equal(outcome.type, 'error');
      if (outcome.type !== 'error') throw new Error('Expected auth failure');
      assert.equal(outcome.error.type, 'session');
      if (outcome.error.type !== 'session') throw new Error('Expected auth session failure');
      assert.equal(outcome.error.message, `reviewer model ${model.provider}/${model.id} is not authenticated: ${message}`);
      assert.equal(outcome.error.transient, transient);
    }
    assert.equal(provider.state.callCount, 0);
  });
});

test('a virtual reviewer retains its existing unrouted-model error without invoking its router', async () => {
  let routes = 0;
  await withPi({ configure: ({ modelRuntime }, main) => {
    modelRuntime.registerVirtualModel({ provider: main.getModel().provider, id: 'guardian-virtual-reviewer', name: 'Synthetic virtual reviewer',
      route: () => { routes++; return { model: main.getModel(), thinkingLevel: 'off' }; } });
    return { model: main.getModel() };
  } }, async ({ runner, provider, cwd }) => {
    const modelId = 'guardian-virtual-reviewer';
    const reviewer = resolveReviewer(runner.createContext().modelRegistry, { provider: provider.getModel().provider, model: modelId, reasoning: 'low' }, 'virtual-reviewer');
    assert.ok(reviewer.ok);
    const outcome = await runReviewerTurn({ cwd, systemPrompt: 'Offline review', userContent: ['Synthetic request'], deadline: Date.now() + 5_000,
      complete: reviewer.complete, runCommand: async () => { throw new Error('No command expected'); } });
    assert.deepEqual(outcome, { type: 'error', error: { type: 'session',
      message: `Virtual model ${provider.getModel().provider}/${modelId} must be routed before streaming`, transient: false } });
    assert.equal(routes, 0);
    assert.equal(provider.state.callCount, 0);
  });
});
