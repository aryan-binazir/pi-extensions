// Ported from openai/codex codex-rs/sandboxing/src/seatbelt_tests.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
// Cases built on Codex's general permission profiles are expressed through the workspace-write/read-only policies ported here.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createSeatbeltCommandArgs, MACOS_PATH_TO_SEATBELT_EXECUTABLE, MACOS_SEATBELT_BASE_POLICY, PROTECTED_METADATA_PATH_NAMES,
  type SandboxPolicy, sandboxEnv, seatbeltRegexEscape,
} from './seatbelt.ts';

const darwin = { skip: process.platform !== 'darwin' && 'Seatbelt is macOS-only' };
const isolatedWorkspace: SandboxPolicy = { mode: 'workspace-write', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };

function tempDir(t: test.TestContext, parent = tmpdir()): string {
  const dir = mkdtempSync(join(parent, 'guardian-seatbelt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function policyArg(args: string[]): string {
  const index = args.indexOf('-p');
  assert.notEqual(index, -1, 'seatbelt args should include -p');
  return args[index + 1];
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(MACOS_PATH_TO_SEATBELT_EXECUTABLE, args, { cwd, env, encoding: 'utf8' });
  return { success: result.status === 0, stderr: result.stderr };
}

function assertSeatbeltDenied(stderr: string, path: string): void {
  assert.ok(stderr === `bash: ${path}: Operation not permitted\n` || stderr === `bash: line 1: ${path}: Operation not permitted\n`,
    `unexpected stderr: ${stderr}`);
}

function protectedMetadataNameRequirements(root: string): string {
  const trimmed = root.length > 1 ? root.replace(/\/+$/, '') : root;
  const escaped = seatbeltRegexEscape(trimmed);
  return PROTECTED_METADATA_PATH_NAMES.map(name => escaped === '/'
    ? `(require-not (regex #"^/${seatbeltRegexEscape(name)}(/.*)?$"))`
    : `(require-not (regex #"^${escaped}/${seatbeltRegexEscape(name)}(/.*)?$"))`).join(' ');
}

function populateTmpdir(tmp: string) {
  const vulnerableRoot = join(tmp, 'vulnerable_root');
  mkdirSync(vulnerableRoot, { recursive: true });
  spawnSync('git', ['init', '.'], { cwd: vulnerableRoot });
  mkdirSync(join(vulnerableRoot, '.codex'), { recursive: true });
  writeFileSync(join(vulnerableRoot, '.codex', 'config.toml'), 'sandbox_mode = "read-only"\n');
  const emptyRoot = join(tmp, 'empty_root');
  mkdirSync(emptyRoot, { recursive: true });
  const vulnerableRootCanonical = realpathSync(vulnerableRoot);
  return {
    vulnerableRoot, vulnerableRootCanonical, emptyRoot, emptyRootCanonical: realpathSync(emptyRoot),
    dotGitCanonical: join(vulnerableRootCanonical, '.git'),
    dotAgentsCanonical: join(vulnerableRootCanonical, '.agents'),
    dotCodexCanonical: join(vulnerableRootCanonical, '.codex'),
  };
}

test('base policy allows node cpu sysctls and KMP registration shm', () => {
  assert.ok(MACOS_SEATBELT_BASE_POLICY.includes('(sysctl-name "machdep.cpu.brand_string")'));
  assert.ok(MACOS_SEATBELT_BASE_POLICY.includes('(sysctl-name "hw.model")'));
  assert.ok(MACOS_SEATBELT_BASE_POLICY.includes(`(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))`));
});

test('seatbelt allows semaphore limit sysconf', darwin, t => {
  const workspace = tempDir(t);
  for (const policy of [{ mode: 'read-only', networkAccess: false }, { mode: 'workspace-write', networkAccess: false }] as const) {
    const output = run(createSeatbeltCommandArgs(['/usr/bin/getconf', 'SEM_NSEMS_MAX'], policy, workspace), workspace);
    assert.ok(output.success, `semaphore limit query should succeed under ${policy.mode}: ${output.stderr}`);
  }
});

test('create seatbelt args with read-only git and codex subpaths', darwin, t => {
  const tmp = tempDir(t);
  const { vulnerableRoot, vulnerableRootCanonical, dotGitCanonical, dotCodexCanonical, emptyRoot, emptyRootCanonical } = populateTmpdir(tmp);
  const cwd = join(tmp, 'cwd');
  mkdirSync(cwd, { recursive: true });
  const cwdCanonical = realpathSync(cwd);
  const policy: SandboxPolicy = { ...isolatedWorkspace, writableRoots: [vulnerableRoot, emptyRoot] };
  const configToml = join(dotCodexCanonical, 'config.toml');
  const shellCommand = ['bash', '-c', `echo 'sandbox_mode = "danger-full-access"' > "$1"`, 'bash', configToml];
  const args = createSeatbeltCommandArgs(shellCommand, policy, cwd);

  const policyText = policyArg(args);
  assert.ok(policyText.includes('(require-all (subpath (param "WRITABLE_ROOT_0"))'), policyText);
  for (const root of [cwdCanonical, vulnerableRootCanonical, emptyRootCanonical]) {
    assert.ok(policyText.includes(protectedMetadataNameRequirements(root)), `missing metadata regexes for ${root}:\n${policyText}`);
  }
  assert.deepEqual(args.filter(arg => arg.startsWith('-DWRITABLE_ROOT_')), [
    `-DWRITABLE_ROOT_0=${cwdCanonical}`,
    `-DWRITABLE_ROOT_0_EXCLUDED_0=${join(cwdCanonical, '.codex')}`,
    `-DWRITABLE_ROOT_0_EXCLUDED_1=${join(cwdCanonical, '.git')}`,
    `-DWRITABLE_ROOT_0_EXCLUDED_2=${join(cwdCanonical, '.agents')}`,
    `-DWRITABLE_ROOT_0_EXCLUDED_3=${join(cwdCanonical, '.aws')}`,
    `-DWRITABLE_ROOT_1=${vulnerableRootCanonical}`,
    `-DWRITABLE_ROOT_1_EXCLUDED_0=${dotGitCanonical}`,
    `-DWRITABLE_ROOT_1_EXCLUDED_1=${dotCodexCanonical}`,
    `-DWRITABLE_ROOT_2=${emptyRootCanonical}`,
  ]);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), shellCommand);

  let output = run(args, cwd);
  assert.equal(readFileSync(configToml, 'utf8'), 'sandbox_mode = "read-only"\n');
  assert.ok(!output.success);
  assertSeatbeltDenied(output.stderr, configToml);

  const preCommitHook = join(dotGitCanonical, 'hooks', 'pre-commit');
  output = run(createSeatbeltCommandArgs(['bash', '-c', `echo 'pwned!' > "$1"`, 'bash', preCommitHook], policy, cwd), cwd);
  assert.ok(!existsSync(preCommitHook));
  assert.ok(!output.success);
  assertSeatbeltDenied(output.stderr, preCommitHook);

  const allowedFile = join(vulnerableRootCanonical, 'allowed.txt');
  output = run(createSeatbeltCommandArgs(['bash', '-c', `echo 'this is allowed' > "$1"`, 'bash', allowedFile], policy, cwd), cwd);
  assert.ok(output.success, output.stderr);
  assert.equal(readFileSync(allowedFile, 'utf8'), 'this is allowed\n');
});

