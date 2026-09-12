import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sentinel from './index.ts';
import { childGuard } from './bridge.ts';
import { piInvocation } from '../subagents/registry.ts';

async function harness(on = true) {
  const home = await mkdtemp(join(tmpdir(), 'sentinel-hooks-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const parent = process.env.PI_SENTINEL_PARENT;
  process.env.PI_CODING_AGENT_DIR = home;
  delete process.env.PI_SENTINEL_PARENT;
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const records: any[] = [];
  const requests: any[] = [];
  const branch: any[] = [{ type: 'message', message: { role: 'user', content: 'Only read synthetic fixtures.', timestamp: 1 } }];
  let label = 'low';
  let assessment: unknown = { outcome: 'allow' };
  let broken = false;
  let onRequest: (() => void) | undefined;
  const model = { id: 'gpt-5.6-luna', provider: 'openai-codex', api: 'openai-codex-responses', contextWindow: 128000, maxTokens: 4096 };
  const provider = { streamSimple: (model: any, input: any, options: any) => {
    onRequest?.();
    requests.push({ model, input, options });
    const text = model.id === 'gpt-5.6-luna' ? label : JSON.stringify(assessment);
    const result = { role: 'assistant', content: [{ type: 'text', text }], stopReason: broken ? 'error' : 'stop' };
    return { async *[Symbol.asyncIterator]() { if (broken) yield { type: 'error' }; else yield { type: 'text_delta', delta: text }; }, result: async () => result };
  } };
  const ctx: any = { cwd: home, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => 'fixture-session', getBranch: () => branch }, modelRegistry: {
    find: (_provider: string, id: string) => id === 'gpt-5.6-luna' ? model : undefined,
    getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'synthetic', headers: { 'x-test': 'yes' }, env: {} }),
  } };
  sentinel({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, value: any) => commands.set(name, value), appendEntry: (type: string, value: any) => { branch.push({ type: 'custom', customType: type, data: value }); if (type === 'sentinel:decision') records.push(value); }, getAllTools: () => [] } as any);
  await handlers.get('session_start')({}, ctx);
  ctx.ui = { notify() {}, setStatus() {}, editor: async (_title: string, text: string) => text, confirm: async () => true };
  if (on) { ctx.hasUI = true; await commands.get('auto').handler('on', ctx); ctx.hasUI = false; }
  await handlers.get('before_agent_start')({ systemPromptOptions: { customPrompt: 'Developer constraints', contextFiles: [] } }, ctx);
  const call = (name = 'read', input: any = { path: 'fixture.txt' }) => handlers.get('tool_call')({ toolName: name, input, toolCallId: `t-${requests.length}` }, ctx);
  return { home, handlers, commands, records, requests, branch, ctx, call,
    onRequest: (fn: () => void) => { onRequest = fn; },
    label: (value: string) => { label = value; }, assessment: (value: unknown) => { assessment = value; }, broken: () => { broken = true; },
    async close() { await handlers.get('session_shutdown')({}, ctx); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; if (parent === undefined) delete process.env.PI_SENTINEL_PARENT; else process.env.PI_SENTINEL_PARENT = parent; await rm(home, { recursive: true, force: true }); },
  };
}

test('cold review then async low cache; actual provider auth and preferences are used', async () => {
  const h = await harness();
  try {
    assert.equal(await h.call(), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await h.call('bash', { command: 'ls' }), undefined);
    assert.deepEqual(h.records.map(r => r.source), ['review', 'cached']);
    assert.equal(h.requests[0].options.apiKey, 'synthetic');
    assert.equal(h.requests[0].options.headers['x-test'], 'yes');
    assert.equal(h.requests[0].options.reasoning, 'low');
    assert.equal(h.requests[0].input.tools.length, 0);
    assert.equal(h.requests.find(r => r.model.id === 'codex-auto-review').input.tools.length, 4);
  } finally { await h.close(); }
});

test('high risk gets synchronous denial; errors and malformed responses fail closed', async () => {
  const h = await harness();
  try {
    h.label('high'); h.assessment({ outcome: 'deny', risk_level: 'high', user_authorization: 'unknown', rationale: 'Unrequested destruction.' });
    assert.match((await h.call('bash', { command: 'rm fixture.txt' })).reason, /Unrequested destruction/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await h.call()).block, true);
    h.assessment({ outcome: 'maybe' }); assert.equal((await h.call()).block, true);
    h.broken(); assert.equal((await h.call()).block, true);
  } finally { await h.close(); }
});

test('changed policy is blocked until explicit reviewed reload; both stages get standing preferences', async () => {
  const h = await harness();
  try {
    await h.call();
    await writeFile(join(h.home, 'sentinel-policy.md'), 'Never push to main without explicit approval.');
    assert.match((await h.call()).reason, /policy changed/);
    h.ctx.hasUI = true;
    h.ctx.ui = { notify() {}, setStatus() {}, editor: async (_title: string, text: string) => text, confirm: async () => true };
    await h.commands.get('sentinel').handler('reload', h.ctx);
    assert.equal(await h.call(), undefined);
    for (const stage of ['gpt-5.6-luna', 'codex-auto-review']) assert.match(h.requests.filter(r => r.model.id === stage).at(-1).input.systemPrompt, /Never push to main without explicit approval/);
    await writeFile(join(h.home, 'sentinel.json'), '{broken');
    assert.equal((await h.call()).block, true);
  } finally { await h.close(); }
});

