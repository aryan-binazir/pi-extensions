import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import todo from './index.js';

function runtime(initial: any[] = []) {
  let tool: ToolDefinition;
  let branch = initial;
  let widget: string[] | undefined;
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  todo({ registerTool: (value: ToolDefinition) => { tool = value; }, on: (name: string, callback: any) => hooks.set(name, callback), appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget: (_key: string, value: string[] | undefined) => { widget = value; }, notify: () => {} } } as unknown as ExtensionContext;
  return { call: (todos: object[]) => tool.execute('test', { todos }, undefined, undefined, ctx), hook: (name: string) => hooks.get(name)!({ systemPrompt: 'You are a coding assistant.\nPreserve the user instructions.' }, ctx), branch: () => structuredClone(branch), switchTo: (entries: any[]) => { branch = entries; }, widget: () => widget };
}

test('todo replacement normalizes list, enforces one active task and restores selected branch', async () => {
  const app = runtime(); await app.hook('session_start');
  const result = await app.call([{ content: '  Implement   feature  ', status: 'in_progress' }, { content: 'Verify', status: 'pending' }]);
  assert.match(JSON.stringify(result), /Implement feature/);
  assert.match(app.widget()!.join('\n'), /Implement feature/);
  await assert.rejects(app.call([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }]), /one/);
  const saved = app.branch();
  await app.call([{ content: 'Different branch', status: 'pending' }]);
  app.switchTo(saved); await app.hook('session_tree');
  assert.match(app.widget()!.join('\n'), /Implement feature/);
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
  await app.call([{ content: 'New', status: 'pending' }]); await app.hook('session_shutdown'); assert.equal(app.widget(), undefined);
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
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  let branch: any[] = [];
  let widget: string[] | undefined;
  let warnings = 0;
  todo({ registerTool: () => {}, on: (name: string, callback: any) => hooks.set(name, callback), appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget: (_key: string, value: string[] | undefined) => { widget = value; }, notify: () => { warnings++; } } } as unknown as ExtensionContext;
  const snapshot = (content: string, staleTurns: number) => ({ type: 'custom', customType: 'interactive-tools:todo', data: { version: 1, todos: [{ content, status: 'pending' }], staleTurns } });
  const broken = { type: 'custom', customType: 'interactive-tools:todo', data: { version: 999, todos: [] } };
  const first = [broken, snapshot('Alpha', 2), broken, snapshot('Beta', 5)];
  const second = [broken, snapshot('Alpha', 2), snapshot('Gamma', 3)];
  for (let pass = 0; pass < 3; pass++) {
    branch = first; await hooks.get('session_tree')!({}, ctx);
    assert.deepEqual(widget, ['Todo — declared progress', '○ Beta']);
    assert.equal(warnings, pass * 3 + 2);
    branch = second; await hooks.get('session_tree')!({}, ctx);
    assert.deepEqual(widget, ['Todo — declared progress', '○ Gamma']);
    assert.equal(warnings, pass * 3 + 3);
  }
  // staleTurns travels with the restored snapshot, not with a neighbouring cached one.
  assert.match((await hooks.get('before_agent_start')!({ systemPrompt: 'S' }, ctx)).systemPrompt, /not changed for several turns[\s\S]*Gamma/);
});
