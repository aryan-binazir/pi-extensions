import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionRuntime, createAgentSession, type CreateAgentSessionRuntimeFactory, CustomEditor, DefaultResourceLoader, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { CombinedAutocompleteProvider, Container, setKittyProtocolActive } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
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

async function fixture(t: TestContext, extra: ((pi: ExtensionAPI) => void)[] = [], enabled = true, before: ((pi: ExtensionAPI) => void)[] = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-escape-continue-'));
  const agentDir = join(cwd, 'agent');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false }, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', doubleEscapeAction: 'none' });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [...before, ...enabled ? [escapeContinue] : [], ...extra], noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
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
  app.ui = { requestRender() {}, terminal: { write() {}, rows: 30, columns: 80 }, onDebug: undefined, setFocus() {}, getFocusedComponent: () => app.editor, getShowHardwareCursor: () => false, setShowHardwareCursor() {} };
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
  let retired = false;
  t.after(async () => {
    await session.abort();
    if (!retired) {
      await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
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
  const services = { cwd, agentDir, settingsManager, modelRuntime, resourceLoader, diagnostics: [] };
  return { session, provider, app, notices, users, blocked, settingsManager, services, retire: () => { retired = true; } };
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

for (const configuration of [
  { name: 'vi first', extra: [viMode, stash], before: [], x: '\x18', s: '\x13', kitty: false },
  { name: 'stash first', extra: [stash, viMode], before: [], x: '\x18', s: '\x13', kitty: false },
  { name: 'Escape last, Kitty', extra: [], before: [viMode, stash], x: '\x1b[120;5u', s: '\x1b[115;5u', kitty: true },
  { name: 'Escape last, modifyOtherKeys', extra: [], before: [viMode, stash], x: '\x1b[27;5;120~', s: '\x1b[27;5;115~', kitty: false },
]) test(`Ctrl-X Ctrl-S promotes the next queued message while Vi stays in insert mode, ${configuration.name}`, async t => {
  const h = await fixture(t, configuration.extra, true, configuration.before);
  setKittyProtocolActive(configuration.kitty);
  t.after(() => setKittyProtocolActive(false));
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  let copies = 0;
  h.app.editor.onAction('app.message.copy', () => { copies++; });
  h.app.editor.handleInput('a');
  h.app.editor.handleInput('b');
  h.app.editor.handleInput(configuration.x);
  h.app.editor.handleInput(configuration.s);
  assert.equal(h.session.agent.signal?.aborted, true);
  await promoted.promise;
  h.app.editor.handleInput('c');
  assert.equal(h.app.editor.getText(), 'abc');
  assert.equal(copies, 0);
  assert.deepEqual(h.users(), ['Original', 'Next']);
  h.app.editor.handleInput(configuration.x);
  h.app.editor.handleInput(configuration.s);
  await h.session.waitForIdle();
  await running;
});

test('fragmented bracketed paste containing Ctrl-X Ctrl-S cannot interrupt the run', async t => {
  const h = await fixture(t, [viMode, stash]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const running = h.session.prompt('Original');
  await first.promise;
  h.app.editor.onAction('app.message.copy', () => assert.fail('paste must not copy'));
  for (const chunk of ['\x1b[200~before', '\x18', '\x13', 'after\x1b[201~'])
    h.app.editor.handleInput(chunk);
  assert.equal(h.session.agent.signal?.aborted, false);
  assert.equal(h.app.editor.getText(), 'beforeafter');
  await h.session.abort();
  await running;
});

for (const extensions of [[], [viMode, stash], [stash, viMode]]) test(`Ctrl-X Ctrl-S works after a real reload, ${extensions.length === 0 ? 'stock' : extensions[0] === viMode ? 'vi first' : 'stash first'}`, async t => {
  const h = await fixture(t, extensions);
  await h.session.reload();
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.onAction('app.message.copy', () => {});
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(h.session.agent.signal?.aborted, true);
  await promoted.promise;
  assert.equal(h.app.editor.getText(), 'draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  await h.session.waitForIdle();
  await running;
});

test('standalone Ctrl-S still stashes and restores the draft immediately', async t => {
  const h = await fixture(t, [viMode, stash]);
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), '');
  h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), 'draft');
});

for (const [encoding, ctrlX] of [['legacy', '\x18'], ['Kitty', '\x1b[120;5u'], ['modifyOtherKeys', '\x1b[27;5;120~']]) test(`standalone ${encoding} Ctrl-X still copies after the prefix timeout`, async t => {
  const h = await fixture(t, [viMode, stash]);
  setKittyProtocolActive(encoding === 'Kitty');
  t.after(() => setKittyProtocolActive(false));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let copied: string | undefined;
  h.app.editor.onAction('app.message.copy', () => { copied = h.app.editor.getText(); });
  h.app.editor.setText('draft');
  h.app.editor.handleInput(ctrlX);
  t.mock.timers.tick(749);
  assert.equal(copied, undefined);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, 'draft');
  assert.equal(h.app.editor.getText(), 'draft');
});

