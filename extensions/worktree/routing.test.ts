import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import worktree from './index.ts';
import { Worktrees } from './manager.ts';
import { getActiveCwd, resolveToolPath, setActiveCwd } from './routing.ts';

async function checkoutFixture(prefix: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const original = join(home, 'repo');
  await mkdir(original);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: original, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
  const active = (await new Worktrees(original, { home, herdr: false }).open('task')).path;
  return { home, original, active };
}

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

test('restored active checkout routes shell and relative files while preserving absolute paths', async () => {
  const { home, original, active } = await checkoutFixture('pi-route-origin-');
  const handlers: Record<string, (...args: any[]) => any> = {};
  const tools: Record<string, any> = {};
  const { ctx } = fakeCtx({ cwd: original, sessionId: 'synthetic', branch: active, hasUI: false });
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool: (tool: any) => tools[tool.name] = tool, registerCommand() {} } as any);
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
    const options = { sections: {} as Record<string, string> };
    assert.equal(handlers.before_agent_start({ systemPromptOptions: options }, ctx), undefined);
    assert.equal(options.sections.active_worktree,
      `Active worktree directory: ${active}. Built-in bash, user shell, and relative file tools use this directory. Absolute paths are unchanged. Pi's original session directory remains ${original}; session storage, loaded context/resources, and arbitrary extension internals are not relocated. Subagents resolve defaults against the active worktree. Inspect this checkout's instructions before editing.`,
    );
    await handlers.session_shutdown({}, ctx); assert.equal(getActiveCwd(original, 'synthetic'), original);
    ctx.sessionManager.getBranch = () => [];
    await handlers.session_start({ reason: 'new' }, ctx);
    assert.equal(getActiveCwd(original, 'synthetic'), original);
    ctx.sessionManager.getBranch = () => [{ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path: active } }];
    await handlers.session_tree({}, ctx);
    assert.equal(getActiveCwd(original, 'synthetic'), active);
    await handlers.session_shutdown({}, ctx);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('restore accepts an alias to the registered checkout', async () => {
  const { home, original, active } = await checkoutFixture('pi-route-alias-');
  const alias = join(home, 'alias');
  await symlink(active, alias);
  const handlers: Record<string, (...args: any[]) => any> = {};
  const { ctx, notices } = fakeCtx({ cwd: original, sessionId: 'alias', branch: alias });
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    assert.equal(getActiveCwd(original, 'alias'), active);
    assert.deepEqual(notices, []);
  } finally { setActiveCwd(original, undefined, 'alias'); await rm(home, { recursive: true, force: true }); }
});

test('restore keeps routing to a valid checkout after it is detached', async () => {
  const { home, original, active } = await checkoutFixture('pi-route-detached-');
  execFileSync('git', ['-C', active, 'checkout', '--detach'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const handlers: Record<string, (...args: any[]) => any> = {};
  const { ctx, notices } = fakeCtx({ cwd: original, sessionId: 'detached', branch: active });
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    assert.equal(getActiveCwd(original, 'detached'), active);
    assert.deepEqual(notices, []);
  } finally { setActiveCwd(original, undefined, 'detached'); await rm(home, { recursive: true, force: true }); }
});

test('session switches clear the prior routing entry without clearing another session', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-switch-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  let sessionId = 'old';
  const ctx: any = { cwd: home, hasUI: false, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } };
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
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
    assert.equal(getActiveCwd('/one/', 'a'), '/target/one-a');
    assert.equal(getActiveCwd('/two/./', 'a'), '/target/two-a');
    setActiveCwd('/one', undefined, 'a');
    assert.equal(getActiveCwd('/one', 'a'), '/one');
    assert.equal(getActiveCwd('/one', 'b'), '/target/one-b');
  } finally { for (const [cwd, session] of pairs) setActiveCwd(cwd, undefined, session); }
});

