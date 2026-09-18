import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { IdeLink, chooseLock, readLocks, type Lock, type LinkState } from './link.ts';
import { editorContext, statusText } from './index.ts';

const token = 'a3f1c2d4e5f60718293a4b5c6d7e8f90';
/** Minimal stand-in for claudecode.nvim's server: token check, initialize, tools/call echo. */
function fakeIde(onClient?: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers['x-claude-code-ide-authorization'] === token });
  const calls: { name: string; arguments: unknown }[] = [];
  server.on('connection', socket => {
    onClient?.(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      if (message.method === 'initialize') reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'claudecode-neovim', version: '0.0.0' } });
      else if (message.method === 'tools/call') {
        calls.push(message.params);
        if (message.params.name === 'boom') reply({ content: [{ type: 'text', text: 'nope' }], isError: true });
        else if (message.params.name === 'slow') return;
        else reply({ content: [{ type: 'text', text: `ok:${message.params.name}` }] });
      }
    });
  });
  const port = () => (server.address() as { port: number }).port;
  const broadcast = (method: string, params: unknown) => { for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method, params })); };
  return { server, calls, port, broadcast, close: () => new Promise<void>(done => { for (const client of server.clients) client.terminate(); server.close(() => done()); }) };
}
const until = (check: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => { const start = Date.now(); const tick = () => check() ? resolve() : Date.now() - start > ms ? reject(new Error('timeout')) : setTimeout(tick, 10); tick(); });
const lock = (overrides: Partial<Lock>): Lock => ({ port: 1, pid: 1, authToken: token, workspaceFolders: ['/w'], ideName: 'Neovim', mtimeMs: 0, ...overrides });

