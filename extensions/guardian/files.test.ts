// Ported from openai/codex codex-rs/core/src/safety.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import type { ApprovalDecision, ApprovalRequest } from './approvals.ts';
import { assessFileChange, createGuardianFileTools, fileChangeAction, sandboxedWrite } from './files.ts';
import { detectPlatformSandbox } from './sandbox.ts';

const detected = (await detectPlatformSandbox()).sandbox;
const sandboxed = { skip: !detected && 'this platform has no usable sandbox' };

function workspace(t: test.TestContext) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-files-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-files-outside-')));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  return { cwd, outside };
}

const isolated = (overrides: Partial<GuardianConfig> = {}): GuardianConfig => ({
  ...DEFAULT_GUARDIAN_CONFIG, ...overrides,
  sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, excludeSlashTmp: true, excludeTmpdirEnvVar: true, ...overrides.sandbox },
});

test('writes inside writable roots auto-approve and others ask', t => {
  const { cwd, outside } = workspace(t);
  const assess = (path: string, config = isolated()) => assessFileChange(resolve(cwd, path), { config, cwd, sandboxAvailable: true });
  assert.equal(assess('src/new.ts'), 'auto_approve');
  assert.equal(assess(join(cwd, 'deep/missing/file.ts')), 'auto_approve');
  assert.equal(assess(join(outside, 'x.txt')), 'ask_user');
  assert.equal(assess(join(outside, 'x.txt'), isolated({ sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, writableRoots: [outside] } })), 'auto_approve');
});

test('protected metadata stays read-only, including case variants and gitdir pointers', t => {
  const { cwd, outside } = workspace(t);
  mkdirSync(join(cwd, '.git'));
  const gitdir = join(outside, 'worktrees', 'w');
  mkdirSync(gitdir, { recursive: true });
  const linked = join(cwd, 'linked');
  mkdirSync(linked);
  writeFileSync(join(linked, '.git'), `gitdir: ${gitdir}\n`);
  const config = isolated({ sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, writableRoots: [linked, outside] } });
  // `.GIT` aliases `.git` only on a case-insensitive volume, the macOS default.
  const caseVariants = process.platform === 'darwin' ? ['.GIT/config'] : [];
  for (const path of ['.git/hooks/pre-commit', '.codex/config.toml', '.agents/x', '.aws/credentials', '.pi/settings.json', ...caseVariants, join(gitdir, 'HEAD'), join(linked, '.git')]) {
    assert.equal(assessFileChange(resolve(cwd, path), { config, cwd, sandboxAvailable: true }), 'ask_user', path);
  }
  assert.equal(assessFileChange(resolve(cwd, '.gitignore'), { config, cwd, sandboxAvailable: true }), 'auto_approve');
});

test('symlinks are resolved before the writable-root check', t => {
  const { cwd, outside } = workspace(t);
  symlinkSync(outside, join(cwd, 'escape'));
  assert.equal(assessFileChange(resolve(cwd, 'escape/file.txt'), { config: isolated(), cwd, sandboxAvailable: true }), 'ask_user');
});

test('approval policy and sandbox mode follow Codex patch safety', t => {
  const { cwd, outside } = workspace(t);
  const inside = resolve(cwd, 'a.txt'), elsewhere = join(outside, 'b.txt');
  const assess = (path: string, config: GuardianConfig, sandboxAvailable = true) => assessFileChange(path, { config, cwd, sandboxAvailable });
  assert.equal(assess(inside, isolated({ approvalPolicy: 'unless-trusted' })), 'ask_user');
  assert.deepEqual(assess(elsewhere, isolated({ approvalPolicy: 'never' })), { type: 'reject', reason: 'writing outside of the project; rejected by user approval settings' });
  assert.deepEqual(assess(inside, isolated({ approvalPolicy: 'never', sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'read-only' } })),
    { type: 'reject', reason: 'writing is blocked by read-only sandbox; rejected by user approval settings' });
  assert.equal(assess(inside, isolated({ sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'read-only' } })), 'ask_user');
  assert.equal(assess(elsewhere, isolated({ sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'danger-full-access' } })), 'auto_approve');
  assert.equal(assess(inside, isolated(), false), 'ask_user');
  assert.equal(assess(elsewhere, isolated({ enabled: false })), 'auto_approve');
});

function fileTools(t: test.TestContext, config: GuardianConfig, decisions: ApprovalDecision[] = []) {
  const { cwd, outside } = workspace(t);
  const requests: ApprovalRequest[] = [];
  const queue = [...decisions];
  const [write, edit] = createGuardianFileTools({
    config: () => config, sandbox: detected,
    approvals: { request: async request => { requests.push(request); return queue.shift() ?? { type: 'rejected', message: 'not approved' }; } },
  }, cwd);
  const ctx = { cwd, hasUI: true, abort: () => {}, ui: { notify: () => {}, select: async () => undefined } };
  const run = (tool: typeof write | typeof edit, params: Record<string, unknown>) =>
    (tool.execute as (...args: unknown[]) => Promise<unknown>)('call-1', params, undefined, undefined, ctx);
  return { cwd, outside, write, edit, run, requests };
}

