import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installRegen } from './index.ts';
import { DEFAULT_CONFIG, MAX_CONFIG_BYTES, parseConfig, readConfig } from './config.ts';
import { conversationText, MAX_CONTEXT, MAX_MESSAGE, MAX_MESSAGES, normalizeTitle } from './text.ts';
import type { SideCompletionRequest, SideCompletionResult } from '../side-completion.ts';

const user = (content: unknown = 'Build a reliable task queue') => ({ role: 'user', content, timestamp: 1 });
const entry = (message: any, id = 'leaf') => ({ type: 'message' as const, id, parentId: null, timestamp: new Date(0).toISOString(), message });
const success = (text = 'Reliable Task Queue Design'): SideCompletionResult => ({ ok: true, text });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(options: { branch?: any[]; entries?: any[]; name?: string; reason?: string; timeoutMs?: number; config?: typeof readConfig; complete?: (request: SideCompletionRequest) => Promise<SideCompletionResult>; parent?: string } = {}) {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  let command: any;
  let name = options.name;
  let id = 'session-one';
  let branch = options.branch ?? [];
  const notifications: string[] = [];
  const names: string[] = [];
  const calls: SideCompletionRequest[] = [];
  const pending: ReturnType<typeof deferred<SideCompletionResult>>[] = [];
  const lookups: string[] = [];
  const model = { provider: 'openai-codex', id: 'gpt-6-luna' };
  const ctx: any = {
    cwd: '/unused', isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => id, getLeafId: () => branch.at(-1)?.id ?? null,
      getBranch: () => branch, getEntries: () => options.entries ?? branch,
      getHeader: () => ({ parentSession: options.parent }),
    },
    model: { provider: 'wrong', id: 'wrong' },
    modelRegistry: { find: (provider: string, modelId: string) => { lookups.push(`${provider}/${modelId}`); return model; } },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const pi: any = {
    on: (event: string, handler: any) => { handlers[event] = handler; },
    registerCommand: (key: string, value: any) => { assert.equal(key, 'regen-name'); command = value.handler; },
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; names.push(value); handlers.session_info_changed?.({ name }, ctx); },
  };
  installRegen(pi, {
    config: options.config ?? readConfig, timeoutMs: options.timeoutMs ?? 30000,
    complete: async request => {
      calls.push(request);
      if (options.complete) return options.complete(request);
      const work = deferred<SideCompletionResult>(); pending.push(work); return work.promise;
    },
  });
  const emit = (event: string, value: any = {}) => handlers[event]?.(value, ctx);
  emit('session_start', { reason: options.reason ?? 'startup' });
  return { ctx, calls, pending, names, notifications, lookups, emit,
    manual: () => command('', ctx), name: () => name,
    rename: (value?: string) => { name = value; emit('session_info_changed', { name }); },
    branch: (value: any[]) => { branch = value; }, switchId: () => { id = 'session-two'; },
  };
}

