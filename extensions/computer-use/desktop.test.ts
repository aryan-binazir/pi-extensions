import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { openSync, fstatSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxDesktop } from './native.ts';
import { DesktopSession, type DesktopBackend } from './desktop.ts';

const fixtureNode = process.env.NATIVE_FIXTURE_NODE ?? process.execPath;

test('desktop serializes operations and does not repeat mutations after transport failure', async () => {
  let active = 0, maximum = 0, calls = 0;
  const backend: DesktopBackend = {
    async run() { calls++; active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; throw new Error('Disconnected'); },
    close() {},
  };
  const session = new DesktopSession(() => backend);
  await Promise.allSettled([session.run({ action: 'type', text: 'first' }), session.run({ action: 'type', text: 'second' })]);
  assert.equal(maximum, 1); assert.equal(calls, 2);
  await session.close();
});

test('inspection reconnects once after a transport failure', async () => {
  let created = 0, closed = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run() { if (generation === 1) throw new Error('stale socket'); return { available: true }; }, close() { closed++; } };
  });
  assert.deepEqual(await session.run({ action: 'accessibility' }), { available: true });
  assert.equal(created, 2); await session.close(); assert.equal(closed, 2);
});

test('a timed-out mutation closes its transport and releases the queue', async () => {
  let closed = 0;
  const hanging = new DesktopSession(() => ({ run: () => new Promise<never>(() => {}), close() { closed++; } }), 15);
  await assert.rejects(hanging.run({ action: 'type', text: 'one' }), /outcome may be partial/);
  assert.equal(closed, 1);
  await hanging.close(); assert.equal(closed, 1);
});

test('invalid desktop commands never reach transport', async () => {
  let calls = 0;
  const session = new DesktopSession(() => ({ async run() { calls++; return {}; }, close() {} }));
  for (const action of [{ action: 'click', output: 'HEADLESS-1', x: NaN, y: 0 }, { action: 'type', text: 'x', command: 'oops' }, { action: 'scroll', output: 'a', dx: 100000, dy: 0 }]) {
    await assert.rejects(session.run(action as any), /Invalid desktop/);
  }
  assert.equal(calls, 0); await session.close();
});

test('already cancelled calls do not create a native transport', async () => {
  let created = 0;
  const session = new DesktopSession(() => { created++; throw new Error('must not run'); });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.run({ action: 'type', text: 'never' }, abort.signal), /abort/i);
  assert.equal(created, 0); await session.close();
});

test('inspection still reconnects when closing the failed transport also rejects', async () => {
  let created = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run() { if (generation === 1) throw new Error('stale socket'); return { available: true }; }, async close() { throw new Error('Close failed'); } };
  });
  assert.deepEqual(await session.run({ action: 'accessibility' }), { available: true });
  assert.equal(created, 2);
  await assert.rejects(session.close(), /Close failed/);
});

test('inspection that cannot be retried keeps its originating failure as the cause of a close failure', async () => {
  const failures = [new Error('first stale socket'), new Error('second stale socket')];
  let created = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run(): Promise<never> { throw failures[generation - 1]; }, async close() { throw new Error('Close failed'); } };
  });
  await assert.rejects(session.run({ action: 'accessibility' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Close failed/);
    assert.equal(error.cause, failures[1]);
    return true;
  });
  assert.equal(created, 2);
  await session.close();
});

test('failed mutation retains its unknown-outcome warning when transport close rejects', async () => {
  const failure = new Error('Disconnected during typing');
  const session = new DesktopSession(() => ({
    async run() { throw failure; },
    async close() { throw new Error('Close failed'); },
  }));
  try {
    await assert.rejects(session.run({ action: 'type', text: 'once' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Desktop mutation failed or was cancelled; outcome may be partial or unknown/);
      assert.equal(error.cause, failure);
      return true;
    });
  } finally { await session.close(); }
});