test('Pi path forms are gated at the path Pi resolved, including @ and file: prefixes', async t => {
  const { cwd, write, run, requests } = fileTools(t, isolated());
  mkdirSync(join(cwd, '.git'));
  for (const path of ['@.git/config', `file://${join(cwd, '.git', 'config')}`, '.git/config']) {
    await assert.rejects(run(write, { path, content: 'pwned' }), /not approved/, path);
  }
  assert.deepEqual(requests.map(request => String((request.action.files as string[])[0]).slice(cwd.length)), ['/.git/config', '/.git/config', '/.git/config'],
    'the review names the exact file Pi resolved');
  assert.ok(!existsSync(join(cwd, '.git', 'config')));
});

test('an approved write runs once and an ordinary workspace write is never asked about', sandboxed, async t => {
  const { cwd, outside, write, edit, run, requests } = fileTools(t, isolated(), [{ type: 'approved' }]);
  await run(write, { path: 'notes/inside.md', content: 'in' });
  assert.equal(readFileSync(join(cwd, 'notes/inside.md'), 'utf8'), 'in');
  assert.deepEqual(requests, []);
  const target = join(outside, 'approved.txt');
  await run(write, { path: target, content: 'out' });
  assert.equal(readFileSync(target, 'utf8'), 'out');
  assert.equal(requests.length, 1, 'one approval covers the whole change');
  await run(edit, { path: 'notes/inside.md', edits: [{ oldText: 'in', newText: 'edited' }] });
  assert.equal(readFileSync(join(cwd, 'notes/inside.md'), 'utf8'), 'edited');
  assert.equal(requests.length, 1);
});

test('a rejected directory creation leaves nothing behind', async t => {
  const { outside, write, run } = fileTools(t, isolated());
  await assert.rejects(run(write, { path: join(outside, 'new/dir/file.txt'), content: 'x' }), /not approved/);
  assert.ok(!existsSync(join(outside, 'new')));
});

test('a dangling symlink inside the workspace cannot redirect a write outside it', t => {
  const { cwd, outside } = workspace(t);
  symlinkSync(join(outside, 'missing.txt'), join(cwd, 'dangling'));
  assert.equal(assessFileChange(resolve(cwd, 'dangling'), { config: isolated(), cwd, sandboxAvailable: true }), 'ask_user');
  symlinkSync(join(outside, 'missing-dir'), join(cwd, 'dangling-dir'));
  assert.equal(assessFileChange(resolve(cwd, 'dangling-dir/file.txt'), { config: isolated(), cwd, sandboxAvailable: true }), 'ask_user');
});

test('a hardlink to a file outside the workspace is not writable', t => {
  const { cwd, outside } = workspace(t);
  const target = join(outside, 'target.txt');
  writeFileSync(target, 'original');
  linkSync(target, join(cwd, 'hardlink.txt'));
  assert.equal(assessFileChange(resolve(cwd, 'hardlink.txt'), { config: isolated(), cwd, sandboxAvailable: true }), 'ask_user');
});

test('file change actions carry the planned change for review', () => {
  assert.deepEqual(fileChangeAction('write', { path: 'a.txt', content: 'hi' }, '/repo/a.txt', '/repo'),
    { tool: 'write', cwd: '/repo', files: ['/repo/a.txt'], content: 'hi', environment_id: 'local' });
  assert.deepEqual(fileChangeAction('edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] }, '/repo/a.txt', '/repo'),
    { tool: 'edit', cwd: '/repo', files: ['/repo/a.txt'], edits: [{ oldText: 'a', newText: 'b' }], environment_id: 'local' });
  const big = fileChangeAction('write', { path: 'a', content: 'x'.repeat(200_000) }, '/repo/a', '/repo');
  assert.equal(big.content, 'x'.repeat(200_000), 'the reviewer sees the complete change');
});

test('a call aborted while approval is pending writes nothing', async t => {
  const { cwd, outside } = workspace(t);
  const controller = new AbortController();
  const [write] = createGuardianFileTools({
    config: () => isolated(), sandbox: detected,
    approvals: { request: async () => { controller.abort(); return { type: 'approved' }; } },
  }, cwd);
  const ctx = { cwd, hasUI: true, abort: () => {}, ui: { notify: () => {}, select: async () => undefined } };
  const target = join(outside, 'aborted.txt');
  await assert.rejects((write.execute as (...args: unknown[]) => Promise<unknown>)('c', { path: target, content: 'x' }, controller.signal, undefined, ctx), /aborted/i);
  assert.ok(!existsSync(target));
});

test('auto-approved writes run inside the sandbox, so a link swapped in after the check cannot escape', sandboxed, async t => {
  const { cwd, outside } = workspace(t);
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'original');
  symlinkSync(victim, join(cwd, 'swapped'));
  await assert.rejects(sandboxedWrite(join(cwd, 'swapped'), 'changed', isolated(), cwd, detected!), /Operation not permitted|Read-only file system/);
  assert.equal(readFileSync(victim, 'utf8'), 'original');
  await sandboxedWrite(join(cwd, 'deep/ok.txt'), 'ok', isolated(), cwd, detected!);
  assert.equal(readFileSync(join(cwd, 'deep/ok.txt'), 'utf8'), 'ok');
});