test('an unrelated next key copies first and then remains available to Vi insertion', async t => {
  const h = await fixture(t, [viMode, stash]);
  const copies: string[] = [];
  h.app.editor.onAction('app.message.copy', () => { copies.push(h.app.editor.getText()); });
  h.app.editor.handleInput('a');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('b');
  assert.deepEqual(copies, ['a']);
  assert.equal(h.app.editor.getText(), 'ab');
});

test('a repeated Ctrl-X copies the first prefix and allows Ctrl-S to complete the second', async t => {
  const h = await fixture(t, [viMode, stash]);
  let copies = 0;
  h.app.editor.onAction('app.message.copy', () => { copies++; });
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(copies, 1);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('Ctrl-S waiting at prefix expiry completes the chord before delayed copy', async t => {
  const h = await fixture(t, [viMode, stash]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let copies = 0;
  h.app.editor.onAction('app.message.copy', () => { copies++; });
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  t.mock.timers.tick(750);
  h.app.editor.handleInput('\x13');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copies, 0);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('an idle chord preserves the Bash draft and never triggers double-Escape navigation', async t => {
  const h = await fixture(t, [viMode, stash]);
  h.settingsManager.setDoubleEscapeAction('tree');
  h.app.lastEscapeTime = Date.now();
  h.app.showTreeSelector = () => assert.fail('idle chord must not open the tree');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), '');
  h.app.isBashMode = true;
  h.app.editor.setText('!echo synthetic');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), '!echo synthetic');
});

test('a pending copy is discarded when editor focus moves to a dialog', async t => {
  const h = await fixture(t, [viMode, stash]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.app.editor.onAction('app.message.copy', () => assert.fail('dialog focus must discard pending copy'));
  h.app.editor.handleInput('\x18');
  h.app.ui.getFocusedComponent = () => new Container();
  t.mock.timers.tick(750);
  h.app.ui.getFocusedComponent = () => h.app.editor;
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), '');
});

