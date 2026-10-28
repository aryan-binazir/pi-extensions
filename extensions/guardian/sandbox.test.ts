// Ported from openai/codex codex-rs/linux-sandbox/tests/suite/sandbox.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. These run commands under real bubblewrap, so they only run on Linux where it works;
// tests/suite cases for WSL, split policies, deny-read globs and the managed proxy are omitted with those features.
import assert from 'node:assert/strict';
import childProcess, { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { runStarted } from './review/process.ts';
import { bubblewrapSandbox, detectPlatformSandbox, sandboxEnv, type SandboxedProcess } from './sandbox.ts';
import { hashPath, syntheticMountRegistryRoot } from './synthetic-mounts.ts';
import { syscallNumber } from './seccomp.ts';
import { PROTECTED_METADATA_PATH_NAMES, type SandboxPolicy } from './seatbelt.ts';

const registryTemp = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-linux-registry-')));
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = registryTemp;
after(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
  rmSync(registryTemp, { recursive: true, force: true });
});

const { sandbox } = await detectPlatformSandbox();
const flock = ['/usr/bin/flock', '/bin/flock'].find(existsSync);
const bubblewrap = { skip: (sandbox?.kind !== 'bubblewrap' || !flock) && 'bubblewrap/flock prerequisites are unavailable' };
const hasProgram = (program: string) => spawnSync('sh', ['-c', `command -v ${program}`]).status === 0;

function tempDir(t: test.TestContext, prefix = 'guardian-linux-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Keeps every test's writes confined to the roots it names; `/tmp` and `$TMPDIR` are otherwise writable. */
const workspace = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy =>
  ({ mode: 'workspace-write', networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true, ...overrides });

async function run(command: readonly string[], policy: SandboxPolicy, cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = await runStarted(() => sandbox!.spawn(command, policy, { cwd, env, stdin: 'pipe' }), { cwd, timeoutMs: 20_000, maxBytes: 64 * 1024 });
  assert.equal(result.spawnError, undefined, result.spawnError);
  return result;
}

test('the root filesystem is readable', bubblewrap, async t => {
  const result = await run(['ls', '-l', '/bin'], workspace(), tempDir(t));
  assert.equal(result.exitCode, 0, result.stderr);
});

test('writes outside the writable roots fail', bubblewrap, async t => {
  const cwd = tempDir(t), outside = tempDir(t);
  const result = await run(['bash', '-c', `echo blah > ${outside}/file`], workspace(), cwd);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Read-only file system/);
  assert.equal(existsSync(join(outside, 'file')), false);
});

test('/dev/null is writable and the minimal device nodes exist', bubblewrap, async t => {
  const cwd = tempDir(t);
  assert.equal((await run(['bash', '-c', 'echo blah > /dev/null'], workspace(), cwd)).exitCode, 0);
  const nodes = await run(['bash', '-c', 'for node in null zero full random urandom tty; do [ -c "/dev/$node" ] || { echo "missing /dev/$node" >&2; exit 1; }; done'], workspace(), cwd);
  assert.equal(nodes.exitCode, 0, nodes.stderr);
});

test('a writable /dev/shm root stays bound to the host', bubblewrap, async t => {
  if (!existsSync('/dev/shm')) return t.skip('/dev/shm is unavailable');
  const target = join('/dev/shm', `guardian-${process.pid}-${Date.now()}`);
  writeFileSync(target, 'host-before');
  t.after(() => rmSync(target, { force: true }));
  const result = await run(['bash', '-c', `printf sandbox-after > ${target}`], workspace({ writableRoots: ['/dev/shm'] }), tempDir(t));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(readFileSync(target, 'utf8'), 'sandbox-after');
});

test('writable roots accept writes, and missing ones are ignored', bubblewrap, async t => {
  const cwd = tempDir(t), extra = tempDir(t);
  const result = await run(['bash', '-c', `echo blah > ${extra}/test && printf sandbox-ok`], workspace({ writableRoots: [extra, join(extra, 'missing')] }), cwd);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'sandbox-ok');
  assert.equal(readFileSync(join(extra, 'test'), 'utf8'), 'blah\n');
});

