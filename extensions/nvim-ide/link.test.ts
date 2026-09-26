import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { IdeLink, chooseLock, maxSelectionChars, readLocks, type Lock, type LinkState } from './link.ts';
import { fakeIde, token, until } from './test-support.ts';

const lockFile = (overrides: Record<string, unknown> = {}) => JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w'], ideName: 'Neovim', authToken: token, ...overrides });

test('lock files: parse, skip dead pids and junk, choose by workspace then env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  try {
    await writeFile(join(dir, '1000.lock'), JSON.stringify({ pid: 1, transport: 'ws', workspaceFolders: ['/w/a'], ideName: 'Neovim', authToken: token }));
    await writeFile(join(dir, '1001.lock'), JSON.stringify({ pid: 2, transport: 'ws', workspaceFolders: ['/w/'], ideName: 'Neovim', authToken: token }));
    await writeFile(join(dir, '1002.lock'), JSON.stringify({ pid: 3, transport: 'ws', workspaceFolders: ['/w'], authToken: token }));
    await writeFile(join(dir, '1003.lock'), '{not json');
    await writeFile(join(dir, '0.lock'), lockFile());
    await writeFile(join(dir, '65536.lock'), lockFile());
    await writeFile(join(dir, '999999999999999999999999.lock'), lockFile());
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

test('a lock that makes WebSocket construction throw does not crash the host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  try {
    await writeFile(join(dir, '12345.lock'), lockFile({ authToken: 'bad\nheader' }));
    const source = `
      import { IdeLink } from ${JSON.stringify(new URL('./link.ts', import.meta.url).href)};
      const link = new IdeLink({ cwd: '/w', lockDir: process.argv[1], alive: () => true, retryMs: 100 });
      link.start();
      await new Promise(resolve => setTimeout(resolve, 150));
      await link.stop();
    `;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, dir]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('newest lock wins among equal workspace matches', () => {
  const base: Lock = { port: 1, authToken: token, workspaceFolders: ['/w'], ideName: 'Neovim', mtimeMs: 0 };
  const locks = [{ ...base, port: 1, mtimeMs: 1 }, { ...base, port: 2, mtimeMs: 5 }, { ...base, port: 3, mtimeMs: 3 }];
  assert.equal(chooseLock(locks, '/w', '')?.port, 2);
});

test('an invalid port lock does not hide a valid IDE lock', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w/project', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile({ workspaceFolders: ['/w'] }));
    await writeFile(join(dir, '65536.lock'), lockFile({ workspaceFolders: ['/w/project'] }));
    link.start();
    await until(() => link.connected);
    assert.equal(link.state.port, ide.port());
    assert.equal(await link.call('getOpenEditors'), 'getOpenEditors({})');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
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
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile({ pid: process.pid, workspaceFolders: ['/w/project'] }));
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
    // The mentions arrive after the malformed selection on the same socket, so this also proves that one was ignored.
    await until(() => link.state.mentions === 2);
    assert.equal(link.state.selection?.filePath, '/w/project/b.ts', 'a malformed selection_changed leaves the last good selection in place');
    assert.deepEqual(link.takeMentions(), [{ filePath: '/w/project/c.ts', lineStart: 3, lineEnd: 9 }, { filePath: '/w/project', lineStart: undefined, lineEnd: undefined }]);
    assert.equal(link.state.mentions, 0);

    assert.equal(await link.call('getOpenEditors'), 'getOpenEditors({})');
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
    assert.equal(await link.call('getCurrentSelection'), 'getCurrentSelection({})');
    assert.ok(states.filter(s => s.connected).length >= 2, 'the reconnect reports connected a second time');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
  await assert.rejects(link.call('getOpenEditors'), /not connected/);
});

test('discovery survives a lock directory that does not exist yet', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const dir = join(parent, 'ide');
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 100, alive: () => true });
  try {
    link.start();
    await new Promise(r => setTimeout(r, 150));
    await mkdir(dir);
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    await until(() => link.connected, 2000);
  } finally { await link.stop(); await ide.close(); await rm(parent, { recursive: true, force: true }); }
});

