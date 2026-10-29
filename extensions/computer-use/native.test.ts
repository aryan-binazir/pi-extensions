import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxDesktop } from './native.ts';
import { DesktopSession } from './desktop.ts';

const fixture = async () => {
  const runtime = await mkdtemp('/tmp/pi-paste-');
  for (const name of ['wtype', 'wl-copy', 'wl-paste']) await symlink(resolve('tests/fixtures/isolated-desktop.mjs'), join(runtime, name));
  const env = { PATH: `${runtime}:${process.env.PATH}`, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: join(runtime, 'private-wayland') };
  return { runtime, env, read: async (name: string) => JSON.parse(await readFile(join(runtime, name), 'utf8')) };
};
const eventually = async <T>(read: () => Promise<T>, accept: (value: T) => boolean = Boolean): Promise<T> => {
  const deadline = Date.now() + 3000;
  for (;;) {
    try { const value = await read(); if (accept(value)) return value; } catch (error) { if (Date.now() >= deadline) throw error; }
    if (Date.now() >= deadline) throw new Error('clipboard fixture condition timed out');
    await delay(10);
  }
};
const alive = async (pid: number) => {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; }
  catch { return false; }
};

test('opt-in paste preserves literal stdin and private clipboard command arguments', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const f = await fixture();
  const session = new DesktopSession(() => new LinuxDesktop(f.env, 'paste'));
  const text = 'literal $HOME; `hello` $(exit 91) \'"\\ 😀é\n\n';
  try {
    await writeFile(join(f.runtime, 'clipboard.json'), JSON.stringify({ text: 'stale selection' }));
    await session.run({ action: 'type', text });
    const typed = await f.read('typed.json');
    assert.equal(typed.text, text);
    assert.deepEqual(typed.args, ['-s', '200', '-M', 'ctrl', '-k', 'v', '-m', 'ctrl', '-s', '100']);
    const copied = await f.read('clipboard-started.json');
    assert.equal(copied.text, text);
    assert.deepEqual(copied.args, ['--foreground', '--type', 'text/plain;charset=utf-8']);
    const commands = (await readFile(join(f.runtime, 'clipboard-commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(commands[0].args, ['--clear']);
    assert.ok(commands.filter(command => command.command === 'wl-paste').length >= 2, 'empty selection is retried before MIME readiness');
    for (const command of [...commands, typed, copied]) assert.equal(command.env.WAYLAND_DISPLAY, f.env.WAYLAND_DISPLAY);
    assert.equal(await alive(copied.pid), true);
    await session.close();
    await eventually(() => alive(copied.pid), value => !value);
  } finally { await session.close(); await rm(f.runtime, { recursive: true, force: true }); }
});

test('default text entry retains foreground wtype stdin and leaves the clipboard untouched', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture(), desktop = new LinuxDesktop(f.env);
  try {
    await writeFile(join(f.runtime, 'clipboard.json'), JSON.stringify({ text: 'existing selection' }));
    await desktop.run({ action: 'type', text: 'literal $HOME; `hello`\n' }, new AbortController().signal);
    const typed = await f.read('typed.json');
    assert.equal(typed.text, 'literal $HOME; `hello`\n');
    assert.deepEqual(typed.args, ['-']);
    assert.equal((await f.read('clipboard.json')).text, 'existing selection');
    await assert.rejects(f.read('clipboard-commands.jsonl'), { code: 'ENOENT' });
  } finally { await desktop.close(); await rm(f.runtime, { recursive: true, force: true }); }
});

test('empty paste spawns no commands and leaves the private selection untouched', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture(), desktop = new LinuxDesktop(f.env, 'paste');
  try {
    await writeFile(join(f.runtime, 'clipboard.json'), JSON.stringify({ text: 'existing selection' }));
    assert.equal((await desktop.run({ action: 'type', text: '' }, new AbortController().signal)).dispatched, true);
    assert.equal((await f.read('clipboard.json')).text, 'existing selection');
    for (const name of ['clipboard-commands.jsonl', 'typed.json']) await assert.rejects(f.read(name), { code: 'ENOENT' });
  } finally { await desktop.close(); await rm(f.runtime, { recursive: true, force: true }); }
});

test('a new paste replaces its owned clipboard and close reaps the replacement', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const f = await fixture(), session = new DesktopSession(() => new LinuxDesktop(f.env, 'paste'));
  try {
    await session.run({ action: 'type', text: 'first' });
    const first = await f.read('clipboard-started.json');
    assert.equal(await alive(first.pid), true);
    await session.run({ action: 'type', text: 'second' });
    const second = await f.read('clipboard-started.json');
    assert.notEqual(second.pid, first.pid);
    await eventually(() => alive(first.pid), value => !value);
    assert.equal((await f.read('typed.json')).text, 'second');
    assert.equal(await alive(second.pid), true);
    await session.close();
    await eventually(() => alive(second.pid), value => !value);
  } finally { await session.close(); await rm(f.runtime, { recursive: true, force: true }); }
});

for (const failure of ['wl-clear-fail', 'wl-copy-fail', 'wl-paste-fail', 'wtype-fail']) test(`paste fails and reaps its clipboard owner on ${failure}`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const f = await fixture(), session = new DesktopSession(() => new LinuxDesktop(f.env, 'paste'), 3000);
  try {
    await writeFile(join(f.runtime, failure), 'fail');
    await assert.rejects(session.run({ action: 'type', text: 'once' }), /outcome may be partial or unknown.*runtime .* failed/);
    if (failure !== 'wl-clear-fail') await eventually(async () => alive((await f.read('clipboard-started.json')).pid), value => !value);
    if (failure !== 'clipboard-exit-fail') await assert.rejects(f.read('typed.json'), { code: 'ENOENT' });
    assert.equal((await session.run({ action: 'accessibility' })).available, false);
  } finally { await session.close(); await rm(f.runtime, { recursive: true, force: true }); }
});

for (const ending of ['abort', 'shutdown', 'timeout']) test(`paste ${ending} kills its shell, clipboard owner and owned descendant`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const f = await fixture(), session = new DesktopSession(() => new LinuxDesktop(f.env, 'paste'), 1500);
  const controller = new AbortController();
  const pids: number[] = [];
  let operation: Promise<void> | undefined;
  try {
    for (const name of ['clipboard-wait', 'clipboard-descendant']) await writeFile(join(f.runtime, name), 'wait');
    operation = assert.rejects(session.run({ action: 'type', text: 'once' }, controller.signal), /outcome may be partial or unknown/);
    const copied = await eventually(() => f.read('clipboard-started.json'));
    const descendant = await eventually(() => f.read('descendant.json'));
    pids.push(copied.parent, copied.pid, descendant.pid);
    if (ending === 'abort') controller.abort();
    if (ending === 'shutdown') await session.close();
    await operation;
    await session.close();
    for (const pid of pids) await eventually(() => alive(pid), value => !value);
    await assert.rejects(f.read('typed.json'), { code: 'ENOENT' });
  } finally {
    await session.close(); await operation?.catch(() => {});
    for (const pid of pids) { try { if (await alive(pid)) process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(f.runtime, { recursive: true, force: true });
  }
});