test('lock files: parse, skip dead pids and junk, choose by workspace then env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  try {
    await writeFile(join(dir, '1000.lock'), JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w/a'], ideName: 'Neovim', authToken: token }));
    await writeFile(join(dir, '1001.lock'), JSON.stringify({ pid: 2, transport: 'ws', workspaceFolders: ['/w/'], ideName: 'Neovim', authToken: token }));
    await writeFile(join(dir, '1002.lock'), JSON.stringify({ pid: 3, transport: 'ws', workspaceFolders: ['/w'], authToken: token }));
    await writeFile(join(dir, '1003.lock'), '{not json');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    const locks = await readLocks(dir, pid => pid !== 3);
    assert.deepEqual(locks.map(l => [l.port, l.workspaceFolders[0]]).sort(), [[1000, '/w/a'], [1001, '/w']]);
    assert.equal(chooseLock(locks, '/w/a/src', '')?.port, 1000);
    assert.equal(chooseLock(locks, '/w/b', '')?.port, 1001);
    assert.equal(chooseLock(locks, '/elsewhere', ''), undefined);
    assert.equal(chooseLock(locks, '/elsewhere', '1001')?.port, 1001);
    assert.equal(chooseLock(locks, '/w/a', '9')?.port, 1000);
    assert.equal(await readLocks(join(dir, 'missing')).then(l => l.length), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('newest lock wins among equal workspace matches', () => {
  const locks = [lock({ port: 1, mtimeMs: 1 }), lock({ port: 2, mtimeMs: 5 }), lock({ port: 3, mtimeMs: 3 })];
  assert.equal(chooseLock(locks, '/w', '')?.port, 2);
});

test('connects with the token, tracks selection and mentions, calls tools, reconnects', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const states: LinkState[] = [];
  const link = new IdeLink({ cwd: '/w/project', lockDir: dir, retryMs: 200, requestTimeoutMs: 100, alive: () => true, onChange: s => states.push(s) });
  try {
    link.start();
    await new Promise(r => setTimeout(r, 60));
    assert.equal(link.connected, false, 'no lock file yet');
    await writeFile(join(dir, `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: ['/w/project'], ideName: 'Neovim', authToken: token }));
    await until(() => link.connected);
    assert.equal(link.state.ideName, 'Neovim');
    assert.equal(link.state.port, ide.port());

    ide.broadcast('selection_changed', { text: 'hello', filePath: '/w/project/a.ts', fileUrl: 'file:///w/project/a.ts', selection: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await until(() => link.state.selection?.text === 'hello');
    ide.broadcast('selection_changed', { text: '', filePath: '/w/project/b.ts', selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } });
    await until(() => link.state.selection?.filePath === '/w/project/b.ts');
    assert.equal(link.state.selection?.isEmpty, true);
    ide.broadcast('selection_changed', { text: 'bad', filePath: 7 });
    ide.broadcast('at_mentioned', { filePath: '/w/project/c.ts', lineStart: 3, lineEnd: 9 });
    ide.broadcast('at_mentioned', { filePath: '/w/project', lineStart: null, lineEnd: null });
    await until(() => link.state.mentions === 2);
    assert.deepEqual(link.takeMentions(), [{ filePath: '/w/project/c.ts', lineStart: 3, lineEnd: 9 }, { filePath: '/w/project', lineStart: undefined, lineEnd: undefined }]);
    assert.equal(link.state.mentions, 0);

    assert.equal(await link.call('getOpenEditors'), 'ok:getOpenEditors');
    assert.deepEqual(ide.calls.at(-1), { name: 'getOpenEditors', arguments: {} });
    await assert.rejects(link.call('boom'), /nope/);
    await assert.rejects(link.call('slow'), /timed out/);
    const controller = new AbortController();
    const aborted = link.call('slow', {}, controller.signal);
    controller.abort();
    await assert.rejects(aborted, /aborted/);

    for (const client of ide.server.clients) client.terminate();
    await until(() => !link.connected);
    await until(() => link.connected);
    assert.equal(await link.call('getCurrentSelection'), 'ok:getCurrentSelection');
    assert.equal(states.filter(s => s.connected).length >= 2, true);
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
  await assert.rejects(link.call('getOpenEditors'), /not connected/);
});

test('a missing lock directory is polled until it can be watched', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const dir = join(parent, 'ide');
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 100, alive: () => true });
  try {
    link.start();
    await new Promise(r => setTimeout(r, 150));
    await mkdir(dir);
    await writeFile(join(dir, `${ide.port()}.lock`), JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w'], ideName: 'Neovim', authToken: token }));
    await until(() => link.connected, 2000);
  } finally { await link.stop(); await ide.close(); await rm(parent, { recursive: true, force: true }); }
});

test('wrong token is refused and never reported as connected', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 200, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w'], ideName: 'Neovim', authToken: 'wrong-token-1234' }));
    link.start();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(link.connected, false);
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});

test('editor context renders selection, cursor and mentions, and nothing when disconnected', () => {
  assert.equal(editorContext({ connected: false, mentions: 0 }, []), undefined);
  const withSelection = editorContext({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'x'.repeat(5000), filePath: '/f.ts', start: { line: 4, character: 0 }, end: { line: 6, character: 2 }, isEmpty: false } }, []);
  assert.match(withSelection!, /^# Editor context \(Neovim\)/);
  assert.match(withSelection!, /Selected lines 5-7:/);
  assert.match(withSelection!, /…\[truncated\]/);
  const cursor = editorContext({ connected: true, mentions: 0, selection: { text: '', filePath: '/g.ts', start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } }, [{ mention: { filePath: '/h.ts', lineStart: 2, lineEnd: 3 }, text: 'a\nb' }, { mention: { filePath: '/dir' } }]);
  assert.match(cursor!, /Active file: \/g\.ts \(cursor at line 1\)/);
  assert.match(cursor!, /User sent from editor: \/h\.ts lines 2-3\n```\na\nb\n```/);
  assert.match(cursor!, /User sent from editor: \/dir$/);
});

test('status text shows connection, active file, cursor line or selected range', () => {
  assert.equal(statusText({ connected: false, mentions: 0 }), undefined);
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0 }), 'Neovim ✓');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: '', filePath: '/w/math.ts', start: { line: 5, character: 0 }, end: { line: 5, character: 0 }, isEmpty: true } }), 'Neovim ✓ math.ts:6');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'abc', filePath: '/w/math.ts', start: { line: 4, character: 0 }, end: { line: 6, character: 1 }, isEmpty: false } }), 'Neovim ✓ math.ts:5-7 ▮');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'ab', filePath: '/w/math.ts', start: { line: 4, character: 0 }, end: { line: 4, character: 2 }, isEmpty: false } }), 'Neovim ✓ math.ts:5 ▮');
});

test('a lock file appearing wakes discovery through the directory watch, not the poll', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, alive: () => true });
  try {
    link.start();
    await new Promise(r => setTimeout(r, 50));
    const started = Date.now();
    await writeFile(join(dir, `${ide.port()}.lock`), JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w'], ideName: 'Neovim', authToken: token }));
    await until(() => link.connected, 2000);
    assert.ok(Date.now() - started < 1500, 'connected well before the 60s poll');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});