for (const ending of ['timeout', 'exited wrapper', 'abort', 'shutdown', 'escaped descendant', 'stderr descendant', 'shell environment'] as const) test(`native ${ending} releases inherited pipes, queued work and close`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-timeout-'));
  const pidFile = join(runtime, 'pids');
  const descendant = join(runtime, 'descendant.cjs');
  await writeFile(descendant, `
require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 5000);
`);
  const lifetime = ending === 'exited wrapper'
    ? `setInterval(() => { if (require('node:fs').readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim().split('\\n').length === 2) process.exit(0); }, 5);`
    : 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);';
  const stdio = ending === 'stderr descendant' ? ['ignore', 'ignore', 'inherit'] : 'inherit';
  await writeFile(join(runtime, 'wtype'), `#!${fixtureNode}
require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], {stdio:${JSON.stringify(stdio)}, detached:${ending === 'escaped descendant'}});
${lifetime}
`, { mode: 0o755 });
  const inherited = ending === 'shell environment' ? { SHELLOPTS: 'monitor:errexit:xtrace', TMOUT: '1', 'BASH_FUNC_read%%': '() { return 1; }', 'BASH_FUNC_kill%%': '() { return 0; }', 'BASH_FUNC_printf%%': '() { return 0; }' } : {};
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused', ...inherited }), 1000);
  const pids: number[] = [];
  const controller = new AbortController();
  const operation = assert.rejects(session.run({ action: 'type', text: 'synthetic input' }, controller.signal), /outcome may be partial or unknown/);
  const queued = session.run({ action: 'accessibility' }).then(value => value, error => error);
  let closing: Promise<void> | undefined;
  try {
    await bounded((async () => {
      for (let attempt = 0; attempt < 150 && pids.length < 2; attempt++) {
        try { pids.splice(0, pids.length, ...(await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)); } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(pids.length, 2, 'owned wrapper and descendant started');
    })());
    if (ending === 'abort') controller.abort(new Error('synthetic cancellation'));
    if (ending === 'shutdown') closing = session.close();
    await bounded(operation);
    const inspection = await bounded(queued);
    if (ending === 'shutdown') assert.match(String(inspection), /session closed/);
    else assert.equal(inspection.available, false);
    if (closing) await bounded(closing);
    await bounded(session.close());
    for (const [index, pid] of pids.entries()) {
      if (ending === 'escaped descendant' && index === 1) assert.equal(await ownedProcessAlive(pid), true);
      else await bounded((async () => { while (await ownedProcessAlive(pid)) await new Promise(resolve => setTimeout(resolve, 10)); })());
    }
  } finally {
    try { pids.splice(0, pids.length, ...(await readFile(pidFile, 'utf8')).trim().split('\n').map(Number)); } catch {}
    for (const pid of pids) {
      try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(runtime)) process.kill(pid, 'SIGKILL'); } catch {}
    }
    try { await bounded(Promise.allSettled([operation, queued, session.close()])); }
    finally { await rm(runtime, { recursive: true, force: true }); }
  }
});

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native operation did not settle within 2500ms')), 2500); })]); }
  finally { clearTimeout(timer); }
}

async function ownedProcessAlive(pid: number): Promise<boolean> {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; }
  catch { return false; }
}

