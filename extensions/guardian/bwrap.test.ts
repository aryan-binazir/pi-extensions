// Ported from the tests in openai/codex codex-rs/linux-sandbox/src/bwrap.rs and linux_run_main_tests.rs @ ce0323f
// (Apache-2.0); see docs/licenses/README.md. Cases for split policies, deny-read globs, WSL and app-server sockets are
// omitted with those features. Argument construction is plain filesystem inspection, so these run on every platform.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type BwrapArgs, type BwrapOptions, createBwrapCommandArgs, createFilesystemArgs, createProcPreflightArgs, FIRST_BIND_DATA_FD,
  isProcMountFailure, withAsPid1, withOptionsBeforeCommand,
} from './bwrap.ts';
import { type SandboxPolicy, type WritableRoot, workspaceWriteRoots } from './seatbelt.ts';

const isolated: SandboxPolicy = { mode: 'workspace-write', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };

function tempDir(t: test.TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-bwrap-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const options = (dir: string, overrides: Partial<BwrapOptions> = {}): BwrapOptions =>
  ({ mountProc: true, networkMode: 'isolated', registryRoot: join(dir, 'registry-outside-roots'), ...overrides });
const windows = (args: readonly string[], size: number) => args.slice(0, Math.max(0, args.length - size + 1)).map((_, index) => args.slice(index, index + size));
const hasWindow = (args: readonly string[], window: readonly string[]) => windows(args, window.length).some(candidate => candidate.every((arg, index) => arg === window[index]));
const indexOfWindow = (args: readonly string[], window: readonly string[]) => windows(args, window.length).findIndex(candidate => candidate.every((arg, index) => arg === window[index]));
const syntheticPaths = (args: BwrapArgs) => args.syntheticMountTargets.map(target => target.path);

function assertEmptyFileBoundWithoutPerms(args: readonly string[], path: string): void {
  assert.ok(windows(args, 3).some(window => window[0] === '--ro-bind-data' && window[2] === path), `expected empty file bind for ${path}: ${args.join(' ')}`);
  assert.ok(!windows(args, 5).some(window => window[0] === '--perms' && window[1] === '000' && window[2] === '--ro-bind-data' && window[4] === path));
}

function assertEmptyDirectoryMountedReadOnly(args: readonly string[], path: string): void {
  assert.ok(hasWindow(args, ['--perms', '555', '--tmpfs', path]), `expected empty directory mount for ${path}: ${args.join(' ')}`);
  assert.ok(hasWindow(args, ['--remount-ro', path]), `expected read-only remount for ${path}`);
}

function assertBindDataUsesDistinctFds(args: BwrapArgs): void {
  const fds = windows(args.args, 3).filter(window => window[0] === '--ro-bind-data').map(window => Number(window[1]));
  assert.deepEqual(fds, Array.from({ length: args.bindDataFds }, (_, index) => FIRST_BIND_DATA_FD + index));
}

test('namespaces, proc and network flags follow the options', t => {
  const dir = tempDir(t);
  for (const mountProc of [true, false]) {
    for (const networkMode of ['isolated', 'full-access'] as const) {
      const { args } = createBwrapCommandArgs(['/bin/true'], [], '/', options(dir, { mountProc, networkMode }));
      assert.ok(args.includes('--unshare-pid'));
      assert.equal(args.includes('--proc'), mountProc);
      assert.ok(args.includes('--unshare-user'));
      assert.ok(args.includes('--unshare-ipc'));
      assert.equal(args.includes('--unshare-net'), networkMode === 'isolated');
      assert.ok(hasWindow(args, ['--cap-drop', 'ALL']));
      assert.deepEqual(args.slice(0, 2), ['--new-session', '--die-with-parent']);
      assert.deepEqual(args.slice(-2), ['--', '/bin/true']);
    }
  }
});

test('the read-only policy mounts the whole filesystem read-only with a minimal /dev', t => {
  const dir = tempDir(t);
  const { args } = createBwrapCommandArgs(['/bin/true'], [], '/', options(dir));
  assert.deepEqual(args.slice(2, 7), ['--ro-bind', '/', '/', '--dev', '/dev']);
  assert.ok(!args.includes('--bind'));
});

test('a symlinked command cwd is entered by its canonical path', t => {
  const dir = tempDir(t);
  const realRoot = join(dir, 'real'), linkRoot = join(dir, 'link');
  mkdirSync(join(realRoot, 'subdir'), { recursive: true });
  symlinkSync(realRoot, linkRoot);
  const roots = workspaceWriteRoots(isolated, linkRoot, {});

  const { args } = createBwrapCommandArgs(['/bin/true'], roots, join(linkRoot, 'subdir'), options(dir));
  assert.ok(hasWindow(args, ['--chdir', join(realRoot, 'subdir')]));
  assert.ok(hasWindow(args, ['--bind', realRoot, realRoot]), 'the writable root binds its real target');
  assert.ok(!hasWindow(args, ['--chdir', join(linkRoot, 'subdir')]));
  assert.ok(!hasWindow(args, ['--bind', linkRoot, linkRoot]));
});

test('an ordinary cwd is not re-entered', t => {
  const dir = tempDir(t);
  assert.ok(!createBwrapCommandArgs(['/bin/true'], [], dir, options(dir)).args.includes('--chdir'));
});

test('symlinked writable roots bind the real target and remap carveouts', t => {
  const dir = tempDir(t);
  const realRoot = join(dir, 'real'), linkRoot = join(dir, 'link');
  mkdirSync(join(realRoot, '.git'), { recursive: true });
  writeFileSync(join(realRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync(realRoot, linkRoot);

  const args = createFilesystemArgs([{ root: linkRoot, readOnlySubpaths: [join(linkRoot, '.git')] }], options(dir));
  assert.ok(hasWindow(args.args, ['--bind', realRoot, realRoot]));
  assert.ok(hasWindow(args.args, ['--ro-bind', join(realRoot, '.git'), join(realRoot, '.git')]));
});

test('writable roots under symlinked ancestors bind the real target', t => {
  const dir = tempDir(t);
  const logicalHome = join(dir, 'home'), realCodex = join(dir, 'real-codex');
  const logicalMemories = join(logicalHome, '.codex', 'memories'), realMemories = join(realCodex, 'memories');
  mkdirSync(logicalHome);
  mkdirSync(realMemories, { recursive: true });
  symlinkSync(realCodex, join(logicalHome, '.codex'));

  const args = createFilesystemArgs([{ root: logicalMemories, readOnlySubpaths: [] }], options(dir));
  assert.ok(hasWindow(args.args, ['--bind', realMemories, realMemories]));
  assert.ok(!hasWindow(args.args, ['--bind', logicalMemories, logicalMemories]));
});

test('protected symlinked directory subpaths fail closed', t => {
  const dir = tempDir(t);
  const root = join(dir, 'root');
  mkdirSync(join(root, 'agents-target'), { recursive: true });
  symlinkSync(join(root, 'agents-target'), join(root, '.agents'));

  assert.throws(() => createFilesystemArgs([{ root, readOnlySubpaths: [] }], options(dir)),
    (error: Error) => error.message.includes('cannot enforce sandbox read-only path') && error.message.includes(join(root, '.agents')));
});

test('a .codex symlink to a decoy in the workspace fails closed', t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'decoy-codex'));
  symlinkSync(join(dir, 'decoy-codex'), join(dir, '.codex'));
  assert.throws(() => createBwrapCommandArgs(['/bin/true'], workspaceWriteRoots(isolated, dir, {}), dir, options(dir)), /crosses writable symlink/);
});

