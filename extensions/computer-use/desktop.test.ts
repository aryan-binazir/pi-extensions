import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxDesktop } from './native.ts';
import { DesktopSession, type DesktopBackend } from './desktop.ts';

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

for (const ending of ['timeout', 'exited wrapper', 'abort', 'shutdown', 'escaped descendant'] as const) test(`native ${ending} releases inherited pipes, queued work and close`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-timeout-'));
  const pidFile = join(runtime, 'pids');
  await writeFile(join(runtime, 'descendant.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n'); setInterval(() => {}, 1000);`);
  await writeFile(join(runtime, 'wtype'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n'); require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(runtime, 'descendant.cjs'))}], {stdio:'inherit', detached:${ending === 'escaped descendant'}}); ${ending === 'exited wrapper' ? `setInterval(() => { if (require('node:fs').readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim().split('\\n').length === 2) process.exit(0); }, 5);` : 'setInterval(() => {}, 1000);'}`, { mode: 0o755 });
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused' }), 1000);
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
    for (const [index, pid] of pids.entries()) assert.equal(await ownedProcessAlive(pid), ending === 'escaped descendant' && index === 1, `unexpected lifetime for owned process ${pid}`);
  } finally {
    for (const pid of pids) {
      try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(runtime)) process.kill(pid, 'SIGKILL'); } catch {}
    }
    await Promise.allSettled([operation, queued, session.close()]);
    await rm(runtime, { recursive: true, force: true });
  }
});

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native operation did not settle within 2500ms')), 2500); })]); }
  finally { clearTimeout(timer); }
}

async function ownedProcessAlive(pid: number): Promise<boolean> {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1][0] !== 'Z'; }
  catch { return false; }
}

for (const scenario of ['stdin', 'nonzero', 'exit 127', 'signal', 'unavailable', 'output cap'] as const) test(`native commands preserve ${scenario} behavior`, { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'pi-native-result-'));
  const inputFile = join(runtime, 'input');
  const scripts = {
    stdin: `const fs = require('node:fs'); const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(inputFile)}, Buffer.concat(chunks)));`,
    nonzero: 'process.exit(7);',
    'exit 127': 'process.exit(127);',
    signal: "process.kill(process.pid, 'SIGKILL');",
    unavailable: '',
    'output cap': `process.stdout.write(Buffer.alloc(17 * 1024 * 1024));`,
  };
  if (scenario !== 'unavailable') await writeFile(join(runtime, 'wtype'), `#!${process.execPath}\n${scripts[scenario]}`, { mode: 0o755 });
  const session = new DesktopSession(() => new LinuxDesktop({ PATH: runtime, WAYLAND_DISPLAY: '/synthetic-unused' }), 5000);
  const text = 'exact input: héllo\nquotes " $; -- 🏀\tend\n';
  try {
    const operation = session.run({ action: 'type', text });
    if (scenario === 'stdin') {
      assert.equal((await bounded(operation)).dispatched, true);
      assert.deepEqual(await readFile(inputFile), Buffer.from(text));
    } else {
      const messages = { nonzero: /failed \(7\)/, 'exit 127': /failed \(127\)/, signal: /failed \(null\)/, unavailable: /wtype unavailable; install its documented prerequisite/, 'output cap': /output exceeded limit/ };
      await bounded(assert.rejects(operation, messages[scenario]));
    }
    assert.equal((await bounded(session.run({ action: 'accessibility' }))).available, false);
    await bounded(session.close());
  } finally {
    await session.close();
    await rm(runtime, { recursive: true, force: true });
  }
});
