import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import computerUse from './index.ts';

const register = () => {
  const handlers = new Map<string, () => Promise<void>>(), tools = new Map<string, any>();
  computerUse({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  return { handlers, call: (name: string, params = {}, signal?: AbortSignal) => tools.get(name).execute('test', params, signal, undefined, {}) };
};

test('invalid browser URLs spawn nothing and preserve host selection', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp('/tmp/pi-url-'), saved = process.env.PATH;
  await writeFile(join(dir, 'bwrap'), `#!/bin/sh\ntouch '${dir}/spawned'\nexit 1\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${saved}`;
  const pi = register();
  try {
    for (const params of [
      {}, { url: 'file:///tmp/a' }, { url: 'https://user:pass@example.com' },
      { url: 'https://example.com/\n' }, { url: 'https://example.com/%00' }, { url: 'https://example.com/\u0085' },
      { url: 'https://example.com/' + 'a'.repeat(2048) },
      { url: 'https://example.com', argv: ['--no-sandbox'] },
    ]) await assert.rejects(pi.call('computer_open', params), /Invalid browser URL/);
    assert.equal((await pi.call('computer_accessibility')).details.target, 'host');
    await assert.rejects(readFile(join(dir, 'spawned')), { code: 'ENOENT' });
  } finally {
    await pi.handlers.get('session_shutdown')!();
    if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

const namespaceProbe = process.platform === 'linux' ? spawnSync('bwrap', ['--new-session', '--die-with-parent', '--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], { encoding: 'utf8', timeout: 3000 }) : undefined;
const namespaceSkip = namespaceProbe?.status === 0 ? false : `real bwrap PID namespace unavailable: ${namespaceProbe?.error?.message ?? namespaceProbe?.stderr ?? process.platform}`;
const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean = Boolean): Promise<T> => {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { const value = await read(); if (accept(value)) return value; } catch (error) { if (Date.now() >= deadline) throw error; }
    if (Date.now() >= deadline) throw new Error('fixture condition timed out');
    await delay(20);
  }
};
const fixture = async () => {
  const dir = await mkdtemp('/tmp/pi-isof-');
  const saved = { ...process.env };
  for (const name of ['sway', 'swaymsg', 'chromium', 'grim', 'wtype', 'wl-copy', 'wl-paste']) await symlink(resolve('tests/fixtures/isolated-desktop.mjs'), join(dir, name));
  let hostConnections = 0;
  const hostSocket = join(dir, 'host-wayland');
  const host = createServer(socket => { hostConnections++; socket.destroy(); });
  await new Promise<void>(resolve => host.listen(hostSocket, resolve));
  Object.assign(process.env, {
    PATH: `${dir}:${saved.PATH}`, XDG_RUNTIME_DIR: dir, HOME: dir,
    DISPLAY: ':99', WAYLAND_DISPLAY: hostSocket, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/never/host-dbus',
    HYPRLAND_INSTANCE_SIGNATURE: 'host', SWAYSOCK: '/never/host-sway',
    NODE_OPTIONS: '--no-warnings', AWS_SECRET_ACCESS_KEY: 'must-not-leak', WLR_BACKENDS: 'wayland',
  });
  const pi = register();
  return { ...pi, dir, get hostConnections() { return hostConnections; }, async close() {
    try { await pi.handlers.get('session_shutdown')!(); }
    finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise<void>(resolve => host.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    }
  } };
};

test('open routes screenshots and input to a private ready output without host session environment', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    const url = "https://example.com/path;param?q=$HOME&name=O'Reilly&literal=$(id)";
    const opened = await pi.call('computer_open', { url });
    assert.equal(opened.details.target, 'isolated');
    assert.equal(opened.details.output, 'PRIVATE-1');
    const dirs = (await readdir(pi.dir)).filter(name => name.startsWith('pi-cu-'));
    assert.equal(dirs.length, 1);
    const runtime = join(pi.dir, dirs[0]);
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    const browser = await eventually(async () => JSON.parse(await readFile(join(runtime, 'browser.json'), 'utf8')));
    for (const key of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE', 'SWAYSOCK', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY']) assert.equal(browser.env[key], undefined, key);
    assert.equal(browser.env.WLR_BACKENDS, 'headless');
    assert.equal(browser.env.WLR_RENDERER, 'pixman');
    assert.equal(browser.env.HOME, join(runtime, 'home'));
    assert.ok(browser.args.includes(`--user-data-dir=${join(runtime, 'profile')}`));
    assert.ok(browser.args.includes('--ozone-platform=wayland'));
    assert.ok(!browser.args.includes('--no-sandbox'));
    assert.deepEqual(browser.args.slice(-2), ['--', url]);
    const shot = await pi.call('computer_screenshot');
    assert.equal(shot.details.target, 'isolated');
    assert.equal(shot.details.output, 'PRIVATE-1');
    assert.equal(shot.details.width, 1);
    await pi.call('computer_click', { output: 'PRIVATE-1', x: 0.25, y: 0.5 });
    await pi.call('computer_scroll', { output: 'PRIVATE-1', dx: 0, dy: 20 });
    await pi.call('computer_type', { text: 'literal $HOME; `hello`' });
    const typed = JSON.parse(await readFile(join(runtime, 'typed.json'), 'utf8'));
    assert.equal(typed.text, 'literal $HOME; `hello`');
    assert.deepEqual(typed.args, ['-s', '200', '-M', 'ctrl', '-k', 'v', '-m', 'ctrl', '-s', '100']);
    const copied = JSON.parse(await readFile(join(runtime, 'clipboard-started.json'), 'utf8'));
    assert.equal(copied.text, 'literal $HOME; `hello`');
    assert.deepEqual(copied.args, ['--foreground', '--type', 'text/plain;charset=utf-8']);
    const clipboardCommands = (await readFile(join(runtime, 'clipboard-commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const command of [copied, typed, ...clipboardCommands]) {
      assert.equal(command.env.WAYLAND_DISPLAY, join(runtime, 'wayland-fixture'));
      assert.equal(command.env.XDG_RUNTIME_DIR, runtime);
      for (const key of ['DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE', 'SWAYSOCK', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY']) assert.equal(command.env[key], undefined, key);
    }
    assert.equal(pi.hostConnections, 0);
    const wire = (await readFile(join(runtime, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(wire.some(request => request.op === 1 && request.body.length === 20 && Buffer.from(request.body).readUInt32LE(4) === 250000));
    assert.ok(wire.some(request => request.op === 3 && request.body.length === 12));
    assert.equal((await pi.call('computer_accessibility')).details.target, 'isolated');
    assert.equal((await pi.call('computer_close')).details.target, 'isolated');
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
  } finally { await pi.close(); }
});

test('an already-cancelled replacement preserves the current isolated browser', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await pi.call('computer_open', { url: 'https://example.com' });
    const runtime = await privateDirectory(pi.dir);
    const browser = await eventually(() => readFile(join(runtime, 'browser.json'), 'utf8'));
    await assert.rejects(pi.call('computer_open', { url: 'https://example.com/next' }, AbortSignal.abort()), /abort/i);
    assert.equal((await pi.call('computer_screenshot')).details.target, 'isolated');
    assert.equal(await readFile(join(runtime, 'browser.json'), 'utf8'), browser);
    assert.equal(pi.hostConnections, 0);
  } finally { await pi.close(); }
});

test('shutdown supersedes a session reset during a replacement open and leaves no private directory', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await pi.call('computer_open', { url: 'https://example.com/previous' });
    const previous = await privateDirectory(pi.dir);
    await eventually(() => descendantPids(previous), pids => pids.length > 0);
    await writeFile(join(pi.dir, 'mode'), 'wait');
    const opening = assert.rejects(pi.call('computer_open', { url: 'https://example.com' }), /shutdown|abort|startup/i);
    const runtime = await privateDirectory(pi.dir, previous);
    await eventually(() => descendantPids(runtime), pids => pids.length > 0);
    assert.deepEqual(await descendantPids(previous), []);
    await assert.rejects(lstat(previous), { code: 'ENOENT' });
    const reset = pi.handlers.get('session_start')!();
    const shutdown = pi.handlers.get('session_shutdown')!();
    await Promise.all([opening, reset, shutdown]);
    await assert.rejects(pi.call('computer_accessibility'), /session closed/i);
    assert.deepEqual((await readdir(pi.dir)).filter(name => name.startsWith('pi-cu-')), []);
    assert.deepEqual(await descendantPids(runtime), []);
    await pi.handlers.get('session_start')!();
    assert.equal((await pi.call('computer_accessibility')).details.target, 'host');
  } finally { await pi.close(); }
});


test('open waits for an output announcement after the socket becomes available', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await writeFile(join(pi.dir, 'mode'), 'delayed-output');
    assert.equal((await pi.call('computer_open', { url: 'https://example.com' })).details.output, 'PRIVATE-1');
  } finally { await pi.close(); }
});


const privateDirectory = (dir: string, exclude?: string) => eventually(async () => {
  const name = (await readdir(dir)).find(name => name.startsWith('pi-cu-') && join(dir, name) !== exclude);
  return name ? join(dir, name) : undefined;
}) as Promise<string>;
const descendantPids = async (runtime: string) => {
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (args.includes('--descendant\0') && args.includes(runtime)) pids.push(Number(entry));
    } catch {}
  }
  return pids;
};
const assertStopped = async (pi: ReturnType<typeof register>) => {
  for (const [tool, params] of [
    ['computer_screenshot', {}], ['computer_accessibility', {}],
    ['computer_click', { output: 'PRIVATE-1', x: 0.5, y: 0.5 }],
    ['computer_scroll', { output: 'PRIVATE-1', dx: 0, dy: 10 }], ['computer_type', { text: 'no host input' }],
  ] as const) await assert.rejects(pi.call(tool, params), /isolated desktop stopped/i, tool);
};

test('startup failure and close stay isolated until session_start resets selection', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await writeFile(join(pi.dir, 'mode'), 'fail');
    const before = Date.now();
    await assert.rejects(pi.call('computer_open', { url: 'https://example.com' }), /fixture sway failed/);
    assert.ok(Date.now() - before < 3000, 'startup death rejects promptly');
    await assertStopped(pi);
    await assert.rejects(pi.call('computer_open', { url: 'https://user:password@example.com' }), /Invalid browser URL/);
    await assertStopped(pi);
    assert.equal((await pi.call('computer_close')).details.target, 'isolated');
    await assertStopped(pi);
    assert.deepEqual((await readdir(pi.dir)).filter(name => name.startsWith('pi-cu-')), []);
    assert.equal(pi.hostConnections, 0);
    await pi.handlers.get('session_start')!();
    assert.equal((await pi.call('computer_accessibility')).details.target, 'host');
  } finally { await pi.close(); }
});

