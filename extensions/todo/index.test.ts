import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai';
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
  const hook = (name: string, event: object = {}) => hooks.get(name)?.({ messages: [], ...event }, ctx);
  const turn = async () => {
    await hook('message_start', { message: { role: 'user', content: 'User prompt' } });
    const result = await hook('context');
    return result?.messages.at(-1)?.content;
  };
  return { turn, reminder: async () => (await hook('context'))?.messages.at(-1)?.content, call: (todos: object[]) => tool.execute('test', { todos }, undefined, undefined, ctx), hook, branch: () => structuredClone(branch), switchTo: (entries: any[]) => { branch = entries; }, widget: () => widget, warnings: () => warnings, appended: () => branch.map((entry: any) => entry.data) };
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

async function todoSession(run: (session: Awaited<ReturnType<typeof createAgentSession>>['session'], provider: ReturnType<typeof fauxProvider>, manager: SessionManager) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-todo-queue-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const agentDir = join(cwd, 'agent');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, followUpMode: 'one-at-a-time', steeringMode: 'one-at-a-time' });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [todo], noExtensions: true, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const provider = fauxProvider({ provider: 'todo-queue-regression', tokensPerSecond: 100000 });
    modelRuntime.registerNativeProvider(provider.provider);
    const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: manager, modelRuntime, model: provider.getModel(), noTools: 'builtin' }));
    await session.bindExtensions({});
    const errors: unknown[] = [];
    session.extensionRunner!.onError(error => errors.push(error));
    await session.getToolDefinition('todo_write')!.execute('seed', { todos: [{ content: 'Still working', status: 'pending' }] }, undefined, undefined, session.extensionRunner!.createContext());
    await run(session, provider, manager);
    assert.deepEqual(errors, []);
  } finally { session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
}

function providerText(context: Context): string {
  return [context.systemPrompt, ...context.messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))].join('\n');
}

for (const mode of ['steer', 'followUp'] as const) {
  test(`queued ${mode} prompts count each delivered user and refresh stale reminders`, async () => todoSession(async (session, provider, manager) => {
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
    assert.equal(snapshots.length, 8, 'one seed and seven saved counts, without an agent_end duplicate');
    assert.deepEqual(snapshots.at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 7 });
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
  assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 7 });  const snapshots = manager.getBranch().filter(entry => entry.type === 'custom');
  assert.equal(snapshots.length, 8);
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

test('queued prompts cancelled before delivery do not count', async () => todoSession(async (session, provider, manager) => {
  provider.setResponses([async () => {
    await session.prompt('Cancelled queued prompt', { streamingBehavior: 'followUp' });
    session.clearQueue();
    return fauxAssistantMessage('Aborted response');
  }]);
  await session.prompt('Initial prompt');
  assert.equal(manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 1);
  assert.deepEqual(manager.getBranch().filter(entry => entry.type === 'custom').at(-1)?.data, { version: 1, todos: [{ content: 'Still working', status: 'pending' }], staleTurns: 1 });
}));

test('repeated provider contexts do not count as user messages', async () => {
  const app = runtime();
  await app.call([{ content: 'Unfinished work', status: 'pending' }]);
  await app.turn();
  for (let request = 0; request < 6; request++) assert.match(await app.reminder(), /Keep the todo list current/);
  assert.equal(app.branch().length, 2);
  assert.equal(app.appended().at(-1).staleTurns, 1);
});
