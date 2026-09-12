import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mcp from './index.ts';
import { McpConnection, toolName, type ServerConfig } from './client.ts';
import { startFixture } from './fixture.ts';

async function harness(servers: Record<string, ServerConfig>, project = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-mcp-lifecycle-'));
  const path = join(cwd, project ? '.pi/mcp.json' : 'mcp.json');
  if (project) await mkdir(join(cwd, '.pi'));
  await writeFile(path, JSON.stringify({ servers }));
  const handlers = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const notifications: string[] = [];
  let active = ['read'];
  const ctx = { cwd, hasUI: true, mode: 'tui', isProjectTrusted: () => true, ui: { confirm: async (_title: string, _message: string, _options?: { signal?: AbortSignal }) => true, notify: (s: string) => notifications.push(s) } };
  mcp({
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    registerFlag: () => {}, getFlag: () => project ? undefined : path,
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
  } as any);
  return {
    ctx, tools, commands, notifications, active: () => active,
    start: () => handlers.get('session_start')({}, ctx),
    shutdown: () => handlers.get('session_shutdown')(),
    status: async () => JSON.parse((await tools.get('mcp').execute('status', { action: 'status' }, undefined, undefined, ctx)).content[0].text),
    close: async () => { await handlers.get('session_shutdown')(); await rm(cwd, { recursive: true, force: true }); },
  };
}

const schema = { type: 'object' as const, properties: { text: { type: 'string' } } };