test('directory tools with no path default to the active checkout while read keeps its own default', async () => {
  const { home, original, active } = await checkoutFixture('pi-route-dir-origin-');
  const handlers: Record<string, (...args: any[]) => any> = {};
  const { ctx } = fakeCtx({ cwd: original, sessionId: 'dir-tools', branch: active, hasUI: false });
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    const routed: Record<string, string | undefined> = {};
    for (const toolName of ['grep', 'find', 'ls', 'read']) {
      const call = { toolName, input: {} as { path?: string } };
      await handlers.tool_call(call, ctx);
      routed[toolName] = call.input.path;
    }
    assert.deepEqual(routed, { grep: active, find: active, ls: active, read: undefined });
    await handlers.session_shutdown({}, ctx);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a saved checkout that no longer exists falls back to the original directory with a warning', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-stale-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  const { ctx, notices } = fakeCtx({ cwd: home, sessionId: 'stale', branch: join(home, 'gone') });
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    assert.deepEqual({ active: getActiveCwd(home, 'stale'), notice: notices.at(-1) }, { active: home, notice: 'Saved worktree is unavailable or invalid; using original session directory' });
    await handlers.session_shutdown({}, ctx);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('the newest worktree entry on the branch wins, so returning to original sticks across resume', async () => {
  const original = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-last-origin-')));
  const active = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-last-active-')));
  const handlers: Record<string, (...args: any[]) => any> = {};
  const entry = (path: string) => ({ type: 'custom', customType: 'agent-workflows:worktree', data: { version: 1, path } });
  const { ctx } = fakeCtx({ cwd: original, sessionId: 'last-wins', hasUI: false });
  ctx.sessionManager.getBranch = () => [entry(active), entry(original)];
  try {
    worktree({ getSettings: () => ({}), on: (name: string, fn: any) => handlers[name] = fn, registerTool() {}, registerCommand() {} } as any);
    await handlers.session_start({}, ctx);
    assert.equal(getActiveCwd(original, 'last-wins'), original);
    await handlers.session_shutdown({}, ctx);
  } finally { await rm(original, { recursive: true, force: true }); await rm(active, { recursive: true, force: true }); }
});

test('switching is refused while a turn is active', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-busy-')));
  const commands: Record<string, any> = {};
  const entries: unknown[] = [];
  const { ctx, notices } = fakeCtx({ cwd: home, sessionId: 'busy' });
  ctx.isIdle = () => false;
  try {
    worktree({ getSettings: () => ({}), on() {}, registerTool() {}, appendEntry: (_type: string, data: unknown) => entries.push(data), registerCommand: (name: string, value: any) => commands[name] = value } as any);
    await commands.worktree.handler('original', ctx);
    assert.deepEqual({ entries, notice: notices.at(-1) }, { entries: [], notice: 'Wait for the active turn before switching worktrees' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('routed agent and user bash preserve the configured shell and apply the prefix once', async t => {
  for (const source of ['persisted', 'effective', 'project-trusted', 'project-untrusted', 'project-malformed']) await t.test(source, async t => {
    const { home, original, active } = await checkoutFixture('pi-route-shell-');
    const agentDir = join(home, 'agent');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
    try {
      await mkdir(agentDir);
      const shellPath = join(home, 'configured shell');
      await writeFile(shellPath, '#!/bin/sh\nexport PI_WORKTREE_SHELL=custom\nexec /bin/bash "$@"\n', { mode: 0o755 });
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
        shellPath, shellCommandPrefix: source !== 'effective' ? 'export PI_WORKTREE_PREFIX="${PI_WORKTREE_PREFIX}x"' : 'export PI_WORKTREE_PREFIX=from-disk',
      }));
      if (source.startsWith('project-')) {
        await mkdir(join(original, '.pi'));
        await mkdir(join(active, '.pi'));
        const projectShell = join(home, 'project shell');
        await writeFile(projectShell, '#!/bin/sh\nexport PI_WORKTREE_SHELL=project\nexec /bin/bash "$@"\n', { mode: 0o755 });
        await writeFile(join(original, '.pi/settings.json'), source === 'project-malformed' ? '{broken' : JSON.stringify({
          shellPath: projectShell, shellCommandPrefix: 'export PI_WORKTREE_PREFIX="${PI_WORKTREE_PREFIX}p"',
        }));
        await writeFile(join(active, '.pi/settings.json'), JSON.stringify({
          shellPath: '/missing-active-checkout-shell', shellCommandPrefix: 'export PI_WORKTREE_PREFIX=wrong-checkout',
        }));
      }
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const settingsManager = source !== 'effective' ? SettingsManager.create(original, agentDir, { projectTrusted: source !== 'project-untrusted' }) : SettingsManager.inMemory({
        shellPath, shellCommandPrefix: 'export PI_WORKTREE_PREFIX="${PI_WORKTREE_PREFIX}x"',
      });
      let supportsEffectiveSettings = false;
      const resourceLoader = new DefaultResourceLoader({ cwd: original, agentDir, settingsManager,
        extensionFactories: [pi => { supportsEffectiveSettings = 'getSettings' in pi; worktree(pi); }], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await resourceLoader.reload();
      if (source === 'effective' && !supportsEffectiveSettings) { t.skip('This SDK lacks ExtensionAPI.getSettings'); return; }
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
        refreshOnCreate: false, allowModelNetwork: false });
      ({ session } = await createAgentSession({ cwd: original, agentDir, settingsManager, resourceLoader,
        modelRuntime, sessionManager: SessionManager.inMemory(original) }));
      await session.bindExtensions({});
      const runner = session.extensionRunner;
      assert.ok(runner);
      const errors: unknown[] = [];
      runner.onError(error => errors.push(error));
      let marker = source === 'project-trusted' ? 'p|project' : 'x|custom';
      const command = 'printf "%s|%s|%s" "${PI_WORKTREE_PREFIX:-missing}" "${PI_WORKTREE_SHELL:-missing}" "$PWD"';
      for (const cwd of [original, active, original]) {
        session.sessionManager.appendCustomEntry('agent-workflows:worktree', { version: 1, path: cwd });
        await runner.emit({ type: 'session_tree', newLeafId: session.sessionManager.getLeafId(), oldLeafId: null });
        const bash: (typeof session.agent.state.tools)[number] | undefined = session.agent.state.tools.find(tool => tool.name === 'bash');
        assert.ok(bash);
        const agent = await bash.execute('shell-settings', { command });
        assert.deepEqual(agent.content, [{ type: 'text', text: `${marker}|${cwd}` }]);
        const intercepted = await runner.emitUserBash({ type: 'user_bash', command, cwd: original, excludeFromContext: false });
        const user = await session.executeBash(command, undefined, { operations: intercepted?.operations });
        assert.equal(user.output, `${marker}|${cwd}`);
        assert.equal(user.exitCode, 0);
        if (source === 'effective' && cwd === active) {
          const secondShell = join(home, 'second shell');
          await writeFile(secondShell, '#!/bin/sh\nexport PI_WORKTREE_SHELL=updated\nexec /bin/bash "$@"\n', { mode: 0o755 });
          settingsManager.applyOverrides({ shellPath: secondShell, shellCommandPrefix: 'export PI_WORKTREE_PREFIX="${PI_WORKTREE_PREFIX}y"' });
          marker = 'y|updated';
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      if (session) { setActiveCwd(original, undefined, session.sessionManager.getSessionId()); session.dispose(); }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(home, { recursive: true, force: true });
    }
  });
});

for (const space of ['\u00a0', '\u202f', '\u3000']) {
  test(`real builtin tools preserve Unicode cwd U+${space.charCodeAt(0).toString(16)} beside an ASCII-space sibling`, async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'pi-route-unicode-')));
    const original = join(home, `repo${space}name`);
    const active = join(home, `checkout${space}name#%`);
    await mkdir(original);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: original, stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-b', 'task', active);
    try {
      for (const cwd of [original, active]) {
        const sibling = cwd.replace(space, ' ');
        await mkdir(sibling);
        await writeFile(join(cwd, 'marker'), 'correct checkout');
        await writeFile(join(sibling, 'marker'), 'wrong sibling');
        await writeFile(join(sibling, 'new file'), 'untouched sibling');
        await writeFile(join(sibling, 'sibling-only'), 'untouched');
        const agentDir = join(home, cwd === original ? 'agent-original' : 'agent-active');
        const settingsManager = SettingsManager.inMemory();
        const sessionManager = SessionManager.inMemory(original);
        if (cwd === active) sessionManager.appendCustomEntry('agent-workflows:worktree', { version: 1, path: active });
        const resourceLoader = new DefaultResourceLoader({ cwd: original, agentDir, settingsManager, noExtensions: true, extensionFactories: [worktree], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
        await resourceLoader.reload();
        const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
        const { session } = await createAgentSession({ cwd: original, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager, tools: ['read', 'write', 'edit', 'ls'] });
        try {
          await session.bindExtensions({});
          const runner = session.extensionRunner;
          assert.ok(runner);
          assert.equal(getActiveCwd(original, sessionManager.getSessionId()), cwd);
          const errors: unknown[] = [];
          runner.onError(error => errors.push(error));
          const execute = async (toolName: string, input: Record<string, unknown>) => {
            assert.notEqual((await runner.emitToolCall({ type: 'tool_call', toolName, toolCallId: toolName, input }))?.block, true);
            const tool = session.agent.state.tools.find(tool => tool.name === toolName);
            assert.ok(tool);
            return tool.execute(toolName, input);
          };
          const read = await execute('read', { path: '@marker' });
          assert.deepEqual(read.content, [{ type: 'text', text: 'correct checkout' }]);
          await execute('write', { path: `new${space}file`, content: 'intended write' });
          assert.equal(await readFile(join(cwd, 'new file'), 'utf8'), 'intended write');
          assert.equal(await readFile(join(sibling, 'new file'), 'utf8'), 'untouched sibling');
          await execute('write', { path: 'created', content: 'new in checkout' });
          assert.equal(await readFile(join(cwd, 'created'), 'utf8'), 'new in checkout');
          await assert.rejects(readFile(join(sibling, 'created')), { code: 'ENOENT' });
          for (const input of [{}, { path: '.' }]) {
            const listing = await execute('ls', input);
            assert.ok(listing.content.some(content => content.type === 'text' && content.text.includes('marker')));
            assert.ok(!listing.content.some(content => content.type === 'text' && content.text.includes('sibling-only')));
          }
          assert.deepEqual(errors, []);
        } finally {
          await session.extensionRunner?.emit({ type: 'session_shutdown', reason: 'quit' });
          session.dispose();
        }
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