test('create seatbelt args rejects symlinked writable root', darwin, t => {
  const tmp = tempDir(t);
  const target = join(tmp, 'target'), workspace = join(tmp, 'workspace');
  mkdirSync(target);
  symlinkSync(target, workspace);
  assert.throws(() => createSeatbeltCommandArgs(['/usr/bin/true'], isolatedWorkspace, workspace), (error: Error) =>
    error.message.includes('symlinked writable roots are not supported') && error.message.includes(workspace));
});

test('seatbelt prevents writable root replacement', darwin, t => {
  const tmp = tempDir(t);
  const workspace = join(tmp, 'workspace'), target = join(tmp, 'target');
  mkdirSync(workspace);
  mkdirSync(target);
  const args = createSeatbeltCommandArgs(['/bin/sh', '-c', 'rm -rf "$PWD" && ln -s "$1" "$PWD"', 'sh', target], isolatedWorkspace, workspace);
  assert.ok(policyArg(args).includes('(deny file-write-unlink (require-all (literal (param "WRITABLE_ROOT_0")) (vnode-type DIRECTORY)))'));
  const output = run(args, workspace);
  const metadata = lstatSync(workspace);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), `sandboxed command replaced ${workspace}: ${output.stderr}`);
  assert.ok(!output.success);
});