test('the placeholder registry is read-only wherever a writable root exposes it', t => {
  const dir = tempDir(t);
  const registryRoot = join(dir, 'tmp', 'codex-bwrap-synthetic-mount-targets-1000');
  mkdirSync(join(dir, 'tmp'));
  const args = createFilesystemArgs([{ root: join(dir, 'tmp'), readOnlySubpaths: [] }], { registryRoot });
  const bind = indexOfWindow(args.args, ['--bind', join(dir, 'tmp'), join(dir, 'tmp')]);
  const registry = indexOfWindow(args.args, ['--ro-bind', registryRoot, registryRoot]);
  assert.ok(bind !== -1 && registry > bind, 'registry protection follows the writable bind');
  assert.ok(existsSync(registryRoot), 'the registry exists so bubblewrap can mount it');

  const inside = createFilesystemArgs([{ root: join(registryRoot, 'nested'), readOnlySubpaths: [] }], { registryRoot });
  assert.ok(!hasWindow(inside.args, ['--ro-bind', registryRoot, registryRoot]), 'a missing root inside the registry is skipped');
});

test('missing read-only subpaths use empty-file bind data and protected names use empty directories', t => {
  const dir = tempDir(t);
  const workspace = join(dir, 'workspace'), blocked = join(workspace, 'blocked'), secondBlocked = join(workspace, 'second-blocked');
  mkdirSync(workspace);

  const args = createFilesystemArgs([{ root: workspace, readOnlySubpaths: [blocked, secondBlocked] }], options(dir));
  assertEmptyFileBoundWithoutPerms(args.args, blocked);
  assertEmptyFileBoundWithoutPerms(args.args, secondBlocked);
  for (const name of ['.git', '.agents', '.codex', '.pi', '.aws']) assertEmptyDirectoryMountedReadOnly(args.args, join(workspace, name));
  assert.equal(args.bindDataFds, 2);
  assertBindDataUsesDistinctFds(args);
  assert.deepEqual(syntheticPaths(args), [blocked, secondBlocked, ...['.git', '.agents', '.codex', '.pi', '.aws'].map(name => join(workspace, name))]);
  assert.ok(!existsSync(blocked) && !existsSync(secondBlocked), 'argument construction does not create host paths');
});

