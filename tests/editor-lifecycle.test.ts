import test from "node:test";
import assert from 'node:assert/strict';
import { CustomEditor, createEventBus } from '@earendil-works/pi-coding-agent';
import { Container, CURSOR_MARKER, isFocusable, stripTerminalSequences, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
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
for (const shape of ['characters', 'lines']) {
  for (const completion of ['async close', 'async rejection', 'sync close']) {
    test(`inline custom UI restores mixed drafts over the ${shape} limit after ${completion}`, async () => {
      const h = host();
      const first = 'PAYLOAD\t\r\n'.repeat(20);
      const second = 'literal [paste #1]\t\r\n'.repeat(20);
      const typed = shape === 'characters' ? 'typed'.repeat(220) : '\nline'.repeat(11);
      const source = h.app.editor;
      source.handleInput(`\x1b[200~${first}\x1b[201~`);
      source.handleInput(`\x1b[200~${second}\x1b[201~`);
      source.insertTextAtCursor('\t\r' + typed);
      const visible = source.getText();
      const expanded = first + second + '\t\r' + typed;
      assert.equal(source.getExpandedText(), expanded);
      assert.ok(shape === 'characters' ? visible.length > 1000 : visible.split('\n').length > 10);
      const setText = source.setText;
      let changed = '';
      source.onChange = (text: string) => { changed = text; };
      try {
        const pending = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) => {
          if (completion === 'async rejection') return Promise.reject(new Error('synthetic failure'));
          if (completion === 'sync close') done('closed');
          return Object.assign(new Container(), {handleInput: () => done('closed')});
        });
        if (completion === 'async rejection') {
          await assert.rejects(pending, /synthetic failure/);
        } else {
          if (completion === 'async close') {
            await new Promise(resolve => setTimeout(resolve, 0));
            h.closeDialog();
          }
          assert.equal(await pending, 'closed');
        }
        assert.equal(h.app.editor, source);
        assert.equal(source.setText, setText);
        assert.equal(source.getText(), visible);
        assert.equal(source.getExpandedText(), expanded);
        assert.equal(changed, visible);
        let submitted = '';
        source.onSubmit = (text: string) => { submitted = text; };
        source.handleInput('\r');
        assert.equal(submitted, expanded.replace(/\r/g, '').trim());
      } finally {
        h.emit('session_shutdown');
      }
    });
  }
}
for (const timing of ['after close', 'during dispose']) {
  test(`inline custom UI preserves a newer draft written ${timing}`, async () => {
    const h = host();
    paste(h.app.editor);
    keys(h.app.editor, 'typed'.repeat(220));
    const source = h.app.editor;
    const setText = source.setText;
    try {
      const pending = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) =>
        Object.assign(new Container(), {
          handleInput() {
            done(undefined);
            if (timing === 'after close') source.setText('replacement draft');
          },
          dispose() {
            if (timing === 'during dispose') source.setText('replacement draft');
          },
        }));
      await new Promise(resolve => setTimeout(resolve, 0));
      h.closeDialog();
      await pending;
      assert.equal(source.getText(), 'replacement draft');
      assert.equal(source.getExpandedText(), 'replacement draft');
      assert.equal(source.setText, setText);
    } finally {
      h.emit('session_shutdown');
    }
  });
}
for (const order of ['first then second', 'second then first']) {
  for (const varied of [false, true]) {
    test(`overlapping inline custom UI preserves ${varied ? 'distinct' : 'identical'} drafts when closing ${order}`, async () => {
      const h = host();
      paste(h.app.editor);
      keys(h.app.editor, 'typed'.repeat(220));
      const source = h.app.editor;
      const visible = source.getText();
      const expanded = payload + 'typed'.repeat(220);
      const setText = source.setText;
      let closeFirst = () => {}, closeSecond = () => {};
      try {
        const first = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) => {
          closeFirst = () => done(undefined);
          return new Container();
        });
        if (varied) keys(source, '!');
        const secondVisible = source.getText();
        const secondExpanded = expanded + (varied ? '!' : '');
        const second = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) => {
          closeSecond = () => done(undefined);
          return new Container();
        });
        await new Promise(resolve => setTimeout(resolve, 0));
        const dialogs = order === 'first then second'
          ? [[closeFirst, first, visible, expanded], [closeSecond, second, secondVisible, secondExpanded]] as const
          : [[closeSecond, second, secondVisible, secondExpanded], [closeFirst, first, visible, expanded]] as const;
        let finalExpanded = '';
        for (const [close, pending, savedVisible, savedExpanded] of dialogs) {
          close();
          await pending;
          assert.equal(source.getText(), savedVisible);
          assert.equal(source.getExpandedText(), savedExpanded);
          finalExpanded = savedExpanded;
        }
        assert.equal(source.setText, setText);
        let submitted = '';
        source.onSubmit = (text: string) => { submitted = text; };
        source.handleInput('\r');
        assert.equal(submitted, finalExpanded.replace(/\r/g, '').trim());
      } finally {
        h.emit('session_shutdown');
      }
    });
  }
}
for (const order of ['first then second', 'second then first']) {
  test(`overlapping inline UI keeps identical markers with different payloads when closing ${order}`, async () => {
    const h = host();
    const source = h.app.editor;
    const getText = source.getText;
    const typed = 'typed'.repeat(220);
    const firstPayload = 'FIRST__\n'.repeat(20);
    const secondPayload = 'SECOND_\n'.repeat(20);
    let closeFirst = () => {}, closeSecond = () => {};
    try {
      source.handleInput(`\x1b[200~${firstPayload}\x1b[201~`);
      keys(source, typed);
      const firstVisible = source.getText();
      const first = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) => {
        closeFirst = () => done(undefined);
        return new Container();
      });
      h.ctx.ui.setEditorText('');
      source.handleInput(`\x1b[200~${secondPayload}\x1b[201~`);
      keys(source, typed);
      const secondVisible = source.getText();
      assert.equal(secondVisible, firstVisible);
      const second = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) => {
        closeSecond = () => done(undefined);
        return new Container();
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      const dialogs = order === 'first then second'
        ? [[closeFirst, first, firstPayload], [closeSecond, second, secondPayload]] as const
        : [[closeSecond, second, secondPayload], [closeFirst, first, firstPayload]] as const;
      for (const [close, pending, savedPayload] of dialogs) {
        close();
        await pending;
        assert.equal(source.getText(), firstVisible);
        assert.equal(source.getExpandedText(), savedPayload + typed);
        assert.equal(source.getText, getText);
        let submitted = '';
        source.onSubmit = (text: string) => { submitted = text; };
        source.handleInput('\r');
        assert.equal(submitted, savedPayload + typed);
      }
    } finally {
      h.emit('session_shutdown');
    }
  });
}
test('inline custom UI leaves a replacement editor owned by Pi', async () => {
  const h = host();
  paste(h.app.editor);
  keys(h.app.editor, 'typed'.repeat(220));
  const source = h.app.editor;
  const visible = source.getText();
  const expanded = source.getExpandedText();
  const setText = source.setText;
  try {
    const pending = h.ctx.ui.custom((_tui: any, _theme: any, _keys: any, done: any) =>
      Object.assign(new Container(), {handleInput: () => done(undefined)}));
    await new Promise(resolve => setTimeout(resolve, 0));
    const component = h.app.editorContainer.children[0];
    h.ctx.ui.setEditorComponent(undefined);
    component.handleInput('\x1b');
    await pending;
    assert.equal(h.app.editor, h.app.defaultEditor);
    assert.notEqual(h.app.editor, source);
    assert.equal(source.getText(), visible);
    assert.equal(source.getExpandedText(), expanded);
    assert.equal(source.setText, setText);
    assert.equal(h.app.editor.getExpandedText(), 'SYNTHETIC_PAYLOAD 😀    \n'.repeat(100) + 'typed'.repeat(220));
  } finally {
    h.emit('session_shutdown');
  }
});
test('inline custom UI synchronous throw keeps the cursor and undo history', async () => {
  const h = host();
  keys(h.app.editor, 'typed'.repeat(220));
  keys(h.app.editor, '\x1b0x');
  const source = h.app.editor;
  const visible = source.getText();
  const cursor = source.getCursor();
  const setText = source.setText;
  try {
    await assert.rejects(h.ctx.ui.custom(() => { throw new Error('synthetic failure'); }), /synthetic failure/);
    assert.equal(source.getText(), visible);
    assert.deepEqual(source.getCursor(), cursor);
    assert.equal(source.setText, setText);
    keys(source, 'u');
    assert.equal(source.getText(), 'typed'.repeat(220));
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

for (const command of ['btw', 'side']) test(`real ${command} overlay tracks editor cursor focus`, async () => {
  const h = host("stock");
  paste(h.app.editor);
  const visible = h.app.editor.getText();
  const expanded = h.app.editor.getExpandedText();
  let input: (data: string) => void = () => { throw new Error('Terminal has not started'); };
  let cursorVisible = false;
  const terminal = {
    rows: 40, columns: 100, kittyProtocolActive: false,
    start(onInput: (data: string) => void) { input = onInput; },
    stop() {}, async drainInput() {}, write() {}, moveBy() {},
    hideCursor() { cursorVisible = false; }, showCursor() { cursorVisible = true; },
    clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {},
  } satisfies Terminal;
  const tui = new TuiMainScreen(terminal);
  h.app.ui = tui;
  h.app.editorContainer.addChild(h.app.editor);
  tui.addChild(h.app.editorContainer);
  tui.setFocus(h.app.editor);
  tui.setShowHardwareCursor(true);
  tui.start();
  Object.assign(h.ctx, {sessionManager: {getBranch: () => []}, getSystemPrompt: () => ''});
  btw(h.api);
  const pending = h.commands.get(command).handler('', h.ctx);
  try {
    await new Promise(resolve => setImmediate(resolve));
    const overlay = tui.getFocusedComponent();
    assert.ok(overlay?.handleInput);
    assert.notEqual(overlay, h.app.editor);
    input('typed question');
    input('\x1b[D');
    const frame = overlay.render(90);
    const inputLine = frame.find(line => line.includes(CURSOR_MARKER));
    assert.ok(inputLine, 'focused side editor emits a cursor marker');
    assert.equal(stripTerminalSequences(inputLine.slice(0, inputLine.indexOf(CURSOR_MARKER))), '│typed questio');
    assert.equal(frame.filter(line => line.includes(CURSOR_MARKER)).length, 1);
    tui.renderNow();
    assert.equal(cursorVisible, true, 'mounted TUI shows the hardware cursor');
    assert.ok(isFocusable(overlay));
    assert.equal(overlay.focused, true);
    tui.setFocus(h.app.editor);
    assert.equal(overlay.focused, false);
    assert.ok(overlay.render(90).every(line => !line.includes(CURSOR_MARKER)));
    tui.setFocus(overlay);
    assert.equal(overlay.focused, true);
    assert.ok(overlay.render(90).some(line => line.includes(CURSOR_MARKER)));
    input('\x1b');
    await pending;
    assert.equal(overlay.focused, false);
    assert.ok(overlay.render(90).every(line => !line.includes(CURSOR_MARKER)));
    assert.equal(tui.getFocusedComponent(), h.app.editor);
    assert.equal(h.app.editor.getText(), visible);
    assert.equal(h.app.editor.getExpandedText(), expanded);
  } finally {
    h.emit('session_shutdown');
    await pending;
    tui.stop();
  }
});
