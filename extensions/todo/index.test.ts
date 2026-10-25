import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { type Component, type Terminal, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import todo from './index.js';
import { withPi, type PiFixture } from '../../tests/pi-session.ts';
import { FramedPanel } from '../framed-panel.ts';

interface Snapshot { version: 1; todos: { content: string; status: string }[]; staleTurns: number }

function runtime(initial: any[] = [], colored = false) {
  let tool: ToolDefinition;
  let branch = initial;
  let widget: string[] | undefined;
  let component: Component | undefined;
  let shortcut: string | undefined;
  let toggle: (ctx: ExtensionContext) => Promise<void> | void;
  const warnings: string[] = [];
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  todo({ registerTool: (value: ToolDefinition) => { tool = value; }, registerShortcut: (key: string, options: { handler: typeof toggle }) => { shortcut = key; toggle = options.handler; }, on: (name: string, callback: any) => hooks.set(name, callback), appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => colored ? `\x1b[34m${text}\x1b[39m` : text };
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget: (_key: string, value: ((tui: unknown, theme: unknown) => Component) | undefined) => { component = value?.(undefined, theme); widget = component?.render(40); }, notify: (message: string) => { warnings.push(message); } } } as unknown as ExtensionContext;
  const toolContext: ExtensionToolContext = {...ctx, tools: [], executeTool: async () => { throw new Error('No nested tools in this fixture'); }};
  const hook = (name: string, event: object = {}) => hooks.get(name)?.({ messages: [], ...event }, ctx);
  const turn = async () => {
    await hook('message_start', { message: { role: 'user', content: 'User prompt' } });
    const result = await hook('context_with_system');
    return result?.messages.at(-1)?.content;
  };
  return { turn, reminder: async () => (await hook('context_with_system'))?.messages.at(-1)?.content, call: (todos: object[]) => tool.execute('test', { todos }, undefined, undefined, toolContext), hook, branch: () => structuredClone(branch), switchTo: (entries: any[]) => { branch = entries; }, widget: () => widget, render: (width: number) => component?.render(width) ?? [], toggle: () => toggle(ctx), shortcut: () => shortcut, warnings: () => warnings, appended: () => branch.map((entry: any) => entry.data) };
}

test('compact summary prioritizes the current task and toggles without changing saved progress', async () => {
  const app = runtime();
  assert.equal(app.shortcut(), 'alt+t');
  await app.call([{ content: 'Done', status: 'completed' }, { content: 'Next', status: 'pending' }, { content: 'Current', status: 'in_progress' }]);
  assert.deepEqual(app.widget(), ['Todos · 1/3 · Current · alt+t']);
  const saved = app.branch();
  const reminder = await app.reminder();
  await app.toggle();
  assert.match(app.widget()!.join('\n'), /Todo — declared progress · alt\+t/);
  assert.match(app.widget()!.join('\n'), /✓ Done[\s\S]*○ Next[\s\S]*→ Current/);
  await app.hook('session_tree');
  assert.ok(app.widget()!.length > 1);
  await app.toggle();
  assert.deepEqual(app.widget(), ['Todos · 1/3 · Current · alt+t']);
  assert.deepEqual(app.branch(), saved);
  assert.equal(await app.reminder(), reminder);
  await app.call([{ content: 'Done', status: 'completed' }, { content: 'Next', status: 'pending' }]);
  assert.deepEqual(app.widget(), ['Todos · 1/2 · Next · alt+t']);
  await app.toggle();
  await app.call([{ content: 'Done', status: 'completed' }]);
  assert.equal(app.widget(), undefined);
  await app.toggle();
  assert.equal(app.widget(), undefined);
  const resumed = runtime(saved);
  await resumed.hook('session_start');
  assert.deepEqual(resumed.widget(), ['Todos · 1/3 · Current · alt+t']);
});

