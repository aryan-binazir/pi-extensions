import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worktrees } from './manager.ts';
import worktree from './index.ts';
import { getActiveCwd, setActiveCwd } from './routing.ts';

type Git = (...args: string[]) => string;

/** A throwaway `<tmp>/repo` with one empty commit, plus its home directory for the `~/repos/.worktrees` layout. */
async function repoFixture(prefix: string, options: { branch?: string } = {}): Promise<{ home: string; repo: string; git: Git }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  try {
    const repo = join(home, 'repo');
    await mkdir(repo);
    const git: Git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', options.branch ?? 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    return { home, repo, git };
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}

/** Put an executable stand-in for `name` first on PATH for the duration of `body`, which receives the directory holding it. */
async function withFakeBin(home: string, name: string, source: string, body: (bin: string) => Promise<void>): Promise<void> {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), source, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try { await body(bin); } finally { process.env.PATH = previousPath; }
}

const mergedPrGh = (head: string) => `#!/bin/sh\nprintf '%s' '[{"state":"MERGED","mergedAt":"2026-01-01","headRefOid":"${head}"}]'\n`;

test('remove requires one nonempty path argument without confirmation or routing changes', async t => {
  const { home, repo } = await repoFixture('pi-worktree-remove-args-');
  const sessionId = 'remove-args';
  const commands: Record<string, any> = {};
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const checkout = await trees.open('active');
    setActiveCwd(repo, checkout.path, sessionId);
    let confirmations = 0;
    const notices: Array<{ message: string; level: string }> = [];
    const entries: unknown[] = [];
    const ctx: any = {
      cwd: repo, hasUI: true, isIdle: () => true,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: (message: string, level: string) => notices.push({ message, level }), setStatus() {}, confirm: async () => { confirmations++; return true; } },
    };
    worktree({ on() {}, registerTool() {}, appendEntry: (...args: unknown[]) => entries.push(args), registerCommand: (name: string, command: any) => commands[name] = command } as any);
    for (const args of ['remove', 'remove --force', 'remove /a/one /a/two', 'remove /a/one --force /a/two', 'remove "" --force']) {
      await t.test(args, async () => {
        notices.length = 0;
        await commands.worktree.handler(args, ctx);
        assert.deepEqual(notices, [{ message: 'Usage: /worktree remove <path> [--force]', level: 'error' }]);
        assert.equal(confirmations, 0);
        assert.deepEqual(entries, []);
        assert.equal(getActiveCwd(repo, sessionId), checkout.path);
        assert.equal(await realpath(checkout.path), checkout.path);
      });
    }
  } finally { setActiveCwd(repo, undefined, sessionId); await rm(home, { recursive: true, force: true }); }
});

