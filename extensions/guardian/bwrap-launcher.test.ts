// Ported from openai/codex codex-rs/sandboxing/src/bwrap_tests.rs, codex-rs/linux-sandbox/src/launcher.rs and
// codex-rs/linux-sandbox/tests/suite/bundled_bwrap.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md. Fake
// bubblewrap scripts stand in for the real one, so these run on every Unix platform.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  bundledBwrapCandidates, bwrapCapabilities, bwrapHasUserNamespaceAccess, codexExecutable, findBwrapLauncher, findCodexBundledBwrap,
  findExecutableInSearchPaths, findSystemBwrap, procVersionIndicatesWsl1,
} from './bwrap-launcher.ts';
import type { WritableRoot } from './seatbelt.ts';

const HELP = "#!/bin/sh\nprintf '%s\\n' '--as-pid-1' '--perms' '--argv0'\n";

function tempDir(t: test.TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-bwrap-launcher-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(path: string, contents = HELP): string {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
  return path;
}

function writeFakeBwrap(dir: string, contents = HELP): string {
  mkdirSync(dir, { recursive: true });
  return writeExecutable(join(dir, 'bwrap'), contents);
}

test('the probe reports user namespace failures', async t => {
  const dir = tempDir(t);
  for (const failure of ['loopback: Failed RTM_NEWADDR', 'loopback: Failed RTM_NEWLINK', 'setting up uid map: Permission denied', 'No permissions to create a new namespace',
    'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.']) {
    const bwrap = writeFakeBwrap(join(dir, String(failure.length)), `#!/bin/sh\necho '${failure}' >&2\nexit 1\n`);
    assert.equal(await bwrapHasUserNamespaceAccess(bwrap), false, failure);
  }
});

test('the probe ignores unrelated bubblewrap failures', async t => {
  const bwrap = writeFakeBwrap(tempDir(t), "#!/bin/sh\necho 'bwrap: Unknown option --argv0' >&2\nexit 1\n");
  assert.equal(await bwrapHasUserNamespaceAccess(bwrap), true);
});

test('namespace classification preserves stderr, exit status, prefix capture and timeout precedence', async t => {
  const dir = tempDir(t), denial = 'setting up uid map: Permission denied';
  for (const [name, script, expected] of [
    ['success', `echo '${denial}' >&2; exit 0`, true],
    ['exit126', `echo '${denial}' >&2; exit 126`, false],
    ['exit127', `echo '${denial}' >&2; exit 127`, false],
    ['signal', `echo '${denial}' >&2; kill -TERM $$`, false],
    ['stdout', `echo '${denial}'; exit 1`, true],
    ['timeout', `echo '${denial}' >&2; exec /bin/sleep 30`, true],
  ] as const) {
    const bwrap = writeFakeBwrap(join(dir, name), `#!/bin/sh\n${script}\n`);
    assert.equal(await bwrapHasUserNamespaceAccess(bwrap, 100), expected, name);
  }
  for (const early of [true, false]) {
    const bwrap = writeFakeBwrap(join(dir, String(early)), `#!${process.execPath}
const fs = require('node:fs');
fs.writeSync(2, ${JSON.stringify(early ? denial : '')} + 'x'.repeat(256 * 1024));
setTimeout(() => { fs.writeSync(2, ${JSON.stringify(denial)}); process.exit(1); }, 50);
`);
    assert.equal(await bwrapHasUserNamespaceAccess(bwrap, 1000), !early, 'only the original stderr prefix contributes');
  }
  assert.equal(await bwrapHasUserNamespaceAccess(join(dir, 'missing')), true);
  assert.equal(await bwrapHasUserNamespaceAccess('\0'), true);
});

test('a probe that times out does not report a failure', async t => {
  const bwrap = writeFakeBwrap(tempDir(t), '#!/bin/sh\nsleep 1\nexit 0\n');
  const started = Date.now();
  assert.equal(await bwrapHasUserNamespaceAccess(bwrap, 100), true);
  assert.ok(Date.now() - started < 900);
});

test('the probe reaps descendants holding stderr open without losing the namespace denial', async t => {
  const dir = tempDir(t), pidFile = join(dir, 'descendant.pid');
  let descendant = 0;
  t.after(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const bwrap = writeFakeBwrap(dir, `#!/bin/sh
/bin/sleep 30 >&2 &
echo $! > '${pidFile}'
echo 'setting up uid map: Permission denied' >&2
exit 1
`);
  const started = Date.now();
  const supported = await bwrapHasUserNamespaceAccess(bwrap);
  descendant = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(supported, false);
  assert.ok(Date.now() - started < 500);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(descendant, 0), /ESRCH/, 'the completed probe owns its remaining process group');
});

test('WSL1 kernels are detected', () => {
  for (const version of ['Linux version 4.4.0-22621-Microsoft', 'Linux version 5.15.0-microsoft-standard-WSL1', 'Linux version 5.15.0-wsl-microsoft-standard-WSL1']) {
    assert.equal(procVersionIndicatesWsl1(version), true, version);
  }
});

test('WSL2 and native Linux are not WSL1', () => {
  for (const version of ['Linux version 6.6.87.2-microsoft-standard-WSL2', 'Linux version 6.6.87.2-wsl-microsoft-standard-WSL2',
    'Linux version 4.19.104-microsoft-standard', 'Linux version 6.6.87.2-microsoft-standard-WSL3', 'Linux version 6.8.0']) {
    assert.equal(procVersionIndicatesWsl1(version), false, version);
  }
});

test('the first executable bwrap on the search path wins', t => {
  const dir = tempDir(t);
  const cwd = join(dir, 'cwd'), first = join(dir, 'first'), second = join(dir, 'second');
  mkdirSync(cwd);
  mkdirSync(first);
  writeFileSync(join(first, 'bwrap'), 'not executable');
  const expected = writeFakeBwrap(second);
  assert.equal(findExecutableInSearchPaths('bwrap', [first, second], cwd, []), expected);
});

test('a workspace-local bwrap is skipped', t => {
  const dir = tempDir(t);
  const cwd = join(dir, 'cwd');
  writeFakeBwrap(cwd);
  const expected = writeFakeBwrap(join(dir, 'trusted'));
  assert.equal(findExecutableInSearchPaths('bwrap', [cwd, join(dir, 'trusted')], cwd, []), expected);
});

test('a root cwd does not hide system bwrap candidates', t => {
  const expected = writeFakeBwrap(join(tempDir(t), 'bin'));
  assert.equal(findExecutableInSearchPaths('bwrap', [join(expected, '..')], '/', []), expected);
});

test('bwrap in writable roots outside the command cwd is skipped', t => {
  const dir = tempDir(t);
  const workspace = join(dir, 'workspace'), cwd = join(workspace, 'service'), workspaceBin = join(workspace, 'bin');
  const extraRoot = join(dir, 'extra'), trusted = join(dir, 'trusted');
  mkdirSync(cwd, { recursive: true });
  writeFakeBwrap(workspaceBin);
  writeFakeBwrap(extraRoot);
  const expected = writeFakeBwrap(trusted);
  const roots: WritableRoot[] = [{ root: workspace, readOnlySubpaths: [] }, { root: extraRoot, readOnlySubpaths: [] }];

  assert.equal(findExecutableInSearchPaths('bwrap', [workspaceBin, extraRoot], cwd, roots), undefined);
  assert.equal(findExecutableInSearchPaths('bwrap', [workspaceBin, extraRoot, trusted], cwd, roots), expected);
});

test('bwrap in a symlinked writable root is skipped', t => {
  const dir = tempDir(t);
  const workspace = join(dir, 'workspace'), cwd = join(workspace, 'service'), workspaceBin = join(workspace, 'bin'), alias = join(dir, 'alias');
  mkdirSync(cwd, { recursive: true });
  writeFakeBwrap(workspaceBin);
  symlinkSync(workspace, alias);
  assert.equal(findExecutableInSearchPaths('bwrap', [workspaceBin], cwd, [{ root: alias, readOnlySubpaths: [] }]), undefined);
});

test('a read-only bwrap carveout does not trust a replaceable parent', t => {
  const dir = tempDir(t);
  const bwrap = writeFakeBwrap(join(dir, 'bin'));
  assert.equal(findExecutableInSearchPaths('bwrap', [join(dir, 'bin')], '/', [{ root: dir, readOnlySubpaths: [bwrap] }]), undefined);
});

test('a read-only system installation stays usable', t => {
  const dir = tempDir(t);
  const systemBinary = realpathSync('/bin/sh');
  symlinkSync(systemBinary, join(dir, 'bwrap'));
  const canModify = process.geteuid!() === 0;
  assert.equal(findExecutableInSearchPaths('bwrap', [dir], '/', [{ root: dir, readOnlySubpaths: [] }]), canModify ? undefined : systemBinary);
});

test('system bwrap needs --as-pid-1 and --perms', async t => {
  const dir = tempDir(t);
  const modern = writeFakeBwrap(join(dir, 'modern'));
  const noPidOne = writeFakeBwrap(join(dir, 'no-pid-one'), "#!/bin/sh\nprintf '%s\\n' '--perms' '--argv0'\n");
  const noPerms = writeFakeBwrap(join(dir, 'no-perms'), "#!/bin/sh\nprintf '%s\\n' '--as-pid-1'\n");
  const noArgv0 = writeFakeBwrap(join(dir, 'no-argv0'), "#!/bin/sh\nprintf '%s\\n' '--as-pid-1' '--perms' >&2\nexit 1\n");

  assert.deepEqual(await bwrapCapabilities(modern), { supportsArgv0: true, supportsPerms: true });
  assert.equal(await bwrapCapabilities(noPidOne), undefined);
  assert.deepEqual(await bwrapCapabilities(noArgv0), { supportsArgv0: false, supportsPerms: true }, 'stderr help counts, and --argv0 is optional');
  assert.equal(await findSystemBwrap([join(dir, 'no-perms'), join(dir, 'no-pid-one'), join(dir, 'modern')], '/', []), undefined,
    'only the first bwrap on PATH is considered, as in Codex');
  assert.equal(await findSystemBwrap([join(dir, 'no-perms')], '/', []), undefined);
  assert.equal(await findSystemBwrap([join(dir, 'no-argv0')], '/', []), noArgv0);
  assert.equal(noPerms.endsWith('bwrap'), true);
  writeExecutable(modern, "#!/bin/sh\nprintf '%s\\n' '--as-pid-1'\n");
  assert.equal(await findSystemBwrap([join(dir, 'modern')], '/', []), undefined, 'changed executable invalidates the positive cache');
});

/** An npm global install: `bin/codex -> lib/node_modules/@openai/codex/bin/codex.js`, with the platform package. */
function npmCodexInstall(prefix: string, target: string, platformPackage: string): { bin: string; bundled: string } {
  const packageRoot = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }));
  writeExecutable(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  const platformRoot = join(packageRoot, 'node_modules', ...platformPackage.split('/'));
  mkdirSync(join(platformRoot, 'vendor', target, 'bin'), { recursive: true });
  mkdirSync(join(platformRoot, 'vendor', target, 'codex-resources'), { recursive: true });
  writeFileSync(join(platformRoot, 'package.json'), JSON.stringify({ name: platformPackage }));
  writeFileSync(join(platformRoot, 'vendor', target, 'codex-package.json'), '{}');
  writeExecutable(join(platformRoot, 'vendor', target, 'bin', 'codex'), '#!/bin/sh\n');
  const bundled = writeExecutable(join(platformRoot, 'vendor', target, 'codex-resources', 'bwrap'));
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(join(packageRoot, 'bin', 'codex.js'), join(prefix, 'bin', 'codex'));
  return { bin: join(prefix, 'bin'), bundled };
}