test('real Pi todo widget follows the shared panel and alt+t toggles both states', async () => {
  let component: Component | undefined;
  const theme = { fg: (color: 'border', text: string) => { assert.equal(color, 'border'); return `\x1b[34m${text}\x1b[39m`; } };
  const blue = (text: string) => theme.fg('border', text);
  await withPi({ extensions: [todo], bind: session => ({ mode: 'tui', uiContext: {
    ...session.extensionRunner.createContext().ui,
    setWidget: (_key, value) => { component = typeof value === 'function' ? value(undefined as any, theme as any) : undefined; },
  } }) }, async ({ session, runner }) => {
    const tasks = [{ content: 'Inspect 界 🧪', status: 'in_progress' }, { content: 'Verify long row '.repeat(8).trim(), status: 'pending' }];
    await session.getToolDefinition('todo_write')!.execute('seed', { todos: tasks }, undefined, undefined, runner.createToolContext('seed', undefined));
    const panel = new FramedPanel('alt+t', 'wrap');
    const content = { summary: `Todos · 0/2 · Inspect 界 🧪 · ${blue('alt+t')}`, title: `Todo — declared progress · ${blue('alt+t')}`, rows: [`${blue('→')} ${tasks[0].content}`, `${blue('○')} ${tasks[1].content}`] };
    const toggle = runner.getShortcuts({}).get('alt+t')!;
    assert.ok(toggle);
    assert.deepEqual(runner.getShortcutDiagnostics(), []);
    assert.deepEqual(component!.render(80), [content.summary]);
    for (const expanded of [true, false]) {
      panel.toggle();
      await toggle.handler(runner.createContext());
      for (const width of [0, 5, 6, 7, 20, 40, 80, 200]) assert.deepEqual(component!.render(width), panel.render(width, theme, content));
      assert.equal(component!.render(80).length > 1, expanded);
    }
    assert.deepEqual(session.sessionManager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: tasks, staleTurns: 0 });
  });
});

test('todo renders controls safely without changing saved progress', async () => {
  const app = runtime([], true);
  const content = 'Task\u202e\x85next';
  await app.call([{ content, status: 'pending' }]);
  const saved = app.branch();
  for (const expanded of [false, true]) {
    if (expanded) await app.toggle();
    const painted = app.render(80).join('\n');
    assert.match(painted, /Task next/);
    assert.doesNotMatch(painted, /[\u202e\x85]/);
    assert.ok(painted.includes('\x1b[34m'), 'theme ANSI survives');
  }
  assert.deepEqual(app.branch(), saved);
  assert.equal(app.appended().at(-1).todos[0].content, content);
});

test('todo updates fit narrow main-screen frames and remain visible after resizing', async t => {
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 80]) {
    await t.test(`${width} columns`, async t => {
      const app = runtime([], true);
      const logDirectory = mkdtempSync(join(tmpdir(), 'pi-todo-render-'));
      let writes = '';
      let stops = 0;
      let resize = () => {};
      const terminal = {
        columns: width, rows: 100, kittyProtocolActive: false,
        start(_onInput: (data: string) => void, onResize: () => void) { resize = onResize; },
        stop() { stops++; },
        async drainInput() {},
        write(data: string) { writes += data; },
        moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
        clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
      } satisfies Terminal;
      const screen = new TuiMainScreen(terminal, false, logDirectory);
      t.after(() => { screen.stop(); rmSync(logDirectory, { recursive: true, force: true }); });
      screen.addChild({ invalidate() {}, render: app.render });
      screen.start();
      await app.call([{ content: 'A', status: 'pending' }]);
      screen.renderNow();
      for (const expanded of [false, true]) {
        if (expanded) await app.toggle();
        for (const content of ['B', '🧪', '界', 'क्ष्म', 'क्क्क्क', 'Long task '.repeat(50)]) {
          await app.call([{ content, status: 'pending' }]);
          assert.doesNotThrow(() => screen.renderNow(), `changed frame at ${width} columns: ${content}`);
          const frame = app.render(width);
          assert.ok(frame.every(line => visibleWidth(line) <= width), `frame fits ${width} columns`);
          if (width < 6) assert.deepEqual(frame, []);
          else assert.ok(frame.length > 0);
          if (!expanded && width >= 6) assert.equal(frame.length, 1);
        }
      }
      await app.call([{ content: 'क्क्क्क', status: 'pending' }]);
      assert.deepEqual(app.render(0), []);
      terminal.columns = 40;
      writes = '';
      resize();
      screen.renderNow();
      assert.match(writes, /क्क्क्क/);
      await app.call([{ content: 'Recovered', status: 'in_progress' }]);
      writes = '';
      assert.doesNotThrow(() => screen.renderNow());
      assert.match(writes, /Recovered/);
      assert.equal(stops, 0, 'todo updates must not stop the TUI');
    });
  }
});