test('a transient empty metadata file is masked, not bound, and is not cleaned up as synthetic', t => {
  const dir = tempDir(t);
  const workspace = join(dir, 'workspace'), dotGit = join(workspace, '.git');
  mkdirSync(workspace);
  writeFileSync(dotGit, '');

  const args = createFilesystemArgs([{ root: workspace, readOnlySubpaths: [] }], options(dir));
  assertEmptyFileBoundWithoutPerms(args.args, dotGit);
  assert.ok(!hasWindow(args.args, ['--ro-bind', dotGit, dotGit]));
  assert.deepEqual(syntheticPaths(args), [dotGit, ...['.agents', '.codex', '.pi', '.aws'].map(name => join(workspace, name))]);
  assert.ok(args.syntheticMountTargets[0].preExisting, 'a pre-existing empty file is remembered by identity');
});

test('a missing child .git under a parent repository is masked read-only', t => {
  const dir = tempDir(t);
  const repo = join(dir, 'repo'), workspace = join(repo, 'workspace');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(workspace);

  const args = createFilesystemArgs(workspaceWriteRoots(isolated, workspace, {}), options(dir));
  for (const name of ['.git', '.agents', '.codex']) assertEmptyDirectoryMountedReadOnly(args.args, join(workspace, name));
  assert.deepEqual(new Set(syntheticPaths(args)), new Set(['.codex', '.git', '.agents', '.pi', '.aws'].map(name => join(workspace, name))));
});

test('a symlinked workspace masks missing metadata at its real path', t => {
  const dir = tempDir(t);
  const repo = join(dir, 'repo'), workspace = join(repo, 'workspace'), linkRepo = join(dir, 'link-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(workspace);
  symlinkSync(repo, linkRepo);

  const args = createFilesystemArgs(workspaceWriteRoots(isolated, join(linkRepo, 'workspace'), {}), options(dir));
  for (const name of ['.git', '.agents', '.codex']) assertEmptyDirectoryMountedReadOnly(args.args, join(workspace, name));
  assert.deepEqual(new Set(syntheticPaths(args)), new Set(['.codex', '.git', '.agents', '.pi', '.aws'].map(name => join(workspace, name))));
});

test('existing metadata directories are bound read-only', t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const args = createFilesystemArgs(workspaceWriteRoots(isolated, dir, {}), options(dir));
  assert.ok(hasWindow(args.args, ['--ro-bind', join(dir, '.git'), join(dir, '.git')]));
  assert.ok(indexOfWindow(args.args, ['--bind', dir, dir]) < indexOfWindow(args.args, ['--ro-bind', join(dir, '.git'), join(dir, '.git')]));
});

