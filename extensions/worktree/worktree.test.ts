import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worktrees } from './manager.ts';

test('creates Herdr-layout checkout, preserves explicit branch and reuses existing checkout', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktree-')));
  try {
    const repo = join(home, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    const trees = new Worktrees(repo, { home, herdr: false });
    const first = await trees.open('task');
    assert.equal(first.path, join(home, 'repos/.worktrees/repo/task'));
    assert.equal(first.branch, 'amb/task');
    assert.equal((await trees.open('task')).path, first.path);
    assert.equal((await trees.open('second', { branch: 'team/exact' })).branch, 'team/exact');
    await writeFile(join(first.path, 'dirty'), 'keep');
    assert.equal((await trees.remove(first.path, { confirm: async () => true })).removed, false);
    assert.equal((await trees.remove(first.path, { force: true, confirm: async () => false })).removed, false);
    assert.equal((await trees.remove(first.path, { force: true, confirm: async () => true })).removed, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cleanup only removes a clean checkout at the exact head of a merged PR', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktree-clean-')));
  const previousPath = process.env.PATH;
  try {
    const repo = join(home, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    const trees = new Worktrees(repo, { home, herdr: false });
    const merged = await trees.open('merged'); const dirty = await trees.open('dirty'); const ahead = await trees.open('ahead');
    const originalHead = git('rev-parse', 'HEAD').trim();
    await writeFile(join(dirty.path, 'keep'), 'uncommitted');
    git('-C', ahead.path, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'post merge');
    const bin = join(home, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf '%s' '[{"state":"MERGED","mergedAt":"2026-01-01","headRefOid":"${originalHead}"}]'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    let confirmations = 0;
    const results = await trees.cleanup({ confirm: async () => { confirmations++; return true; } });
    assert.equal(confirmations, 1);
    assert.deepEqual(results.find(item => item.path === merged.path), { path: merged.path, removed: true });
    assert.equal(results.find(item => item.path === dirty.path)?.reason, 'dirty');
    assert.equal(results.find(item => item.path === ahead.path)?.reason, 'no merged PR at checkout HEAD');
    await assert.rejects(trees.remove(repo, { force: true, confirm: async () => true }), /primary/);
  } finally { process.env.PATH = previousPath; await rm(home, { recursive: true, force: true }); }
});

test('unsafe names cannot escape the worktree directory', async () => {
  const trees = new Worktrees('/tmp', { herdr: false });
  for (const name of ['../escape', '..', '/absolute', '-flag', 'amb/nested/name']) await assert.rejects(trees.open(name), /single safe directory|not a valid branch/);
});

test('active Herdr uses create/open and resolves an opaque workspace for removal', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktree-herdr-')));
  const previousPath = process.env.PATH;
  try {
    const repo = join(home, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    const bin = join(home, 'bin'); await mkdir(bin);
    const log = join(home, 'calls.jsonl');
    await writeFile(join(bin, 'herdr'), `#!/usr/bin/env node\nconst fs=require('node:fs'),cp=require('node:child_process');\nconst a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');\nconst get=k=>a[a.indexOf(k)+1];\nif(a[1]==='create')cp.execFileSync('git',['worktree','add','-b',get('--branch'),get('--path'),get('--base')],{cwd:get('--cwd')});\nif(a[1]==='list')console.log(JSON.stringify({result:{worktrees:[{open_workspace_id:'w-opaque',path:${JSON.stringify(join(home, 'repos/.worktrees/repo/task'))}}]}}));\nif(a[1]==='remove'){if(get('--workspace')!=='w-opaque')process.exit(2);cp.execFileSync('git',['worktree','remove',${JSON.stringify(join(home, 'repos/.worktrees/repo/task'))}],{cwd:${JSON.stringify(repo)}});}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    const trees = new Worktrees(repo, { home, herdr: true });
    const checkout = await trees.open('task'); await trees.open('task');
    assert.equal((await trees.remove(checkout.path, { confirm: async () => true })).removed, true);
    const { readFile } = await import('node:fs/promises');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(args => args[1] !== 'list');
    assert.deepEqual(calls[0], ['worktree', 'create', '--cwd', repo, '--branch', 'amb/task', '--base', 'main', '--path', checkout.path, '--no-focus']);
    assert.deepEqual(calls[1], ['worktree', 'open', '--cwd', repo, '--path', checkout.path, '--no-focus']);
    assert.deepEqual(calls.at(-1), ['worktree', 'remove', '--workspace', 'w-opaque']);
  } finally { process.env.PATH = previousPath; await rm(home, { recursive: true, force: true }); }
});

test('unopened Herdr worktrees and unavailable server use Git; original session checkout stays protected', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktree-fallback-')));
  const previousPath = process.env.PATH;
  try {
    const repo = join(home, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    const gitTrees = new Worktrees(repo, { home, herdr: false });
    const checkout = await gitTrees.open('unopened');
    await assert.rejects(new Worktrees(checkout.path, { home, herdr: false }).remove(checkout.path, { confirm: async () => true }), /original session directory/);
    const bin = join(home, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'herdr'), `#!/bin/sh\nprintf '%s' '{"result":{"worktrees":[{"path":"${checkout.path}","open_workspace_id":null}]}}'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath}`;
    const trees = new Worktrees(repo, { home, herdr: true });
    assert.equal((await trees.remove(checkout.path, { confirm: async () => true })).removed, true);
    await writeFile(join(bin, 'herdr'), '#!/bin/sh\nprintf \'%s\' \'{"error":{"code":"server_not_running"}}\' >&2\nexit 1\n', { mode: 0o755 });
    const fallback = await trees.open('offline');
    assert.equal(fallback.branch, 'amb/offline');
    assert.equal((await trees.remove(fallback.path, { confirm: async () => true })).removed, true);
  } finally { process.env.PATH = previousPath; await rm(home, { recursive: true, force: true }); }
});