for (const scenario of ['stdin', 'nonzero', 'exit 127', 'signal', 'unavailable', 'missing interpreter', 'output cap'] as const) test(`native commands preserve ${scenario} behavior`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-result-'));
  const inputFile = join(runtime, 'input');
  const scripts = {
    stdin: `const fs = require('node:fs'); const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(inputFile)}, Buffer.concat(chunks)));`,
    nonzero: 'process.exit(7);',
    'exit 127': 'process.exit(127);',
    signal: "process.kill(process.pid, 'SIGKILL');",
    unavailable: '',
    'missing interpreter': '',
    'output cap': `process.stdout.write(Buffer.alloc(17 * 1024 * 1024));`,
  };
  if (scenario !== 'unavailable') await writeFile(join(runtime, 'wtype'), scenario === 'missing interpreter' ? '#!/synthetic-missing-interpreter\n' : `#!${fixtureNode}\n${scripts[scenario]}`, { mode: 0o755 });
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused' }), 5000);
  const text = 'exact input: héllo\nquotes " $; -- 🏀\tend\n'.repeat(scenario === 'stdin' ? 200 : 1);
  try {
    const operation = session.run({ action: 'type', text });
    if (scenario === 'stdin') {
      assert.equal((await bounded(operation)).dispatched, true);
      assert.deepEqual(await readFile(inputFile), Buffer.from(text));
    } else {
      const messages = { nonzero: /failed \(7\)/, 'exit 127': /failed \(127\)/, signal: /failed \(null\)/, unavailable: /wtype unavailable; install its documented prerequisite/, 'missing interpreter': /wtype unavailable; install its documented prerequisite/, 'output cap': /output exceeded limit/ };
      await bounded(assert.rejects(operation, messages[scenario]));
    }
    assert.equal((await bounded(session.run({ action: 'accessibility' }))).available, false);
    await bounded(session.close());
  } finally {
    try { await bounded(session.close()); }
    finally { await rm(runtime, { recursive: true, force: true }); }
  }
});

test('native consecutive commands preserve unrelated owned descriptors', { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-consecutive-'));
  const descriptors: number[] = [];
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused' }));
  try {
    await writeFile(join(runtime, 'wtype'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (let i = 0; i < 100; i++) {
      assert.equal((await session.run({ action: 'type', text: 'owned input' })).dispatched, true);
      descriptors.push(openSync('/dev/null', 'r'));
    }
    (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const descriptor of descriptors) assert.equal(fstatSync(descriptor).isCharacterDevice(), true);
  } finally {
    for (const descriptor of descriptors) try { closeSync(descriptor); } catch {}
    try { await bounded(session.close()); }
    finally { await rm(runtime, { recursive: true, force: true }); }
  }
});

test('native normal completion ignores shell reader timeouts and exported functions', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-environment-'));
  const marker = join(runtime, 'overridden');
  const exported = `() { /bin/echo overridden >> ${marker}; return 0; }`;
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused', SHELLOPTS: 'monitor:errexit:xtrace', TMOUT: '1', 'BASH_FUNC_read%%': exported, 'BASH_FUNC_kill%%': exported, 'BASH_FUNC_printf%%': exported }), 5000);
  try {
    await writeFile(join(runtime, 'wtype'), `#!${fixtureNode}\nprocess.stdin.resume(); setTimeout(() => {}, 1200);`, { mode: 0o755 });
    assert.equal((await bounded(session.run({ action: 'type', text: 'owned input' }))).dispatched, true);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    try { await bounded(session.close()); }
    finally { await rm(runtime, { recursive: true, force: true }); }
  }
});

test('native success preserves descendants that released command pipes', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-success-'));
  const pidFile = join(runtime, 'pid');
  const descendant = join(runtime, 'descendant.cjs');
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused' }), 5000);
  let pid: number | undefined;
  try {
    await writeFile(descendant, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 5000);`);
    await writeFile(join(runtime, 'wtype'), `#!${fixtureNode}
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref();
setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 5);
`, { mode: 0o755 });
    assert.equal((await bounded(session.run({ action: 'type', text: 'owned input' }))).dispatched, true);
    pid = Number(await readFile(pidFile, 'utf8'));
    await bounded(session.close());
    assert.equal(await ownedProcessAlive(pid), true);
  } finally {
    try { pid = Number(await readFile(pidFile, 'utf8')); } catch {}
    if (pid) try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(runtime)) process.kill(pid, 'SIGKILL'); } catch {}
    try { await bounded(session.close()); }
    finally { await rm(runtime, { recursive: true, force: true }); }
  }
});
