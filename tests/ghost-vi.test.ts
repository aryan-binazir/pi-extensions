import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CustomEditor, InteractiveMode } from '@earendil-works/pi-coding-agent';
import { Container, stripTerminalSequences } from '@earendil-works/pi-tui';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { withPi } from './pi-session.ts';
import { editor, keys } from '../extensions/vi-mode/test-support.ts';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

initTheme('dark', false);
const ghostPath = process.env.PI_GHOST_TEST_ENTRYPOINT;
const localExtensions = ['vi-mode', 'prompt-stash', 'escape-continue'].map(name =>
  fileURLToPath(new URL(`../extensions/${name}/index.ts`, import.meta.url)));

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(condition(), 'Ghost completion reached the expected state');
}

for (const order of ['ghost first', 'ghost last']) test(`installed Ghost retains Vi, stash, and late-response cancellation with ${order}`, { skip: !ghostPath }, async t => {
  const env = {
    PI_GHOST_PROVIDER: 'pi', PI_GHOST_MODEL: 'pi-test/faux-1', PI_GHOST_DEBOUNCE_MS: '10',
    PI_GHOST_MIN_CONFIDENCE: '0', PI_GHOST_PROVISIONAL: 'off', PI_GHOST_PROFILE: 'off', PI_GHOST_TURN_PREFETCH: 'off',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const extensions = order === 'ghost first' ? [ghostPath!, ...localExtensions] : [...localExtensions, ghostPath!];
  let app: any;
  await withPi({ settings: { extensions }, responses: [fauxAssistantMessage('compatibility')], bind(session) {
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
  } }, async fixture => {
    await app.bindCurrentSessionExtensions();
    const e = app.editor;
    const screen = () => stripTerminalSequences(e.render(100).join('\n'));
    assert.equal(typeof e.getDiagnostics, 'function', 'the original Ghost editor is active');
    keys(e, 'Please verify the ');
    await waitFor(() => e.getDiagnostics().ghostShown);
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

    fixture.provider.appendResponses([fauxAssistantMessage('synthetic words')]);
    e.setText('');
    keys(e, 'iContinue with ');
    await waitFor(() => e.getDiagnostics().ghostShown);
    e.handleInput('\x1b[1;5C');
    assert.match(e.getText(), /^Continue with synthetic\s?$/);
    e.handleInput('\x1b[1;5C');
    assert.equal(e.getText(), 'Continue with synthetic words');
    e.handleInput('\x1b');

    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    fixture.provider.appendResponses([async () => { await pending; return fauxAssistantMessage('LATE_SYNTHETIC_RESPONSE'); }]);
    const callsBeforeLateResponse = fixture.provider.state.callCount;
    e.setText('');
    keys(e, 'iPlease check the late ');
    await waitFor(() => fixture.provider.state.callCount === callsBeforeLateResponse + 1);
    e.handleInput('\x1b');
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(e.getDiagnostics().ghostShown, false);
    assert.doesNotMatch(screen(), /LATE_SYNTHETIC_RESPONSE/);
    assert.match(screen(), /NORMAL/);

    e.setText('');
    keys(e, 'i');
    const payload = 'synthetic paste 😀\t\n'.repeat(100);
    e.handleInput('\x1b[200~' + payload + '\x1b[201~');
    assert.match(e.getText(), /\[paste #/);
    assert.equal(e.getExpandedText(), payload);
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