test('seatbelt prevents writable directory root rename', darwin, t => {
  const tmp = tempDir(t);
  const cwd = join(tmp, 'cwd'), source = join(tmp, 'source'), destination = join(tmp, 'destination'), renamed = join(destination, 'renamed');
  for (const dir of [cwd, source, destination]) mkdirSync(dir);
  const output = run(createSeatbeltCommandArgs(['/bin/mv', source, renamed], { ...isolatedWorkspace, writableRoots: [source, destination] }, cwd), cwd);
  assert.ok(!output.success);
  assert.ok(existsSync(source));
  assert.ok(!existsSync(renamed));
});

test('seatbelt protects writable root created as directory', darwin, t => {
  const tmp = tempDir(t);
  const cwd = join(tmp, 'cwd'), writableRoot = join(tmp, 'writable-root'), progress = join(tmp, 'progress.txt');
  mkdirSync(cwd);
  writeFileSync(progress, 'pending');
  const args = createSeatbeltCommandArgs([
    '/bin/sh', '-c', 'mkdir "$1" && touch "$1/file" && printf ok > "$2" && rm "$1/file" && rmdir "$1"', 'sh', writableRoot, progress,
  ], { ...isolatedWorkspace, writableRoots: [writableRoot, progress] }, cwd);
  assert.ok(policyArg(args).includes('(literal (param "WRITABLE_ROOT_2"))'), 'file roots are granted literally');
  const output = run(args, cwd);
  assert.ok(!output.success);
  assert.ok(lstatSync(writableRoot).isDirectory());
  assert.equal(readFileSync(progress, 'utf8'), 'ok');
});

test('seatbelt protects .aws in extra writable home', darwin, t => {
  for (const existing of [true, false]) {
    const tmp = tempDir(t);
    const home = join(tmp, 'home'), workspace = join(tmp, 'workspace'), aws = join(home, '.aws'), config = join(aws, 'config'), probe = join(home, 'probe');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(home, 'replacement'), 'replacement');
    mkdirSync(join(home, 'replacement-dir'));
    if (existing) {
      mkdirSync(aws);
      writeFileSync(config, 'original');
    }
    const attempts = existing
      ? ['printf changed > "$HOME/.aws/config"', '/bin/rm "$HOME/.aws/config"', '/bin/mv "$HOME/.aws/config" "$HOME/renamed-config"',
        '/bin/mv "$HOME/replacement" "$HOME/.aws/config"', '/bin/mv "$HOME/.aws" "$HOME/renamed-aws"']
      : ['/bin/mkdir "$HOME/.aws"', '/bin/mv "$HOME/replacement-dir" "$HOME/.aws"', '/bin/ln -s "$HOME/replacement-dir" "$HOME/.aws"'];
    for (const attempt of attempts) {
      const args = createSeatbeltCommandArgs(['/bin/sh', '-c', `printf ran > "$HOME/probe" && ${attempt}`], { ...isolatedWorkspace, writableRoots: [home] }, workspace);
      const output = run(args, workspace, { ...process.env, HOME: home });
      assert.equal(readFileSync(probe, 'utf8'), 'ran');
      rmSync(probe);
      assert.ok(!output.success && output.stderr.includes('Operation not permitted'), `expected Seatbelt denial for ${attempt}: ${output.stderr}`);
      if (existing) assert.equal(readFileSync(config, 'utf8'), 'original');
      else assert.ok(!existsSync(aws) && !lstatSafe(aws), '.aws should remain absent');
    }
  }
});

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

