import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import todo from './index.js';

interface Snapshot { version: 1; todos: { content: string; status: string }[]; staleTurns: number }

function runtime(initial: any[] = []) {
  let tool: ToolDefinition;
  let branch = initial;
  let widget: string[] | undefined;
  const warnings: string[] = [];
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  todo({ registerTool: (value: ToolDefinition) => { tool = value; }, on: (name: string, callback: any) => hooks.set(name, callback), appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text };
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget: (_key: string, value: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined) => { widget = value?.(undefined, theme).render(40); }, notify: (message: string) => { warnings.push(message); } } } as unknown as ExtensionContext;
  return { call: (todos: object[]) => tool.execute('test', { todos }, undefined, undefined, ctx), hook: (name: string) => hooks.get(name)!({ systemPrompt: 'You are a coding assistant.\nPreserve the user instructions.' }, ctx), branch: () => structuredClone(branch), switchTo: (entries: any[]) => { branch = entries; }, widget: () => widget, warnings: () => warnings, appended: () => branch.map((entry: any) => entry.data) };
}

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
  assert.ok(app.widget()!.every(line => line.length === 40), 'border spans the render width');
  assert.doesNotMatch(app.widget()!.join('\n'), /Different/);
  app.switchTo([]); await app.hook('session_start'); assert.equal(app.widget(), undefined);
  const resumed = runtime(saved); await resumed.hook('session_start'); assert.match(resumed.widget()!.join('\n'), /Implement feature/);
});

test('completed/cleared todos remove reminder; stale warnings survive resume without invented completion', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  assert.equal((await app.hook('before_agent_start')).systemPrompt, 'You are a coding assistant.\nPreserve the user instructions.\n\nKeep the todo list current as work progresses.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  for (let turn = 0; turn < 4; turn++) await app.hook('before_agent_start');
  const resumed = runtime(app.branch()); await resumed.hook('session_start');
  assert.equal((await resumed.hook('before_agent_start')).systemPrompt, 'You are a coding assistant.\nPreserve the user instructions.\n\nSTALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  await resumed.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  assert.equal((await resumed.hook('before_agent_start')).systemPrompt, 'You are a coding assistant.\nPreserve the user instructions.\n\nSTALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
  await resumed.call([{ content: 'Unfinished work', status: 'completed' }]);
  assert.equal(resumed.widget(), undefined);
  assert.equal(await resumed.hook('before_agent_start'), undefined);
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
  const { systemPrompt } = await app.hook('before_agent_start');
  assert.match(systemPrompt, /\[pending\] Shared task/);
  assert.doesNotMatch(systemPrompt, /Tampered|Injected/);
});

test('todo accepts 100 tasks and rejects an oversized replacement without changing progress', async () => {
  const app = runtime();
  const tasks = Array.from({ length: 100 }, (_, index) => ({ content: `Task ${index + 1}`, status: 'pending' }));
  await app.call(tasks);
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
    assert.deepEqual(app.widget(), ['╭──────────────────────────────────────╮', '│ Todo — declared progress             │', '│ ○ Beta                               │', '╰──────────────────────────────────────╯']);
    assert.equal(app.warnings().length, pass * 2 + 1);
    assert.equal(app.warnings().at(-1), 'Skipped 2 invalid or unsupported todo snapshots: Unsupported todo snapshot');
    app.switchTo(second); await app.hook('session_tree');
    assert.deepEqual(app.widget(), ['╭──────────────────────────────────────╮', '│ Todo — declared progress             │', '│ ○ Gamma                              │', '╰──────────────────────────────────────╯']);
    assert.equal(app.warnings().length, pass * 2 + 2);
    assert.equal(app.warnings().at(-1), 'Skipped 1 invalid or unsupported todo snapshot: Unsupported todo snapshot');
  }
  // staleTurns travels with the restored snapshot, not with a neighbouring cached one.
  assert.match((await app.hook('before_agent_start')).systemPrompt, /not changed for several turns[\s\S]*Gamma/);
});

test('changing the declared list resets the stale reminder', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  for (let turn = 0; turn < 6; turn++) await app.hook('before_agent_start');
  assert.match((await app.hook('before_agent_start')).systemPrompt, /STALE TODO/);
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }, { content: 'Next step', status: 'pending' }]);
  assert.equal((await app.hook('before_agent_start')).systemPrompt, 'You are a coding assistant.\nPreserve the user instructions.\n\nKeep the todo list current as work progresses.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work\n[pending] Next step');
});

test('the reminder strengthens on exactly the third unchanged turn', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'in_progress' }]);
  await app.hook('before_agent_start');
  assert.match((await app.hook('before_agent_start')).systemPrompt, /Keep the todo list current/);
  assert.equal((await app.hook('before_agent_start')).systemPrompt, 'You are a coding assistant.\nPreserve the user instructions.\n\nThis todo list has not changed for several turns. Update actual progress or explain the blocker.\nPersisted todos are declared progress, not verified completion:\n[in_progress] Unfinished work');
});
