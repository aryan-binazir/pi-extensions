import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalog } from './catalog/index.ts';
import { withHooks } from './test-support.ts';

const draftOnly = 'hooks:\n  draft-prs: true\n';
const blocked = (result: any, pattern: RegExp, label: string) => {
  assert.equal(result?.block, true, label);
  assert.match(result.reason, /^\[hooks: protection\] /, label);
  assert.match(result.reason, pattern, label);
};

test('agents can switch live hooks on by writing the whole file, but never off', async () => {
  await withHooks([...catalog], draftOnly, async ({ dir, call }) => {
    const path = join(dir, 'hooks.yaml');
    assert.equal(await call('write', { path, content: '# comment\nhooks:\n  rg-replace-flag: true\n  draft-prs: true\n' }), undefined);
    blocked(await call('write', { path, content: 'hooks: {}\n' }), /never off.*draft-prs/, 'write removal');
    blocked(await call('write', { path, content: 'hooks:\n  draft-prs: false\n' }), /never off.*draft-prs/, 'write off');
    blocked(await call('write', { path, content: 'hooks:\n  draft-prs: true\n  typo: true\n' }), /no hooks named: typo/, 'unknown live id');
    blocked(await call('write', { path, content: 'hooks: [draft-prs]\n' }), /would leave .* invalid/, 'invalid proposal');
    assert.equal(await readFile(path, 'utf8'), draftOnly, 'checks never write the file');
  });
});

test('edits to a switches file are refused because they apply to whatever the file holds when they run', async () => {
  await withHooks([...catalog], 'hooks:\n  draft-prs: true\n  no-admin-merge: true\n', async ({ dir, call }) => {
    const path = join(dir, 'hooks.yaml');
    for (const edits of [
      [{ oldText: 'no-admin-merge: true\n', newText: 'no-admin-merge: true\n  rg-replace-flag: true\n' }],
      [{ oldText: 'no-admin-merge: true\n', newText: 'no-admin-merge: true\n  #' }],
    ]) blocked(await call('edit', { path, edits }), /write tool with the whole file/, JSON.stringify(edits));
    assert.equal(await call('edit', { path: join(dir, 'notes.yaml'), edits: [] }), undefined, 'other files keep the edit tool');
  });
});

test('every checkout copy is protected, through relative paths and symlinks either way, while new hooks may be enabled', async () => {
  await withHooks([...catalog], 'hooks: {}\n', async ({ dir, call }) => {
    const copy = join(dir, 'worktree', 'personal-settings', 'hooks.yaml');
    await mkdir(join(dir, 'worktree', 'personal-settings'), { recursive: true });
    await writeFile(copy, draftOnly);
    assert.equal(await call('write', { path: copy, content: 'hooks:\n  draft-prs: true\n  future-hook: true\n' }), undefined);
    blocked(await call('write', { path: 'worktree/personal-settings/hooks.yaml', content: 'hooks: {}\n' }), /never off/, 'relative path');
    await symlink(copy, join(dir, 'alias.yaml'));
    blocked(await call('write', { path: join(dir, 'alias.yaml'), content: 'hooks: {}\n' }), /never off/, 'alias pointing at a switches file');
    await symlink(join(dir, 'worktree', 'personal-settings'), join(dir, 'settings-link'));
    blocked(await call('write', { path: join(dir, 'settings-link', 'hooks.yaml'), content: 'hooks: {}\n' }), /never off/, 'symlinked directory');
    await mkdir(join(dir, 'linked', 'personal-settings'), { recursive: true });
    await writeFile(join(dir, 'target.yaml'), draftOnly);
    await symlink(join(dir, 'target.yaml'), join(dir, 'linked', 'personal-settings', 'hooks.yaml'));
    blocked(await call('write', { path: join(dir, 'linked', 'personal-settings', 'hooks.yaml'), content: 'hooks: {}\n' }), /never off/, 'switches file that is itself a symlink');
    const fresh = join(dir, 'other', 'personal-settings', 'hooks.yaml');
    assert.equal(await call('write', { path: fresh, content: draftOnly }), undefined, 'a new copy may start with hooks on');
    await writeFile(copy, '{');
    blocked(await call('write', { path: copy, content: draftOnly }), /currently invalid/, 'only the user repairs an invalid copy');
    assert.equal(await call('write', { path: join(dir, 'notes.yaml'), content: 'hooks: {}\n' }), undefined, 'unrelated files');
  });
});

test('protection runs even when every hook is off or the switches are broken', async () => {
  await withHooks([...catalog], '{', async ({ dir, call }) => {
    const copy = join(dir, 'personal-settings', 'hooks.yaml');
    await mkdir(join(dir, 'personal-settings'));
    await writeFile(copy, draftOnly);
    blocked(await call('write', { path: copy, content: 'hooks: {}\n' }), /never off/, 'invalid live config');
  });
});

test('Bash may read and commit the switches but cannot change them', async () => {
  await withHooks([...catalog], 'hooks: {}\n', async ({ call }) => {
    for (const command of [
      'cat personal-settings/hooks.yaml', '/usr/bin/cat personal-settings/hooks.yaml', 'git diff personal-settings/hooks.yaml',
      'grep -n true personal-settings/hooks.yaml', 'rg -n draft personal-settings/hooks.yaml', 'rg --pretty draft personal-settings/hooks.yaml',
      'git add personal-settings/hooks.yaml && git commit -m "Enable rg advice in personal-settings/hooks.yaml"',
      'git -C repo --no-pager log -p personal-settings/hooks.yaml', 'ls personal-settings', 'echo hooks', 'npm run check',
      'gh pr create --draft --title "Enable a hook" --body "Switches it on in personal-settings/hooks.yaml."',
    ]) assert.equal(await call('bash', { command }), undefined, command);
    for (const command of [
      'echo "hooks: {}" > personal-settings/hooks.yaml', "sed -i 's/true/false/' personal-settings/hooks.yaml",
      'cp /tmp/off.yaml personal-settings/hooks.yaml', 'rm personal-settings/hooks.yaml', 'mv personal-settings elsewhere',
      'cat "$(cp /tmp/off.yaml personal-settings/hooks.yaml)"', 'cat `cp /tmp/off.yaml personal-settings/hooks.yaml`',
      'git checkout HEAD~1 -- personal-settings/hooks.yaml', 'git restore -- "checkout with space/personal-settings/hooks.yaml"',
      'git diff --output=personal-settings/hooks.yaml', 'git -c core.pager=x diff personal-settings/hooks.yaml',
      'GIT_EXTERNAL_DIFF=x git diff personal-settings/hooks.yaml', 'git diff --ext-diff personal-settings/hooks.yaml',
      'rg --pre=/tmp/x draft personal-settings/hooks.yaml', 'rg --pre /tmp/x draft personal-settings/hooks.yaml',
      'rg --hostname-bin=/tmp/x draft personal-settings/hooks.yaml', 'gh api "repos/a/b/contents/x y/personal-settings/hooks.yaml"',
      'cd personal-settings && vi hooks.yaml', 'tee personal-settings/hooks.yaml < /tmp/x', 'f=hooks.yaml; cp /tmp/x "personal-settings/$f"',
      "cp /tmp/x person'al-settings/hoo'ks.yaml", "cat \"$(cp /tmp/x person'al-settings/hoo'ks.yaml)\"",
      'bash -c "cp /tmp/x personal-settings/hooks.yaml"',
    ]) blocked(await call('bash', { command }), /cannot change .*through Bash/, command);
  });
});