test('seatbelt protects case variants of metadata', darwin, t => {
  const results: unknown[] = [], expected: unknown[] = [];
  for (const name of PROTECTED_METADATA_PATH_NAMES) {
    const uppercase = name.toUpperCase();
    for (const existingName of [undefined, name, uppercase]) {
      for (const rootName of ['workspace', 'WORKSPACE']) {
        const tmp = tempDir(t);
        const workspace = join(tmp, 'workspace'), variant = join(workspace, uppercase), probe = join(workspace, 'probe');
        mkdirSync(workspace);
        if (!existsSync(join(tmp, 'WORKSPACE'))) return t.skip('requires a case-insensitive filesystem');
        if (existingName) {
          mkdirSync(join(workspace, existingName));
          writeFileSync(join(workspace, existingName, 'config'), 'original');
        }
        const command = existingName ? 'printf ran > "$2" && printf changed > "$1/config"' : 'printf ran > "$2" && mkdir -p "$1" && printf changed > "$1/config"';
        const output = run(createSeatbeltCommandArgs(['/bin/sh', '-c', command, 'sh', variant, probe], isolatedWorkspace, join(tmp, rootName)), workspace);
        assert.equal(readFileSync(probe, 'utf8'), 'ran');
        let config: string | undefined;
        try {
          config = readFileSync(join(workspace, existingName ?? uppercase, 'config'), 'utf8');
        } catch {
          config = undefined;
        }
        results.push([name, existingName, rootName, output.success, existsSync(variant), config]);
        expected.push([name, existingName, rootName, false, existingName !== undefined, existingName ? 'original' : undefined]);
      }
    }
  }
  assert.deepEqual(results, expected);
});

test('create seatbelt args block first-time .codex creation with metadata name regex', darwin, t => {
  const repoRoot = join(tempDir(t), 'repo');
  mkdirSync(repoRoot, { recursive: true });
  spawnSync('git', ['init', '.'], { cwd: repoRoot });
  const dotCodex = join(repoRoot, '.codex');
  const args = createSeatbeltCommandArgs(
    ['bash', '-c', `mkdir -p "$1" && echo 'sandbox_mode = "danger-full-access"' > "$2"`, 'bash', dotCodex, join(dotCodex, 'config.toml')],
    { ...isolatedWorkspace, writableRoots: [repoRoot] }, repoRoot);
  assert.ok(policyArg(args).includes(protectedMetadataNameRequirements(realpathSync(repoRoot))));
  const output = run(args, repoRoot);
  assert.ok(!output.success);
  assert.ok(!existsSync(dotCodex));
});

test('create seatbelt args with read-only git pointer file', darwin, t => {
  const tmp = tempDir(t);
  const worktreeRoot = join(tmp, 'worktree_root'), gitdir = join(worktreeRoot, 'actual-gitdir'), cwd = join(tmp, 'cwd');
  mkdirSync(gitdir, { recursive: true });
  mkdirSync(cwd);
  const gitdirConfig = join(gitdir, 'config');
  writeFileSync(gitdirConfig, '[core]\n');
  const dotGit = join(worktreeRoot, '.git'), dotGitContents = `gitdir: ${gitdir}\n`;
  writeFileSync(dotGit, dotGitContents);
  const policy: SandboxPolicy = { ...isolatedWorkspace, writableRoots: [worktreeRoot] };

  let output = run(createSeatbeltCommandArgs(['bash', '-c', `echo 'pwned!' > "$1"`, 'bash', dotGit], policy, cwd), cwd);
  assert.equal(readFileSync(dotGit, 'utf8'), dotGitContents);
  assert.ok(!output.success);
  assertSeatbeltDenied(output.stderr, dotGit);

  output = run(createSeatbeltCommandArgs(['bash', '-c', `echo 'pwned!' > "$1"`, 'bash', gitdirConfig], policy, cwd), cwd);
  assert.equal(readFileSync(gitdirConfig, 'utf8'), '[core]\n');
  assert.ok(!output.success);
  assertSeatbeltDenied(output.stderr, gitdirConfig);
});

test('workspace-write protects linked worktree gitdir under tmp', darwin, t => {
  const tmp = tempDir(t, '/private/tmp');
  const worktree = join(tmp, 'worktree'), gitdir = join(tmp, 'common/.git/worktrees/worktree'), allowed = join(tmp, 'allowed');
  mkdirSync(worktree);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
  const commondir = join(gitdir, 'commondir');
  writeFileSync(commondir, '../..\n');
  const output = run(createSeatbeltCommandArgs(['/bin/sh', '-c', 'printf allowed > "$1" && printf changed > "$2"', 'sh', allowed, commondir],
    { mode: 'workspace-write', networkAccess: false }, worktree), worktree);
  assert.equal(readFileSync(allowed, 'utf8'), 'allowed');
  assert.ok(!output.success);
  assert.equal(readFileSync(commondir, 'utf8'), '../..\n');
});

