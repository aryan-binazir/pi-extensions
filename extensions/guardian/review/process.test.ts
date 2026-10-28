import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runBounded, runStarted } from './process.ts';

const node = (script: string) => [process.execPath, ['-e', script]] as const;

test('bounded external commands preserve argv and stdin through the POSIX shell owner', async () => {
  const echo = await runBounded('/bin/echo', ['ACTUAL_OK'], { cwd: tmpdir(), timeoutMs: 2000, maxBytes: 100 });
  assert.equal(echo.exitCode, 0);
  assert.equal(echo.stdout, 'ACTUAL_OK\n');
  assert.equal(echo.spawnError, undefined);
  const args = ['space here', '', '"quoted"', '$(printf REINTERPRETED)', 'A=B', '--', '\n'];
  const result = await runBounded(process.execPath, ['-e', "let stdin='';process.stdin.on('data',chunk=>stdin+=chunk).on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),stdin})))", '--', ...args], {
    cwd: tmpdir(), stdin: 'exact stdin\nsecond line', timeoutMs: 2000, maxBytes: 2000,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args, stdin: 'exact stdin\nsecond line' });
});

test('executable names stay external, including builtins, assignments and leading hyphens', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'guardian-dispatch-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bin = join(cwd, '-bin');
  mkdirSync(bin);
  const args = ['-a', 'space here', '', 'A=B', '$(printf REINTERPRETED)'];
  const invocation = ['-e', "let stdin='';process.stdin.on('data',chunk=>stdin+=chunk).on('end',()=>console.log(JSON.stringify({argv0:process.argv0,args:process.argv.slice(1),stdin})))", '--', ...args];
  for (const name of ['-a', '--', '-', 'cd', 'A=B']) {
    const executable = join(bin, name);
    symlinkSync(process.execPath, executable);
    for (const command of [name, `-bin/${name}`]) {
      const result = await runBounded(command, invocation, {
        cwd, env: { ...process.env, PATH: '-bin', 'BASH_FUNC_cd%%': '() { echo REINTERPRETED; }', 'BASH_FUNC_command%%': '() { echo REINTERPRETED; }' }, stdin: 'unaltered\n', timeoutMs: 2000, maxBytes: 2000,
      });
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { argv0: command, args, stdin: 'unaltered\n' });
    }
  }
  const handled = await runBounded('-bin/-a', ['-e', "process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('SURVIVED');process.exit(7)},50));setInterval(()=>{},1000);process.kill(0,'SIGTERM');"], {
    cwd, timeoutMs: 2000, maxBytes: 100,
  });
  assert.equal(handled.exitCode, 7, 'a handled group signal must wait for a hyphen-leading command');
  assert.equal(handled.stdout, 'SURVIVED');
  const missing = await runBounded('-'.repeat(2000), [], { cwd, env: { ...process.env, PATH: '-bin' }, timeoutMs: 2000, maxBytes: 100 });
  assert.ok(missing.spawnError && missing.spawnError.length < 600, 'failed executable lookup must keep diagnostics bounded');
});

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
  assert.match((await runBounded('/nonexistent/binary', [], { cwd: tmpdir(), timeoutMs: 1_000, maxBytes: 1_000 })).spawnError ?? '', /No such file|not found/);
});

test('an inherited pipe writer is stopped when its command exits without signalling reaped groups', async t => {
  const pidFile = `${tmpdir()}/guardian-writer-${process.pid}-${Date.now()}`;
  let descendant = 0;
  t.after(() => {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    rmSync(pidFile, { force: true });
  });
  const originalKill = process.kill;
  const kills: number[] = [];
  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => { kills.push(pid); return originalKill(pid, signal); }) as typeof process.kill);
  const script = `
    process.stdout.write('PARENT DONE');
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.stdout.on('error',()=>{});setInterval(()=>process.stdout.write('x'.repeat(1000)),10);process.send('ready');"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', () => {
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.disconnect(); child.unref();
    });
  `;
  const began = Date.now();
  const result = await runBounded(process.execPath, ['-e', script], { cwd: tmpdir(), env: { ...process.env, SHELLOPTS: 'errexit:monitor' }, timeoutMs: 1500, maxBytes: 200 });
  descendant = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(Date.now() - began < 1000, 'the pipe writer must not keep a completed command waiting for its deadline');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /PARENT DONE/);
  assert.ok(result.stdout.length < 300);
  assert.deepEqual(kills, [], 'the parent must not signal a completed group');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => originalKill(descendant, 0), /ESRCH/);
  descendant = 0;
});

