import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, CustomEditor, DefaultResourceLoader, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { CombinedAutocompleteProvider, Container } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { fauxToolCall } from '@earendil-works/pi-ai';
import viMode from '../vi-mode/index.ts';
import stash from '../prompt-stash/index.ts';
import { editor } from '../vi-mode/test-support.ts';
import { KeybindingsManager } from '../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { initTheme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import escapeContinue from './index.ts';

initTheme('dark', false);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, extra: ((pi: ExtensionAPI) => void)[] = [], enabled = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-escape-continue-'));
  const agentDir = join(cwd, 'agent');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', doubleEscapeAction: 'none' });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [...enabled ? [escapeContinue] : [], ...extra], noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const provider = fauxProvider({ provider: 'escape-continue-test', tokensPerSecond: 100000 });
  modelRuntime.registerNativeProvider(provider.provider);
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(cwd), model: provider.getModel(), noTools: 'builtin' });
  const app: any = Object.create(InteractiveMode.prototype);
  Object.defineProperty(app, 'session', { value: session, writable: true, configurable: true });
  Object.defineProperty(app, 'sessionManager', { get: () => app.session.sessionManager });
  app.defaultEditor = editor(CustomEditor);
  app.editor = app.defaultEditor;
  app.editorContainer = new Container();
  app.pendingMessagesContainer = new Container();
  app.statusContainer = new Container();
  app.compactionQueuedMessages = [];
  Object.defineProperty(app, 'settingsManager', { value: settingsManager });
  app.keybindings = new KeybindingsManager();
  app.ui = { requestRender() {}, terminal: { write() {}, rows: 30, columns: 80 }, onDebug: undefined, setFocus() {}, getShowHardwareCursor: () => false, setShowHardwareCursor() {} };
  const notices: string[] = [];
  const baseUI = session.extensionRunner!.createContext().ui;
  const ui = { ...baseUI,
    notify: (message: string) => { notices.push(message); },
    setStatus: (_key: string, text: string | undefined) => { if (text) notices.push(text); },
    getEditorText: () => app.editor.getExpandedText(),
    setEditorText: (text: string) => app.editor.setText(text),
    getEditorComponent: () => app.editorComponentFactory,
    setEditorComponent: (factory: unknown) => app.setCustomEditorComponent(factory),
  };
  app.createExtensionUIContext = () => ui;
  app.setupAutocompleteProvider = app.setupExtensionShortcuts = app.showLoadedResources = app.showStartupNoticesIfNeeded = () => {};
  app.showExtensionError = (_path: string, error: string) => { notices.push(error); };
  app.setupKeyHandlers();
  await app.bindCurrentSessionExtensions();
  const errors: unknown[] = [];
  session.extensionRunner!.onError(error => errors.push(error));
  t.after(async () => {
    await session.abort();
    await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const users = () => session.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
  const blocked = (started: ReturnType<typeof deferred>, released?: ReturnType<typeof deferred>): FauxResponseFactory => async (_context, options) => {
    started.resolve();
    if (released) await released.promise;
    else if (!options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return fauxAssistantMessage('Cancelled response');
  };
  return { session, provider, app, notices, users, blocked, settingsManager };
}

test('Escape aborts the current run and starts the queued follow-up without touching the draft', async t => {
  const h = await fixture(t);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), () => { promoted.resolve(); return fauxAssistantMessage('New direction'); }]);
  const running = h.session.prompt('Original request');
  await first.promise;
  await h.session.followUp('Change direction');
  h.app.editor.setText('Unsubmitted draft');
  h.app.editor.handleInput('\x1b');
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original request', 'Change direction']);
  await promoted.promise;
  await h.session.waitForIdle();
  assert.equal(h.app.editor.getText(), 'Unsubmitted draft');
  assert.equal(h.session.pendingMessageCount, 0);
});

