import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import worktree from './index.ts';
import { getActiveCwd, setActiveCwd } from './routing.ts';

test('restored active checkout routes shell and relative files while preserving absolute paths', async () => {
  const original = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-origin-')));
  const active = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-active-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  const tools: Record<string, any> = {};
  const ctx: any = { cwd: original, hasUI: false, sessionManager: { getSessionId: () => 'synthetic', getSessionFile: () => undefined, getBranch: () => [{ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path: active } }] } };
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
      ['space\u00a0name', join(active, 'space name')],
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
    assert.match(handlers.before_agent_start({ systemPrompt: 'base' }, ctx).systemPrompt, /original session directory/);
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


test('two coexisting sessions at one original cwd keep independent active checkouts', () => {
  setActiveCwd('/tmp/original', '/tmp/one', 'session-one');
  setActiveCwd('/tmp/original', '/tmp/two', 'session-two');
  assert.equal(getActiveCwd('/tmp/original', 'session-one'), '/tmp/one');
  assert.equal(getActiveCwd('/tmp/original', 'session-two'), '/tmp/two');
  setActiveCwd('/tmp/original', undefined, 'session-one');
  assert.equal(getActiveCwd('/tmp/original', 'session-one'), '/tmp/original');
  assert.equal(getActiveCwd('/tmp/original', 'session-two'), '/tmp/two');
  setActiveCwd('/tmp/original', undefined, 'session-two');
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
  const { mkdir, symlink } = await import('node:fs/promises');
  const { Worktrees } = await import('./manager.ts');
  const handlers: Record<string, (...args: any[]) => any> = {};
  const commands: Record<string, any> = {};
  const originalRemove = Worktrees.prototype.remove;
  try {
    const original = join(home, 'original'); await mkdir(original);
    const alias = join(home, 'alias'); await symlink(original, alias);
    let status: string | undefined = 'initial';
    let removedPath = '';
    const notices: string[] = [];
    Worktrees.prototype.remove = async function(path) { removedPath = path; return { removed: false, reason: 'test only' }; };
    const ctx: any = { cwd: alias, hasUI: true, isIdle: () => true, ui: { setStatus: (_key: string, value: string | undefined) => status = value, notify: (value: string) => notices.push(value), confirm: async () => true }, sessionManager: { getSessionId: () => 'quoted', getBranch: () => [{ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path: alias } }] } };
    worktree({ on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand: (name: string, value: any) => commands[name] = value } as any);
    await handlers.session_start({}, ctx);
    assert.equal(status, undefined);
    await mkdir(join(original, 'some  directory'));
    await mkdir(join(original, 'other  directory'));
    await commands.worktree.handler('remove "some  directory" --force', ctx);
    assert.equal(removedPath, join(original, 'some  directory'));
    await commands.worktree.handler("remove 'other  directory'", ctx);
    assert.equal(removedPath, join(original, 'other  directory'));
    await commands.worktree.handler('remove "unclosed', ctx);
    assert.match(notices.at(-1) ?? '', /Unclosed quote/);
    await handlers.session_shutdown({}, ctx);
  } finally { Worktrees.prototype.remove = originalRemove; await rm(home, { recursive: true, force: true }); }
});


test('removing active checkout through an alias resets routing before the canonical path disappears', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-remove-alias-')));
  const { mkdir, symlink } = await import('node:fs/promises');
  const { Worktrees } = await import('./manager.ts');
  const commands: Record<string, any> = {};
  const originalRemove = Worktrees.prototype.remove;
  try {
    const active = join(home, 'active'); await mkdir(active);
    const alias = join(home, 'alias'); await symlink(active, alias);
    setActiveCwd(home, active, 'remove-alias');
    Worktrees.prototype.remove = async function(path) {
      assert.equal(path, active);
      await rm(path, { recursive: true });
      return { removed: true };
    };
    const entries: any[] = [];
    const notices: string[] = [];
    const ctx: any = { cwd: home, hasUI: true, isIdle: () => true, ui: { setStatus() {}, notify: (value: string) => notices.push(value), confirm: async () => true }, sessionManager: { getSessionId: () => 'remove-alias' } };
    worktree({ on() {}, registerTool() {}, appendEntry: (_type: string, data: any) => entries.push(data), registerCommand: (name: string, value: any) => commands[name] = value } as any);
    await commands.worktree.handler(`remove "${alias}"`, ctx);
    assert.equal(getActiveCwd(home, 'remove-alias'), home);
    assert.deepEqual(entries, [{ version: 1, path: home }]);
    assert.equal(notices.at(-1), `${active}: removed`);
    await commands.worktree.handler(`remove "${alias}"`, ctx);
    assert.match(notices.at(-1) ?? '', /ENOENT/);
  } finally {
    Worktrees.prototype.remove = originalRemove;
    setActiveCwd(home, undefined, 'remove-alias');
    await rm(home, { recursive: true, force: true });
  }
});

test('tool path resolution normalizes exactly like path.resolve for every segment shape', async () => {
  const { resolve } = await import('node:path');
  const { resolveToolPath } = await import('./routing.ts');
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
