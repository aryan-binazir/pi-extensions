import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { CustomEditor, InteractiveMode } from '@earendil-works/pi-coding-agent';
import { Container, stripTerminalSequences } from '@earendil-works/pi-tui';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { withPi } from './pi-session.ts';
import { editor, keys } from '../extensions/vi-mode/test-support.ts';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import backgroundModels from '../extensions/background-models/index.ts';

initTheme('dark', false);
const ghostPath = process.env.PI_GHOST_TEST_ENTRYPOINT ?? fileURLToPath(import.meta.resolve('pi-ghost-autocomplete'));
const localExtensions = ['vi-mode', 'prompt-stash', 'escape-continue'].map(name =>
  fileURLToPath(new URL(`../extensions/${name}/index.ts`, import.meta.url)));
const backgroundPath = fileURLToPath(new URL('../extensions/background-models/index.ts', import.meta.url));

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'Ghost completion reached the expected state');
}

for (const order of ['ghost first', 'ghost last', 'stash before vi', 'background after ghost']) test(`Ghost compatibility and background startup order: ${order}`, async t => {
  const env = {
    PI_GHOST_PROVIDER: 'pi', PI_GHOST_MODEL: 'ghost-codex-test/gpt-6-luna', PI_GHOST_DEBOUNCE_MS: '10',
    PI_GHOST_MIN_CONFIDENCE: '0', PI_GHOST_PROVISIONAL: 'off', PI_GHOST_PROFILE: 'off', PI_GHOST_TURN_PREFETCH: 'off',
  };
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PI_GHOST_')));
  for (const key of Object.keys(previous)) delete process.env[key];
  const previousPath = process.env.PATH;
  // Ghost scans the entire process report for musl, including unrelated PATH entries.
  if (previousPath !== undefined) process.env.PATH = previousPath.split(delimiter).filter(entry => !entry.includes('musl')).join(delimiter);
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('PI_GHOST_')) delete process.env[key];
    Object.assign(process.env, previous);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  });
  let networkRequests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    networkRequests++;
    throw new Error('Unexpected network request in synthetic Ghost fixture');
  });
  t.after(() => assert.equal(networkRequests, 0, 'Ghost tests use synthetic providers only'));
  const extensions = order === 'ghost first' || order === 'background after ghost' ? [ghostPath, ...localExtensions]
    : order === 'ghost last' ? [...localExtensions, ghostPath]
      : [localExtensions[1], localExtensions[0], localExtensions[2], ghostPath];
  const requests: any[] = [];
  const codex = fauxProvider({ provider: 'ghost-codex-test', api: 'openai-codex-responses', tokensPerSecond: Infinity,
    models: [{ id: 'gpt-6-luna', reasoning: true }] });
  codex.setResponses([(_context, options) => { requests.push(options); return fauxAssistantMessage('compatibility'); }]);
  const selected = order === 'background after ghost' ? extensions : [backgroundPath, ...extensions];
  let app: any;
  await withPi({ settings: { extensions: selected }, extensions: order === 'background after ghost' ? [backgroundModels] : [],
    configure({ modelRuntime }, provider) {
      modelRuntime.registerNativeProvider(codex.provider);
      return { model: provider.getModel() };
    }, bind(session) {
    app = Object.create(InteractiveMode.prototype);
    Object.defineProperty(app, 'session', { value: session });
    app.defaultEditor = editor(CustomEditor);
    app.defaultEditor.onEscape = () => {};
    app.editor = app.defaultEditor;
    app.editorContainer = new Container();
    app.statusContainer = new Container();
    app.pendingMessagesContainer = new Container();
    app.footerDataProvider = { setExtensionStatus() {} };
    app.keybindings = new KeybindingsManager();
    app.compactionQueuedMessages = [];
    app.disposeActiveSelector = () => {};
    let focused = app.editor, cursor = false;
    app.ui = {
      terminal: { rows: 30, columns: 100, write() {} }, requestRender() {},
      setFocus(component: any) {
        if (focused) focused.focused = false;
        focused = component;
        if (focused) focused.focused = true;
      },
      getFocusedComponent: () => focused,
      getShowHardwareCursor: () => cursor,
      setShowHardwareCursor(value: boolean) { cursor = value; },
    };
    app.setupAutocompleteProvider = app.setupExtensionShortcuts = app.showLoadedResources = app.showStartupNoticesIfNeeded = () => {};
    app.showExtensionError = (_path: string, error: string) => assert.fail(error);
    return { uiContext: app.createExtensionUIContext(), mode: 'tui' };
  } }, async () => {
    const e = app.editor;
    const screen = () => stripTerminalSequences(e.render(100).join('\n'));
    assert.equal(typeof e.getDiagnostics, 'function', 'the original Ghost editor is active');
    keys(e, 'Please verify the ');
    await waitFor(() => screen().includes('compatibility'));
    assert.equal(requests[0].temperature, order === 'background after ghost' ? 0 : undefined);
    assert.equal(requests[0].reasoningEffort, order === 'background after ghost' ? undefined : 'low');
    assert.match(screen(), /compatibility/);
    e.handleInput('\x1b[C');
    assert.equal(e.getText(), 'Please verify the compatibility');
    e.handleInput('\x1b');
    assert.match(screen(), /NORMAL/);
    keys(e, 'u');
    assert.equal(e.getText(), 'Please verify the ');
    e.handleInput('\x12');
    assert.equal(e.getText(), 'Please verify the compatibility');
    keys(e, '0dw');
    assert.equal(e.getText(), 'verify the compatibility');
    keys(e, 'u');
    assert.equal(e.getText(), 'Please verify the compatibility');
    e.handleInput('\x13');
    assert.equal(e.getText(), '');
    e.handleInput('\x13');
    assert.equal(e.getText(), 'Please verify the compatibility');
    keys(e, '0ve');
    assert.match(screen(), /VISUAL/);
    assert.equal(e.getDiagnostics().ghostShown, false);
    keys(e, 'x');
    assert.equal(e.getText(), ' verify the compatibility');
    keys(e, 'u');
    assert.equal(e.getText(), 'Please verify the compatibility');

    codex.appendResponses([fauxAssistantMessage('synthetic words')]);
    e.setText('');
    keys(e, 'iContinue with ');
    await waitFor(() => screen().includes('synthetic words'));
    e.handleInput('\x1b[1;5C');
    assert.match(e.getText(), /^Continue with synthetic\s?$/);
    e.handleInput('\x1b[1;5C');
    assert.equal(e.getText(), 'Continue with synthetic words');
    e.handleInput('\x1b');

    e.setText('abc');
    keys(e, 'i');
    e.forceClearGhost();
    e.ghostForText = e.getText();
    e.ghostReplaceFrom = { line: 0, start: 0, end: 3, col: 0, from: 0, startCol: 0, token: 'abc', text: 'abc' };
    e.ghostText = 'abcdef';
    e.handleInput('\x1b[C');
    assert.equal(e.getText(), 'abcdef');
    e.handleInput('\x1b');
    keys(e, 'u');
    assert.equal(e.getText(), 'abc');
    e.handleInput('\x12');
    assert.equal(e.getText(), 'abcdef');

    let release!: () => void, delivered!: () => void;
    let requestStarted = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const responseDelivered = new Promise<void>(resolve => { delivered = resolve; });
    e.setProvider({ name: 'synthetic-late', debounceMs: 10, async predict() {
      requestStarted = true;
      await pending;
      delivered();
      return 'LATE_SYNTHETIC_RESPONSE';
    } });
    e.setText('');
    keys(e, 'iPlease check the late ');
    await waitFor(() => requestStarted);
    e.handleInput('\x1b');
    release();
    await responseDelivered;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(e.getDiagnostics().ghostShown, false);
    assert.doesNotMatch(screen(), /LATE_SYNTHETIC_RESPONSE/);
    assert.match(screen(), /NORMAL/);

    e.setText('');
    keys(e, 'i');
    const payload = 'synthetic paste 😀\t\n'.repeat(100);
    e.handleInput('\x1b[200~' + payload + '\x1b[201~');
    assert.match(e.getText(), /\[paste #/);
    assert.equal(e.getExpandedText(), payload);
    keys(e, ' typed suffix');
    const rawDraft = e.getText();
    const rawPayloads = e.getExpandedText();
    e.handleInput('\x13');
    e.handleInput('\x13');
    assert.equal(e.getText(), rawDraft);
    assert.equal(e.getExpandedText(), rawPayloads);
    e.setText('');
    e.handleInput('\x1b[200~' + payload + '\x1b[201~');
    e.handleInput('\x1b');
    keys(e, 'ggdd');
    assert.equal(e.getText(), '');
    keys(e, 'u');
    assert.equal(e.getExpandedText(), payload);
    let submitted = '';
    e.onSubmit = (text: string) => { submitted = text; };
    e.handleInput('\r');
    assert.equal(submitted, payload.trim());
  });
});
