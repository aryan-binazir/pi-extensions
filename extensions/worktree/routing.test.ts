import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import worktree from './index.ts';
import { Worktrees } from './manager.ts';
import { getActiveCwd, resolveToolPath, setActiveCwd } from './routing.ts';

/** Enough of Pi's ExtensionContext to drive the extension, with the UI calls it makes recorded. */
function fakeCtx(options: { cwd: string; sessionId: string; branch?: string; hasUI?: boolean }) {
  const status: Array<string | undefined> = [];
  const notices: string[] = [];
  const branch = options.branch === undefined ? [] : [{ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path: options.branch } }];
  const ctx: any = {
    cwd: options.cwd, hasUI: options.hasUI ?? true, isIdle: () => true,
    ui: { setStatus: (_key: string, value: string | undefined) => status.push(value), notify: (value: string) => notices.push(value), confirm: async () => true },
    sessionManager: { getSessionId: () => options.sessionId, getSessionFile: () => undefined, getBranch: () => branch },
  };
  return { ctx, status, notices };
}

/** Swap in a stubbed `Worktrees.prototype.remove` with no window in which a throw could leave it installed. */
async function withStubbedRemove(stub: Worktrees['remove'], body: () => Promise<void>): Promise<void> {
  const original = Worktrees.prototype.remove;
  Worktrees.prototype.remove = stub;
  try { await body(); } finally { Worktrees.prototype.remove = original; }
}

