import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners, once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { IdeLink, chooseLock, maxSelectionChars, readLocks, type Lock, type LinkState } from './link.ts';
import { fakeIde, token, until } from './test-support.ts';

async function submittedMentions(link: IdeLink) {
  const batch = await link.prepareMentions();
  batch.acknowledge();
  return batch.mentions;
}

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
      import assert from 'node:assert/strict';
      import { IdeLink } from ${JSON.stringify(new URL('./link.ts', import.meta.url).href)};
      let scans = 0;
      const link = new IdeLink({ cwd: '/w', lockDir: process.argv[1], alive: () => { scans++; return true; }, retryMs: 100 });
      link.start();
      try {
        const deadline = Date.now() + 2000;
        while (scans < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(scans >= 2, 'constructor failure schedules a retry');
        assert.equal(link.state.port, undefined, 'failed construction clears the chosen lock');
        assert.equal(link.connected, false);
      } finally { await link.stop(); }
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
    ide.broadcast('at_mentioned', { filePath: '/w/project/c.ts', lineStart: 2, lineEnd: 8 });
    ide.broadcast('at_mentioned', { filePath: '/w/project', lineStart: null, lineEnd: null });
    await until(() => link.state.mentions === 2);
    assert.equal(link.state.selection?.filePath, '/w/project/b.ts', 'a malformed selection_changed leaves the last good selection in place');
    assert.deepEqual(await submittedMentions(link), [{ filePath: '/w/project/c.ts', lineStart: 3, lineEnd: 9 }, { filePath: '/w/project', lineStart: undefined, lineEnd: undefined }]);
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

for (const [mode, message] of [['disconnect', 'IDE disconnected'], ['reconnect', 'reconnecting'], ['stop', 'IDE link stopped']] as const) {
  test(`${mode} rejects pending editor calls and removes their abort listeners`, async () => {
    const ide = fakeIde();
    await once(ide.server, 'listening');
    const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
    const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, requestTimeoutMs: 60_000, alive: () => true });
    const aborted = new AbortController();
    const pending = new AbortController();
    const errors: Error[] = [];
    try {
      await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
      link.start();
      await until(() => link.connected);
      const calls = [aborted.signal, pending.signal, pending.signal].map(signal => link.call('slow', {}, signal).catch((error: Error) => { errors.push(error); return error.message; }));
      await until(() => ide.calls.length === 3);
      assert.equal(getEventListeners(pending.signal, 'abort').length, 2);
      aborted.abort();
      assert.equal(await calls[0], 'aborted');
      assert.equal(getEventListeners(aborted.signal, 'abort').length, 0);

      if (mode === 'disconnect') {
        for (const client of ide.server.clients) client.terminate();
      } else if (mode === 'reconnect') link.reconnect();
      else void link.stop();
      await until(() => errors.length === 3, 1000);
      assert.deepEqual(await Promise.all(calls), ['aborted', message, message]);
      assert.equal(getEventListeners(pending.signal, 'abort').length, 0);
      pending.abort();

      if (mode === 'reconnect') {
        await until(() => link.connected);
        assert.equal(await link.call('getOpenEditors'), 'getOpenEditors({})');
      }
    } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('discovery survives a lock directory that does not exist yet', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const dir = join(parent, 'ide');
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, alive: () => true });
  try {
    link.start();
    await new Promise(r => setTimeout(r, 150));
    const started = Date.now();
    await mkdir(dir);
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    await until(() => link.connected, 2000);
    assert.ok(Date.now() - started < 1500, 'the parent watch reports the new directory well before the 60s poll');
  } finally { await link.stop(); await ide.close(); await rm(parent, { recursive: true, force: true }); }
});