test('missing writable roots are skipped', t => {
  const dir = tempDir(t);
  const existing = join(dir, 'existing'), missing = join(dir, 'missing');
  mkdirSync(existing);
  const roots: WritableRoot[] = [{ root: existing, readOnlySubpaths: [] }, { root: missing, readOnlySubpaths: [] }];

  const args = createFilesystemArgs(roots, options(dir));
  assert.ok(hasWindow(args.args, ['--bind', existing, existing]));
  assert.ok(!args.args.some(arg => arg.startsWith(missing)));
});

test('/dev is mounted before writable /dev binds and recreated after a root bind', t => {
  const dir = tempDir(t);
  const args = createFilesystemArgs([{ root: '/', readOnlySubpaths: [] }, { root: '/dev', readOnlySubpaths: [] }], options(dir));
  const devMounts = windows(args.args, 2).flatMap((window, index) => window[0] === '--dev' && window[1] === '/dev' ? [index] : []);
  assert.equal(devMounts.length, 2);
  const rootBind = indexOfWindow(args.args, ['--bind', '/', '/']), devBind = indexOfWindow(args.args, ['--bind', '/dev', '/dev']);
  assert.ok(devMounts[0] < rootBind && rootBind < devMounts[1] && devMounts[1] < devBind);
  assert.ok(hasWindow(args.args, ['--dev', '/dev', '--bind-try', '/dev/shm', '/dev/shm']));
});

test('nested writable roots bind after their parent and keep their own carveouts', t => {
  const dir = tempDir(t);
  const nested = join(dir, 'nested');
  mkdirSync(join(nested, '.git'), { recursive: true });
  writeFileSync(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const args = createFilesystemArgs([
    { root: dir, readOnlySubpaths: [join(nested, '.git')] },
    { root: nested, readOnlySubpaths: [join(nested, '.git')] },
  ], options(dir));
  const parent = indexOfWindow(args.args, ['--bind', dir, dir]), child = indexOfWindow(args.args, ['--bind', nested, nested]);
  const carveout = indexOfWindow(args.args, ['--ro-bind', join(nested, '.git'), join(nested, '.git')]);
  assert.ok(parent < child && child < carveout, 'the deeper root reapplies the carveout after its own bind');
  assert.equal(args.args.filter(arg => arg === join(nested, '.git')).length, 2, 'the carveout is mounted once');
});

test('proc mount failures are recognized', () => {
  for (const reason of ['Invalid argument', 'Operation not permitted', 'Permission denied']) {
    assert.ok(isProcMountFailure(`bwrap: Can't mount proc on /newroot/proc: ${reason}`));
  }
  assert.ok(!isProcMountFailure("bwrap: Can't bind mount /dev/null: Operation not permitted"));
});

test('the proc preflight does not bind the full filesystem', () => {
  const args = createProcPreflightArgs('isolated');
  assert.ok(hasWindow(args, ['--tmpfs', '/']));
  assert.ok(hasWindow(args, ['--proc', '/proc']));
  assert.ok(args.includes('--unshare-net'));
  assert.ok(!hasWindow(args, ['--ro-bind', '/', '/']));
  assert.ok(!hasWindow(args, ['--bind', '/', '/']));
  assert.ok(!createProcPreflightArgs('full-access').includes('--unshare-net'));
});

test('--as-pid-1 is added when bubblewrap creates a PID namespace', () => {
  assert.deepEqual(withAsPid1(['--unshare-pid', '--', 'sh']), ['--as-pid-1', '--unshare-pid', '--', 'sh']);
  assert.deepEqual(withAsPid1(['--', 'sh', '--unshare-pid']), ['--', 'sh', '--unshare-pid'], 'only bubblewrap\'s own flags count');
});

test('options go before the command separator', () => {
  assert.deepEqual(withOptionsBeforeCommand(['--unshare-pid', '--', 'sh', '--', 'x'], ['--seccomp', '4']), ['--unshare-pid', '--seccomp', '4', '--', 'sh', '--', 'x']);
  assert.throws(() => withOptionsBeforeCommand(['sh'], ['--seccomp', '3']), /missing command separator/);
});