test('todo replacement normalizes list, enforces one active task and restores selected branch', async () => {
  const app = runtime(); await app.hook('session_start');
  const result = await app.call([{ content: '  Implement   feature  ', status: 'in_progress' }, { content: 'Verify', status: 'pending' }]);
  assert.equal((result.details as Snapshot).todos[0].content, 'Implement feature');
  assert.match(app.widget()!.join('\n'), /Implement feature/);
  await assert.rejects(app.call([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }]), /one/);
  const saved = app.branch();
  await app.call([{ content: 'Different branch', status: 'pending' }]);
  app.switchTo(saved); await app.hook('session_tree');
  assert.match(app.widget()!.join('\n'), /Implement feature/);
  assert.equal(app.widget()!.length, 1);
  assert.doesNotMatch(app.widget()!.join('\n'), /Different/);
  app.switchTo([]); await app.hook('session_start'); assert.equal(app.widget(), undefined);
  const resumed = runtime(saved); await resumed.hook('session_start'); assert.match(resumed.widget()!.join('\n'), /Implement feature/);
});

test('completed/cleared todos remove reminder; stale warnings survive resume without invented completion', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  assert.equal((await app.turn()), 'Keep the todo list current as work progresses.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  for (let turn = 0; turn < 4; turn++) await app.turn();
  const resumed = runtime(app.branch()); await resumed.hook('session_start');
  assert.equal((await resumed.turn()), 'STALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  await resumed.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  assert.equal((await resumed.turn()), 'STALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  await resumed.call([{ content: 'Unfinished work', status: 'completed' }]);
  assert.equal(resumed.widget(), undefined);
  assert.equal(await resumed.turn(), undefined);
  await resumed.call([]); assert.equal(resumed.widget(), undefined);
  const fresh = runtime(resumed.branch()); await fresh.hook('session_start'); assert.equal(fresh.widget(), undefined);
});

test('invalid snapshots and malformed replacement cannot restore stale or corrupt declarations', async () => {
  const app = runtime(); await app.call([{ content: 'Valid', status: 'pending' }]);
  await assert.rejects(app.call([{ content: '   ', status: 'pending' }]), /nonempty/);
  await assert.rejects(app.call([{ content: 'Same', status: 'pending' }, { content: ' Same ', status: 'completed' }]), /unique/);
  assert.match(app.widget()!.join('\n'), /Valid/);
  app.switchTo([...app.branch(), { type: 'custom', customType: 'interactive-tools:todo', data: { version: 999, todos: [] } }]);
  await app.hook('session_start'); assert.equal(app.widget(), undefined);
  const rejected = runtime([{ type: 'custom', customType: 'interactive-tools:todo', data: { version: 1, staleTurns: 0, todos: [{ content: 'x'.repeat(501), status: 'pending' }] } }]);
  await rejected.hook('session_start');
  assert.equal(rejected.widget(), undefined);
  assert.equal(rejected.warnings().at(-1), 'Skipped 1 invalid or unsupported todo snapshot: Todo content must be nonempty plain text, at most 500 characters');
});

test('session shutdown clears the todo widget', async () => {
  const app = runtime();
  await app.call([{ content: 'Still pending', status: 'pending' }]);
  assert.match(app.widget()!.join('\n'), /Still pending/);
  await app.hook('session_shutdown');
  assert.equal(app.widget(), undefined);
});

test('appended snapshots are decoupled from the live todo state', async () => {
  const app = runtime();
  await app.call([{ content: 'Shared task', status: 'pending' }]);
  const appended = app.appended().at(-1) as any;
  appended.todos[0].content = 'Tampered';
  appended.todos.push({ content: 'Injected', status: 'pending' });
  const reminder = await app.turn();
  assert.match(reminder, /\[pending\] Shared task/);
  assert.doesNotMatch(reminder, /Tampered|Injected/);
});

test('todo accepts 100 tasks and rejects an oversized replacement without changing progress', async () => {
  const app = runtime();
  const tasks = Array.from({ length: 100 }, (_, index) => ({ content: `Task ${index + 1}`, status: 'pending' }));
  await app.call(tasks);
  assert.deepEqual(app.widget(), ['Todos · 0/100 · Task 1 · alt+t']);
  await app.toggle();
  assert.match(app.widget()!.join('\n'), /Task 100/);
  const before = app.branch();
  await assert.rejects(app.call([...tasks, { content: 'Task 101', status: 'pending' }]), /100/);
  assert.deepEqual(app.branch(), before);
  assert.doesNotMatch(app.widget()!.join('\n'), /Task 101/);
});

test('repeated branch switches restore each branch and still warn once per invalid snapshot', async () => {
  const app = runtime();
  const snapshot = (content: string, staleTurns: number) => ({ type: 'custom', customType: 'interactive-tools:todo', data: { version: 1, todos: [{ content, status: 'pending' }], staleTurns } });
  const broken = { type: 'custom', customType: 'interactive-tools:todo', data: { version: 999, todos: [] } };
  const first = [broken, snapshot('Alpha', 2), broken, snapshot('Beta', 5)];
  const second = [broken, snapshot('Alpha', 2), snapshot('Gamma', 3)];
  for (let pass = 0; pass < 3; pass++) {
    app.switchTo(first); await app.hook('session_tree');
    assert.deepEqual(app.widget(), ['Todos · 0/1 · Beta · alt+t']);
    assert.equal(app.warnings().length, pass * 2 + 1);
    assert.equal(app.warnings().at(-1), 'Skipped 2 invalid or unsupported todo snapshots: Unsupported todo snapshot');
    app.switchTo(second); await app.hook('session_tree');
    assert.deepEqual(app.widget(), ['Todos · 0/1 · Gamma · alt+t']);
    assert.equal(app.warnings().length, pass * 2 + 2);
    assert.equal(app.warnings().at(-1), 'Skipped 1 invalid or unsupported todo snapshot: Unsupported todo snapshot');
  }
  assert.match((await app.turn()), /not changed for several turns[\s\S]*Gamma/);
});

test('changing the declared list resets the stale reminder', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  for (let turn = 0; turn < 6; turn++) await app.turn();
  assert.match((await app.turn()), /STALE TODO/);
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }, { content: 'Next step', status: 'pending' }]);
  assert.equal((await app.turn()), 'Keep the todo list current as work progresses.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work\n[pending] Next step');
});