test('promotion preserves duplicate steering tails and attachments without folding them into its first request', async t => {
  const h = await fixture(t);
  h.session.setSteeringMode('all');
  const settings = h.settingsManager.getSettings();
  const first = deferred(), promoted = deferred();
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
  const requests: string[][] = [];
  h.provider.setResponses([h.blocked(first), async (context, options) => {
    requests.push(context.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')));
    promoted.resolve();
    if (!options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return fauxAssistantMessage('Stopped promotion');
  }]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.steer('Same text');
  await h.session.steer('Same text', [image]);
  await h.session.followUp('Later');
  h.app.editor.handleInput('\x1b');
  await running;
  await new Promise(resolve => setImmediate(resolve));
  await promoted.promise;
  assert.deepEqual(h.session.getSteeringMessages(), ['Same text']);
  assert.deepEqual(requests, [['Original', 'Same text']]);
  const queued = h.session.agent.peekQueuedMessages()[0];
  assert.ok(queued.role === 'user');
  assert.deepEqual(queued.content, [{ type: 'text', text: 'Same text' }, image]);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Later']);
  assert.deepEqual(h.settingsManager.getSettings(), settings);
  h.session.clearQueue();
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  assert.deepEqual(h.users(), ['Original', 'Same text']);
});

test('a second Escape during cancellation stops the handoff and retains the queued image message', async t => {
  const h = await fixture(t);
  const first = deferred(), release = deferred();
  t.after(() => release.resolve());
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'synthetic-image-data' };
  await h.session.followUp('Next', [image]);
  h.app.editor.setText('Keep my draft');
  h.app.editor.handleInput('\x1b');
  h.app.editor.handleInput('\x1b');
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original']);
  assert.equal(h.provider.state.callCount, 1);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  const queued = h.session.agent.peekQueuedMessages()[0];
  assert.ok(queued.role === 'user');
  assert.deepEqual(queued.content, [{ type: 'text', text: 'Next' }, image]);
  assert.equal(h.app.editor.getText(), 'Keep my draft');
  assert.ok(h.notices.some(message => /queued.*kept|kept.*queued/i.test(message)));
});

test('Escape during promoted-prompt preflight cancels before a provider request and retains the prompt', async t => {
  const preparing = deferred(), release = deferred();
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await release.promise; }
  })]);
  t.after(() => release.resolve());
  const first = deferred();
  h.provider.setResponses([h.blocked(first), fauxAssistantMessage('Must not request')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await running;
  await preparing.promise;
  h.app.editor.handleInput('\x1b');
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await h.session.waitForIdle();
  assert.equal(h.provider.state.callCount, 1);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
});

test('unsupported queue internals fall back to stock Escape and warn once per session', async t => {
  const h = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const first = deferred();
    h.provider.setResponses([h.blocked(first)]);
    const running = h.session.prompt(`Original ${index}`);
    await first.promise;
    await h.session.followUp('Next');
    (h.session.agent as any).steeringQueue.messages = undefined;
    assert.doesNotThrow(() => h.app.editor.handleInput('\x1b'));
    await running;
    assert.match(h.app.editor.getText(), /Next/);
    h.app.editor.setText('');
  }
  assert.equal(h.notices.filter(message => /unsupported.*Pi|Pi.*unsupported/i.test(message)).length, 1);
});