test('the bundled bwrap is found through the npm codex.js shim', t => {
  const dir = tempDir(t);
  const { bin, bundled } = npmCodexInstall(join(dir, 'prefix'), 'x86_64-unknown-linux-musl', '@openai/codex-linux-x64');
  const exe = codexExecutable([bin], dir, 'x64');
  assert.equal(exe, join(bundled, '..', '..', 'bin', 'codex'));
  assert.equal(findCodexBundledBwrap([bin], join(dir, 'workspace'), [], { CODEX_HOME: join(dir, 'codex-home') }), process.arch === 'x64' ? bundled : undefined);
  assert.equal(codexExecutable([bin], dir, 'arm64'), undefined, 'another architecture has no native package');
});

test('a bundled bwrap the sandbox could replace is skipped', t => {
  const dir = tempDir(t);
  const prefix = join(dir, 'workspace', 'prefix');
  const { bin } = npmCodexInstall(prefix, 'aarch64-unknown-linux-musl', '@openai/codex-linux-arm64');
  assert.equal(findCodexBundledBwrap([bin], join(dir, 'workspace'), [], {}), undefined, 'inside the cwd');
  assert.equal(findCodexBundledBwrap([bin], dir, [{ root: join(dir, 'workspace'), readOnlySubpaths: [] }], {}), undefined, 'inside a writable root');
});