test('the reminder strengthens on exactly the third unchanged turn', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  await app.turn();
  assert.match((await app.turn()), /Keep the todo list current/);
  assert.equal((await app.turn()), 'This todo list has not changed for several turns. Update actual progress or explain the blocker.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
});

test('active todo preserves the request prefix and mid-conversation system updates', async () => withPi({ extensions: [todo] }, async ({ session, runner }) => {
  await session.getToolDefinition('todo_write')!.execute('seed', { todos: [{ content: 'Active task', status: 'in_progress' }] }, undefined, undefined, runner.createToolContext('seed', undefined));
  const initial = [
    { role: 'system' as const, content: 'You are Pi', sections: { editor_context: '<editor_context>file A line 1</editor_context>', subagent_profiles: 'Original profiles' }, timestamp: 1 },
    { role: 'user' as const, content: 'First prompt', timestamp: 2 },
    fauxAssistantMessage('First reply'),
  ];
  const update = { role: 'system' as const, content: '', sections: { editor_context: '<editor_context>file B line 9</editor_context>', subagent_profiles: 'Updated profiles' }, toolsAdded: [{ name: 'new_tool', description: 'Added tool', parameters: { type: 'object' } }], toolsRemoved: [{ name: 'old_tool' }], timestamp: 4 };
  const first = await runner.emitContext(initial);
  const next = await runner.emitContext([...initial, update, { role: 'user', content: 'Second prompt', timestamp: 5 }]);
  assert.deepEqual(first.slice(0, -1), initial);
  assert.deepEqual(next.slice(0, initial.length), initial);
  assert.deepEqual(next[initial.length], update);
  const reminder = first.at(-1)!;
  assert.equal(reminder.role, 'custom');
  assert.ok('content' in reminder);
  assert.match(String(reminder.content), /Keep the todo list current[\s\S]*\[in_progress\] Active task/);
  assert.equal(next.filter(message => message.role === 'custom').length, 1);
}));

