import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, type ListToolsResult, type ListToolsRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpConnection } from './client.ts';
import { startFixture } from './fixture.ts';

async function catalogServer(list: (request: ListToolsRequest) => Promise<ListToolsResult>, supportsTools = true) {
  const sessions: Server[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const http = createServer(async (req, res) => {
    headers.push(req.headers);
    const server = new Server({ name: 'catalog', version: '1' }, { capabilities: supportsTools ? { tools: {} } : {} });
    if (supportsTools) server.setRequestHandler(ListToolsRequestSchema, list);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    sessions.push(server);
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`, headers,
    close: async () => { await Promise.all(sessions.map(s => s.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}

const echo = { name: 'echo', inputSchema: { type: 'object' as const } };

test('concurrent connection waiters receive only sanitized errors', async () => {
  const http = createServer((_req, res) => { res.writeHead(500); res.end('SYNTHETIC_SECRET_NEVER_ECHO'); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const c = new McpConnection('coalesced', { url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp` });
  try {
    const results = await Promise.allSettled([c.connect(), c.connect()]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') { assert.match(String(result.reason), /MCP request failed/); assert.doesNotMatch(String(result.reason), /SYNTHETIC_SECRET/); }
    }
  } finally { await c.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});

test('cancellation while waiting for shared reconnect never dispatches the action', async () => {
  const fixture = await startFixture('http', true);
  const c = new McpConnection('reconnect-cancel', fixture.config);
  const calls = test.mock.method(Client.prototype, 'callTool');
  let delayed: ReturnType<typeof test.mock.method> | undefined;
  try {
    await c.connect();
    await assert.rejects(c.call('echo', { text: 'x'.repeat(2 * 1024 * 1024 + 1) }), /exceeds/);
    const connect = c.connect.bind(c);
    delayed = test.mock.method(c, 'connect', async () => { await new Promise(resolve => setTimeout(resolve, 250)); return connect(); });
    const abort = new AbortController();
    const start = Date.now();
    const pending = c.call('echo', { text: 'must not dispatch' }, abort.signal);
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending, /cancelled/);
    assert.ok(Date.now() - start < 200);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(calls.mock.callCount(), 1);
  } finally { delayed?.mock.restore(); calls.mock.restore(); await c.close(); await fixture.close(); }
});

test('locally detected config failures keep actionable secret-free diagnostics', async () => {
  const variable = 'HARBOR_MISSING_TEST_ENV';
  const previous = process.env[variable]; delete process.env[variable];
  try {
    for (const config of [
      { command: process.execPath, envVars: [variable] },
      { url: 'http://127.0.0.1:1', bearerTokenEnvVar: variable },
      { url: 'http://127.0.0.1:1', transport: 'sse' as const, headers: { 'invalid header': 'synthetic-secret' } },
    ]) {
      const c = new McpConnection('configuration', config);
      try {
        await assert.rejects(c.connect(), /environment reference unavailable|headers could not be resolved/);
        assert.equal(c.status.state, 'failed');
        assert.doesNotMatch(JSON.stringify(c.status), /synthetic-secret|HARBOR_MISSING_TEST_ENV/);
      } finally { await c.close(); }
    }
  } finally { if (previous !== undefined) process.env[variable] = previous; }
});

test('successful discovery cannot overwrite a concurrent closed status', async () => {
  const c = new McpConnection('close-success', { command: process.execPath });
  const mock = test.mock.method(c as any, 'open', async () => { queueMicrotask(() => { void c.close(); }); return []; });
  try {
    await assert.rejects(c.connect(), /cancelled/);
    assert.equal(c.status.state, 'closed');
  } finally { mock.mock.restore(); await c.close(); }
});

test('startup has a single budget across handshake/discovery and reports failed status', async () => {
  let pages = 0;
  const fixture = await catalogServer(async () => {
    await new Promise(resolve => setTimeout(resolve, 40));
    return { tools: [], nextCursor: String(++pages) };
  });
  const c = new McpConnection('slow', { url: fixture.url, startupTimeoutMs: 150, toolTimeoutMs: 2000 });
  try {
    const start = Date.now();
    await assert.rejects(c.connect(), /timed out/);
    assert.ok(Date.now() - start < 1000);
    assert.ok(pages < 8);
    assert.equal(c.status.state, 'failed');
  } finally { await c.close(); await fixture.close(); }
});