test('replacing the editor discards a pending copy and preserves the chord on the new editor', async t => {
  const h = await fixture(t, [viMode, stash]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = h.app.editor;
  previous.onAction('app.message.copy', () => assert.fail('retired editor must not copy'));
  previous.handleInput('\x18');
  h.app.setCustomEditorComponent(undefined);
  t.mock.timers.tick(750);
  h.app.editor.onAction('app.message.copy', () => assert.fail('chord must not copy'));
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  t.mock.timers.tick(750);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('disabling Escape Continue drops the prefix and restores immediate standalone copy', async t => {
  const h = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let copies = 0;
  h.app.editor.onAction('app.message.copy', () => { copies++; });
  h.app.editor.handleInput('\x18');
  await h.session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' });
  t.mock.timers.tick(750);
  assert.equal(copies, 0);
  h.app.editor.handleInput('\x18');
  assert.equal(copies, 1);
});

test('interactive quit drops a pending copy before terminal drain', async t => {
  const h = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let copies = 0;
  h.app.editor.onAction('app.message.copy', () => { copies++; });
  h.app.editor.handleInput('\x18');
  h.app.themeController = { disableAutoSync() {} };
  h.app.stop = () => {};
  h.app.ui.terminal.drainInput = async () => { t.mock.timers.tick(750); };
  h.app.runtimeHost = { dispose: async () => {} };
  const exit = process.exit, expectedExit = new Error('Expected interactive quit');
  process.exit = () => { throw expectedExit; };
  try { await assert.rejects(h.app.shutdown(), error => error === expectedExit); }
  finally { process.exit = exit; }
  assert.equal(copies, 0);
});

test('the chord aborts a running Bash command without changing the insert draft', { timeout: 5000 }, async t => {
  const h = await fixture(t, [viMode, stash]);
  const started = deferred();
  const running = h.session.executeBash("printf 'ready\\n'; sleep 30", chunk => {
    if (chunk.includes('ready')) started.resolve();
  });
  await started.promise;
  assert.equal(h.session.isStreaming, false);
  assert.equal(h.session.isBashRunning, true);
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal((await running).cancelled, true);
  h.app.editor.handleInput('i');
  assert.equal(h.app.editor.getText(), 'drafti');
});

test('the chord reaches manual compaction cancellation while no agent run is streaming', { timeout: 5000 }, async t => {
  const h = await fixture(t, [viMode, stash]);
  const started = deferred();
  h.provider.setResponses([fauxAssistantMessage('A completed seed response'), h.blocked(started)]);
  await h.session.prompt('Seed a completed conversation for compaction');
  h.app.defaultEditor.onEscape = () => h.session.abortCompaction();
  const compacting = h.session.compact();
  const cancelled = assert.rejects(compacting, /cancel|abort/i);
  await started.promise;
  assert.equal(h.session.isStreaming, false);
  assert.equal(h.session.isCompacting, true);
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  await cancelled;
  assert.equal(h.session.isCompacting, false);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('the chord reaches the retry cancellation callback during actual backoff', { timeout: 5000 }, async t => {
  const h = await fixture(t, [viMode, stash]);
  h.settingsManager.setRetryEnabled(true);
  const retrying = deferred();
  h.session.subscribe(event => {
    if (event.type === 'auto_retry_start') {
      h.app.defaultEditor.onEscape = () => h.session.abortRetry();
      retrying.resolve();
    }
  });
  h.provider.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit exceeded' })]);
  const running = h.session.prompt('Original');
  await retrying.promise;
  assert.equal(h.session.isRetrying, true);
  h.app.editor.setText('draft');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  await running;
  assert.equal(h.session.isRetrying, false);
  assert.equal(h.provider.state.callCount, 1);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('a second chord during slow cancellation holds the queued image and draft', async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t, [viMode, stash]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'synthetic-image-data' };
  await h.session.followUp('Next', [image]);
  h.app.editor.setText('draft');
  for (let press = 0; press < 2; press++) {
    h.app.editor.handleInput('\x18');
    h.app.editor.handleInput('\x13');
  }
  assert.ok(h.notices.some(message => /stopped; queued messages and attachments kept waiting/.test(message)));
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original']);
  const queued = h.session.agent.peekQueuedMessages()[0];
  assert.ok(queued.role === 'user');
  assert.deepEqual(queued.content, [{ type: 'text', text: 'Next' }, image]);
  assert.equal(h.app.editor.getText(), 'draft');
});

test('the chord uses the live Escape callback without leaving Vi insert mode', async t => {
  const h = await fixture(t, [viMode, stash]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const running = h.session.prompt('Original');
  await first.promise;
  let stopped = false;
  h.app.defaultEditor.onEscape = () => { stopped = true; };
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(stopped, true);
  h.app.editor.handleInput('i');
  assert.equal(h.app.editor.getText(), 'i');
  await h.session.abort();
  await running;
});

test('the chord interrupts immediately with autocomplete open and retains the insert draft', async t => {
  const h = await fixture(t, [viMode, stash]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const running = h.session.prompt('Original');
  await first.promise;
  h.app.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'hello' }, { name: 'help' }], h.session.sessionManager.getCwd()));
  h.app.editor.setText('/he');
  h.app.editor.handleInput('\t');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.app.editor.isShowingAutocomplete(), true);
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.equal(h.session.agent.signal?.aborted, true);
  assert.equal(h.app.editor.isShowingAutocomplete(), true);
  assert.equal(h.app.editor.getText(), '/he');
  await running;
});

test('a second chord during prompt preparation stops the handoff and keeps the queued message', async t => {
  const preparing = deferred(), release = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await release.promise; }
  }), viMode, stash]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first), fauxAssistantMessage('Should not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  await preparing.promise;
  h.app.editor.handleInput('\x18');
  h.app.editor.handleInput('\x13');
  assert.ok(h.notices.some(message => /stopped; queued messages and attachments kept waiting/.test(message)));
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original']);
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
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

test('preflight cancellation preserves next-turn notifications and the idle system prompt', async t => {
  const preparing = deferred(), release = deferred();
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await release.promise; return { systemPrompt: 'Cancelled prompt override' }; }
  })]);
  t.after(() => release.resolve());
  const first = deferred();
  h.provider.setResponses([h.blocked(first)]);
  const baseline = h.session.systemPrompt;
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.sendCustomMessage({ customType: 'notification', content: 'Worker finished', display: false }, { deliverAs: 'nextTurn' });
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await preparing.promise;
  h.app.editor.handleInput('\x1b');
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.session.systemPrompt, baseline);
  h.session.clearQueue();
  h.provider.setResponses([fauxAssistantMessage('Later reply')]);
  await h.session.prompt('Later');
  assert.ok(h.session.messages.some(message => message.role === 'custom' && message.customType === 'notification' && message.content === 'Worker finished'));
});