test('create seatbelt args for cwd as git repo', darwin, t => {
  const { vulnerableRoot, vulnerableRootCanonical, dotGitCanonical, dotAgentsCanonical, dotCodexCanonical } = populateTmpdir(tempDir(t));
  const shellCommand = ['bash', '-c', `echo 'sandbox_mode = "danger-full-access"' > "$1"`, 'bash', join(dotCodexCanonical, 'config.toml')];
  const args = createSeatbeltCommandArgs(shellCommand, { mode: 'workspace-write', networkAccess: false }, vulnerableRoot);
  const slashTmp = realpathSync('/tmp');
  const policyText = policyArg(args);
  assert.ok(policyText.includes(protectedMetadataNameRequirements(vulnerableRootCanonical)));
  assert.ok(policyText.includes(protectedMetadataNameRequirements(slashTmp)));
  if (process.env.TMPDIR) assert.ok(policyText.includes(protectedMetadataNameRequirements(realpathSync(process.env.TMPDIR))));
  for (const definition of [
    `-DWRITABLE_ROOT_0=${vulnerableRootCanonical}`, `-DWRITABLE_ROOT_0_EXCLUDED_0=${dotGitCanonical}`,
    `-DWRITABLE_ROOT_0_EXCLUDED_1=${dotCodexCanonical}`, `-DWRITABLE_ROOT_0_EXCLUDED_2=${dotAgentsCanonical}`,
    `-DWRITABLE_ROOT_1=${slashTmp}`,
  ]) assert.ok(args.includes(definition), `missing ${definition}: ${args.join('\n')}`);
  assert.deepEqual(args.slice(args.indexOf('--') + 1), shellCommand);
});

test('read-only policy denies writes everywhere but still runs commands', darwin, t => {
  const workspace = tempDir(t);
  const target = join(realpathSync(workspace), 'out.txt');
  const args = createSeatbeltCommandArgs(['bash', '-c', 'echo hi > "$1"', 'bash', target], { mode: 'read-only', networkAccess: false }, workspace);
  assert.ok(!args.some(arg => arg.startsWith('-DWRITABLE_ROOT_')));
  const output = run(args, workspace);
  assert.ok(!output.success);
  assertSeatbeltDenied(output.stderr, target);
  assert.ok(run(createSeatbeltCommandArgs(['/bin/cat', '/etc/hosts'], { mode: 'read-only', networkAccess: false }, workspace), workspace).success);
});

test('restricted policies deny mutating fcntls and unrestricted xpc lookups', () => {
  const policyText = policyArg(createSeatbeltCommandArgs(['/usr/bin/true'], { mode: 'read-only', networkAccess: false }, '/'));
  assert.ok(policyText.includes('(deny system-fcntl (fcntl-command 80 110))'));
  assert.ok(policyText.includes('(deny mach-lookup (xpc-service-name-prefix ""))'));
});

test('network is blocked unless the policy enables it', darwin, async t => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = String((server.address() as { port: number }).port);
  const workspace = tempDir(t);
  const connect = ['/usr/bin/nc', '-z', '-w', '2', '127.0.0.1', port];
  const blocked = createSeatbeltCommandArgs(connect, { mode: 'workspace-write', networkAccess: false }, workspace);
  const allowed = createSeatbeltCommandArgs(connect, { mode: 'workspace-write', networkAccess: true }, workspace);
  const runAsync = (args: string[]) => new Promise<boolean>(resolve => {
    spawn(MACOS_PATH_TO_SEATBELT_EXECUTABLE, args, { cwd: workspace, stdio: 'ignore' }).on('exit', code => resolve(code === 0));
  });
  assert.equal(await runAsync(blocked), false);
  assert.equal(await runAsync(allowed), true);
});

test('sandbox env marks seatbelt and disabled network like Codex', () => {
  assert.deepEqual(sandboxEnv({ mode: 'workspace-write', networkAccess: false }), { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' });
  assert.deepEqual(sandboxEnv({ mode: 'workspace-write', networkAccess: true }), { CODEX_SANDBOX: 'seatbelt' });
});