test('provider requests retain the cached prefix when editor context changes between turns', async () => {
  let turn = 0;
  const requests: TranscriptContext[] = [];
  await withPi({ extensions: [todo, pi => {
    pi.on('before_agent_start', event => { event.systemPromptOptions.sections.editor_context = ++turn === 1 ? '<editor_context>file A line 1</editor_context>' : '<editor_context>file B line 9</editor_context>'; });
  }], responses: Array.from({ length: 2 }, () => (context: TranscriptContext) => { requests.push(structuredClone(context)); return fauxAssistantMessage('Reply'); }) }, async ({ session, runner }) => {
    await session.getToolDefinition('todo_write')!.execute('seed', { todos: [{ content: 'Active task', status: 'pending' }] }, undefined, undefined, runner.createToolContext('seed', undefined));
    await session.prompt('First prompt');
    await session.prompt('Second prompt');
    const first = requests[0].messages, next = requests[1].messages;
    assert.equal(next.filter(message => message.role === 'system').length, 2);
    assert.deepEqual(next.slice(0, first.length - 1), first.slice(0, -1));
    const prefix = JSON.stringify(first.slice(0, -1)).slice(0, -1);
    assert.equal(JSON.stringify(next).slice(0, prefix.length), prefix);
    assert.deepEqual(next.at(-1)?.content, [{ type: 'text', text: 'Keep the todo list current as work progresses.\nPersisted todos are declared progress, not verified completion:\n[pending] Active task' }]);
  });
});

test('unchanged todos stop saving after six turns and preserve reminders on disk resume', async () => withPi({ extensions: [todo], settings: { compaction: { enabled: false }, retry: { enabled: false } } }, async fixture => {
  const tasks = [{ content: 'Still working', status: 'pending' }];
  const write = (todos: typeof tasks) => fixture.session.getToolDefinition('todo_write')!.execute('write', { todos }, undefined, undefined, fixture.runner.createToolContext('write', undefined));
  const snapshots = () => fixture.session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'interactive-tools:todo');
  const reminders: string[] = [];
  await write(tasks);
  for (let turn = 1; turn <= 12; turn++) {
    fixture.provider.setResponses([context => { reminders.push(providerText(context)); return fauxAssistantMessage('Reply'); }]);
    await fixture.session.prompt(`Turn ${turn}`);
    assert.equal(snapshots().length, Math.min(turn, 6) + 1);
    if ([2, 5, 6, 12].includes(turn)) {
      const path = fixture.session.sessionManager.getSessionFile()!;
      await fixture.runtime.switchSession(path);
      const context = await fixture.runner.emitContext([]);
      const reminder = context.at(-1)!;
      assert.ok('content' in reminder);
      assert.ok(reminders.at(-1)!.includes(String(reminder.content)));
    }
  }
  assert.match(reminders[1], /Keep the todo list current/);
  assert.match(reminders[2], /not changed for several turns/);
  assert.match(reminders[4], /not changed for several turns/);
  assert.match(reminders[5], /STALE TODO/);
  assert.match(reminders[11], /STALE TODO/);
  const saved = snapshots();
  await write(tasks);
  assert.deepEqual(snapshots(), saved);
  await write([{ content: 'New actual progress', status: 'pending' }]);
  assert.equal(snapshots().length, 8);
  const changed = snapshots().at(-1)!;
  assert.equal(changed.type, 'custom');
  if (changed.type === 'custom') assert.equal((changed.data as Snapshot).staleTurns, 0);
  await write([]);
  assert.equal(snapshots().length, 9);
  assert.deepEqual(await fixture.runner.emitContext([]), []);
}));

async function todoSession(run: (session: PiFixture['session'], provider: PiFixture['provider'], manager: SessionManager) => Promise<void>) {
  return withPi({ extensions: [todo], settings: { compaction: { enabled: false }, retry: { enabled: false }, followUpMode: 'one-at-a-time', steeringMode: 'one-at-a-time' } }, async ({ session, provider, runner }) => {
    await session.getToolDefinition('todo_write')!.execute('seed', { todos: [{ content: 'Still working', status: 'pending' }] }, undefined, undefined, runner.createToolContext('seed', undefined));
    await run(session, provider, session.sessionManager);
  });
}