test('wrong token is refused and never reported as connected', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 200, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile({ authToken: 'wrong-token-1234' }));
    link.start();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(link.connected, false);
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
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
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    await until(() => link.connected, 2000);
    assert.ok(Date.now() - started < 1500, 'connected well before the 60s poll');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});

test('editor restart: dropped connection then a new lock on a new port reconnects to the new server', async () => {
  const first = fakeIde();
  await once(first.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, alive: () => true });
  try {
    link.start();
    await writeFile(join(dir, `${first.port()}.lock`), lockFile());
    await until(() => link.connected);
    // claudecode.nvim removes its lock before closing the socket
    await rm(join(dir, `${first.port()}.lock`));
    await first.close();
    await until(() => !link.connected);
    const second = fakeIde();
    await once(second.server, 'listening');
    try {
      // atomic write like the plugin: temp file then rename
      await writeFile(join(dir, `${second.port()}.lock.tmp.1.2`), lockFile());
      await rename(join(dir, `${second.port()}.lock.tmp.1.2`), join(dir, `${second.port()}.lock`));
      await until(() => link.connected, 2000);
      assert.equal(link.state.port, second.port());
      assert.equal(await link.call('getOpenEditors'), 'getOpenEditors({})');
    } finally { await second.close(); }
  } finally { await link.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('an editor that accepts the socket but never answers initialize is not connected, and links once it responds', async () => {
  let answer = false;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize' && answer) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
  }));
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const states: boolean[] = [];
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 100, requestTimeoutMs: 100, alive: () => true, onChange: s => states.push(s.connected) });
  try {
    await writeFile(join(dir, `${port}.lock`), lockFile());
    link.start();
    await new Promise(r => setTimeout(r, 350));
    assert.equal(link.connected, false);
    assert.deepEqual(states, [], 'a stalled handshake never reports connected');
    answer = true;
    await until(() => link.connected, 2000);
  } finally { await link.stop(); await new Promise<void>(done => { for (const c of server.clients) c.terminate(); server.close(() => done()); }); await rm(dir, { recursive: true, force: true }); }
});

test('server-initiated requests: ping is answered, anything else gets method-not-found, and selection text is capped', async () => {
  const seen: unknown[] = [];
  const ide = fakeIde(socket => socket.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id === 'srv-ping' || m.id === 'srv-other') seen.push(m); }));
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 100, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    for (const client of ide.server.clients) {
      client.send(JSON.stringify({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' }));
      client.send(JSON.stringify({ jsonrpc: '2.0', id: 'srv-other', method: 'sampling/createMessage', params: {} }));
      client.send('not json at all');
      client.send(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }));
    }
    await until(() => seen.length === 2);
    assert.deepEqual(seen, [{ jsonrpc: '2.0', id: 'srv-ping', result: {} }, { jsonrpc: '2.0', id: 'srv-other', error: { code: -32601, message: 'Method not found' } }]);
    ide.broadcast('selection_changed', { text: 'y'.repeat(maxSelectionChars + 10), filePath: '/w/big.ts', selection: { start: { line: 0, character: 0 }, end: { line: 500, character: 0 }, isEmpty: false } });
    await until(() => link.state.selection?.filePath === '/w/big.ts');
    assert.equal(link.state.selection?.text.length, maxSelectionChars);
    assert.equal(link.connected, true, 'junk from the server does not drop the link');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});

test('stop during discovery and stop twice are clean, and start after stop resumes discovery', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 100, alive: () => true });
  try {
    link.start();
    await link.stop();
    await link.stop();
    assert.equal(link.connected, false);
    await assert.rejects(link.call('getOpenEditors'), /not connected/);
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected, 2000);
    assert.equal(await link.call('getOpenEditors'), 'getOpenEditors({})');
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});