test('each Escape promotes just one next message, then an empty queue means stop', async t => {
  const h = await fixture(t);
  const first = deferred(), second = deferred(), third = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(second), h.blocked(third)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Second');
  await h.session.followUp('Third');
  h.app.editor.handleInput('\x1b');
  await second.promise;
  assert.deepEqual(h.users(), ['Original', 'Second']);
  h.app.editor.handleInput('\x1b');
  await third.promise;
  assert.deepEqual(h.users(), ['Original', 'Second', 'Third']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
  assert.equal(h.provider.state.callCount, 3);
  assert.equal(h.session.pendingMessageCount, 0);
});

test('Escape during a slow tool keeps steering out of the cancelled run', async t => {
  const toolStarted = deferred(), release = deferred();
  const h = await fixture(t, [pi => pi.registerTool({
    name: 'slow', label: 'Slow', description: 'Synthetic slow tool', parameters: Type.Object({}),
    execute: async () => { toolStarted.resolve(); await release.promise; return { content: [{ type: 'text', text: 'Done' }], details: undefined }; },
  })]);
  t.after(() => release.resolve());
  const promoted = deferred();
  h.provider.setResponses([fauxAssistantMessage(fauxToolCall('slow', {}, { id: 'slow-call' })), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await toolStarted.promise;
  await h.session.steer('Steer next');
  h.app.editor.handleInput('\x1b');
  assert.deepEqual(h.users(), ['Original']);
  release.resolve();
  await promoted.promise;
  const userIndex = h.session.messages.findIndex(message => message.role === 'user' && typeof message.content !== 'string' && message.content.some(part => part.type === 'text' && part.text === 'Steer next'));
  const toolIndex = h.session.messages.findIndex(message => message.role === 'toolResult');
  assert.ok(userIndex > toolIndex, 'queued steering belongs to the new run, after the cancelled tool result');
  assert.deepEqual(h.users(), ['Original', 'Steer next']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

test('custom queued messages survive promotion with their original contents and order', async t => {
  const h = await fixture(t);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.sendCustomMessage({ customType: 'synthetic', content: 'Background context', display: false }, { deliverAs: 'steer' });
  await h.session.followUp('Next');
  await h.session.followUp('Tail');
  const original = h.session.agent.peekQueuedMessages()[0];
  h.app.editor.handleInput('\x1b');
  await promoted.promise;
  assert.deepEqual(h.users(), ['Original', 'Next']);
  assert.deepEqual(h.session.agent.peekQueuedMessages(), [original]);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Tail']);
  h.session.clearQueue();
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

for (const lifecycle of ['shutdown', 'reload'] as const) test(`${lifecycle} during cancellation retires the handoff without losing the old queue`, async t => {
  const h = await fixture(t);
  const first = deferred(), release = deferred();
  t.after(() => release.resolve());
  h.provider.setResponses([h.blocked(first, release)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await h.session.extensionRunner!.emit({ type: 'session_shutdown', reason: lifecycle === 'reload' ? 'reload' : 'quit' });
  if (lifecycle === 'reload') await h.app.bindCurrentSessionExtensions();
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.provider.state.callCount, 1);
  assert.deepEqual(h.users(), ['Original']);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
});

test('an unselected extension leaves stock Escape queue-to-editor behavior intact', async t => {
  const h = await fixture(t, [], false);
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await running;
  assert.deepEqual(h.users(), ['Original']);
  assert.equal(h.app.editor.getText(), 'Next');
});

for (const extensions of [[viMode, stash], [stash, viMode]]) test(`vi-mode and stash retain their Escape ownership in load order ${extensions[0] === viMode ? 'vi first' : 'stash first'}`, async t => {
  const h = await fixture(t, extensions);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  assert.equal(h.session.agent.signal?.aborted, false, 'insert-mode Escape is only a vi-mode change');
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  h.app.editor.handleInput('\x1b');
  await promoted.promise;
  assert.deepEqual(h.users(), ['Original', 'Next']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

test('a manually submitted prompt during promotion preflight cannot consume or replace the held queue', async t => {
  const preparing = deferred(), release = deferred();
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await release.promise; }
  })]);
  t.after(() => release.resolve());
  const first = deferred(), manualStarted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(manualStarted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await preparing.promise;
  const manual = h.session.prompt('Manual');
  await manualStarted.promise;
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original', 'Manual']);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  assert.equal(h.provider.state.callCount, 2);
  h.session.clearQueue();
  h.app.editor.handleInput('\x1b');
  await manual;
  await running;
});

test('the promoted message preserves its image attachment through normal prompt preparation', async t => {
  const h = await fixture(t);
  const first = deferred(), promoted = deferred();
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Look at this', [image]);
  h.app.editor.handleInput('\x1b');
  await promoted.promise;
  const user = h.session.messages.filter(message => message.role === 'user').at(-1)!;
  assert.ok(user.role === 'user' && typeof user.content !== 'string');
  assert.deepEqual(user.content, [{ type: 'text', text: 'Look at this' }, image]);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

test('an input handler consuming a promoted prompt leaves the prepared queue waiting', async t => {
  const handled = deferred();
  const h = await fixture(t, [pi => pi.on('input', event => {
    if (event.source === 'extension') { handled.resolve(); return { action: 'handled' }; }
    return { action: 'continue' };
  })]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await handled.promise;
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original']);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  assert.ok(h.notices.some(message => /did not start/.test(message)));
});

test('autocomplete Escape closes suggestions without interrupting or promoting', async t => {
  const h = await fixture(t);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'hello' }, { name: 'help' }], h.session.sessionManager.getCwd()));
  h.app.editor.setText('/he');
  h.app.editor.handleInput('\t');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.app.editor.isShowingAutocomplete(), true);
  h.app.editor.handleInput('\x1b');
  assert.equal(h.app.editor.isShowingAutocomplete(), false);
  assert.equal(h.session.agent.signal?.aborted, false);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  h.app.editor.handleInput('\x1b');
  await promoted.promise;
  assert.equal(h.app.editor.getText(), '/he');
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

test('rebinding the UI wraps Escape only once', async t => {
  const h = await fixture(t);
  const original = h.app.defaultEditor.onEscape;
  await h.app.bindCurrentSessionExtensions();
  await h.app.bindCurrentSessionExtensions();
  assert.equal(h.app.defaultEditor.onEscape, original);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await promoted.promise;
  assert.deepEqual(h.users(), ['Original', 'Next']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});





