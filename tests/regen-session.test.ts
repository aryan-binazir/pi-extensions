import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import regen from '../extensions/regen/index.ts';
import { withPi } from './pi-session.ts';

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'naming request did not settle');
    await setImmediate();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function namingProvider() {
  return fauxProvider({
    provider: 'openai-codex',
    models: [{ id: 'gpt-6-luna', reasoning: true }],
    tokensPerSecond: Infinity,
  });
}

test('real Pi lifecycle names the first message without blocking, persists it, and regenerates without adding messages', async () => {
  const titles = namingProvider();
  const release = deferred();
  titles.setResponses([
    async (context, options, _state, model) => {
      assert.equal(model.id, 'gpt-6-luna');
      assert.equal(options?.reasoning, 'low');
      assert.ok(context.messages.some(entry => entry.role === 'user' && JSON.stringify(entry).includes('synthetic first prompt')));
      await release.promise;
      return fauxAssistantMessage('Synthetic First Thread');
    },
    fauxAssistantMessage('Regenerated Synthetic Thread'),
  ]);
  try {
    await withPi({
      extensions: [regen],
      responses: [fauxAssistantMessage('First reply'), fauxAssistantMessage('Second reply')],
      configure: (services, main) => {
        services.modelRuntime.registerNativeProvider(titles.provider);
        return { model: main.getModel(), scopedModels: [{ model: main.getModel(), thinkingLevel: 'off' }] };
      },
    }, async ({ session, provider }) => {
      await session.prompt('synthetic first prompt');
      await eventually(() => titles.state.callCount === 1);
      assert.equal(session.sessionName, undefined);
      assert.equal(session.getLastAssistantText(), 'First reply');
      release.resolve();
      await eventually(() => session.sessionName === 'Synthetic First Thread');
      assert.ok(session.sessionFile);
      assert.match(await readFile(session.sessionFile, 'utf8'), /Synthetic First Thread/);
      await session.prompt('synthetic second prompt');
      assert.equal(titles.state.callCount, 1);
      const before = session.messages.length;
      const mainModel = session.model;
      const mainEffort = session.thinkingLevel;
      await session.prompt('/regen-name');
      assert.equal(session.sessionName, 'Regenerated Synthetic Thread');
      assert.equal(session.messages.length, before);
      assert.equal(provider.state.callCount, 2);
      assert.equal(titles.state.callCount, 2);
      assert.equal(session.model, mainModel);
      assert.equal(session.thinkingLevel, mainEffort);
    });
  } finally {
    release.resolve();
  }
});

test('real resumed unnamed conversation is not automatically named but can be named manually', async () => {
  const titles = namingProvider();
  titles.setResponses([fauxAssistantMessage('Manually Named Resumed Thread')]);
  await withPi({
    extensions: [regen],
    responses: [fauxAssistantMessage('Resumed reply')],
    sessionStartEvent: { type: 'session_start', reason: 'resume' },
    sessionManager: cwd => {
      const manager = SessionManager.create(cwd);
      manager.appendMessage({ role: 'user', content: 'Existing synthetic prompt', timestamp: Date.now() });
      manager.appendMessage(fauxAssistantMessage('Existing reply'));
      return manager;
    },
    configure: (services, main) => {
      services.modelRuntime.registerNativeProvider(titles.provider);
      return { model: main.getModel() };
    },
  }, async ({ session }) => {
    await session.prompt('Continue this synthetic conversation');
    assert.equal(titles.state.callCount, 0);
    assert.equal(session.sessionName, undefined);
    await session.prompt('/regen-name');
    assert.equal(session.sessionName, 'Manually Named Resumed Thread');
    assert.equal(titles.state.callCount, 1);
  });
});

test('real manual regeneration cannot overwrite a name changed while the provider was running', async () => {
  const titles = namingProvider();
  const release = deferred();
  titles.setResponses([async () => {
    await release.promise;
    return fauxAssistantMessage('Stale Generated Thread');
  }]);
  try {
    await withPi({
      extensions: [regen],
      sessionManager: cwd => {
        const manager = SessionManager.create(cwd);
        manager.appendMessage({ role: 'user', content: 'Existing synthetic prompt', timestamp: Date.now() });
        manager.appendMessage(fauxAssistantMessage('Existing reply'));
        manager.appendSessionInfo('Original title');
        return manager;
      },
      configure: (services, main) => {
        services.modelRuntime.registerNativeProvider(titles.provider);
        return { model: main.getModel() };
      },
    }, async ({ session, runner }) => {
      const naming = session.prompt('/regen-name');
      await eventually(() => titles.state.callCount === 1);
      session.sessionManager.appendSessionInfo('User Chosen Title');
      await runner.emit({ type: 'session_info_changed', name: 'User Chosen Title' });
      release.resolve();
      await naming;
      assert.equal(session.sessionName, 'User Chosen Title');
    });
  } finally {
    release.resolve();
  }
});

test('real runtime replacement discards an old automatic title and names the new session', async () => {
  const titles = namingProvider();
  const release = deferred();
  titles.setResponses([
    async () => {
      await release.promise;
      return fauxAssistantMessage('Obsolete Synthetic Thread');
    },
    fauxAssistantMessage('Replacement Synthetic Thread'),
  ]);
  try {
    await withPi({
      extensions: [regen],
      responses: [fauxAssistantMessage('Old reply'), fauxAssistantMessage('New reply')],
      configure: (services, main) => {
        services.modelRuntime.registerNativeProvider(titles.provider);
        return { model: main.getModel() };
      },
    }, async fixture => {
      await fixture.session.prompt('Old synthetic session');
      await eventually(() => titles.state.callCount === 1);
      const old = fixture.session;
      await fixture.runtime.newSession();
      release.resolve();
      await fixture.session.prompt('New synthetic session');
      await eventually(() => fixture.session.sessionName === 'Replacement Synthetic Thread');
      assert.equal(old.sessionName, undefined);
      assert.equal(titles.state.callCount, 2);
    });
  } finally {
    release.resolve();
  }
});