test('unknown tools are reviewed, huge action blocks, and cancellation/session shutdown cannot allow', async () => {
  const h = await harness();
  try {
    h.assessment({ outcome: 'deny' });
    assert.equal((await h.call('external_plugin_mutation', {})).block, true);
    assert.match((await h.call('write', { content: 'x'.repeat(257000) })).reason, /exceeds/);
    const controller = new AbortController(); controller.abort(); h.ctx.signal = controller.signal;
    assert.equal((await h.call()).block, true);
    await h.handlers.get('session_shutdown')({}, h.ctx);
    assert.equal((await h.call()).block, true);
  } finally { await h.close(); }
});

test('mandatory child extension receives live root authorization and snapshot is removed on shutdown', async () => {
  const h = await harness();
  let path = '';
  try {
    const extra = childGuard(h.home, 'fixture-session');
    assert.ok(extra);
    path = extra.env.PI_SENTINEL_PARENT;
    const parent = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(parent.authorization.users, ['Only read synthetic fixtures.']);
    assert.match(extra.extensions[0], /sentinel\/index\.ts$/);
    const invocation = piInvocation({ task: 'Only inspect fixture.txt', cwd: h.home, tools: ['read'], extensions: [], timeout: 1000 }, extra);
    assert.equal(invocation.env.PI_SENTINEL_PARENT, path);
    assert.ok(invocation.args.includes(extra.extensions[0]));
    h.branch.push({ type: 'message', message: { role: 'user', content: 'Stop modifying files.' } });
    childGuard(h.home, 'fixture-session');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).authorization.users.at(-1), 'Stop modifying files.');
  } finally { await h.close(); }
  await assert.rejects(readFile(path));
  assert.equal(childGuard(h.home, 'fixture-session'), undefined);
});

test('new chats default off without touching providers; only explicit mode entries survive resume', async () => {
  const h = await harness(false);
  try {
    assert.equal(await h.call('write'), undefined);
    assert.equal(h.requests.length, 0);
    assert.equal(childGuard(h.home, 'fixture-session'), undefined);
    h.ctx.hasUI = true;
    await h.commands.get('auto').handler('on', h.ctx);
    await h.handlers.get('session_start')({}, h.ctx);
    await h.call(); assert.ok(h.requests.length > 0);
    await h.commands.get('auto').handler('off', h.ctx);
    const count = h.requests.length;
    await h.call(); assert.equal(h.requests.length, count);
    await h.handlers.get('session_start')({}, h.ctx);
    await h.call(); assert.equal(h.requests.length, count);
    h.branch.length = 0; // A new session has no inherited mode entry.
    await h.handlers.get('session_start')({}, h.ctx);
    await h.call(); assert.equal(h.requests.length, count);
  } finally { await h.close(); }
});

test('large exact actions defer to blocking review without classifier truncation', async () => {
  const h = await harness();
  try {
    assert.equal(await h.call('write', { path: 'large.txt', content: 'x'.repeat(50000) }), undefined);
    assert.equal(h.records.at(-1).source, 'review');
    assert.equal(h.requests.some(r => r.model.id === 'gpt-5.6-luna'), false);
    assert.ok(h.requests[0].input.messages[0].content[0].text.includes('x'.repeat(50000)));
  } finally { await h.close(); }
});

test('relative custom policy path forces fresh review and changed confirmation is not adopted', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.home, 'sec.md'), 'Preserve source files.');
    await writeFile(join(h.home, 'sentinel.json'), JSON.stringify({ policyFile: join(h.home, 'sec.md') }));
    h.ctx.hasUI = true;
    await h.commands.get('sentinel').handler('reload', h.ctx);
    await h.call(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await h.call('write', { path: 'sec.md', content: 'replacement' }), undefined);
    assert.equal(h.records.at(-1).source, 'review');
    h.ctx.ui.confirm = async () => { await writeFile(join(h.home, 'sec.md'), 'Unseen blanket approval'); return true; };
    await h.commands.get('sentinel').handler('reload', h.ctx);
    assert.equal((await h.call()).block, true);
  } finally { await h.close(); }
});

test('evidence becoming incomplete while reviewer runs invalidates the decision', async () => {
  const h = await harness();
  try {
    let changed = false;
    h.onRequest(() => { if (!changed) { changed = true; h.branch.push({ type: 'message', message: { role: 'toolResult', content: 'x'.repeat(20000) } }); } });
    assert.match((await h.call()).reason, /changed during review/);
  } finally { await h.close(); }
});

test('lifecycle snapshot failures remove stale child authority without throwing', async () => {
  const h = await harness();
  try {
    const guard = childGuard(h.home, 'fixture-session')!;
    await rm(join(guard.env.PI_SENTINEL_PARENT, '..'), { recursive: true, force: true });
    await assert.doesNotReject(async () => h.handlers.get('before_agent_start')({ systemPromptOptions: {} }, h.ctx));
    await assert.rejects(readFile(guard.env.PI_SENTINEL_PARENT));
    assert.equal((await h.call()).block, true);
  } finally { await h.close(); }
});