test('new steering entered during cancellation stays after older held steering and out of the promoted request', async t => {
  const h = await fixture(t);
  const first = deferred(), release = deferred(), promoted = deferred();
  t.after(() => release.resolve());
  h.provider.setResponses([h.blocked(first, release), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.steer('Older A');
  await h.session.steer('Older B');
  h.app.editor.handleInput('\x1b');
  await h.session.steer('Newer N');
  release.resolve();
  await promoted.promise;
  assert.deepEqual(h.users(), ['Original', 'Older A']);
  assert.deepEqual(h.session.getSteeringMessages(), ['Older B', 'Newer N']);
  h.session.clearQueue();
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

for (const missing of ['editor', 'handler']) test(`a missing Escape ${missing} warns without breaking UI rebinding`, async t => {
  const h = await fixture(t);
  if (missing === 'editor') h.app.defaultEditor = undefined;
  else h.app.defaultEditor.onEscape = undefined;
  await assert.doesNotReject(h.app.bindCurrentSessionExtensions());
  assert.ok(h.notices.some(message => /unsupported Pi internals/.test(message)));
});

test('second Escape while a tool is still cancelling immediately reports the retained queue', async t => {
  const first = deferred(), release = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t);
  h.provider.setResponses([h.blocked(first, release)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  assert.ok(h.notices.some(message => /1 queued held/.test(message)));
  h.app.editor.handleInput('\x1b');
  assert.ok(h.notices.some(message => /stopped; queued messages and attachments kept waiting/.test(message)));
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
});

test('Escape after preflight starts aborts the promoted run without draining its remaining queue', async t => {
  const messageStarting = deferred(), release = deferred();
  const h = await fixture(t, [pi => pi.on('message_start', async event => {
    if (event.message.role === 'user' && typeof event.message.content !== 'string' && event.message.content.some(part => part.type === 'text' && part.text === 'Next')) {
      messageStarting.resolve();
      await release.promise;
    }
  })]);
  t.after(() => release.resolve());
  const first = deferred();
  let requestedWithAbort = false;
  h.provider.setResponses([h.blocked(first), (_context, options) => {
    requestedWithAbort = options?.signal?.aborted === true;
    return fauxAssistantMessage('Aborted before processing');
  }]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.steer('Next');
  await h.session.steer('Later steering');
  h.app.editor.handleInput('\x1b');
  await messageStarting.promise;
  h.app.editor.handleInput('\x1b');
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  await h.session.waitForIdle();
  assert.ok(h.provider.state.callCount === 1 || requestedWithAbort, 'no unaborted request is issued');
  assert.deepEqual(h.users(), ['Original', 'Next']);
  assert.deepEqual(h.session.getSteeringMessages(), ['Later steering']);
  assert.ok(h.notices.some(message => /stopped; queued messages/.test(message)));
});

for (const mode of ['rpc', 'json', 'print'] as const) test(`the extension remains inert when session_start uses ${mode} mode`, async t => {
  const h = await fixture(t);
  await h.session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' });
  await h.session.bindExtensions({ mode });
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

test('replacing the host with another real session prevents delayed handoff into the replacement', async t => {
  const old = await fixture(t), replacement = await fixture(t);
  const first = deferred(), release = deferred();
  t.after(() => release.resolve());
  old.provider.setResponses([old.blocked(first, release)]);
  const running = old.session.prompt('Original');
  await first.promise;
  await old.session.followUp('Next');
  old.app.editor.handleInput('\x1b');
  old.app.session = replacement.session;
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(old.users(), ['Original']);
  assert.deepEqual(old.session.getFollowUpMessages(), ['Next']);
  assert.deepEqual(replacement.users(), []);
  assert.equal(replacement.provider.state.callCount, 0);
});

test('manual input cancels a promoted preflight before either completion order can commit it', async t => {
  for (const order of ['promoted-first', 'manual-first']) await t.test(order, async t => {
    const promotedPreparing = deferred(), manualPreparing = deferred(), releasePromoted = deferred(), releaseManual = deferred();
    const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
      if (event.prompt === 'Next') { promotedPreparing.resolve(); await releasePromoted.promise; }
      if (event.prompt === 'Manual') { manualPreparing.resolve(); await releaseManual.promise; }
    })]);
    t.after(() => { releasePromoted.resolve(); releaseManual.resolve(); });
    const first = deferred(), manualStarted = deferred();
    h.provider.setResponses([h.blocked(first), h.blocked(manualStarted)]);
    const running = h.session.prompt('Original');
    await first.promise;
    await h.session.followUp('Next');
    h.app.editor.handleInput('\x1b');
    await promotedPreparing.promise;
    await h.session.sendCustomMessage({ customType: 'notification', content: 'Keep this result', display: false }, { deliverAs: 'nextTurn' });
    h.app.flushPendingBashComponents = () => {};
    h.app.setupEditorSubmitHandler();
    let manual!: Promise<void>;
    h.app.onInputCallback = (text: string) => { manual = h.session.prompt(text).then(() => {}); };
    await h.app.defaultEditor.onSubmit('Manual');
    await manualPreparing.promise;
    if (order === 'promoted-first') releasePromoted.resolve();
    else releaseManual.resolve();
    await new Promise(resolve => setImmediate(resolve));
    releasePromoted.resolve(); releaseManual.resolve();
    await manualStarted.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.session.isStreaming, true, 'the live provider still belongs to the manual run');
    assert.deepEqual(h.users(), ['Original', 'Manual']);
    assert.ok(h.session.messages.some(message => message.role === 'custom' && message.customType === 'notification' && message.content === 'Keep this result'));
    assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
    h.session.clearQueue();
    h.app.editor.handleInput('\x1b');
    await manual;
    await running;
    assert.equal(h.session.agent.signal, undefined);
  });
});

test('programmatic abort cancels a held handoff and uses stock queue-to-editor behavior', async t => {
  const h = await fixture(t);
  const first = deferred(), release = deferred();
  t.after(() => release.resolve());
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.setText('Draft');
  h.app.editor.handleInput('\x1b');
  h.session.extensionRunner!.createContext().abort();
  const draft = h.app.editor.getText();
  release.resolve();
  assert.equal(draft, 'Next\n\nDraft');
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.users(), ['Original']);
  assert.equal(h.provider.state.callCount, 1);
  assert.equal(h.session.pendingMessageCount, 0);
});

test('stock dequeue sees held messages and does not duplicate them after cancellation settles', async t => {
  const h = await fixture(t);
  const first = deferred(), release = deferred();
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'stock-dequeue-image' };
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.steer('Steering', [image]);
  await h.session.followUp('Follow-up');
  h.app.editor.setText('Draft');
  h.app.editor.handleInput('\x1b');
  h.app.showStatus = (message: string) => h.notices.push(message);
  h.app.handleDequeue();
  const draft = h.app.editor.getText();
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(draft, 'Steering\n\nFollow-up\n\nDraft');
  assert.equal(h.app.editor.getText(), draft);
  assert.ok(h.notices.includes('Restored 2 queued messages to editor'));
  assert.equal(h.session.pendingMessageCount, 0);
  assert.deepEqual(h.session.agent.peekQueuedMessages(), []);
  assert.equal(h.provider.state.callCount, 1);
});

test('accepted runtime replacement retires a handoff before an earlier async shutdown handler yields', async t => {
  const shutdown = deferred(), releaseShutdown = deferred();
  const h = await fixture(t, [], true, [pi => pi.on('session_shutdown', async () => {
    shutdown.resolve();
    await releaseShutdown.promise;
  })]);
  const create: CreateAgentSessionRuntimeFactory = async options => {
    await h.services.resourceLoader.reload();
    const result = await createAgentSession({
      ...h.services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent,
      model: h.provider.getModel(), noTools: 'builtin',
    });
    return { ...result, services: h.services, diagnostics: [] };
  };
  const runtime = new AgentSessionRuntime(h.session, h.services, create);
  runtime.setRebindSession(async session => {
    h.app.session = session;
    await h.app.bindCurrentSessionExtensions();
  });
  const first = deferred(), release = deferred();
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  const replacement = runtime.newSession();
  release.resolve();
  try {
    await shutdown.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.provider.state.callCount, 1, 'no outgoing provider starts during accepted teardown');
    assert.deepEqual(h.users(), ['Original']);
    assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  } finally {
    releaseShutdown.resolve();
    await replacement;
    h.retire();
    await runtime.dispose();
  }
  await running;
  assert.notEqual(runtime.session, h.session);
  assert.deepEqual(runtime.session.messages, []);
});

