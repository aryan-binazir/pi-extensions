import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, visibleWidth, type Component, type OverlayOptions, type Terminal } from '@earendil-works/pi-tui';
import { withPi } from '../../tests/pi-session.ts';
import threadHeader, { sanitizeName } from './index.ts';

type Factory = Parameters<ExtensionUIContext['setHeader']>[0];
function render(factory: Factory, width = 80) {
  assert.ok(factory);
  let overlay!: Component;
  const component = factory({
    showOverlay: (content: Component, options: OverlayOptions) => {
      assert.deepEqual(options, { row: 0, col: 0, width: '100%', maxHeight: 1, nonCapturing: true });
      overlay = content;
      return { hide() {} };
    },
    requestRender() {},
  } as any, { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` } as any);
  component.invalidate();
  assert.deepEqual(component.render(width), [], 'the scrolling header no longer contains the title');
  return overlay.render(width);
}

function harness(mode = 'tui') {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void>();
  const headers: Factory[] = [];
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const notices: string[] = [];
  let name: string | undefined = 'original';
  const ctx = { mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getSessionName: () => name },
    ui: { setHeader: (factory: Factory) => headers.push(factory),
      theme: { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m` },
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionContext;
  threadHeader({ on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  return { headers, notices, command: (args: string) => commands.get('thread-header')!.handler(args, ctx),
    setName: (value: string | undefined) => { name = value; },
    emit: (type: string, data = {}) => handlers.get(type)!({ type, ...data }, ctx),
    line: (width = 80) => stripVTControlCharacters(render(headers.at(-1), width)[0]).trimEnd(),
  };
}

test('startup, immediate rename and clear, replacement, and idempotent native-header restoration', () => {
  const h = harness();
  assert.equal(h.headers.length, 0);
  h.emit('session_shutdown');
  assert.equal(h.headers.length, 0);
  h.emit('session_start');
  assert.equal(h.line(), 'π · original');
  h.emit('session_info_changed', { name: 'hey' });
  assert.equal(h.line(), 'π · hey');
  h.emit('session_info_changed', { name: undefined });
  assert.equal(h.line(), 'π · Unnamed thread', 'clear must not read the stale session name');
  h.setName('replacement');
  h.emit('session_start', { reason: 'resume' });
  assert.equal(h.line(), 'π · replacement');
  h.emit('session_shutdown');
  assert.equal(h.headers.at(-1), undefined);
  const count = h.headers.length;
  h.emit('session_shutdown');
  assert.equal(h.headers.length, count);
  h.setName(undefined);
  h.emit('session_start', { reason: 'new' });
  assert.equal(h.line(), 'π · Unnamed thread');
});

for (const mode of ['rpc', 'json', 'print']) {
  test(`${mode} never takes a UI slot`, () => {
    const h = harness(mode);
    h.emit('session_start');
    h.emit('session_info_changed', { name: 'hey' });
    h.emit('session_shutdown');
    assert.deepEqual(h.headers, []);
  });
}

test('on/off removes the overlay owner and reattaches it with the current session name', async () => {
  const h = harness();
  h.emit('session_start');
  assert.equal(h.line(), 'π · original');
  await h.command('off');
  assert.equal(h.headers.at(-1), undefined);
  const count = h.headers.length;
  h.emit('session_start');
  h.emit('session_info_changed', { name: 'while disabled' });
  assert.equal(h.headers.length, count);
  h.setName('current thread');
  await h.command('on');
  assert.equal(h.line(), 'π · current thread');
  await h.command('invalid');
  assert.deepEqual(h.notices, ['Usage: /thread-header [on|off]']);
  await h.command('');
  assert.equal(h.headers.at(-1), undefined);
  await h.command('');
  assert.equal(h.line(), 'π · current thread');
});

test('names are single-line plain text without terminal controls or bidi overrides', () => {
  assert.equal(sanitizeName('\x1b[31mhey\x1b[0m\n\tthere\x07\u202e'), 'hey there');
  assert.equal(sanitizeName('\x1b]0;evil title\x07hello'), 'hello');
  assert.equal(sanitizeName('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(sanitizeName(' \t\n\x00'), 'Unnamed thread');
  assert.equal(sanitizeName('你好 👩‍💻 é'), '你好 👩‍💻 é');
  assert.equal(sanitizeName('safe\x1b]52;c;clipboard'), 'safe');
  assert.equal(sanitizeName('\x1bPpayload\x1b\\safe'), 'safe');
  assert.equal(sanitizeName('\u009d0;title\u009csafe'), 'safe');
});

test('header fits narrow terminal columns, Unicode graphemes, ANSI styling, and resize', () => {
  const h = harness();
  h.emit('session_start');
  h.emit('session_info_changed', { name: '\x1b[31m你好 👩‍💻 é long title\x1b[0m' });
  for (let width = 0; width < 40; width++) {
    const lines = render(h.headers.at(-1), width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, `width ${width}: ${JSON.stringify(lines)}`);
    assert.doesNotMatch(stripVTControlCharacters(lines[0]), /[\r\n\x1b\ufffd]/u);
  }
  assert.equal(h.line(0), '');
  assert.equal(h.line(80), 'π · 你好 👩‍💻 é long title');
});

test('native overlays keep the header visible over long transcripts without stealing editor or dialog focus', () => {
  class Viewport extends TuiMainScreen {
    override requestRender() {}
    visible(lines: string[], width: number, height: number) {
      return this.compositeOverlays(lines, width, height).slice(-height).map(line => stripVTControlCharacters(line));
    }
  }
  const tui = new Viewport({ columns: 40, rows: 10, hideCursor() {} } as Terminal);
  const editor = { focused: false, render: () => ['draft'], invalidate() {} };
  tui.addChild(editor);
  tui.setFocus(editor);
  const h = harness();
  h.emit('session_start');
  const header = h.headers.at(-1)!(tui, { fg: (_color: string, text: string) => text } as any);
  const transcript = Array.from({ length: 120 }, (_, index) => `Transcript line ${index}`);
  try {
    assert.equal(editor.focused, true);
    assert.deepEqual(header.render(40), []);
    assert.equal(tui.visible(transcript, 40, 10)[0].trimEnd(), 'π · original');
    h.emit('session_info_changed', { name: 'hey' });
    assert.equal(h.headers.length, 1, 'renames update the existing overlay instead of raising it above dialogs');
    assert.equal(tui.visible(transcript, 40, 10)[0].trimEnd(), 'π · hey');
    assert.equal(tui.visible(transcript, 12, 5)[0].trimEnd(), 'π · hey');
    const dialog = { focused: false, render: () => ['Dialog'], invalidate() {} };
    const handle = tui.showOverlay(dialog, { row: 0, width: '100%', maxHeight: 1 });
    h.emit('session_info_changed', { name: 'renamed' });
    assert.equal(dialog.focused, true);
    assert.ok(tui.visible(transcript, 40, 10)[0].startsWith('Dialog'));
    handle.hide();
    assert.equal(editor.focused, true);
    assert.equal(tui.visible(transcript, 40, 10)[0].trimEnd(), 'π · renamed');
  } finally {
    header.dispose?.();
  }
  assert.equal(tui.hasOverlay(), false, 'disposing the header removes its passive overlay');
});

test('real Pi session name API updates the header and session replacement resets it', async () => {
  const headers: Factory[] = [];
  await withPi({ extensions: [threadHeader], bind: session => ({ mode: 'tui', uiContext: {
    ...session.extensionRunner.createContext().ui,
    theme: { fg: (_color: string, text: string) => text } as any,
    setHeader: factory => headers.push(factory),
  } }) }, async fixture => {
    const line = () => stripVTControlCharacters(render(headers.at(-1))[0]).trimEnd();
    assert.equal(line(), 'π · Unnamed thread');
    fixture.session.setSessionName('hey');
    assert.equal(line(), 'π · hey');
    fixture.session.setSessionName('');
    assert.equal(line(), 'π · Unnamed thread');
    fixture.session.setSessionName('old thread');
    await fixture.runtime.newSession();
    assert.ok(headers.includes(undefined), 'replacement restores the native header before rebinding');
    assert.equal(line(), 'π · Unnamed thread');
  });
  assert.equal(headers.at(-1), undefined);
});