function providerText(context: TranscriptContext): string {
  return context.messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
}

for (const mode of ['steer', 'followUp'] as const) {
  test(`queued ${mode} prompts account through six delivered users and keep stale reminders`, async () => todoSession(async (session, provider, manager) => {
    const requests: string[] = [];
    provider.setResponses(Array.from({ length: 7 }, (_, index) => async context => {
      requests.push(providerText(context));
      if (index === 0) for (let queued = 1; queued <= 6; queued++) await session.prompt(`Queued ${queued}`, { streamingBehavior: mode });
      return fauxAssistantMessage(`Response ${index}`);
    }));
    await session.prompt('Initial prompt');
    assert.equal(requests.length, 7);
    assert.match(requests[1], /Keep the todo list current/);
    assert.match(requests[2], /not changed for several turns/);
    assert.match(requests[4], /not changed for several turns/);
    assert.match(requests[5], /STALE TODO/);
    assert.match(requests[6], /STALE TODO/);
    assert.ok(requests.every(text => text.split('Persisted todos are declared progress').length === 2));
    const branch = manager.getBranch();
    assert.equal(branch.filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 7);
    const snapshots = branch.filter(entry => entry.type === 'custom').filter(entry => entry.customType === 'interactive-tools:todo');
    assert.equal(snapshots.length, 7, 'one seed and counts through six, without an agent_end duplicate');
    assert.deepEqual(snapshots.slice(1).map(entry => entry.parentId), branch.filter(entry => entry.type === 'message' && entry.message.role === 'user').slice(0, 6).map(entry => entry.id));
    assert.deepEqual(snapshots.at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 6 });
    for (const entry of snapshots.slice(1)) {
      const parent = manager.getEntry(entry.parentId!);
      assert.equal(parent?.type, 'message');
      if (parent?.type === 'message') assert.equal(parent.message.role, 'user', 'accounting snapshot follows its delivered user');
    }
    assert.ok(!branch.some(entry => entry.type === 'custom_message' && entry.customType === 'interactive-tools:todo-reminder'), 'reminders never enter saved history');
    assert.ok(!session.messages.some(message => message.role === 'custom' && message.customType === 'interactive-tools:todo-reminder'));
    const reopened = SessionManager.open(manager.getSessionFile()!);
    assert.deepEqual(reopened.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, snapshots.at(-1)?.data);
    const users = branch.filter(entry => entry.type === 'message').filter(entry => entry.message.role === 'user');
    await session.navigateTree(users[3].id, { summarize: false });
    provider.setResponses([fauxAssistantMessage('Branch reply')]);
    await session.prompt('New branch prompt');
    assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 4 });
  }));
}

for (const mode of ['steer', 'followUp'] as const) {
  for (const todos of [[{ content: 'Still working', status: 'completed' }], []]) {
    test(`${mode} requests drop obsolete reminders after ${todos.length ? 'completion' : 'clearing'}`, async () => todoSession(async (session, provider, manager) => {
      const requests: string[] = [];
      provider.setResponses([
        async context => {
          requests.push(providerText(context));
          await session.prompt('Queued prompt after todo update', { streamingBehavior: mode });
          return fauxAssistantMessage(fauxToolCall('todo_write', { todos }, { id: 'complete' }));
        },
        context => { requests.push(providerText(context)); return fauxAssistantMessage('Updated'); },
        context => { requests.push(providerText(context)); return fauxAssistantMessage('Queued reply'); },
      ]);
      await session.prompt('Initial prompt');
      assert.match(requests[0], /\[pending\] Still working/);
      assert.ok(requests.length >= 2);
      for (const text of requests.slice(1)) assert.doesNotMatch(text, /Persisted todos are declared progress|\[pending\] Still working/);
      assert.equal(manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 2);
      assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos, staleTurns: 0 });
    }));
  }
}

