import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import guard from './index.ts';

async function withGuard(config: unknown, body: (call: (command: string, toolName?: string) => Promise<any>, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-guard-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers: Record<string, (...args: any[]) => any> = {};
  try {
    const path = join(dir, 'guard.json');
    if (config !== undefined) await writeFile(path, JSON.stringify(config));
    guard({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
    await body(async (command, toolName = 'bash') => handlers.tool_call({ type: 'tool_call', toolName, toolCallId: 'test', input: { command } }, {}), path);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const enabled = { requireDraftPr: true, blockAdminMerge: true };

test('draft creation and unrelated commands remain available', async () => {
  await withGuard(enabled, async call => {
    for (const command of ['gh pr create --draft', 'gh pr create -d', 'gh pr ready', 'git status']) {
      assert.equal(await call(command), undefined, command);
    }
  });
});

test('shell quoting and command boundaries distinguish execution from literal text', async () => {
  await withGuard(enabled, async call => {
    for (const command of [
      'cd repo && gh pr create', 'echo ok; gh pr merge --admin',
      'gh pr create --title "a --draft title"', 'gh pr create --title --draft',
      'gh pr create --draft; gh pr create', 'gh pr create # --draft',
      'gh pr create\n# --draft', 'gh pr create --body "first\n--draft"',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'echo "gh pr merge --admin"', 'echo gh pr create', '# gh pr create',
      'gh pr create --title "semi;colon" --draft',
      'gh pr create --title "a \\"quoted\\" title" --draft',
      'gh pr merge --body "--admin"', 'gh pr merge --subject=--admin',
      'gh pr merge --body-file -', 'gh pr create --draft \\\n --body-file -',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('boolean values, repeated flags, and short clusters follow gh option semantics', async () => {
  await withGuard(enabled, async call => {
    for (const command of [
      'gh pr create --draft --draft=false', 'gh pr create -d=false',
      'gh pr create -ft--draft', 'gh pr create --web', 'gh pr create --dry-run',
      'gh pr merge --admin=true', 'gh pr merge --admin=1',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'gh pr create --draft=true', 'gh pr create --draft=1', 'gh pr create -fd',
      'gh pr create --draft=false -d', 'gh pr create -dtTitle',
      'gh pr merge --admin=false', 'gh pr merge --admin --admin=false',
      'gh pr merge -- --admin', 'gh pr create --draft --body-file -',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('config is opt-in, independently switches rules, and reports invalid settings on Bash only', async () => {
  await withGuard(undefined, async call => assert.equal(await call('gh pr create'), undefined));
  await withGuard({ requireDraftPr: false, blockAdminMerge: true }, async (call, path) => {
    assert.equal(await call('gh pr create'), undefined);
    assert.equal((await call('gh pr merge --admin'))?.block, true);
    await writeFile(path, JSON.stringify({ requireDraftPr: true, blockAdminMerge: false }));
    assert.equal((await call('gh pr create'))?.block, true);
    assert.equal(await call('gh pr merge --admin'), undefined);
    for (const invalid of ['{', 'null', '{}', '{"requireDraftPr":"true","blockAdminMerge":true}', '{"requireDraftPr":true,"blockAdminMerge":true,"typo":true}']) {
      await writeFile(path, invalid);
      const result = await call('git status');
      assert.equal(result?.block, true, invalid);
      assert.match(result.reason, /guard.json/);
      assert.equal(await call('anything', 'read'), undefined);
    }
  });
});

test('repository selection, assignments, absolute gh paths and the new alias retain the guard', async () => {
  await withGuard(enabled, async call => {
    for (const command of ['gh -R org/repo pr create', 'gh pr --repo=org/repo create', 'GH_HOST=github.com /usr/bin/gh pr merge --admin', 'gh pr new', 'gh pr create --help=false']) {
      assert.equal((await call(command))?.block, true, command);
    }
    for (const command of ['gh -Rorg/repo pr create -d', 'gh pr create --help', 'gh pr merge --admin --help']) {
      assert.equal(await call(command), undefined, command);
    }
  });
});

test('short help works, browser creation gives a usable correction, and broken config links block', async () => {
  await withGuard(enabled, async (call, path) => {
    assert.equal(await call('gh pr create -h'), undefined);
    assert.equal(await call('gh pr merge --admin -h'), undefined);
    for (const command of ['gh pr create --web', 'gh pr create -w --draft']) {
      assert.deepEqual(await call(command), { block: true, reason: 'gh cannot create drafts with --web. Drop --web/-w and pass --draft.' });
    }
    await rm(path);
    await symlink(join(path, '..', 'missing.json'), path);
    const result = await call('gh pr create');
    assert.equal(result?.block, true);
    assert.match(result.reason, /guard.json.*symlink/);
  });
});

test('inherited help flags, mixed web aliases, and literal Bash whitespace keep their semantics', async () => {
  await withGuard(enabled, async call => {
    for (const command of [
      'gh --help=false pr merge --admin', 'gh pr --help=false merge --admin',
      'gh --help=false pr create', 'gh pr --help=false create',
      'gh --help pr create --help=false',
      'gh pr create --title=Fix\u00a0--draft --body=Details',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'gh --help pr create', 'gh pr -h merge --admin',
      'gh pr create -w --web=false --draft', 'gh pr create --web -w=false --draft',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('administrator merges are blocked without blocking normal merges', async () => {
  await withGuard(enabled, async call => {
    assert.deepEqual(await call('gh pr merge 42 --admin'), {
      block: true, reason: 'Merge without --admin. Satisfy the repository review and check requirements instead of bypassing them.',
    });
    assert.equal(await call('gh pr merge 42 --squash -d'), undefined);
  });
});

test('non-draft PR creation is blocked with a corrective instruction', async () => {
  await withGuard(enabled, async call => {
    assert.deepEqual(await call('gh pr create --title "Fix" --body "Details"'), {
      block: true, reason: 'Create PRs as drafts. Add --draft; mark ready with gh pr ready after review.',
    });
  });
});

test('the tracked guard.json, linked as the README documents, parses and enables both rules', async () => {
  await withGuard(undefined, async (call, path) => {
    await symlink(resolve(import.meta.dirname, 'guard.json'), path);
    assert.deepEqual(
      [await call('git status'), (await call('gh pr create'))?.block, (await call('gh pr merge --admin'))?.block],
      [undefined, true, true],
    );
  });
});