test('strict config defaults and exact custom model/effort', () => {
  assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
  for (const thinking of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    assert.deepEqual(parseConfig({ model: 'provider/model/nested', thinking }), { model: 'provider/model/nested', thinking });
  for (const value of [null, [], 'x', { extra: true }, { model: '' }, { model: 'luna' }, { model: '/luna' }, { model: 'a/' }, { model: 'a/b c' }, { model: 'a/\u001b' }, { model: null }, { thinking: 'auto' }, { thinking: null }])
    assert.throws(() => parseConfig(value));
});

test('config reads trusted cwd only, rereads, and rejects nonregular/oversized files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'regen-'));
  try {
    assert.deepEqual(await readConfig(cwd, true), DEFAULT_CONFIG);
    await mkdir(join(cwd, '.pi'));
    const file = join(cwd, '.pi/regen.json');
    await writeFile(file, '{invalid');
    assert.deepEqual(await readConfig(cwd, false), DEFAULT_CONFIG);
    await assert.rejects(readConfig(cwd, true), /valid JSON/);
    await writeFile(file, JSON.stringify({ thinking: 'high' }));
    assert.equal((await readConfig(cwd, true)).thinking, 'high');
    await writeFile(file, '{}');
    assert.deepEqual(await readConfig(cwd, true), DEFAULT_CONFIG);
    await writeFile(file, ' '.repeat(MAX_CONFIG_BYTES + 1));
    await assert.rejects(readConfig(cwd, true), /exceeds/);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readConfig(cwd, true), /regular file/);
    await rm(file, { recursive: true });
    execFileSync('mkfifo', [file]);
    await assert.rejects(readConfig(cwd, true), /regular file/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('context is bounded current-branch user/assistant text only', () => {
  const branch: any[] = [
    entry(user([{ type: 'text', text: 'keep user' }, { type: 'image', data: 'secret image' }])),
    entry({ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thinking' }, { type: 'toolCall', arguments: { secret: true } }, { type: 'text', text: 'keep assistant' }] }),
    entry({ role: 'toolResult', content: 'secret tool' }), entry({ role: 'system', content: 'secret system' }),
    { type: 'branch_summary', summary: 'secret abandoned' }, { type: 'compaction', summary: 'secret summary' },
    { type: 'custom_message', content: 'secret custom' },
  ];
  assert.equal(conversationText(branch), 'user: keep user\n\nassistant: keep assistant');
  const large = conversationText(Array.from({ length: 1000 }, (_, i) => entry(user(`${i}: ${'x'.repeat(9000)}`))));
  assert.ok(large.length <= MAX_CONTEXT);
  assert.ok(large.includes('999:'));
  assert.ok(!large.includes('user: 0:'));
  assert.ok(conversationText([entry(user('x'.repeat(9000)))]).length <= MAX_MESSAGE + 6);
  assert.equal(conversationText(Array.from({ length: 100 }, () => entry(user('x')))).split('\n\n').length, MAX_MESSAGES);
});

test('titles normalize escapes, controls, prefixes, quotes, words and Unicode bounds', () => {
  assert.equal(normalizeTitle('\u001b[31mTitle: “Build\t a\n task queue”\u001b[0m'), 'Build a task queue');
  assert.equal(normalizeTitle('\u001b]0;secret\u0007Clean\u0000 task queue'), 'Clean task queue');
  assert.equal(normalizeTitle('one two three four five six seven eight'), 'one two three four five six');
  assert.equal(normalizeTitle('😀'.repeat(70)), '😀'.repeat(60));
  assert.equal(normalizeTitle(`${'a'.repeat(40)} ${'b'.repeat(40)}`), 'a'.repeat(40));
  assert.throws(() => normalizeTitle(' \u001b[31m\n"" '), /empty/);
});

test('auto starts nonblocking from unpersisted first user and uses exact default low model', async () => {
  const h = harness();
  assert.equal(h.emit('message_end', { message: user() }), undefined);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].messages[0].content, 'user: Build a reliable task queue');
  assert.equal(h.calls[0].reasoning, 'low');
  assert.deepEqual(h.lookups, ['openai-codex/gpt-6-luna']);
  assert.ok(!h.calls[0].systemPrompt.includes('wrong'));
  h.emit('message_end', { message: user() });
  h.branch([entry(user())]);
  h.pending[0].resolve(success());
  await tick();
  assert.deepEqual(h.names, ['Reliable Task Queue Design']);
  assert.equal(h.calls.length, 1);
});

test('auto excludes existing, resumed, forked, reloaded, named and abandoned histories', async () => {
  for (const options of [
    { branch: [entry(user())] }, { entries: [entry(user())] }, { reason: 'resume' },
    { reason: 'fork' }, { reason: 'reload' }, { name: 'Chosen name' }, { parent: '/old/session' },
  ]) {
    const h = harness(options);
    h.emit('message_end', { message: user() }); await tick();
    assert.equal(h.calls.length, 0);
  }
  const h = harness();
  h.emit('message_end', { message: { role: 'assistant', content: 'skip' } });
  h.emit('message_end', { message: { role: 'custom', content: 'skip' } });
  h.emit('message_end', { message: user([{ type: 'image', data: 'skip' }]) });
  h.emit('message_end', { message: user() }); await tick();
  assert.equal(h.calls.length, 0);
});

test('manual replaces a name and rereads trusted config every request', async () => {
  let reads = 0;
  const h = harness({ name: 'Old title', branch: [entry(user())], config: async (cwd, trusted) => {
    assert.equal(cwd, '/unused'); assert.equal(trusted, true);
    return { model: `custom/model${++reads}`, thinking: reads === 1 ? 'high' : 'off' };
  }, complete: async () => success() });
  h.ctx.isProjectTrusted = () => true;
  await h.manual(); await h.manual();
  assert.deepEqual(h.lookups, ['custom/model1', 'custom/model2']);
  assert.equal(h.calls[0].reasoning, 'high'); assert.equal(h.calls[1].reasoning, undefined);
  assert.equal(h.names.length, 2);
});

test('newer manual supersedes auto and older manual even if provider ignores abort', async () => {
  const h = harness();
  h.emit('message_end', { message: user() }); await tick();
  h.branch([entry(user())]);
  const first = h.manual(); await tick();
  const second = h.manual(); await tick();
  assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.calls[1].signal.aborted, true);
  h.pending[2].resolve(success('Newest Manual Session Title'));
  await second;
  h.pending[0].resolve(success('Stale Automatic Session Title'));
  h.pending[1].resolve(success('Stale Manual Session Title'));
  await first; await tick();
  assert.deepEqual(h.names, ['Newest Manual Session Title']);
  assert.deepEqual(h.notifications, []);
});

test('auto preserves names changed during flight including changed then cleared', async () => {
  for (const clear of [false, true]) {
    const h = harness(); h.emit('message_end', { message: user() }); await tick();
    h.rename('My chosen name'); if (clear) h.rename();
    h.pending[0].resolve(success()); await tick();
    assert.deepEqual(h.names, []);
    assert.equal(h.name(), clear ? undefined : 'My chosen name');
  }
});

test('manual generation preserves newer names including changed then restored or cleared', async () => {
  for (const rename of ['Chosen while generating', 'Original title', undefined]) {
    const h = harness({ name: 'Original title', branch: [entry(user())] });
    const work = h.manual(); await tick();
    h.rename('Intermediate name');
    h.rename(rename);
    h.pending[0].resolve(success()); await work;
    assert.deepEqual(h.names, []);
    assert.equal(h.name(), rename);
    assert.deepEqual(h.notifications, []);
  }
});

test('all lifecycle invalidations cancel requests and dismiss late outcomes', async () => {
  for (const event of ['session_shutdown', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree', 'session_start']) {
    const h = harness({ branch: [entry(user())] });
    const work = h.manual(); await tick();
    h.emit(event, { reason: 'reload' });
    assert.equal(h.calls[0].signal.aborted, true);
    await work;
    h.pending[0].resolve(success()); await tick();
    assert.deepEqual(h.names, []); assert.deepEqual(h.notifications, []);
  }
});

test('identity and lineage guard writes without relying solely on events', async () => {
  for (const changeId of [true, false]) {
    const h = harness({ branch: [entry(user())] }); const work = h.manual(); await tick();
    if (changeId) h.switchId(); else h.branch([entry(user('different branch'), 'other')]);
    h.pending[0].resolve(success()); await work;
    assert.deepEqual(h.names, []);
  }
  const h = harness({ branch: [entry(user())] }); const work = h.manual(); await tick();
  h.branch([entry(user()), entry({ role: 'assistant', content: 'Continuation' }, 'next')]);
  h.pending[0].resolve(success()); await work;
  assert.equal(h.names.length, 1);
});

test('failure preserves names and reports concise category without provider secrets', async () => {
  for (const kind of ['auth', 'provider', 'provider-unavailable', 'limit', 'tool-use', 'incomplete', 'empty'] as const) {
    const h = harness({ name: 'Keep me', branch: [entry(user())], complete: async () => ({ ok: false, kind, text: '', error: new Error('secret credentials') }) });
    await h.manual(); assert.equal(h.name(), 'Keep me'); assert.equal(h.names.length, 0);
    assert.equal(h.notifications.length, 1); assert.ok(h.notifications[0].includes(kind));
    assert.ok(!h.notifications[0].includes('secret'));
  }
  const invalid = harness({ branch: [entry(user())], config: async () => { throw new Error('model must be provider/model'); } });
  await invalid.manual(); assert.equal(invalid.calls.length, 0); assert.match(invalid.notifications[0], /provider\/model/);
  const unavailable = harness({ branch: [entry(user())] }); unavailable.ctx.modelRegistry.find = () => undefined;
  await unavailable.manual(); assert.equal(unavailable.calls.length, 0); assert.match(unavailable.notifications[0], /model unavailable/);
  const empty = harness({ branch: [entry(user())], complete: async () => success('""') });
  await empty.manual(); assert.equal(empty.names.length, 0); assert.match(empty.notifications[0], /empty title/);
  const noText = harness(); await noText.manual(); assert.equal(noText.calls.length, 0);
});

test('automatic failure never retries, but manual request can retry', async () => {
  const h = harness({ complete: async () => ({ ok: false, kind: 'empty', text: '' }) });
  h.emit('message_end', { message: user() }); await tick();
  h.emit('message_end', { message: user() }); await tick();
  h.emit('session_start', { reason: 'startup' });
  h.emit('message_end', { message: user() }); await tick();
  assert.equal(h.calls.length, 1);
  h.branch([entry(user())]); await h.manual(); assert.equal(h.calls.length, 2);
});

test('timeout bounds config and provider work and dismisses late completion', async () => {
  const config = deferred<ReturnType<typeof parseConfig>>();
  const stalled = harness({ branch: [entry(user())], timeoutMs: 5, config: () => config.promise });
  await stalled.manual(); assert.match(stalled.notifications[0], /timed out/);
  config.resolve(DEFAULT_CONFIG); await tick(); assert.equal(stalled.calls.length, 0);
  const h = harness({ branch: [entry(user())], name: 'Keep title', timeoutMs: 5 });
  await h.manual(); assert.match(h.notifications[0], /timed out/); assert.equal(h.calls[0].signal.aborted, true);
  h.pending[0].resolve(success()); await tick(); assert.equal(h.name(), 'Keep title'); assert.deepEqual(h.names, []);
});