test('replacement, close, and browser crash terminate setsid descendants before removing their profiles', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  const runtimes: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      await pi.call('computer_open', { url: `https://example.com/${i}` });
      const runtime = await privateDirectory(pi.dir); runtimes.push(runtime);
      await eventually(() => descendantPids(runtime), pids => pids.length > 0);
      if (i === 0) continue;
      assert.deepEqual(await descendantPids(runtimes[i - 1]), []);
      await assert.rejects(lstat(runtimes[i - 1]), { code: 'ENOENT' });
      if (i === 1) {
        await pi.call('computer_close');
        await assertStopped(pi);
      } else {
        await writeFile(join(runtime, 'crash'), 'exit');
        await eventually(async () => { try { await lstat(runtime); return false; } catch { return true; } });
        await assertStopped(pi);
      }
      assert.deepEqual(await descendantPids(runtime), []);
      await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    }
    assert.equal(pi.hostConnections, 0);
  } finally {
    await pi.close();
    for (const runtime of runtimes) assert.deepEqual(await descendantPids(runtime), []);
  }
});


test('cancelling the first open after children start is sticky and cleans the namespace', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await writeFile(join(pi.dir, 'mode'), 'no-output');
    const abort = new AbortController();
    const opening = assert.rejects(pi.call('computer_open', { url: 'https://example.com' }, abort.signal), /abort|cancel/i);
    const runtime = await privateDirectory(pi.dir);
    await eventually(() => descendantPids(runtime), pids => pids.length > 0);
    await eventually(async () => (await readFile(join(runtime, 'wire.jsonl'), 'utf8')).includes('"op":0'));
    abort.abort(); await opening;
    await assertStopped(pi);
    assert.equal(pi.hostConnections, 0);
    assert.deepEqual(await descendantPids(runtime), []);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    await assert.rejects(pi.call('computer_open', { url: 'https://example.com' }, AbortSignal.abort()), /abort/i);
    await assertStopped(pi);
  } finally { await pi.close(); }
});