test('a small tool timeout does not shorten startup discovery', async () => {
  const fixture = await catalogServer(async () => { await new Promise(resolve => setTimeout(resolve, 80)); return { tools: [echo] }; });
  const c = new McpConnection('split', { url: fixture.url, startupTimeoutMs: 2000, toolTimeoutMs: 20 });
  try { assert.equal((await c.connect()).length, 1); }
  finally { await c.close(); await fixture.close(); }
});

test('unsupported catalogs return empty without sending unsupported requests', async () => {
  const fixture = await catalogServer(async () => { assert.fail('no list'); }, false);
  const c = new McpConnection('minimal', { url: fixture.url });
  try {
    assert.deepEqual(await c.connect(), []);
    const requests = fixture.headers.length;
    assert.deepEqual(await c.resources(), []);
    assert.deepEqual(await c.resourceTemplates(), []);
    assert.deepEqual(await c.prompts(), []);
    assert.equal(fixture.headers.length, requests);
  } finally { await c.close(); await fixture.close(); }
});

for (const duplicate of [false, true]) test(`rejects ${duplicate ? 'duplicate tool names' : 'cyclic remote cursors'} before registering`, async () => {
  let requests = 0;
  const fixture = await catalogServer(async () => { requests++; return duplicate ? { tools: [echo, echo] } : { tools: [], nextCursor: 'loop' }; });
  const c = new McpConnection('bad', { url: fixture.url });
  try { await assert.rejects(c.connect(), duplicate ? /duplicate/ : /repeated/); assert.equal(requests, duplicate ? 1 : 2); }
  finally { await c.close(); await fixture.close(); }
});

test('shutdown during startup prevents late ready state', async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fixture = await catalogServer(async () => { entered(); await new Promise(resolve => setTimeout(resolve, 80)); return { tools: [echo] }; });
  const c = new McpConnection('closing', { url: fixture.url });
  try {
    const pending = assert.rejects(c.connect(), /cancelled|failed/);
    await started; await c.close(); await pending;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(c.status.state, 'closed');
    await assert.rejects(c.connect(), /closed/);
  } finally { await c.close(); await fixture.close(); }
});

test('stdio uses explicit cwd and environment forwarding with explicit overrides', async () => {
  const fixture = await startFixture('stdio');
  const dir = await mkdtemp(join(tmpdir(), 'mcp-cwd-'));
  const oldInherited = process.env.MCP_FIXTURE_INHERITED, oldOverride = process.env.MCP_FIXTURE_OVERRIDE;
  process.env.MCP_FIXTURE_INHERITED = 'synthetic-inherited'; process.env.MCP_FIXTURE_OVERRIDE = 'ambient';
  const c = new McpConnection('env', { ...fixture.config, cwd: dir, envVars: ['MCP_FIXTURE_INHERITED', 'MCP_FIXTURE_OVERRIDE'], env: { MCP_FIXTURE_OVERRIDE: 'explicit' } });
  try {
    await c.connect();
    const result = await c.call('echo', { text: 'process-context' });
    const context = JSON.parse((result.content as { text: string }[])[0].text);
    assert.deepEqual(context, { cwd: dir, inherited: 'synthetic-inherited', override: 'explicit' });
  } finally {
    await c.close(); await rm(dir, { recursive: true, force: true });
    if (oldInherited === undefined) delete process.env.MCP_FIXTURE_INHERITED; else process.env.MCP_FIXTURE_INHERITED = oldInherited;
    if (oldOverride === undefined) delete process.env.MCP_FIXTURE_OVERRIDE; else process.env.MCP_FIXTURE_OVERRIDE = oldOverride;
  }
});

test('bearer/env headers reach the MCP endpoint and status never reveals them', async () => {
  const fixture = await catalogServer(async () => ({ tools: [] }));
  const prior = process.env.MCP_FIXTURE_TOKEN; process.env.MCP_FIXTURE_TOKEN = 'synthetic-bearer';
  const c = new McpConnection('headers', { url: fixture.url, bearerTokenEnvVar: 'MCP_FIXTURE_TOKEN', envHeaders: { 'X-Fixture': 'MCP_FIXTURE_TOKEN' } });
  try {
    await c.connect();
    assert.ok(fixture.headers.length > 0);
    for (const h of fixture.headers) { assert.equal(h.authorization, 'Bearer synthetic-bearer'); assert.equal(h['x-fixture'], 'synthetic-bearer'); }
    assert.doesNotMatch(JSON.stringify(c.status), /synthetic-bearer/);
  } finally { await c.close(); await fixture.close(); if (prior === undefined) delete process.env.MCP_FIXTURE_TOKEN; else process.env.MCP_FIXTURE_TOKEN = prior; }
});