test('interactive quit retires a handoff before terminal drain or async shutdown handlers', async t => {
  const h = await fixture(t);
  const runtime = new AgentSessionRuntime(h.session, h.services, async () => { throw new Error('Quit must not replace the runtime'); });
  const first = deferred(), release = deferred(), draining = deferred(), releaseDrain = deferred();
  h.provider.setResponses([h.blocked(first, release), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  h.app.themeController = { disableAutoSync() {} };
  h.app.stop = () => {};
  h.app.ui.terminal.drainInput = async () => { draining.resolve(); await releaseDrain.promise; };
  h.app.runtimeHost = { dispose: async () => { await runtime.dispose(); h.retire(); } };
  const exit = process.exit, expectedExit = new Error('Expected interactive quit');
  process.exit = () => { throw expectedExit; };
  const quitting = h.app.shutdown().catch((error: unknown) => { assert.equal(error, expectedExit); });
  release.resolve();
  try {
    await draining.promise;
    await running;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.provider.state.callCount, 1);
    assert.deepEqual(h.users(), ['Original']);
  } finally {
    release.resolve(); releaseDrain.resolve();
    try { await quitting; } finally { process.exit = exit; }
  }
});

test('accepted TUI reload cannot start a held prompt while an earlier shutdown handler waits', async t => {
  const preparing = deferred(), releasePrompt = deferred(), shuttingDown = deferred(), releaseShutdown = deferred();
  t.after(() => { releasePrompt.resolve(); releaseShutdown.resolve(); });
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await releasePrompt.promise; }
  })], true, [pi => pi.on('session_shutdown', async event => {
    if (event.reason === 'reload') { shuttingDown.resolve(); await releaseShutdown.promise; }
  })]);
  const first = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.setText('Draft');
  h.app.editor.handleInput('\x1b');
  await preparing.promise;
  assert.equal(h.session.isStreaming, false);
  h.app.ui.hideOverlay = () => {};
  h.app.clearExtensionTerminalInputListeners = h.app.setExtensionFooter = h.app.setExtensionHeader = h.app.clearExtensionWidgets = () => {};
  h.app.footerDataProvider = { clearExtensionStatuses() {} };
  h.app.footer = { invalidate() {} };
  h.app.updateTerminalTitle = h.app.setWorkingIndicator = h.app.setHiddenThinkingLabel = () => {};
  h.app.rebuildChatFromMessages = h.app.applyRuntimeSettings = () => {};
  h.app.themeController = { applyFromSettings() {} };
  h.app.keybindings.reload = () => {};
  h.app.maybeSaveImplicitProjectTrustAfterReload = () => false;
  h.app.showStatus = h.app.showWarning = h.app.showError = (message: string) => h.notices.push(message);
  const reset = h.app.resetExtensionUI.bind(h.app);
  h.app.resetExtensionUI = () => {
    assert.ok(h.notices.some(message => /Escape Continue stopped/.test(message)), 'retirement notice precedes UI teardown and its first yield');
    reset();
  };
  h.app.setupEditorSubmitHandler();
  const reloading = h.app.defaultEditor.onSubmit('/reload');
  try {
    await Promise.race([shuttingDown.promise, reloading.then(() => { throw new Error('Reload must reach the blocked shutdown handler'); })]);
    releasePrompt.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.provider.state.callCount, 1, 'accepted reload must not start the pending handoff');
    assert.deepEqual(h.users(), ['Original']);
    assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  } finally {
    releasePrompt.resolve();
    await h.session.abort();
    releaseShutdown.resolve();
    await reloading;
    await running;
  }
  assert.ok(!h.notices.some(message => /Reload failed/.test(message)), h.notices.join('\n'));
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
});