test('a missing lock directory is left to the parent watch, but polling remains when the parent cannot be watched', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const attempts = async (lockDir: string, trace: string) => {
    const source = `
      import { IdeLink } from ${JSON.stringify(new URL('./link.ts', import.meta.url).href)};
      const link = new IdeLink({ cwd: '/w', lockDir: process.argv[1], retryMs: 20 });
      link.start();
      await new Promise(resolve => setTimeout(resolve, 400));
      await link.stop();
    `;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, lockDir], { env: { ...process.env, NVIM_IDE_TRACE: trace } });
    return (await readFile(trace, 'utf8')).split('\n').filter(line => line.endsWith(' attempt')).length;
  };
  try {
    const [watched, unwatchable] = await Promise.all([attempts(join(parent, 'ide'), join(parent, 'watched.log')), attempts(join(parent, 'missing', 'ide'), join(parent, 'unwatchable.log'))]);
    assert.equal(watched, 1, 'only the initial scan');
    assert.ok(unwatchable >= 5, `${unwatchable} scans`);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a lock directory created before the parent watch delivers events is found by a one-time recheck', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const dir = join(parent, 'ide');
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, alive: () => true });
  try {
    link.start();
    (link as any).parentWatcher.close(); // armed but not yet reporting, as macOS FSEvents can be just after watch() returns
    await new Promise(r => setTimeout(r, 100));
    await mkdir(dir);
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    await until(() => link.connected, 2500);
  } finally { await link.stop(); await ide.close(); await rm(parent, { recursive: true, force: true }); }
});