test('batched prompts count users rather than provider requests', async () => todoSession(async (session, provider, manager) => {
  session.setFollowUpMode('all');
  const requests: string[] = [];
  provider.setResponses([
    async context => {
      requests.push(providerText(context));
      for (let queued = 1; queued <= 6; queued++) await session.prompt(`Queued ${queued}`, { streamingBehavior: 'followUp' });
      return fauxAssistantMessage('First reply');
    },
    context => { requests.push(providerText(context)); return fauxAssistantMessage('Batch reply'); },
  ]);
  await session.prompt('Initial prompt');
  assert.equal(requests.length, 2);
  assert.match(requests[1], /STALE TODO/);
  assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 6 });  const snapshots = manager.getBranch().filter(entry => entry.type === 'custom');
  assert.equal(snapshots.length, 7);
  assert.deepEqual(snapshots.slice(1).map(entry => entry.parentId), manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').slice(0, 6).map(entry => entry.id));
  for (const entry of snapshots.slice(1)) {
    const parent = manager.getEntry(entry.parentId!);
    assert.equal(parent?.type, 'message');
    if (parent?.type === 'message') assert.equal(parent.message.role, 'user');
  }
  const users = manager.getBranch().filter(entry => entry.type === 'message').filter(entry => entry.message.role === 'user');
  await session.navigateTree(users[3].id, { summarize: false });
  provider.setResponses([fauxAssistantMessage('New branch reply')]);
  await session.prompt('Branch after first three users');
  assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 4 });
}));

test('preparation failure saves delivered user accounting without a provider context', async () => todoSession(async (session, provider, manager) => {
  session.agent.transformContext = async () => { throw new Error('Synthetic preparation failure'); };
  await session.prompt('Delivered before preparation fails');
  assert.equal(provider.state.callCount, 0);
  assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 1 });
  const snapshot = manager.getBranch().filter(entry => entry.type === 'custom').at(-1)!;
  const parent = manager.getEntry(snapshot.parentId!);
  assert.equal(parent?.type, 'message');
}));

test('queued prompts cancelled before delivery do not count', async () => {
  let active!: PiFixture['session'];
  await withPi({ extensions: [todo],
    settings: { compaction: { enabled: false }, retry: { enabled: false }, followUpMode: 'one-at-a-time', steeringMode: 'one-at-a-time' },
    responses: [async () => {
      await active.prompt('Cancelled queued prompt', { streamingBehavior: 'followUp' });
      active.clearQueue();
      return fauxAssistantMessage('Aborted response');
    }],
  }, async ({ session, runner }) => {
    active = session;
    await session.getToolDefinition('todo_write')!.execute('seed', { todos: [{ content: 'Still working', status: 'pending' }] }, undefined, undefined, runner.createToolContext('seed', undefined));
    const manager = session.sessionManager;
    await session.prompt('Initial prompt');
    assert.equal(manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 1);
    assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 1 });
  });
});

test('an identical declaration saves pending accounting before resume', async () => {
  const app = runtime();
  const tasks = [{ content: 'Unfinished work', status: 'pending' }];
  await app.call(tasks);
  await app.turn();
  await app.hook('message_start', { message: { role: 'user', content: 'Second prompt' } });
  await app.call(tasks);
  assert.equal(app.appended().at(-1).staleTurns, 2);
  const resumed = runtime(app.branch());
  await resumed.hook('session_start');
  assert.equal(await resumed.turn(), 'This todo list has not changed for several turns. Update actual progress or explain the blocker.\nPersisted todos are declared progress, not verified completion:\n[pending] Unfinished work');
});

test('legacy counts above six retain the stale warning without more snapshots', async () => {
  const app = runtime([{ type: 'custom', customType: 'interactive-tools:todo', data: { version: 1, todos: [{ content: 'Legacy work', status: 'pending' }], staleTurns: 20 } }]);
  await app.hook('session_start');
  const saved = app.branch();
  for (let turn = 0; turn < 8; turn++) assert.match(await app.turn(), /STALE TODO[\s\S]*Legacy work/);
  await app.call([{ content: 'Legacy work', status: 'pending' }]);
  assert.deepEqual(app.branch(), saved);
  await app.call([{ content: 'Reconciled work', status: 'pending' }]);
  assert.equal(app.appended().at(-1).staleTurns, 0);
  assert.match(await app.turn(), /Keep the todo list current/);
});

test('repeated provider contexts do not count as user messages', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'pending' }]);
  await app.turn();
  for (let request = 0; request < 6; request++) assert.match(await app.reminder(), /Keep the todo list current/);
  assert.equal(app.branch().length, 2);
  assert.equal(app.appended().at(-1).staleTurns, 1);
});