test('consent and tool labels cannot be hidden or overflowed by server tool names', async () => {
  const raw = 'lookup\n\nFAKE REASSURANCE\x1b[8mconceal' + 'x'.repeat(100000);
  const mock = test.mock.method(McpConnection.prototype, 'connect', async () => [{ name: raw, inputSchema: schema }]);
  const h = await harness({ s: { url: 'http://127.0.0.1:1' } });
  try {
    await h.start();
    const tool = h.tools.get(toolName('s', raw));
    assert.ok(tool.label.length < 180);
    assert.ok(tool.description.length < 2020);
    assert.doesNotMatch(tool.label, /[\x00-\x1f\x7f-\x9f]/);
    let displayed = '';
    h.ctx.ui.confirm = async (_title, message) => { displayed = message; return false; };
    await assert.rejects(tool.execute('malicious', { text: 'REAL_ARGUMENTS' }, undefined, undefined, h.ctx), /declined/);
    assert.ok(displayed.split('\n')[0].length <= 256);
    assert.doesNotMatch(displayed, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    assert.match(displayed, /\n\{"text":"REAL_ARGUMENTS"\}\nRemote annotations do not grant permission\./);
    assert.ok(displayed.includes(tool.name));
  } finally { mock.mock.restore(); await h.close(); }
});

test('deep schemas are skipped without dropping later valid tools', async () => {
  let deep: any = { type: 'object' };
  for (let i = 0; i < 10000; i++) deep = { type: 'object', properties: { child: deep } };
  const mock = test.mock.method(McpConnection.prototype, 'connect', async () => [{ name: 'deep', inputSchema: deep }, { name: 'valid', inputSchema: schema }]);
  const h = await harness({ s: { url: 'http://127.0.0.1:1', consent: 'allow' } });
  try {
    await h.start();
    assert.equal(h.active().includes(toolName('s', 'deep')), false);
    assert.equal(h.active().includes(toolName('s', 'valid')), true);
    assert.equal((await h.status())[0].registeredTools, 1);
  } finally { mock.mock.restore(); await h.close(); }
});

test('non-OAuth auth command leaves a healthy inventory untouched', async () => {
  const fixture = await startFixture('http');
  const h = await harness({ fixture: { ...fixture.config, consent: 'allow' } });
  try {
    await h.start();
    const name = toolName('fixture', 'echo'), old = h.tools.get(name);
    await h.commands.get('mcp-auth').handler('fixture', h.ctx);
    assert.match(h.notifications.at(-1)!, /OAuth is not configured/);
    assert.ok(h.active().includes(name));
    assert.match((await old.execute('still-valid', { text: 'still-valid' }, undefined, undefined, h.ctx)).content[0].text, /still-valid/);
  } finally { await h.close(); await fixture.close(); }
});

test('config errors identify their source and preserve safe validation reasons', async () => {
  const h = await harness({});
  try {
    const file = join(h.ctx.cwd, 'mcp.json');
    await writeFile(file, JSON.stringify({ servers: { bad: { command: 'synthetic', required: true } } }));
    await h.start();
    assert.match(h.notifications.at(-1)!, /Explicit MCP configuration: Unsupported MCP server field/);
    assert.doesNotMatch(h.notifications.at(-1)!, /synthetic/);
    await writeFile(file, ' '.repeat(1048577));
    await h.start();
    assert.match(h.notifications.at(-1)!, /Explicit MCP configuration:.*exceeds 1 MiB/);
  } finally { await h.close(); }
});

test('RPC dialog consent works without silently granting headless authority', async () => {
  const fixture = await startFixture('http');
  const h = await harness({ fixture: fixture.config });
  h.ctx.mode = 'rpc';
  let prompts = 0;
  h.ctx.ui.confirm = async () => { prompts++; return true; };
  try {
    await h.start();
    const tool = h.tools.get(toolName('fixture', 'echo'));
    assert.match((await tool.execute('rpc', { text: 'rpc' }, undefined, undefined, h.ctx)).content[0].text, /rpc/);
    assert.equal(prompts, 2);
    h.ctx.hasUI = false;
    await assert.rejects(tool.execute('headless', { text: 'no' }, undefined, undefined, h.ctx), /consent/);
  } finally { await h.close(); await fixture.close(); }
});

test('refresh retires removed/schema-rejected tools and invalidates saved callbacks', async () => {
  const fixture = await startFixture('http');
  const h = await harness({ fixture: { ...fixture.config, consent: 'allow' } });
  try {
    await h.start();
    const name = toolName('fixture', 'echo');
    const old = h.tools.get(name);
    assert.ok(h.active().includes(name));
    const mocked = test.mock.method(McpConnection.prototype, 'connect', async () => [{ name: 'unsafe', inputSchema: { type: 'object', $ref: 'https://example.invalid/schema' } }]);
    try { await h.commands.get('mcp-connect').handler('fixture', h.ctx); } finally { mocked.mock.restore(); }
    assert.equal(h.active().includes(name), false);
    assert.ok(h.active().includes('read'));
    assert.equal((await h.status())[0].registeredTools, 0);
    assert.ok(h.notifications.includes('MCP registered 0 tools'));
    await assert.rejects(old.execute('old', { text: 'no' }, undefined, undefined, h.ctx), /catalog expired/);
  } finally { await h.close(); await fixture.close(); }
});

test('late discovery after shutdown never registers stale tools', async () => {
  const h = await harness({ delayed: { url: 'http://127.0.0.1:1', consent: 'allow' } });
  let finish!: (value: any) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const mocked = test.mock.method(McpConnection.prototype, 'connect', () => { entered(); return new Promise(resolve => { finish = resolve; }); });
  try {
    const pending = h.start();
    await started;
    await h.shutdown();
    finish([{ name: 'late', inputSchema: schema }]);
    await pending;
    assert.equal([...h.tools.keys()].some(name => name.startsWith('mcp_delayed_')), false);
  } finally { mocked.mock.restore(); await h.close(); }
});

test('disabled servers never prompt or connect; failures are isolated and status has no config secrets', async () => {
  const fixture = await startFixture('http');
  const h = await harness({
    disabled: { url: 'http://127.0.0.1:1', enabled: false, headers: { Secret: 'do-not-display' } },
    bad: { url: 'http://127.0.0.1:1', startupTimeoutMs: 100, consent: 'allow' },
    good: { ...fixture.config, consent: 'allow' },
  });
  let prompts = 0;
  h.ctx.ui.confirm = async () => { prompts++; return true; };
  try {
    await h.start();
    const statuses = await h.status();
    assert.deepEqual(statuses.map((s: any) => s.state), ['disabled', 'failed', 'ready']);
    assert.equal(statuses[2].registeredTools, 1);
    assert.equal(prompts, 0);
    assert.doesNotMatch(JSON.stringify(statuses), /do-not-display|headers|127\.0\.0\.1/);
    await h.commands.get('mcp-connect').handler('disabled', h.ctx);
    assert.equal(prompts, 0);
    assert.match(h.notifications.at(-1)!, /disabled/);
  } finally { await h.close(); await fixture.close(); }
});

test('interactive startup consent is serialized even with parallel connections', async () => {
  const mocked = test.mock.method(McpConnection.prototype, 'connect', async () => []);
  const h = await harness(Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(name => [name, { url: 'http://127.0.0.1:1' }])));
  let pending = 0, maximum = 0, prompts = 0;
  h.ctx.ui.confirm = async () => { prompts++; maximum = Math.max(maximum, ++pending); await new Promise(r => setTimeout(r, 5)); pending--; return true; };
  try { await h.start(); assert.equal(maximum, 1); assert.equal(prompts, 5); }
  finally { mocked.mock.restore(); await h.close(); }
});