test('discovery survives replacement of an already watched lock directory', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const parent = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const dir = join(parent, 'ide');
  await mkdir(dir);
  await writeFile(join(dir, `${ide.port()}.lock`), lockFile({ workspaceFolders: ['/elsewhere'] }));
  let initialLockRead!: () => void;
  const initialScan = new Promise<void>(resolve => { initialLockRead = resolve; });
  const link = new IdeLink({ cwd: '/w', lockDir: dir, retryMs: 60_000, alive: () => { initialLockRead(); return true; } });
  try {
    link.start();
    await initialScan;
    assert.equal(link.connected, false);
    await rm(dir, { recursive: true });
    await mkdir(dir);
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    await until(() => link.connected, 2000);
    assert.equal(link.state.port, ide.port());
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
    await rm(join(dir, `${first.port()}.lock`));
    await first.close();
    await until(() => !link.connected);
    const second = fakeIde();
    await once(second.server, 'listening');
    try {
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

test('a mention sent before initialize identifies the server still includes row zero', async () => {
  const ide = fakeIde(socket => socket.on('message', raw => {
    if (JSON.parse(raw.toString()).method === 'initialize') socket.send(JSON.stringify({
      jsonrpc: '2.0', method: 'at_mentioned', params: { filePath: '/w/a.ts', lineStart: 0, lineEnd: 0 },
    }));
  }));
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected && link.state.mentions === 1);
    assert.deepEqual(await submittedMentions(link), [{ filePath: '/w/a.ts', lineStart: 1, lineEnd: 1 }]);
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});

test('relative sends before initialization cannot be rebound to a later workspace', async () => {
  let finishInitialize: (() => void) | undefined;
  let root = '/original';
  let rootLookups = 0;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath: 'relative.ts', lineStart: 0, lineEnd: 0 } }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath: '/original/absolute.ts', lineStart: 0, lineEnd: 0 } }));
      finishInitialize = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'claudecode-neovim' } } }));
    } else if (message.method === 'tools/call') {
      rootLookups++;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ rootPath: root }) }] } }));
    }
  }));
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const port = (server.address() as { port: number }).port;
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${port}.lock`), lockFile());
    link.start();
    await until(() => !!finishInitialize);
    root = '/replacement';
    finishInitialize!();
    await until(() => link.connected && link.state.mentions === 2);
    const batch = await link.prepareMentions();
    assert.deepEqual(batch.mentions.map(mention => mention.filePath), ['/original/absolute.ts']);
    assert.equal(batch.undelivered, 1);
    assert.equal(rootLookups, 0, 'the newer workspace is not used to guess ownership');
  } finally {
    await link.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('mention row conversion follows initialized identity across reconnects, not the lock label', async () => {
  let serverName: string | undefined = 'claudecode-neovim';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers['x-claude-code-ide-authorization'] === token });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: serverName } } }));
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${address.port}.lock`), lockFile({ ideName: 'IDE' }));
    link.start();
    for (const name of ['claudecode-neovim', 'another-ide', undefined]) {
      serverName = name;
      if (name !== 'claudecode-neovim') {
        await writeFile(join(dir, `${address.port}.lock`), lockFile({ ideName: 'Neovim' }));
        link.reconnect();
      }
      await until(() => link.connected);
      for (const params of [
        { lineStart: 0, lineEnd: 0 },
        { lineStart: 1, lineEnd: 2 },
        { lineStart: 0 },
        { lineStart: null, lineEnd: null },
        {},
        { lineStart: -1, lineEnd: 1.5 },
      ]) for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath: '/w/a.ts', ...params } }));
      await until(() => link.state.mentions === 6);
      const ranges = name === 'claudecode-neovim'
        ? [[1, 1], [2, 3], [1, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined]]
        : [[undefined, undefined], [1, 2], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined]];
      assert.deepEqual(await submittedMentions(link), ranges.map(([lineStart, lineEnd]) => ({ filePath: '/w/a.ts', lineStart, lineEnd })));
    }
  } finally {
    await link.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepared editor sends survive until acknowledgement and never consume newer sends', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    ide.broadcast('at_mentioned', { filePath: '/w/first.ts' });
    await until(() => link.state.mentions === 1);
    const first = await link.prepareMentions();
    assert.deepEqual(first.mentions, [{ filePath: '/w/first.ts', lineStart: undefined, lineEnd: undefined }]);
    assert.equal(link.state.mentions, 1, 'preparing is not delivery');
    ide.broadcast('at_mentioned', { filePath: '/w/newer.ts' });
    await until(() => link.state.mentions === 2);
    link.reconnect();
    await until(() => link.connected);
    assert.equal(link.state.mentions, 2, 'absolute sends survive a reconnect');
    first.acknowledge();
    first.acknowledge();
    assert.deepEqual((await link.prepareMentions()).mentions.map(item => item.filePath), ['/w/newer.ts']);
  } finally {
    await link.stop();
    await ide.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounded send queues protect prepared sends and report rejected new arrivals', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    for (let i = 0; i < 51; i++) ide.broadcast('at_mentioned', { filePath: `/w/${i}.ts` });
    await until(() => link.state.mentions === 50);
    const first = await link.prepareMentions();
    assert.equal(first.dropped, 1);
    assert.equal(first.mentions[0].filePath, '/w/1.ts');
    ide.broadcast('at_mentioned', { filePath: '/w/newer.ts' });
    await link.call('getWorkspaceFolders');
    const held = await link.prepareMentions();
    assert.equal(held.mentions[0].filePath, '/w/1.ts', 'a pending snapshot is not evicted while its request is prepared');
    assert.ok(!held.mentions.some(mention => mention.filePath === '/w/newer.ts'));
    first.acknowledge();
    first.acknowledge();
    const next = await link.prepareMentions();
    assert.deepEqual(next.mentions, []);
    assert.equal(next.dropped, 1, 'the rejected new arrival is reported, not an already delivered send');
  } finally {
    await link.stop();
    await ide.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('overlapping preparations acknowledge dropped sends with a monotonic watermark', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${ide.port()}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    for (let i = 0; i < 51; i++) ide.broadcast('at_mentioned', { filePath: `/w/old-${i}.ts` });
    await link.call('getWorkspaceFolders');
    const first = await link.prepareMentions(), overlapping = await link.prepareMentions();
    assert.equal(first.dropped, 1);
    first.acknowledge();
    for (let i = 0; i < 51; i++) ide.broadcast('at_mentioned', { filePath: `/w/new-${i}.ts` });
    await link.call('getWorkspaceFolders');
    overlapping.acknowledge();
    const next = await link.prepareMentions();
    assert.equal(next.dropped, 1, 'an older acknowledgement cannot erase newer overflow');
    next.acknowledge();
    assert.equal((await link.prepareMentions()).dropped, 0);
  } finally { await link.stop(); await ide.close(); await rm(dir, { recursive: true, force: true }); }
});