test('refuses a deleted checkout and allows reopening after explicit Git recovery', async () => {
  const { home, repo, git } = await repoFixture('pi-worktree-deleted-');
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const checkout = await trees.open('task');
    await rm(checkout.path, { recursive: true });
    await assert.rejects(trees.open('task'), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Worktree directory is unavailable/);
      assert.ok(error.message.includes(checkout.path));
      return true;
    });
    await writeFile(checkout.path, 'not a checkout directory');
    await assert.rejects(trees.open('task'), /Worktree directory is unavailable/);
    await rm(checkout.path);
    git('worktree', 'remove', '--force', checkout.path);
    const reopened = await trees.open('task');
    assert.equal(await realpath(reopened.path), checkout.path);
    assert.equal(reopened.branch, checkout.branch);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('creates the managed checkout layout, preserves an explicit branch and reuses an existing checkout', async () => {
  const { home, repo } = await repoFixture('pi-worktree-');
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const first = await trees.open('task');
    assert.equal(first.path, join(home, 'repos/.worktrees/repo/task'));
    assert.equal(first.branch, 'amb/task');
    assert.equal((await trees.open('task')).path, first.path);
    assert.equal((await trees.open('second', { branch: 'team/exact' })).branch, 'team/exact');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('remove refuses a dirty checkout, then an unconfirmed one, and succeeds once forced and confirmed', async () => {
  const { home, repo } = await repoFixture('pi-worktree-remove-');
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const checkout = await trees.open('task');
    await writeFile(join(checkout.path, 'dirty'), 'keep');
    assert.deepEqual(await trees.remove(checkout.path, { confirm: async () => true }), { removed: false, reason: 'dirty' });
    assert.deepEqual(await trees.remove(checkout.path, { force: true, confirm: async () => false }), { removed: false, reason: 'not confirmed' });
    assert.deepEqual(await trees.remove(checkout.path, { force: true, confirm: async () => true }), { removed: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cleanup only removes a clean checkout at the exact head of a merged PR', async () => {
  const { home, repo, git } = await repoFixture('pi-worktree-clean-');
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const merged = await trees.open('merged'); const dirty = await trees.open('dirty'); const ahead = await trees.open('ahead');
    const originalHead = git('rev-parse', 'HEAD').trim();
    await writeFile(join(dirty.path, 'keep'), 'uncommitted');
    git('-C', ahead.path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'post merge');
    await withFakeBin(home, 'gh', mergedPrGh(originalHead), async () => {
      let confirmations = 0;
      const results = await trees.cleanup({ confirm: async () => { confirmations++; return true; } });
      assert.equal(confirmations, 1);
      assert.deepEqual(results.find(item => item.path === merged.path), { path: merged.path, removed: true });
      assert.equal(results.find(item => item.path === dirty.path)?.reason, 'dirty');
      assert.equal(results.find(item => item.path === ahead.path)?.reason, 'no merged PR at checkout HEAD');
      await assert.rejects(trees.remove(repo, { force: true, confirm: async () => true }), /primary/);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('unsafe names cannot escape the worktree directory', async () => {
  const trees = new Worktrees('/tmp', { herdr: false });
  const rejected: Array<[string, RegExp]> = [
    ['../escape', /'\.\.\/escape' is not a valid branch name/],
    ['..', /Worktree name must be a single safe directory name/],
    ['/absolute', /'\/absolute' is not a valid branch name/],
    ['-flag', /Worktree name must be a single safe directory name/],
    ['amb/nested/name', /Worktree name must be a single safe directory name/],
  ];
  for (const [name, message] of rejected) await assert.rejects(trees.open(name), message, name);
});

test('active Herdr uses create/open and resolves an opaque workspace for removal', async () => {
  const { home, repo, git } = await repoFixture('pi-worktree-herdr-');
  try {
    const log = join(home, 'calls.jsonl');
    const checkoutPath = join(home, 'repos/.worktrees/repo/task');
    // Records every invocation, then performs the Git side of create/remove itself and answers `list` with one opaque workspace.
    const herdr = `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const get = key => a[a.indexOf(key) + 1];
if (a[1] === 'create') cp.execFileSync('git', ['worktree', 'add', '-b', get('--branch'), get('--path'), get('--base')], { cwd: get('--cwd') });
if (a[1] === 'list') console.log(JSON.stringify({ result: { worktrees: [{ open_workspace_id: 'w-opaque', path: ${JSON.stringify(checkoutPath)} }] } }));
if (a[1] === 'remove') {
  if (get('--workspace') !== 'w-opaque') process.exit(2);
  cp.execFileSync('git', ['worktree', 'remove', ${JSON.stringify(checkoutPath)}], { cwd: ${JSON.stringify(repo)} });
}
`;
    await withFakeBin(home, 'herdr', herdr, async () => {
      const trees = new Worktrees(repo, { home, herdr: true });
      const checkout = await trees.open('task'); await trees.open('task');
      assert.equal(checkout.path, checkoutPath);
      await rm(checkout.path, { recursive: true });
      await assert.rejects(trees.open('task'), /Worktree directory is unavailable/);
      git('worktree', 'remove', '--force', checkout.path);
      git('worktree', 'add', checkout.path, checkout.branch);
      assert.equal((await trees.remove(checkout.path, { confirm: async () => true })).removed, true);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(args => args[1] !== 'list');
      assert.deepEqual(calls[0], ['worktree', 'create', '--cwd', repo, '--branch', 'amb/task', '--base', 'main', '--path', checkout.path, '--no-focus']);
      assert.deepEqual(calls[1], ['worktree', 'open', '--cwd', repo, '--path', checkout.path, '--no-focus']);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.at(-1), ['worktree', 'remove', '--workspace', 'w-opaque']);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a checkout Herdr knows but has not opened is removed through Git', async () => {
  const { home, repo } = await repoFixture('pi-worktree-unopened-');
  try {
    const checkout = await new Worktrees(repo, { home, herdr: false }).open('unopened');
    // Herdr lists the checkout without a workspace; any `remove` sent to it must fail loudly.
    const herdr = `#!/bin/sh\n[ "$2" = remove ] && exit 2\nprintf '%s' '{"result":{"worktrees":[{"path":"${checkout.path}","open_workspace_id":null}]}}'\n`;
    await withFakeBin(home, 'herdr', herdr, async () => {
      const trees = new Worktrees(repo, { home, herdr: true });
      assert.equal((await trees.remove(checkout.path, { confirm: async () => true })).removed, true);
      await assert.rejects(realpath(checkout.path), { code: 'ENOENT' });
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an unreachable Herdr server falls back to Git for both create and remove', async () => {
  const { home, repo } = await repoFixture('pi-worktree-offline-');
  try {
    const herdr = '#!/bin/sh\nprintf \'%s\' \'{"error":{"code":"server_not_running"}}\' >&2\nexit 1\n';
    await withFakeBin(home, 'herdr', herdr, async () => {
      const trees = new Worktrees(repo, { home, herdr: true });
      const fallback = await trees.open('offline');
      assert.equal(fallback.branch, 'amb/offline');
      assert.equal((await trees.remove(fallback.path, { confirm: async () => true })).removed, true);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a checkout that is itself the session directory is never removed', async () => {
  const { home, repo } = await repoFixture('pi-worktree-session-');
  try {
    const checkout = await new Worktrees(repo, { home, herdr: false }).open('unopened');
    await assert.rejects(new Worktrees(checkout.path, { home, herdr: false }).remove(checkout.path, { confirm: async () => true }), /original session directory/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cleanup preserves outcomes and continues past unmanaged and missing checkouts', async () => {
  const { home, repo, git } = await repoFixture('pi-worktree-mixed-');
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    const managed = await trees.open('managed');
    const stale = await trees.open('stale');
    const afterStale = await trees.open('zz-after-stale');
    const unmanaged = join(home, 'z-unmanaged');
    git('worktree', 'add', '-b', 'unmanaged', unmanaged);
    await rm(stale.path, { recursive: true });
    await withFakeBin(home, 'gh', mergedPrGh(git('rev-parse', 'HEAD').trim()), async () => {
      let confirmations = 0;
      const results = await trees.cleanup({ confirm: async () => { confirmations++; return true; } });
      assert.equal(confirmations, 2);
      assert.deepEqual(results.find(item => item.path === afterStale.path), { path: afterStale.path, removed: true });
      assert.deepEqual(results.find(item => item.path === managed.path), { path: managed.path, removed: true });
      assert.match(results.find(item => item.path === stale.path)?.reason ?? '', /ENOENT/);
      assert.match(results.find(item => item.path === unmanaged)?.reason ?? '', /outside the managed/);
      assert.equal(await realpath(unmanaged), unmanaged);
      await rm(join(home, 'repos'), { recursive: true });
      const missingLayout = await trees.cleanup({ confirm: async () => { throw new Error('must not approve'); } });
      assert.equal(missingLayout.length, 2);
      assert.ok(missingLayout.every(item => !item.removed && item.reason?.includes('ENOENT')));
      assert.equal(await realpath(unmanaged), unmanaged);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('new branches use master or the remote default and require a base when neither exists', async () => {
  const { home, repo, git } = await repoFixture('pi-worktree-base-', { branch: 'master' });
  try {
    const trees = new Worktrees(repo, { home, herdr: false });
    assert.equal((await trees.open('from-master')).branch, 'amb/from-master');
    git('branch', '-m', 'trunk');
    await assert.rejects(trees.open('needs-base'), /specify --base/);
    git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal((await trees.open('from-remote')).branch, 'amb/from-remote');
  } finally { await rm(home, { recursive: true, force: true }); }
});


/** The command handler builds its manager from the real home directory and Herdr environment; point both at the fixture. */
async function withHome(home: string, body: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME, previousHerdr = process.env.HERDR_ENV;
  process.env.HOME = home; delete process.env.HERDR_ENV;
  try { await body(); } finally {
    process.env.HOME = previousHome;
    if (previousHerdr === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousHerdr;
  }
}

/** The extension registered against a recording context, with the session's routing cleared afterwards. */
function commandHost(repo: string, sessionId: string, options: { confirm?: () => Promise<boolean> } = {}) {
  const commands: Record<string, any> = {};
  const entries: unknown[] = [];
  const notices: string[] = [];
  const ctx: any = {
    cwd: repo, hasUI: true, isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { notify: (message: string) => notices.push(message), setStatus() {}, confirm: options.confirm ?? (async () => true) },
  };
  worktree({ on() {}, registerTool() {}, appendEntry: (_type: string, data: unknown) => entries.push(data), registerCommand: (name: string, value: any) => commands[name] = value } as any);
  return { ctx, entries, notices, run: (args: string) => commands.worktree.handler(args, ctx), release: () => setActiveCwd(repo, undefined, sessionId) };
}

test('/worktree <name> --branch creates the checkout, activates it and persists the switch', async () => {
  const { home, repo } = await repoFixture('pi-worktree-command-');
  const h = commandHost(repo, 'command-open');
  try {
    await withHome(home, async () => {
      await h.run('feature --branch team/exact');
      const path = join(home, 'repos/.worktrees/repo/feature');
      assert.deepEqual({ entries: h.entries, active: getActiveCwd(repo, 'command-open'), notice: h.notices.at(-1) },
        { entries: [{ version: 1, path }], active: path, notice: `Active worktree: ${path}. Pi session storage remains at ${repo}.` });
      await h.run('feature --base');
      assert.equal(h.notices.at(-1), 'Usage: /worktree <name> [--branch branch] [--base ref]');
    });
  } finally { h.release(); await rm(home, { recursive: true, force: true }); }
});

test('/worktree remove keeps quoted spaces in the path and reports an unconfirmed removal', async () => {
  const { home, repo } = await repoFixture('pi worktree spaced ');
  const h = commandHost(repo, 'command-spaces', { confirm: async () => false });
  try {
    await withHome(home, async () => {
      const checkout = await new Worktrees(repo, { home, herdr: false }).open('task');
      assert.match(checkout.path, / /);
      await h.run(`remove "${checkout.path}" --force`);
      assert.equal(h.notices.at(-1), `${checkout.path}: not confirmed`);
      await h.run(`remove '${checkout.path}'`);
      assert.equal(h.notices.at(-1), `${checkout.path}: not confirmed`);
      await h.run('remove "unclosed');
      assert.equal(h.notices.at(-1), 'Unclosed quote in worktree command');
      assert.equal(await realpath(checkout.path), checkout.path);
    });
  } finally { h.release(); await rm(home, { recursive: true, force: true }); }
});

test('removing the active checkout through an alias resets routing before the directory disappears', async () => {
  const { home, repo } = await repoFixture('pi-worktree-alias-');
  const h = commandHost(repo, 'command-alias');
  try {
    await withHome(home, async () => {
      const checkout = await new Worktrees(repo, { home, herdr: false }).open('task');
      const alias = join(home, 'alias'); await symlink(checkout.path, alias);
      setActiveCwd(repo, checkout.path, 'command-alias');
      await h.run(`remove "${alias}"`);
      assert.deepEqual({ active: getActiveCwd(repo, 'command-alias'), entries: h.entries, notice: h.notices.at(-1) },
        { active: repo, entries: [{ version: 1, path: repo }], notice: `${checkout.path}: removed` });
      await assert.rejects(realpath(checkout.path), { code: 'ENOENT' });
      await h.run(`remove "${alias}"`);
      assert.match(h.notices.at(-1) ?? '', /ENOENT/);
    });
  } finally { h.release(); await rm(home, { recursive: true, force: true }); }
});