test('standalone and legacy layouts are searched like Codex', t => {
  const dir = tempDir(t);
  const codexHome = join(dir, '.codex');
  const release = join(codexHome, 'packages', 'standalone', 'releases', '0.163.0-x86_64-unknown-linux-musl');
  mkdirSync(release, { recursive: true });
  assert.deepEqual(bundledBwrapCandidates(join(release, 'codex'), codexHome), [
    join(release, 'codex-resources', 'bwrap'), join(dirname(release), 'codex-resources', 'bwrap'), join(release, 'bwrap'),
  ]);
  const packageDir = join(dir, 'package');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(join(packageDir, 'codex-package.json'), '{}');
  assert.deepEqual(bundledBwrapCandidates(join(packageDir, 'bin', 'codex'), codexHome), [
    join(packageDir, 'codex-resources', 'bwrap'), join(packageDir, 'bin', 'codex-resources', 'bwrap'), join(packageDir, 'bin', 'bwrap'),
  ]);
});

test('system bubblewrap is preferred over the bundled one', async t => {
  const dir = tempDir(t);
  const { bin, bundled } = npmCodexInstall(join(dir, 'prefix'), process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl',
    process.arch === 'arm64' ? '@openai/codex-linux-arm64' : '@openai/codex-linux-x64');
  const system = writeFakeBwrap(join(dir, 'system'));
  const cwd = join(dir, 'workspace');
  mkdirSync(cwd);
  assert.deepEqual(await findBwrapLauncher(cwd, [], { PATH: `${join(dir, 'system')}:${bin}` }), { program: system, source: 'system' });
  assert.deepEqual(await findBwrapLauncher(cwd, [], { PATH: bin }), { program: bundled, source: 'codex' });
  writeExecutable(system, "#!/bin/sh\nprintf '%s\\n' '--as-pid-1'\n");
  assert.deepEqual(await findBwrapLauncher(cwd, [], { PATH: `${join(dir, 'system')}:${bin}` }), { program: bundled, source: 'codex' });
  assert.equal(await findBwrapLauncher(cwd, [], { PATH: join(dir, 'empty') }), undefined);
});