test('direct session reload retires a held preflight before earlier async shutdown handlers', async t => {
  const preparing = deferred(), releasePrompt = deferred(), shuttingDown = deferred(), releaseShutdown = deferred();
  t.after(() => { releasePrompt.resolve(); releaseShutdown.resolve(); });
  const h = await fixture(t, [pi => pi.on('before_agent_start', async event => {
    if (event.prompt === 'Next') { preparing.resolve(); await releasePrompt.promise; }
  })], true, [pi => pi.on('session_shutdown', async event => {
    if (event.reason === 'reload') { shuttingDown.resolve(); await releaseShutdown.promise; }
  })]);
  const first = deferred();
  h.provider.setResponses([h.blocked(first), fauxAssistantMessage('Must not start')]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  await preparing.promise;
  const reloading = h.session.reload();
  try {
    await shuttingDown.promise;
    releasePrompt.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.provider.state.callCount, 1);
    assert.deepEqual(h.users(), ['Original']);
    assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
  } finally {
    releasePrompt.resolve();
    await h.session.abort();
    releaseShutdown.resolve();
    await reloading;
    await running;
  }
  assert.deepEqual(h.session.getFollowUpMessages(), ['Next']);
});

test('a rejected TUI reload leaves the pending handoff eligible to continue', async t => {
  const first = deferred(), release = deferred(), promoted = deferred();
  t.after(() => release.resolve());
  const h = await fixture(t);
  h.provider.setResponses([h.blocked(first, release), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  h.app.showWarning = (message: string) => h.notices.push(message);
  h.app.setupEditorSubmitHandler();
  await h.app.defaultEditor.onSubmit('/reload');
  assert.ok(h.notices.some(message => /Wait for the current response/.test(message)));
  release.resolve();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.provider.state.callCount, 2);
  assert.deepEqual(h.users(), ['Original', 'Next']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
});

test('a cancelled runtime replacement leaves the held handoff eligible to continue', async t => {
  const h = await fixture(t, [pi => pi.on('session_before_switch', () => ({ cancel: true }))]);
  const runtime = new AgentSessionRuntime(h.session, h.services, async () => { throw new Error('Cancelled replacement must not create a runtime'); });
  const first = deferred(), release = deferred(), promoted = deferred();
  h.provider.setResponses([h.blocked(first, release), h.blocked(promoted)]);
  const running = h.session.prompt('Original');
  await first.promise;
  await h.session.followUp('Next');
  h.app.editor.handleInput('\x1b');
  const result = await runtime.newSession();
  release.resolve();
  assert.deepEqual(result, { cancelled: true });
  await promoted.promise;
  assert.deepEqual(h.users(), ['Original', 'Next']);
  h.app.editor.handleInput('\x1b');
  await h.session.waitForIdle();
  await running;
});

test('compatibility warning remains once per session across reload', async t => {
  const h = await fixture(t);
  for (let index = 0; index < 2; index++) {
    h.app.defaultEditor.onEscape = undefined;
    await h.app.bindCurrentSessionExtensions();
    await h.session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'reload' });
  }
  assert.equal(h.notices.filter(message => /unsupported Pi internals/.test(message)).length, 1);
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