test('relative sends capture the live editor root at receipt, without waiting for a turn', async () => {
  let root = '/sent-from';
  let lookups = 0;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    else if (message.method === 'tools/call') {
      lookups++;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, rootPath: root }) }] } }));
    }
  }));
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const port = (server.address() as { port: number }).port;
  const link = new IdeLink({ cwd: '/w', lockDir: dir, alive: () => true });
  try {
    await writeFile(join(dir, `${port}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath: 'chosen.ts' } }));
    await until(() => lookups === 1, 1000);
    root = '/changed-after-send';
    const batch = await link.prepareMentions();
    assert.deepEqual(batch.mentions.map(mention => mention.filePath), ['/sent-from/chosen.ts']);
    assert.equal(lookups, 1, 'preparing a request performs no new workspace lookup');
  } finally {
    await link.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('mentions never fall back to Pi cwd or stale lock folders when live workspace lookup fails', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let response = '{}';
  let isError = false;
  let answer = true;
  let requests = 0;
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    else if (message.method === 'tools/call') {
      assert.deepEqual(message.params, { name: 'getWorkspaceFolders', arguments: {} });
      requests++;
      if (answer) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: response }], isError } }));
    }
  }));
  await once(server, 'listening');
  const dir = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const port = (server.address() as { port: number }).port;
  const link = new IdeLink({ cwd: '/w/nested', lockDir: dir, alive: () => true, requestTimeoutMs: 3000 });
  const send = (filePath: string) => {
    for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath, lineStart: 2, lineEnd: 3 } }));
  };
  const absolute = { filePath: '/elsewhere/absolute.ts', lineStart: 2, lineEnd: 3 };
  try {
    await writeFile(join(dir, `${port}.lock`), lockFile());
    link.start();
    await until(() => link.connected);
    for (response of ['not JSON', 'null', '[]', '{}', '{"rootPath":5}', '{"rootPath":""}', '{"rootPath":"relative"}', '{"success":false,"rootPath":"/w"}']) {
      send('selected.ts');
      send(absolute.filePath);
      await until(() => link.state.mentions === 2);
      assert.deepEqual(await submittedMentions(link), [absolute], response);
      assert.deepEqual(await submittedMentions(link), []);
    }
    response = '{"success":true,"rootPath":"/w"}';
    isError = true;
    send('selected.ts');
    send(absolute.filePath);
    await until(() => link.state.mentions === 2);
    assert.deepEqual(await submittedMentions(link), [absolute], 'tool errors preserve absolute mentions only');
    isError = false;
    answer = false;
    const before = requests;
    send('selected.ts');
    await until(() => link.state.mentions === 1);
    const pending = submittedMentions(link);
    await until(() => requests === before + 1);
    send(absolute.filePath);
    await until(() => link.state.mentions === 2);
    let lookupFinished = false;
    void pending.then(() => { lookupFinished = true; });
    await until(() => lookupFinished, 2000);
    assert.deepEqual(await pending, [], 'the one-second workspace deadline beats the three-second RPC timeout');
    assert.deepEqual(await submittedMentions(link), [absolute], 'new notifications belong to the next batch');
    assert.equal(requests, before + 1, 'absolute-only batches do not need the editor root');

    send('selected.ts');
    send(absolute.filePath);
    await until(() => link.state.mentions === 2);
    const interrupted = submittedMentions(link);
    let finished = false;
    void interrupted.then(() => { finished = true; });
    await until(() => requests === before + 2);
    link.reconnect();
    await until(() => finished, 1000);
    assert.deepEqual(await interrupted, [absolute], 'an interrupted lookup cannot resolve against a replacement editor');
    await until(() => link.connected);

    send('selected.ts');
    send(absolute.filePath);
    await until(() => link.state.mentions === 2);
    await link.stop();
    assert.deepEqual(await submittedMentions(link), [absolute], 'relative mentions cannot survive into a replacement editor');
  } finally {
    await link.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});