test('concurrent resolver callers share a probe without sharing cancellation', async t => {
  const dir = tempDir(t), count = join(dir, 'count'), pidFile = join(dir, 'pid');
  const system = writeFakeBwrap(join(dir, 'system'), `#!/bin/sh
printf 'probe\\n' >> '${count}'
echo $$ > '${pidFile}'
printf '%s\\n' --as-pid-1 --perms
exec /bin/sleep 0.2
`);
  const env = { PATH: join(dir, 'system') };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const cancelled = findBwrapLauncher('/', [], env, controller.signal);
  const successful = findBwrapLauncher('/', [], env);
  const rejection = assert.rejects(cancelled, /owned cancellation/);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pid = Number(readFileSync(pidFile, 'utf8')); if (pid > 1) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort(new Error('owned cancellation'));
  await rejection;
  assert.ok(pid && pid > 1, 'the shared probe started before cancellation');
  assert.deepEqual(await successful, { program: system, source: 'system' });
  assert.deepEqual(await findBwrapLauncher('/', [], env), { program: system, source: 'system' });
  assert.equal(readFileSync(count, 'utf8'), 'probe\n');
});

test('an abandoned probe is reaped without caching failure before a later resolver call', async t => {
  const dir = tempDir(t), pidFile = join(dir, 'pid'), count = join(dir, 'count');
  const program = writeFakeBwrap(join(dir, 'system'), `#!/bin/sh
printf '%s\\n' --as-pid-1 --perms
if [ ! -e '${count}' ]; then
  printf 'probe\\n' >> '${count}'
  echo $$ > '${pidFile}'
  exec /bin/sleep 30
fi
printf 'probe\\n' >> '${count}'
`);
  const env = { PATH: join(dir, 'system') };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const resolving = findBwrapLauncher('/', [], env, controller.signal);
  const rejection = assert.rejects(resolving, /owned cancellation/);
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pid = Number(readFileSync(pidFile, 'utf8')); if (pid > 1) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort(new Error('owned cancellation'));
  await rejection;
  assert.ok(pid && pid > 1, 'the capability probe started');
  let reaped = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0); } catch { reaped = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(reaped, true, 'cancelled probe was reaped');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(await findBwrapLauncher('/', [], env), { program, source: 'system' });
  assert.deepEqual(await findBwrapLauncher('/', [], env), { program, source: 'system' });
  await assert.rejects(findBwrapLauncher('/', [], env, AbortSignal.abort(new Error('already cancelled'))), /already cancelled/);
  assert.equal(readFileSync(count, 'utf8'), 'probe\nprobe\n');
});

function dirname(path: string): string {
  return join(path, '..');
}