test('no_new_privs is set and no capabilities remain', bubblewrap, async t => {
  if (!hasProgram('python3')) return t.skip('python3 is unavailable');
  const cwd = tempDir(t);
  const nnp = await run(['python3', '-c', 'import ctypes; print(ctypes.CDLL(None).prctl(39, 0, 0, 0, 0))'], workspace(), cwd);
  assert.equal(nnp.stdout, '1\n', nnp.stderr);
  const caps = await run(['python3', '-c', 'import ctypes; h=(ctypes.c_uint*2)(0x20080522,0); d=(ctypes.c_uint*6)(); assert ctypes.CDLL(None).capget(h,d)==0; print(d[0],d[1],d[3],d[4])'], workspace(), cwd);
  assert.equal(caps.stdout, '0 0 0 0\n', caps.stderr);
});

test('commands see Codex\'s sandbox environment', bubblewrap, async t => {
  const result = await run(['bash', '-c', 'echo "${CODEX_SANDBOX:-unset} ${CODEX_SANDBOX_NETWORK_DISABLED:-unset}"'], workspace(), tempDir(t));
  assert.equal(result.stdout, 'unset 1\n');
  assert.deepEqual(sandboxEnv('bubblewrap', workspace({ networkAccess: true })), {});
});

for (const command of [['curl', '-I', 'http://openai.com'], ['wget', '-qO-', 'http://openai.com'], ['ping', '-c', '1', '8.8.8.8'], ['nc', '-z', '127.0.0.1', '80'],
  ['getent', 'ahosts', 'openai.com'], ['bash', '-c', 'echo hi > /dev/tcp/127.0.0.1/80']]) {
  test(`network is blocked: ${command.join(' ')}`, bubblewrap, async t => {
    if (!hasProgram(command[0])) return t.skip(`${command[0]} is unavailable`);
    const result = await run(command, workspace(), tempDir(t));
    assert.notEqual(result.exitCode, 0, `${command.join(' ')} exited 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });
}

test('the seccomp filter denies inet sockets, ptrace and io_uring without network, and VM sockets with it', bubblewrap, async t => {
  if (!hasProgram('python3')) return t.skip('python3 is unavailable');
  const cwd = tempDir(t);
  const probe = `import ctypes, os, socket
libc = ctypes.CDLL(None, use_errno=True)
def sys(nr, *args):
    return 'ok' if libc.syscall(nr, *args) >= 0 else os.strerror(ctypes.get_errno())
def sock(family):
    try:
        socket.socket(family, socket.SOCK_STREAM).close()
        return 'ok'
    except OSError as error:
        return os.strerror(error.errno)
print(sock(socket.AF_INET), sock(socket.AF_UNIX), sock(40), sys(${syscallNumber(process.arch, 'ptrace')}, 0, 0, 0, 0), sys(425, 1, 0), sep='|')`;
  const isolated = await run(['python3', '-c', probe], workspace(), cwd);
  assert.equal(isolated.stdout, 'Operation not permitted|ok|Operation not permitted|Operation not permitted|Operation not permitted\n', isolated.stderr);
  const networked = await run(['python3', '-c', probe], workspace({ networkAccess: true }), cwd);
  const [inet, unix, vsock, , ioUring] = networked.stdout.trim().split('|');
  assert.deepEqual([inet, unix, vsock, ioUring], ['ok', 'ok', 'Operation not permitted', 'Operation not permitted'], networked.stderr);
});

for (const [name, config] of [['.git', 'config'], ['.codex', 'config.toml'], ['.aws', 'config'], ['.pi', 'settings.json']]) {
  test(`metadata writes inside a writable root are blocked: ${name}`, bubblewrap, async t => {
    const cwd = tempDir(t), home = tempDir(t);
    mkdirSync(join(home, name));
    const target = join(home, name, config);
    writeFileSync(target, 'original');
    const script = 'set -eu\nprintf permitted > "$1/allowed"\nif (printf changed > "$2") 2>/dev/null; then exit 1; fi\nprintf protected';
    const result = await run(['/bin/sh', '-c', script, 'metadata-test', home, target], workspace({ writableRoots: [home] }), cwd);
    assert.deepEqual([result.exitCode, result.stdout, result.stderr], [0, 'protected', '']);
    assert.equal(readFileSync(target, 'utf8'), 'original');
    assert.equal(readFileSync(join(home, 'allowed'), 'utf8'), 'permitted');
  });
}

test('a .codex symlink replacement attack fails before anything runs', bubblewrap, async t => {
  const cwd = tempDir(t);
  mkdirSync(join(cwd, 'decoy-codex'));
  symlinkSync(join(cwd, 'decoy-codex'), join(cwd, '.codex'));
  const result = await runStarted(() => sandbox!.spawn(['bash', '-c', `echo denied > ${join(cwd, '.codex', 'config.toml')}`], workspace(), { cwd, env: process.env, stdin: 'pipe' }),
    { cwd, timeoutMs: 20_000, maxBytes: 4_096 });
  assert.match(result.spawnError ?? '', /cannot enforce sandbox read-only path .*crosses writable symlink/);
  assert.equal(existsSync(join(cwd, 'decoy-codex', 'config.toml')), false);
});

test('parent repository discovery works while child metadata stays blocked, and placeholders are cleaned up', bubblewrap, async t => {
  if (!hasProgram('git') || !hasProgram('python3')) return t.skip('git or python3 is unavailable');
  const root = tempDir(t);
  const repo = join(root, 'repo'), subdir = join(repo, 'sub');
  mkdirSync(subdir, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);

  const script = `set -e
test "$(git rev-parse --show-toplevel)" = '${repo}'
git status --short > status.before
if grep -E '(^|[[:space:]])\\.(git|codex|agents|pi)(/|$)' status.before; then cat status.before; exit 21; fi
printf '%s\\n' 'import json, sys' 'for line in sys.stdin:' '    print(json.loads(line)["message"])' > jsonl_viewer.py
printf '%s\\n' '{"message":"ok"}' | python3 jsonl_viewer.py | grep -q ok`;
  const result = await run(['bash', '-c', script], workspace(), subdir);
  assert.equal(result.exitCode, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.ok(existsSync(join(subdir, 'jsonl_viewer.py')));

  assert.notEqual((await run(['git', 'init', '-q'], workspace(), subdir)).exitCode, 0, 'child git init is denied');
  assert.notEqual((await run(['mkdir', '.codex'], workspace(), subdir)).exitCode, 0, 'child .codex creation is denied');
  for (const name of ['.git', '.codex', '.agents', '.pi', '.aws']) assert.equal(existsSync(join(subdir, name)), false, `${name} placeholder was removed`);
});

test('the placeholder registry is read-only inside the sandbox', bubblewrap, async t => {
  const cwd = tempDir(t);
  const result = await run(['bash', '-c', 'registry="${TMPDIR:-/tmp}/codex-bwrap-synthetic-mount-targets-$(id -u)"; if touch "$registry/forged-marker" 2>/dev/null; then exit 22; fi'],
    workspace({ excludeSlashTmp: false, excludeTmpdirEnvVar: false }), cwd);
  assert.equal(result.exitCode, 0, result.stderr);
});

test('concurrent sandboxes in one workspace keep each other\'s placeholders until the last exits', bubblewrap, async t => {
  const cwd = tempDir(t);
  const long = run(['bash', '-c', 'sleep 1; if mkdir .codex/x 2>/dev/null; then exit 1; fi'], workspace(), cwd);
  await new Promise(resolve => setTimeout(resolve, 200));
  const short = await run(['true'], workspace(), cwd);
  assert.equal(short.exitCode, 0);
  assert.equal((await long).exitCode, 0, 'the placeholder still masked .codex after the shorter sandbox exited');
  assert.equal(existsSync(join(cwd, '.codex')), false);
});

test('a read-only policy denies writes even in the cwd', bubblewrap, async t => {
  const cwd = tempDir(t);
  const result = await run(['bash', '-c', 'echo x > file'], { mode: 'read-only', networkAccess: false }, cwd);
  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(join(cwd, 'file')), false);
});

function isolatedRegistry(t: test.TestContext): string {
  const dir = tempDir(t, 'guardian-registry-');
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  return syntheticMountRegistryRoot();
}

test('failed partial registration leaves no phantom owners after successful commands', bubblewrap, async t => {
  const cwd = tempDir(t), registry = isolatedRegistry(t);
  const conflict = join(registry, hashPath(join(cwd, PROTECTED_METADATA_PATH_NAMES.at(-1)!)));
  mkdirSync(registry, { recursive: true });
  writeFileSync(conflict, 'conflicting marker directory');
  const failed = await runStarted(signal => sandbox!.spawn(['/bin/true'], workspace(), {
    cwd, env: process.env, stdin: 'ignore', signal,
  }), { cwd, timeoutMs: 2000, maxBytes: 1000 });
  assert.match(failed.spawnError ?? '', /EEXIST/);

  rmSync(conflict);
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.equal((await run(['/bin/true'], workspace(), cwd)).exitCode, 0);
    assert.deepEqual(readdirSync(cwd), []);
    assert.deepEqual(readdirSync(registry), ['lock']);
  }
});

async function holdLock(t: test.TestContext, registry: string) {
  mkdirSync(registry, { recursive: true });
  const child = spawn(flock!, ['--exclusive', join(registry, 'lock'), '/bin/sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  const closed = once(child, 'close');
  const release = async () => { child.stdin.end(); await closed; };
  t.after(release);
  return release;
}

test('held registry locks respect cancellation and deadlines before executing, then recover', bubblewrap, async t => {
  const cwd = tempDir(t), registry = isolatedRegistry(t), marker = join(cwd, 'executed');
  for (const abort of [true, false]) {
    const release = await holdLock(t, registry);
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 50) : undefined;
    const started = Date.now();
    const result = await runStarted(signal => sandbox!.spawn(['/bin/sh', '-c', 'printf executed > executed'], workspace(), {
      cwd, env: process.env, stdin: 'pipe', signal,
    }), { cwd, signal: controller.signal, timeoutMs: abort ? 1000 : 80, maxBytes: 1000 });
    clearTimeout(timer);
    assert.equal(result.aborted, abort);
    assert.equal(result.timedOut, !abort);
    assert.equal(result.spawnError, undefined);
    assert.ok(Date.now() - started < 500);
    assert.equal(existsSync(marker), false);
    await release();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(existsSync(marker), false, 'a cancelled preparation cannot launch when the lock becomes available');
  }
  const recovered = await run(['/bin/true'], workspace(), cwd);
  assert.equal(recovered.exitCode, 0);
  assert.equal(existsSync(join(cwd, '.codex')), false);
});

test('completion settles under cleanup contention and reconciles without removing another sandbox placeholder', bubblewrap, async t => {
  const cwd = tempDir(t), registry = isolatedRegistry(t);
  const started = await sandbox!.spawn(['/bin/sh', '-c', 'printf ready; read -r done'], workspace(), { cwd, env: process.env, stdin: 'pipe' });
  await once(started.child.stdout, 'data');
  const release = await holdLock(t, registry);
  const foreignPath = join(cwd, '.aws'), foreignMarker = join(registry, hashPath(foreignPath), '1');
  writeFileSync(foreignMarker, 'synthetic\n');
  started.child.stdin?.end('done\n');
  const settled = await Promise.race([started.finished.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 2800))]);
  assert.equal(settled, true, 'cleanup contention cannot hold finished forever');
  assert.equal(existsSync(join(cwd, '.codex')), true);
  assert.equal(readFileSync(join(registry, hashPath(join(cwd, '.codex')), String(process.pid)), 'utf8'), 'synthetic\n');
  await release();
  for (let attempt = 0; attempt < 300 && existsSync(join(cwd, '.codex')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(join(cwd, '.codex')), false);
  assert.equal(existsSync(foreignPath), true);
  assert.equal(readFileSync(foreignMarker, 'utf8'), 'synthetic\n');
});

test('synchronous launch failure releases registrations and every preparation descriptor', bubblewrap, async t => {
  const cwd = tempDir(t), registry = isolatedRegistry(t);
  const before = readdirSync('/proc/self/fd').length;
  await assert.rejects(sandbox!.spawn(['/bin/true'], workspace(), { cwd, env: { ...process.env, GUARDIAN_INVALID: '\0' }, stdin: 'pipe' }), /null bytes/);
  assert.deepEqual(readdirSync(registry), ['lock']);
  assert.ok(readdirSync('/proc/self/fd').length <= before);
  assert.equal((await run(['/bin/true'], workspace(), cwd)).exitCode, 0);
});

test('asynchronous launch failure releases registrations even when launch races cancellation', bubblewrap, async t => {
  const cwd = tempDir(t), registry = isolatedRegistry(t);
  const before = readdirSync('/proc/self/fd').length;
  const originalSpawn = childProcess.spawn;
  let controller: AbortController;
  let abort = false;
  t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof spawn>) => {
    if (!args[1]?.includes('--seccomp')) return originalSpawn(...args);
    const child = originalSpawn('/nonexistent/guardian-launcher', args[1], args[2]);
    if (abort) controller.abort();
    return child;
  }) as typeof spawn);
  syncBuiltinESMExports();
  try {
    for (abort of [false, true]) {
      controller = new AbortController();
      let launching: Promise<SandboxedProcess> | undefined;
      const result = await runStarted(signal => launching = sandbox!.spawn(['/bin/true'], workspace(), { cwd, env: process.env, stdin: 'pipe', signal }),
        { cwd, signal: controller.signal, timeoutMs: 10_000, maxBytes: 100 });
      assert.equal(result.aborted, abort);
      if (!abort) assert.match(result.spawnError ?? '', /ENOENT/);
      await (await launching!).finished;
      assert.deepEqual(readdirSync(registry), ['lock']);
      assert.ok(readdirSync('/proc/self/fd').length <= before);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a caller can cancel a shared proc preflight without launching its command', bubblewrap, async t => {
  const cwd = tempDir(t), launcherDir = tempDir(t), registry = isolatedRegistry(t), pidFile = join(launcherDir, 'probe.pid');
  const launcher = join(launcherDir, 'bwrap');
  writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--help" ]; then printf '%s\n' --as-pid-1 --perms; exit 0; fi
echo $$ > '${pidFile}'
exec /bin/sleep 30
`);
  chmodSync(launcher, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = launcherDir;
  let probePid: number | undefined;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (probePid) { try { process.kill(-probePid, 'SIGKILL'); } catch {} }
  });
  const fixture = bubblewrapSandbox({ program: launcher, source: 'system' });
  const startedAt = Date.now();
  const result = await runStarted(signal => fixture.spawn(['/bin/sh', '-c', 'touch executed'], workspace(), {
    cwd, env: process.env, stdin: 'pipe', signal,
  }), { cwd, timeoutMs: 100, maxBytes: 1000 });
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, undefined);
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(existsSync(join(cwd, 'executed')), false);
  assert.equal(existsSync(registry), false, 'cancelled preflight does not enter registration');
  probePid = Number(readFileSync(pidFile, 'utf8'));
  process.kill(-probePid, 'SIGKILL');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(probePid, 0); } catch { probePid = undefined; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(probePid, undefined, 'the fixture probe is reaped during teardown');
});