test('the command status survives group cleanup and its report pipe is private', async () => {
  for (const [script, expected] of [['process.exit(3)', 3], ["process.kill(process.pid, 'SIGTERM')", 143], ["process.kill(0, 'SIGTERM')", 143]] as const) {
    const result = await runBounded(process.execPath, ['-e', script], {
      cwd: tmpdir(), env: { ...process.env, SHELLOPTS: 'errexit:monitor:xtrace', 'BASH_FUNC_printf%%': '() { echo 99; }', 'BASH_FUNC_kill%%': '() { return 0; }' }, timeoutMs: 2000, maxBytes: 100,
    });
    assert.equal(result.exitCode, expected);
    assert.equal(result.spawnError, undefined);
    assert.doesNotMatch(result.stderr, /process\.exit|process\.kill/, 'exported tracing cannot print the command arguments');
  }
  const forged = await runBounded('/bin/sh', ['-c', 'echo 99 >&3'], { cwd: tmpdir(), timeoutMs: 2000, maxBytes: 1000 });
  assert.ok(forged.exitCode === 1 || forged.exitCode === 2, 'the command reports its shell redirection error, not the forged status');
  assert.match(forged.stderr, /Bad file descriptor/);
});

test('exported shell job control cannot let the command escape its timeout', async t => {
  const pidFile = `${tmpdir()}/guardian-monitor-${process.pid}-${Date.now()}`;
  let pid = 0;
  t.after(() => {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(pidFile, { force: true });
  });
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const result = await runBounded(process.execPath, ['-e', script], {
    cwd: tmpdir(), env: { ...process.env, SHELLOPTS: 'errexit:monitor' }, timeoutMs: 500, maxBytes: 100,
  });
  pid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(result.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the timeout must reach the command even with exported job control');
  pid = 0;
});

test('completion leaves a descendant that created another process group alive', async t => {
  const pidFile = `${tmpdir()}/guardian-outsider-${process.pid}-${Date.now()}`;
  let outsider = 0;
  t.after(() => {
    if (outsider) { try { process.kill(outsider, 'SIGKILL'); } catch {} }
    rmSync(pidFile, { force: true });
  });
  const script = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref(); process.stdout.write('DONE');
  `;
  const result = await runBounded(process.execPath, ['-e', script], { cwd: tmpdir(), timeoutMs: 2000, maxBytes: 100 });
  outsider = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'DONE');
  assert.doesNotThrow(() => process.kill(outsider, 0), 'the other group is outside command ownership');
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

test('cleanup waits honour cancellation without misreporting completed commands', async t => {
  const originalKill = process.kill;
  const kills: number[] = [];
  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => { kills.push(pid); return originalKill(pid, signal); }) as typeof process.kill);
  for (const abort of [true, false]) {
    const controller = new AbortController();
    const run = runStarted(async () => {
      const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      if (abort) child.once('exit', () => setTimeout(() => controller.abort(), 20));
      return { child, finished: new Promise<void>(() => {}) };
    }, { cwd: tmpdir(), signal: controller.signal, timeoutMs: abort ? 2000 : 1000, maxBytes: 100 });
    const outcome = await Promise.race([run, new Promise<undefined>(resolve => setTimeout(resolve, 2500))]);
    assert.ok(outcome, 'completion cleanup cannot hold settlement beyond the budget');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.aborted, false);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.spawnError, undefined);
  }
  assert.deepEqual(kills, [], 'completion cancellation must not kill a reaped process group');
});

test('cancellation after exit preserves the command result while buffered output drains', async t => {
  const originalKill = process.kill;
  const kills: number[] = [];
  t.mock.method(process, 'kill', ((pid: number, signal?: NodeJS.Signals | number) => { kills.push(pid); return originalKill(pid, signal); }) as typeof process.kill);
  const controller = new AbortController();
  const result = await runStarted(async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('tail')"], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pause();
    child.once('exit', () => { controller.abort(); child.stdout.resume(); });
    return { child, finished: new Promise<void>(() => {}) };
  }, { cwd: tmpdir(), signal: controller.signal, timeoutMs: 10_000, maxBytes: 100 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.aborted, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'tail');
  assert.deepEqual(kills, [], 'an exited group must not be signalled while its output drains');
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


test('cancellation drains pipe output written after the group exits within a bounded grace', async t => {
  const pidFile = `${tmpdir()}/guardian-drain-${process.pid}-${Date.now()}`;
  t.after(() => {
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    rmSync(pidFile, { force: true });
  });
  const controller = new AbortController();
  const script = `
const {spawn}=require('node:child_process');
const watcher = "const fs=require('node:fs');process.stdout.on('error',()=>process.exit());fs.writeFileSync(" + JSON.stringify(${JSON.stringify(pidFile)}) + ",String(process.pid));const timer=setInterval(()=>{try{process.kill(" + process.pid + ",0)}catch{clearInterval(timer);process.stdout.write('TAIL',()=>process.exit())}},1);process.stdout.write('READY');setTimeout(()=>process.exit(),5000).unref();";
spawn(process.execPath,['-e',watcher],{detached:true,stdio:['ignore','inherit','inherit']});
setInterval(()=>{},1000);
`;
  const result = await runBounded(process.execPath, ['-e', script], {
    cwd: tmpdir(), signal: controller.signal, timeoutMs: 3000, maxBytes: 1000,
    onData: chunk => { if (chunk.toString().includes('READY')) controller.abort(); },
  });
  assert.equal(result.aborted, true);
  assert.match(result.stdout, /READY.*TAIL/);
});
