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