test('trust/session changes during consent block tools and resources before dispatch', async () => {
  const fixture = await startFixture('http');
  const h = await harness({ fixture: fixture.config }, true);
  try {
    await h.start();
    const tool = h.tools.get(toolName('fixture', 'echo'));
    h.ctx.ui.confirm = async () => { h.ctx.isProjectTrusted = () => false; return true; };
    await assert.rejects(tool.execute('tool', { text: 'denied' }, undefined, undefined, h.ctx), /trust/);
    h.ctx.isProjectTrusted = () => true;
    await assert.rejects(h.tools.get('mcp').execute('resource', { action: 'read', server: 'fixture', uri: 'fixture://hello' }, undefined, undefined, h.ctx), /trust/);
    h.ctx.isProjectTrusted = () => true;
    h.ctx.ui.confirm = async () => { await h.shutdown(); return true; };
    await assert.rejects(tool.execute('tool', { text: 'stale' }, undefined, undefined, h.ctx), /expired|cancelled/);
  } finally { await h.close(); await fixture.close(); }
});

test('cancelled active and queued consent releases the queue without dispatch', async () => {
  const a = await startFixture('http'), b = await startFixture('http');
  const h = await harness({ a: a.config, b: b.config });
  const calls = test.mock.method(McpConnection.prototype, 'call');
  try {
    await h.start();
    let entered!: () => void;
    const displayed = new Promise<void>(resolve => { entered = resolve; });
    let prompts = 0;
    h.ctx.ui.confirm = async (_title, _message, options) => {
      prompts++; entered();
      assert.ok(options?.signal);
      return new Promise<boolean>(resolve => {
        if (options.signal!.aborted) resolve(false);
        else options.signal!.addEventListener('abort', () => resolve(false), { once: true });
      });
    };
    const active = new AbortController(), queued = new AbortController();
    const first = assert.rejects(h.tools.get(toolName('a', 'echo')).execute('a', { text: 'no dispatch' }, active.signal, undefined, h.ctx), /cancelled/);
    await displayed;
    const second = assert.rejects(h.tools.get('mcp').execute('b', { action: 'templates', server: 'b' }, queued.signal, undefined, h.ctx), /cancelled/);
    queued.abort();
    await second; // Must finish while A still owns the displayed dialog.
    assert.equal(prompts, 1);
    active.abort(); await first;
    h.ctx.ui.confirm = async () => { prompts++; return true; };
    assert.match((await h.tools.get(toolName('a', 'echo')).execute('live', { text: 'live' }, undefined, undefined, h.ctx)).content[0].text, /live/);
    assert.equal(prompts, 2);
    assert.equal(calls.mock.callCount(), 1);
  } finally { calls.mock.restore(); await h.close(); await a.close(); await b.close(); }
});

test('templates stay untrusted metadata and tool errors preserve useful bounded diagnostics', async () => {
  const fixture = await startFixture('http');
  const h = await harness({ fixture: { ...fixture.config, consent: 'allow', maxOutputBytes: 512 } });
  try {
    await h.start();
    const result = await h.tools.get('mcp').execute('templates', { action: 'templates', server: 'fixture' }, undefined, undefined, h.ctx);
    assert.match(result.content[0].text, /Untrusted MCP server output/);
    assert.match(result.content[0].text, /fixture:\/\/items\/\{id\}/);
    const tool = h.tools.get(toolName('fixture', 'echo'));
    await assert.rejects(tool.execute('error', { text: 'tool-error' }, undefined, undefined, h.ctx), /Untrusted MCP server output.*\n.*synthetic tool failure/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tool.execute('cancelled', { text: 'no request' }, controller.signal, undefined, h.ctx), /cancelled/);
  } finally { await h.close(); await fixture.close(); }
});
