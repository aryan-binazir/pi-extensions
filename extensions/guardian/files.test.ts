// Ported from openai/codex codex-rs/core/src/safety.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import { assessFileChange, fileChangeAction, resolveToolPath } from './files.ts';

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
  const assess = (path: string, config = isolated()) => assessFileChange(resolveToolPath(path, cwd), { config, cwd, sandboxAvailable: true });
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
  for (const path of ['.git/hooks/pre-commit', '.codex/config.toml', '.agents/x', '.aws/credentials', '.GIT/config', join(gitdir, 'HEAD'), join(linked, '.git')]) {
    assert.equal(assessFileChange(resolveToolPath(path, cwd), { config, cwd, sandboxAvailable: true }), 'ask_user', path);
  }
  assert.equal(assessFileChange(resolveToolPath('.gitignore', cwd), { config, cwd, sandboxAvailable: true }), 'auto_approve');
});

test('symlinks are resolved before the writable-root check', t => {
  const { cwd, outside } = workspace(t);
  symlinkSync(outside, join(cwd, 'escape'));
  assert.equal(assessFileChange(resolveToolPath('escape/file.txt', cwd), { config: isolated(), cwd, sandboxAvailable: true }), 'ask_user');
});

test('approval policy and sandbox mode follow Codex patch safety', t => {
  const { cwd, outside } = workspace(t);
  const inside = resolveToolPath('a.txt', cwd), elsewhere = join(outside, 'b.txt');
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

test('tool paths resolve like Pi tools, including ~', () => {
  assert.equal(resolveToolPath('~/notes.md', '/repo'), join(homedir(), 'notes.md'));
  assert.equal(resolveToolPath('src/a.ts', '/repo'), '/repo/src/a.ts');
  assert.equal(resolveToolPath('/abs/b.ts', '/repo'), '/abs/b.ts');
});

test('file change actions carry the planned change for review', () => {
  assert.deepEqual(fileChangeAction('write', { path: 'a.txt', content: 'hi' }, '/repo/a.txt', '/repo'),
    { tool: 'write', cwd: '/repo', files: ['/repo/a.txt'], content: 'hi', environment_id: 'local' });
  assert.deepEqual(fileChangeAction('edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] }, '/repo/a.txt', '/repo'),
    { tool: 'edit', cwd: '/repo', files: ['/repo/a.txt'], edits: [{ oldText: 'a', newText: 'b' }], environment_id: 'local' });
  const big = fileChangeAction('write', { path: 'a', content: 'x'.repeat(200_000) }, '/repo/a', '/repo');
  assert.match(String(big.content), /<truncated omitted_approx_tokens=/);
});
