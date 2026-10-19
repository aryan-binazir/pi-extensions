// Ported from openai/codex codex-rs/linux-sandbox/tests/suite/sandbox.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. These run commands under real bubblewrap, so they only run on Linux where it works;
// tests/suite cases for WSL, split policies, deny-read globs and the managed proxy are omitted with those features.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runStarted } from './review/process.ts';
import { detectPlatformSandbox, sandboxEnv } from './sandbox.ts';
import { syscallNumber } from './seccomp.ts';
import type { SandboxPolicy } from './seatbelt.ts';

const { sandbox } = await detectPlatformSandbox();
const bubblewrap = { skip: sandbox?.kind !== 'bubblewrap' && 'bubblewrap sandbox prerequisites are unavailable' };
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