test('SIGKILL of the tool owner kills its browser namespace including setsid descendants', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/isolated-parent.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const reaped = new Promise<void>(resolve => child.once('close', () => resolve()));
  let runtime: string | undefined;
  try {
    const ready = new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('\n')) resolve(JSON.parse(output.trim()).runtime); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`fixture owner exited: ${stderr}`)));
    });
    runtime = await ready;
    await eventually(() => descendantPids(runtime!), pids => pids.length > 0);
    child.kill('SIGKILL'); await reaped;
    await eventually(() => descendantPids(runtime!), pids => pids.length === 0);
    assert.deepEqual(await descendantPids(runtime), []);
  } finally {
    child.kill('SIGKILL'); await reaped;
    if (runtime) { await eventually(() => descendantPids(runtime!), pids => pids.length === 0); await rm(runtime, { recursive: true, force: true }); }
    await pi.close();
  }
});

test('an output that never becomes ready times out within the startup deadline and cleans up', { skip: namespaceSkip, timeout: 20000 }, async () => {
  const pi = await fixture();
  try {
    await writeFile(join(pi.dir, 'mode'), 'no-output');
    const before = Date.now();
    const opening = assert.rejects(pi.call('computer_open', { url: 'https://example.com' }), /timeout|timed out/i);
    const runtime = await privateDirectory(pi.dir);
    await eventually(() => descendantPids(runtime), pids => pids.length > 0);
    await opening;
    assert.ok(Date.now() - before < 17000, '15 second readiness deadline plus bounded teardown');
    await assertStopped(pi);
    assert.deepEqual(await descendantPids(runtime), []);
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    assert.equal(pi.hostConnections, 0);
  } finally { await pi.close(); }
});


