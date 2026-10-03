import test from "node:test";
import assert from 'node:assert/strict';
import { CustomEditor, createEventBus } from '@earendil-works/pi-coding-agent';
import { Container } from '@earendil-works/pi-tui';
import { InteractiveMode } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js';
import { initTheme } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { editor, keys } from '../extensions/vi-mode/test-support.ts';
import viMode from '../extensions/vi-mode/index.ts';
import stash from '../extensions/prompt-stash/index.ts';
import questionnaire from '../extensions/questionnaire/index.ts';
import effort from '../extensions/effort/index.ts';
import btw from '../extensions/btw/index.ts';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ThinkingSelectorComponent } from '../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/thinking-selector.js';
initTheme('dark', false);
const payload = 'SYNTHETIC_PAYLOAD 😀\t\r\n'.repeat(100);
const paste = (e: any) => e.handleInput('\x1b[200~' + payload + '\x1b[201~');
function host(stashFirst: boolean | "stock" = false) {
  const app: any = Object.create(InteractiveMode.prototype);
  app.defaultEditor = editor(CustomEditor);
  app.editor = app.defaultEditor;
  app.keybindings = new KeybindingsManager();
  app.editorContainer = new Container();
  app.statusContainer = new Container();
  app.disposeActiveSelector = () => {};
  let overlay: any;
  let showHardwareCursor = false;
  app.ui = {
    terminal: {rows: 30, columns: 100, write() {}},
    requestRender() {},
    getShowHardwareCursor: () => showHardwareCursor,
    setShowHardwareCursor: (show: boolean) => { showHardwareCursor = show; },
    setFocus() {},
    showOverlay(c: any) {overlay = c; return {};},
    hideOverlay() {overlay = undefined;},
  };
  const hooks = new Map<string, any[]>(), shortcuts = new Map(), commands = new Map(), tools = new Map();
  const api: any = {
    events: createEventBus(),
    on(name: string, fn: any) {hooks.set(name, [...hooks.get(name) ?? [], fn]);},
    registerShortcut(n: string, s: any) {shortcuts.set(n, s);},
    registerCommand(n: string, c: any) {commands.set(n, c);},
    registerTool(t: any) {tools.set(t.name, t);},
    getThinkingLevel() {return 'off';},
  };
  const ctx: any = {
    mode: 'tui',
    hasUI: true,
    model: {id: 'synthetic', provider: 'openai', reasoning: false},
    ui: {
      getEditorText: () => app.editor.getExpandedText(),
      setEditorText: (s: string) => app.editor.setText(s),
      pasteToEditor: (s: string) => app.editor.handleInput('\x1b[200~' + s + '\x1b[201~'),
      getEditorComponent: () => app.editorComponentFactory,
      setEditorComponent: (f: any) => app.setCustomEditorComponent(f),
      setStatus() {},
      notify() {},
      custom: (f: any, options: any) => app.showExtensionCustom(f, options),
    },
  };
  const emit = (n: string) => {for (const fn of hooks.get(n) ?? []) fn({}, ctx);};
  if (stashFirst !== "stock") {
    if (stashFirst) { stash(api); viMode(api); } else { viMode(api); stash(api); }
  }
  emit('session_start'); emit('resources_discover');
  return {
    app, api, ctx, emit, shortcuts, commands, tools,
    closeDialog() {
      const c = overlay ?? app.editorContainer.children[0];
      assert.ok(c?.handleInput, 'real dialog component mounted');
      c.handleInput('\x1b');
    },
  };
}
for (const action of ['complete', 'escape', 'ctrl+c', 'abort', 'shutdown', 'factory throw', 'factory rejection', 'early abort'])
  test(`questionnaire ${action} preserves and submits the expanded stock-editor draft`, async () => {
    const h = host("stock");
    const first = 'SYNTHETIC DRAFT 😀 '.repeat(100);
    const second = 'short line\n'.repeat(12);
    const draft = 'typed prefix ' + first + ' between ' + second + ' typed suffix';
    h.app.editor.handleInput('typed prefix ');
    h.app.editor.handleInput('\x1b[200~' + first + '\x1b[201~');
    h.app.editor.handleInput(' between ');
    h.app.editor.handleInput('\x1b[200~' + second + '\x1b[201~');
    h.app.editor.handleInput(' typed suffix');
    assert.equal(h.app.editor.getExpandedText(), draft);
    assert.match(h.app.editor.getText(), /\[paste #/);
    questionnaire(h.api);
    const controller = new AbortController();
    const ui = h.ctx.ui;
    let live = true;
    Object.defineProperty(h.ctx, 'ui', {
      get() { assert.ok(live, 'A retired context cannot access UI'); return ui; },
    });
    const emit = h.api.events.emit.bind(h.api.events);
    h.api.events.emit = (channel: string, data: unknown) => {
      assert.ok(live, 'A retired runtime cannot emit events');
      emit(channel, data);
    };
    const waiting: boolean[] = [];
    h.api.events.on('pi-interactive:questionnaire-waiting', (event: any) => waiting.push(event.waiting));
    if (action.startsWith('factory') || action === 'early abort') {
      ui.custom = (factory: any, options: any) => h.app.showExtensionCustom((...args: any[]) => {
        const component = factory(...args);
        if (action === 'factory throw') throw new Error('Synthetic factory failure');
        if (action === 'factory rejection') return Promise.reject(new Error('Synthetic factory failure'));
        controller.abort();
        return component;
      }, options);
    }
    const pending = h.tools.get('questionnaire').execute('synthetic', {
      questions: [{id: 'a', prompt: 'Synthetic?', options: [{label: 'Yes', value: 'yes'}]}],
    }, controller.signal, undefined, h.ctx);
    await new Promise(r => setImmediate(r));
    if (action === 'complete') h.app.editorContainer.children[0].handleInput('\r');
    if (action === 'escape') h.closeDialog();
    if (action === 'ctrl+c') h.app.editorContainer.children[0].handleInput('\x03');
    if (action === 'abort') controller.abort();
    if (action === 'shutdown') {
      h.emit('session_shutdown');
      assert.equal(h.app.editor.getExpandedText(), draft, 'Restore before retiring the context');
      live = false;
    }
    const result = await pending;
    assert.equal(result.details.cancelled, action !== 'complete');
    if (action.startsWith('factory')) assert.match(result.details.reason, /Synthetic factory failure/);
    assert.deepEqual(waiting, [true, false]);
    assert.equal(h.app.editor.getExpandedText(), draft);
    assert.match(h.app.editor.getText(), /\[paste #/);
    let submitted = '';
    h.app.editor.onSubmit = (text: string) => { submitted = text; };
    h.app.editor.handleInput('\r');
    assert.equal(submitted, draft);
  });

for (const fallback of ['missing', 'throws', 'ineffective', 'control bytes'])
  test(`stock questionnaire restores exact draft when paste is ${fallback}`, async () => {
    const h = host("stock");
    const text = 'SYNTHETIC DRAFT '.repeat(100);
    const prefix = fallback === 'control bytes' ? 'typed\x01\x1b[201~suffix ' : 'typed prefix ';
    const draft = prefix + text + ' typed suffix';
    h.app.editor.setText(prefix);
    h.app.editor.handleInput('\x1b[200~' + text + '\x1b[201~');
    h.app.editor.handleInput(' typed suffix');
    if (fallback === 'missing') h.ctx.ui.pasteToEditor = undefined;
    if (fallback === 'throws') h.ctx.ui.pasteToEditor = () => { throw new Error('Synthetic paste failure'); };
    if (fallback === 'ineffective') h.ctx.ui.pasteToEditor = () => {};
    questionnaire(h.api);
    const pending = h.tools.get('questionnaire').execute('synthetic', {
      questions: [{id: 'a', prompt: 'Synthetic?', options: [{label: 'Yes', value: 'yes'}]}],
    }, undefined, undefined, h.ctx);
    await new Promise(r => setImmediate(r));
    h.closeDialog();
    assert.equal((await pending).details.cancelled, true);
    assert.equal(h.app.editor.getExpandedText(), draft);
  });

test('shutdown restoration cannot overwrite a new draft when a factory later rejects', async () => {
  const h = host("stock");
  const draft = 'SYNTHETIC DRAFT '.repeat(100);
  h.app.editor.handleInput('\x1b[200~' + draft + '\x1b[201~');
  questionnaire(h.api);
  let rejectFactory: (error: Error) => void = () => {};
  h.ctx.ui.custom = (factory: any, options: any) => h.app.showExtensionCustom((...args: any[]) => {
    factory(...args);
    return new Promise((_resolve, reject) => { rejectFactory = reject; });
  }, options);
  const pending = h.tools.get('questionnaire').execute('synthetic', {
    questions: [{id: 'a', prompt: 'Synthetic?', options: [{label: 'Yes', value: 'yes'}]}],
  }, undefined, undefined, h.ctx);
  h.emit('session_shutdown');
  assert.equal(h.app.editor.getExpandedText(), draft);
  Object.defineProperty(h.ctx, 'ui', { get() { throw new Error('Retired context'); } });
  h.api.events.emit = () => { throw new Error('Retired runtime'); };
  h.app.editor.setText('new session draft');
  rejectFactory(new Error('Delayed factory failure'));
  assert.equal((await pending).details.cancelled, true);
  await new Promise(r => setImmediate(r));
  assert.equal(h.app.editor.getExpandedText(), 'new session draft');
});

for (const draft of ['', 'typed draft']) test(`stock questionnaire leaves ${draft ? 'typed' : 'empty'} drafts unchanged`, async () => {
  const h = host("stock");
  h.app.editor.setText(draft);
  h.ctx.ui.setEditorText = () => { throw new Error('Unchanged draft must not be rewritten'); };
  questionnaire(h.api);
  const pending = h.tools.get('questionnaire').execute('synthetic', {
    questions: [{id: 'a', prompt: 'Synthetic?', options: [{label: 'Yes', value: 'yes'}]}],
  }, undefined, undefined, h.ctx);
  await new Promise(r => setImmediate(r));
  h.closeDialog();
  assert.equal((await pending).details.cancelled, true);
  assert.equal(h.app.editor.getExpandedText(), draft);
});

test('real InteractiveMode editor swap preserves visible marker and raw payload', () => {
  const h = host(); paste(h.app.editor); const visible = h.app.editor.getText();
  h.app.setCustomEditorComponent(undefined);
  assert.equal(h.app.editor.getExpandedText(), payload);
  assert.equal(h.app.editor.getText(), visible);
  h.emit('session_shutdown'); h.emit('session_start');
  assert.equal(h.app.editor.getExpandedText(), payload);
  assert.match(h.app.editor.getText(), /\[paste #/);
  h.emit('session_shutdown');
});
for (const dialog of ['questionnaire', 'effort']) test(`real ${dialog} callback through InteractiveMode.showExtensionCustom preserves draft`, async () => {
  const h = host(); paste(h.app.editor); const visible = h.app.editor.getText();
  let pending: Promise<any>;
  if (dialog === 'questionnaire') { questionnaire(h.api); pending = h.tools.get(dialog).execute('synthetic', {questions: [{id: 'a', prompt: 'Synthetic?', options: [{label: 'Yes', value: 'yes'}]}]}, undefined, undefined, h.ctx); }
  else { effort(h.api); pending = h.commands.get(dialog).handler('', h.ctx); }
  await new Promise(r => setTimeout(r, 0)); h.closeDialog(); await pending;
  assert.equal(h.app.editor.getExpandedText(), payload); assert.equal(h.app.editor.getText(), visible);
  h.emit('session_shutdown');
});
test('inline custom UI factory failure preserves pasted draft', async () => {
  const h = host(); paste(h.app.editor); const visible = h.app.editor.getText();
  try {
    await assert.rejects(h.app.showExtensionCustom(() => { throw new Error('synthetic failure'); }), /synthetic failure/);
    assert.equal(h.app.editor.getText(), visible);
    assert.equal(h.app.editor.getExpandedText(), payload);
  } finally {
    h.emit('session_shutdown');
  }
});
test('inline custom UI synchronous completion preserves pasted draft', async () => {
  const h = host(); paste(h.app.editor);
  try {
    await h.app.showExtensionCustom((_tui: any, _theme: any, _keys: any, done: any) => {
      done(undefined);
      return new Container();
    });
    assert.equal(h.app.editor.getExpandedText(), payload);
  } finally {
    h.emit('session_shutdown');
  }
});
test('real extension event wiring preserves typed and mixed drafts through stash', () => {
  const h = host();
  const typed = 'editable prose '.repeat(90);
  keys(h.app.editor, typed);
  assert.equal(h.app.editor.getText(), typed);
  const toggle = () => h.app.editor.handleInput('\x13');
  toggle(); toggle(); assert.equal(h.app.editor.getText(), typed);
  paste(h.app.editor); keys(h.app.editor, ' suffix');
  const visible = h.app.editor.getText(), expanded = h.app.editor.getExpandedText();
  toggle(); toggle(); assert.equal(h.app.editor.getText(), visible); assert.equal(h.app.editor.getExpandedText(), expanded);
  h.emit('session_shutdown');
});
test('stock editor handoff normalizes inline CR and tabs for safe rendering', () => {
  const h = host();
  h.app.editor.handleInput('\x1b[200~alpha\r\nbeta\tgamma\x1b[201~');
  h.app.setCustomEditorComponent(undefined);
  assert.equal(h.app.editor.getText(), 'alpha\nbeta    gamma');
  const frame = h.app.editor.render(60).join('\n');
  assert.ok(!frame.includes('\r') && !frame.includes('\t'));
  h.emit('session_shutdown');
});
test('stash restoration notifies Pi of the restored draft', () => {
  const h = host(); let changed = '';
  h.app.editor.onChange = (text: string) => { changed = text; };
  keys(h.app.editor, '!echo synthetic');
  const toggle = () => h.app.editor.handleInput('\x13');
  toggle(); assert.equal(changed, '');
  toggle(); assert.equal(changed, '!echo synthetic');
  h.emit('session_shutdown');
});

for (const stashFirst of [false, true]) test(`stash composes with vi in load order ${stashFirst ? 'stash first' : 'vi first'}`, () => {
  const h = host(stashFirst);
  assert.equal(h.shortcuts.size, 0);
  paste(h.app.editor);
  const visible = h.app.editor.getText();
  const enterNormalMode = () => h.app.editor.handleInput('\x1b');
  enterNormalMode();
  h.app.editor.handleInput('\x13'); assert.equal(h.app.editor.getText(), '');
  h.app.editor.handleInput('\x13'); assert.equal(h.app.editor.getText(), visible);
  assert.equal(h.app.editor.getExpandedText(), payload);
  h.app.editor.handleInput('0'); h.app.editor.handleInput('x');
  assert.equal(h.app.editor.getText(), '');
  h.app.editor.handleInput('u'); assert.equal(h.app.editor.getExpandedText(), payload);
  h.emit('session_shutdown'); h.emit('session_start'); h.emit('resources_discover');
  h.app.editor.setText('new draft'); h.app.editor.handleInput('\x13');
  assert.equal(h.app.editor.getText(), '');
  h.emit('session_shutdown');
});

test('focused Pi thinking selector keeps Ctrl+S save; main editor alone stashes', async () => {
  const h = host();
  // Use Pi's own TUI module even when npm keeps a nested copy.
  const requirePi = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { getKeybindings, setKeybindings } = await import(pathToFileURL(requirePi.resolve('@earendil-works/pi-tui')).href);
  const previousKeys = getKeybindings();
  setKeybindings(new KeybindingsManager());
  h.app.editor.setText('draft behind selector');
  let saved = '';
  const pending = h.app.showExtensionCustom((_tui: any, _theme: any, _kb: any, done: any) =>
    new ThinkingSelectorComponent('medium', ['low', 'medium', 'high'], done, () => done(undefined), level => { saved = level; done(level); }));
  await new Promise(resolve => setTimeout(resolve, 0));
  h.app.editorContainer.children[0].handleInput('\x13');
  await pending;
  setKeybindings(previousKeys);
  assert.equal(saved, 'medium');
  assert.equal(h.app.editor.getText(), 'draft behind selector');
  h.app.editor.handleInput('\x13'); assert.equal(h.app.editor.getText(), '');
  h.app.editor.handleInput('\x13'); assert.equal(h.app.editor.getText(), 'draft behind selector');
  h.emit('session_shutdown');
});


test('real btw overlay through InteractiveMode.showExtensionCustom preserves the pasted draft', async () => {
  const h = host(); paste(h.app.editor); const visible = h.app.editor.getText();
  Object.assign(h.ctx, {sessionManager: {getBranch: () => []}, getSystemPrompt: () => '', modelRegistry: {getApiKeyAndHeaders: async () => ({ok: false, error: 'synthetic'})}});
  btw(h.api);
  const pending = h.commands.get('btw').handler('', h.ctx);
  await new Promise(r => setTimeout(r, 0)); h.closeDialog(); await pending;
  assert.equal(h.app.editor.getExpandedText(), payload); assert.equal(h.app.editor.getText(), visible);
  h.emit('session_shutdown');
});