test('restored active checkout routes shell and relative files while preserving absolute paths', async () => {
  const original = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-origin-')));
  const active = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-active-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  const tools: Record<string, any> = {};
  const { ctx } = fakeCtx({ cwd: original, sessionId: 'synthetic', branch: active, hasUI: false });
  try {
    worktree({ on: (name: string, fn: any) => handlers[name] = fn, registerTool: (tool: any) => tools[tool.name] = tool, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    assert.equal(getActiveCwd(original, 'synthetic'), active);
    const relative = { toolName: 'read', input: { path: 'nested/file' } }; await handlers.tool_call(relative, ctx);
    assert.equal(relative.input.path, join(active, 'nested/file'));
    const absolute = { toolName: 'write', input: { path: '/tmp/already-absolute' } }; await handlers.tool_call(absolute, ctx);
    assert.equal(absolute.input.path, '/tmp/already-absolute');
    for (const [raw, expected] of [
      ['@/tmp/absolute', '/tmp/absolute'],
      [pathToFileURL('/tmp/file url').href, '/tmp/file url'],
      ['@nested/file', join(active, 'nested/file')],
      ['~/file', join(homedir(), 'file')],
      ['@~/file', join(homedir(), 'file')],
      ['space name', join(active, 'space name')],
    ]) {
      const call = { toolName: 'read', input: { path: raw } };
      await handlers.tool_call(call, ctx);
      assert.equal(call.input.path, expected, raw);
    }
    const result = await tools.bash.execute('call', { command: 'pwd' }, undefined, undefined, ctx);
    assert.equal(result.content[0].text.trim(), active);
    const user = await handlers.user_bash({ command: 'pwd', cwd: original }, ctx);
    let output = '';
    await user.operations.exec('pwd', original, { onData: (data: Buffer) => output += data.toString() });
    assert.equal(output.trim(), active);
    assert.equal(
      handlers.before_agent_start({ systemPrompt: 'base' }, ctx).systemPrompt,
      `base\n\nActive worktree directory: ${active}. Built-in bash, user shell, and relative file tools use this directory. Absolute paths are unchanged. Pi's original session directory remains ${original}; session storage, loaded context/resources, and arbitrary extension internals are not relocated. Subagents resolve defaults against the active worktree. Inspect this checkout's instructions before editing.`,
    );
    await handlers.session_shutdown({}, ctx); assert.equal(getActiveCwd(original, 'synthetic'), original);
    // Pi switches/new/forks tear down the old runtime and then emit session_start.
    ctx.sessionManager.getBranch = () => [];
    await handlers.session_start({ reason: 'new' }, ctx);
    assert.equal(getActiveCwd(original, 'synthetic'), original);
    ctx.sessionManager.getBranch = () => [{ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path: active } }];
    await handlers.session_tree({}, ctx);
    assert.equal(getActiveCwd(original, 'synthetic'), active);
    await handlers.session_shutdown({}, ctx);
  } finally { await rm(original, { recursive: true, force: true }); await rm(active, { recursive: true, force: true }); }
});

test('session switches clear the prior routing entry without clearing another session', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-switch-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  let sessionId = 'old';
  const ctx: any = { cwd: home, hasUI: false, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } };
  try {
    worktree({ on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    setActiveCwd(home, '/tmp/old-route', 'old');
    setActiveCwd(home, '/tmp/independent-route', 'independent');
    sessionId = 'new';
    await handlers.session_start({}, ctx);
    assert.equal(getActiveCwd(home, 'old'), home);
    assert.equal(getActiveCwd(home, 'independent'), '/tmp/independent-route');
    setActiveCwd(home, '/tmp/new-route', 'new');
    sessionId = 'tree';
    await handlers.session_tree({}, ctx);
    assert.equal(getActiveCwd(home, 'new'), home);
  } finally {
    for (const id of ['old', 'new', 'tree', 'independent']) setActiveCwd(home, undefined, id);
    await rm(home, { recursive: true, force: true });
  }
});

test('worktree remove preserves quoted path spaces and original aliases restore without status', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-command-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  try {
    const original = join(home, 'original'); await mkdir(original);
    const alias = join(home, 'alias'); await symlink(original, alias);
    let removedPath = '';
    const { ctx, status, notices } = fakeCtx({ cwd: alias, sessionId: 'quoted', branch: alias });
    await withStubbedRemove(async function(path) { removedPath = path; return { removed: false, reason: 'test only' }; }, async () => {
      worktree({ on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand: (name: string, value: any) => commands[name] = value } as any);
      await handlers.session_start({}, ctx);
      assert.deepEqual(status, [undefined], 'an active checkout equal to the session directory shows no status');
      await mkdir(join(original, 'some  directory'));
      await mkdir(join(original, 'other  directory'));
      await commands.worktree.handler('remove "some  directory" --force', ctx);
      assert.equal(removedPath, join(original, 'some  directory'));
      await commands.worktree.handler("remove 'other  directory'", ctx);
      assert.equal(removedPath, join(original, 'other  directory'));
      await commands.worktree.handler('remove "unclosed', ctx);
      assert.match(notices.at(-1) ?? '', /Unclosed quote/);
      await handlers.session_shutdown({}, ctx);
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('removing active checkout through an alias resets routing before the canonical path disappears', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-remove-alias-')));
  const commands: Record<string, any> = {};
  try {
    const active = join(home, 'active'); await mkdir(active);
    const alias = join(home, 'alias'); await symlink(active, alias);
    setActiveCwd(home, active, 'remove-alias');
    const entries: any[] = [];
    const { ctx, notices } = fakeCtx({ cwd: home, sessionId: 'remove-alias' });
    await withStubbedRemove(async function(path) {
      assert.equal(path, active);
      await rm(path, { recursive: true });
      return { removed: true };
    }, async () => {
      worktree({ on() {}, registerTool() {}, appendEntry: (_type: string, data: any) => entries.push(data), registerCommand: (name: string, value: any) => commands[name] = value } as any);
      await commands.worktree.handler(`remove "${alias}"`, ctx);
      assert.equal(getActiveCwd(home, 'remove-alias'), home);
      assert.deepEqual(entries, [{ version: 1, path: home }]);
      assert.equal(notices.at(-1), `${active}: removed`);
      await commands.worktree.handler(`remove "${alias}"`, ctx);
      assert.match(notices.at(-1) ?? '', /ENOENT/);
    });
  } finally {
    setActiveCwd(home, undefined, 'remove-alias');
    await rm(home, { recursive: true, force: true });
  }
});

test('tool path resolution normalizes exactly like path.resolve for every segment shape', () => {
  const cwds = ['/base/dir', '/base/dir/', '/', '/base/./dir', '/base//dir', '/base/dir/..'];
  const segments = ['a', 'b.ts', '.', '..', '', 'x y', 'file.name.ext', '.hidden', '...'];
  const prefixes = ['', '/', '@', '@/', './', '../'];
  for (const cwd of cwds) {
    for (const prefix of prefixes) {
      for (const first of segments) {
        for (const second of segments) {
          for (const raw of [`${prefix}${first}`, `${prefix}${first}/${second}`, `${prefix}${first}//${second}`, `${prefix}${first}/${second}/`]) {
            const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
            assert.equal(resolveToolPath(raw, cwd), stripped.startsWith('/') ? resolve(stripped) : resolve(cwd, stripped), `${raw} in ${cwd}`);
          }
        }
      }
    }
  }
});

test('routing identities stay distinct as sessions and directories interleave', () => {
  const pairs: Array<[string, string | undefined]> = [['/one', 'a'], ['/one', 'b'], ['/two', 'a'], ['/one', undefined]];
  try {
    for (const [cwd, session] of pairs) setActiveCwd(cwd, `/target${cwd}-${session}`, session);
    for (const [cwd, session] of pairs) assert.equal(getActiveCwd(cwd, session), `/target${cwd}-${session}`, `${cwd} ${session}`);
    // Unnormalized spellings of one directory share a single identity.
    assert.equal(getActiveCwd('/one/', 'a'), '/target/one-a');
    assert.equal(getActiveCwd('/two/./', 'a'), '/target/two-a');
    setActiveCwd('/one', undefined, 'a');
    assert.equal(getActiveCwd('/one', 'a'), '/one');
    assert.equal(getActiveCwd('/one', 'b'), '/target/one-b');
  } finally { for (const [cwd, session] of pairs) setActiveCwd(cwd, undefined, session); }
});
