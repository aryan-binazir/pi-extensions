import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runBounded, runStarted } from './process.ts';

const node = (script: string) => [process.execPath, ['-e', script]] as const;

test('output beyond the cap keeps its head and tail', async () => {
  const [command, args] = node("process.stdout.write('A'.repeat(1000) + 'B'.repeat(5_000_000) + 'Z'.repeat(1000))");
  const run = await runBounded(command, args, { cwd: tmpdir(), timeoutMs: 20_000, maxBytes: 4_000 });
  assert.equal(run.exitCode, 0);
  assert.ok(run.stdout.startsWith('A'.repeat(1000)) && run.stdout.endsWith('Z'.repeat(1000)));
  assert.match(run.stdout, /\[\.\.\. \d+ bytes omitted \.\.\.\]/);
  assert.ok(run.stdout.length < 4_200);
});

test('timeouts and cancellation kill the whole process group', async t => {
  const pidFile = `${tmpdir()}/guardian-grandchild-${process.pid}-${Date.now()}`;
  t.after(() => rmSync(pidFile, { force: true }));
  const [command, args] = node(`const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); setInterval(() => {}, 1000);`);
  const timedOut = await runBounded(command, args, { cwd: tmpdir(), timeoutMs: 500, maxBytes: 1_000 });
  assert.equal(timedOut.timedOut, true);
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'the grandchild was killed with its group');
  const controller = new AbortController();
  const pending = runBounded(command, args, { cwd: tmpdir(), timeoutMs: 20_000, maxBytes: 1_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  assert.equal((await pending).aborted, true);
});

test('stdin is delivered and spawn failures are reported', async () => {
  const [command, args] = node("let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(s.toUpperCase()))");
  assert.equal((await runBounded(command, args, { cwd: tmpdir(), stdin: 'hello', timeoutMs: 10_000, maxBytes: 1_000 })).stdout, 'HELLO');
  assert.match((await runBounded('/nonexistent/binary', [], { cwd: tmpdir(), timeoutMs: 1_000, maxBytes: 1_000 })).spawnError ?? '', /ENOENT/);
});


test('the deadline includes preparation and prevents launch after cancellation', async () => {
  let launched = false;
  const started = Date.now();
  const run = await runStarted(async signal => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    signal?.throwIfAborted();
    launched = true;
    return { child: spawn(process.execPath, ['-e', ''], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] }), finished: Promise.resolve() };
  }, { cwd: tmpdir(), timeoutMs: 40, maxBytes: 100 });
  assert.equal(run.timedOut, true);
  assert.equal(run.spawnError, undefined);
  assert.equal(launched, false);
  assert.ok(Date.now() - started < 180);
});

test('cancellation and deadlines remain active while completion cleanup is pending', async () => {
  for (const abort of [true, false]) {
    const controller = new AbortController();
    const run = runStarted(async () => {
      const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (abort) child.once('exit', () => setTimeout(() => controller.abort(), 20));
      return { child, finished: new Promise<void>(() => {}) };
    }, { cwd: tmpdir(), signal: controller.signal, timeoutMs: abort ? 1000 : 100, maxBytes: 100 });
    const outcome = await Promise.race([run, new Promise<undefined>(resolve => setTimeout(resolve, 400))]);
    assert.ok(outcome, 'completion cleanup cannot hold settlement beyond the budget');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.aborted, abort);
    assert.equal(outcome.timedOut, !abort);
    assert.equal(outcome.spawnError, undefined);
  }
});

test('an abandoned start that resolves late is terminated and reaped', async () => {
  let child: ReturnType<typeof spawn> | undefined;
  const result = await runStarted(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = started;
    return { child: started, finished: Promise.resolve() };
  }, { cwd: tmpdir(), timeoutMs: 20, maxBytes: 100 });
  assert.equal(result.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.ok(child?.pid);
  assert.throws(() => process.kill(child!.pid!, 0), /ESRCH/);
});