test('browser death interrupts an active desktop command promptly and reports stopped', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await pi.call('computer_open', { url: 'https://example.com' });
    const runtime = await privateDirectory(pi.dir);
    await writeFile(join(runtime, 'grim-wait'), 'wait');
    const screenshot = assert.rejects(pi.call('computer_screenshot', {}, AbortSignal.timeout(4000)), /isolated desktop stopped/i);
    await eventually(() => readFile(join(runtime, 'grim-started')));
    const before = Date.now();
    await writeFile(join(runtime, 'crash'), 'exit');
    await screenshot;
    assert.ok(Date.now() - before < 1500, 'death invalidates the active transport');
    await assertStopped(pi);
    assert.equal(pi.hostConnections, 0);
  } finally { await pi.close(); }
});


test('inspection reconnects after a grim failure without replacing the browser', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await pi.call('computer_open', { url: 'https://example.com' });
    const runtime = await privateDirectory(pi.dir);
    const browser = await eventually(async () => JSON.parse(await readFile(join(runtime, 'browser.json'), 'utf8')));
    await writeFile(join(runtime, 'grim-fail'), 'fail once');
    assert.equal((await pi.call('computer_screenshot')).details.output, 'PRIVATE-1');
    assert.equal(await privateDirectory(pi.dir), runtime);
    assert.equal(JSON.parse(await readFile(join(runtime, 'browser.json'), 'utf8')).instance, browser.instance);
    assert.equal(pi.hostConnections, 0);
  } finally { await pi.close(); }
});

test('missing isolated prerequisites report the binary and leave sticky stopped selection', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp('/tmp/pi-nosway-'), saved = process.env.PATH;
  await writeFile(join(dir, 'bwrap'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  process.env.PATH = dir;
  const pi = register();
  try {
    await assert.rejects(pi.call('computer_open', { url: 'https://example.com' }), /prerequisite sway unavailable.*reload/i);
    await assertStopped(pi);
    assert.deepEqual(await readdir(dir), ['bwrap']);
  } finally {
    await pi.handlers.get('session_shutdown')!();
    if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved;
    await rm(dir, { recursive: true, force: true });
  }
});


test('startup errors include bounded stderr and remove the private directory', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    await writeFile(join(pi.dir, 'mode'), 'noisy-fail');
    await assert.rejects(pi.call('computer_open', { url: 'https://example.com' }), (error: Error) => {
      assert.match(error.message, /fixture sway failure/);
      assert.ok(error.message.length < 4500);
      return true;
    });
    assert.deepEqual((await readdir(pi.dir)).filter(name => name.startsWith('pi-cu-')), []);
    await assertStopped(pi);
  } finally { await pi.close(); }
});

test('an overlong host runtime path uses a short private fallback and a pinned absolute socket', { skip: namespaceSkip, timeout: 10000 }, async () => {
  const pi = await fixture();
  try {
    process.env.XDG_RUNTIME_DIR = join(pi.dir, 'long-runtime-'.repeat(10));
    await mkdir(process.env.XDG_RUNTIME_DIR, { mode: 0o700 });
    await pi.call('computer_open', { url: 'https://example.com' });
    const runtime = await readFile(join(pi.dir, 'latest-runtime'), 'utf8');
    assert.match(runtime, /^\/tmp\/pi-cu-/);
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    await pi.call('computer_type', { text: 'private' });
    const typed = JSON.parse(await readFile(join(runtime, 'typed.json'), 'utf8'));
    assert.equal(typed.env.WAYLAND_DISPLAY, join(runtime, 'wayland-fixture'));
    assert.ok(Buffer.byteLength(typed.env.WAYLAND_DISPLAY) <= 107);
    await pi.call('computer_close');
    await assert.rejects(lstat(runtime), { code: 'ENOENT' });
    assert.equal(pi.hostConnections, 0);
  } finally { await pi.close(); }
});
