import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import nvimIde, { editorContext, statusText } from './index.ts';
import { maxSelectionChars } from './link.ts';
import { fakeIde, token, until } from './test-support.ts';
import { setActiveCwd } from '../worktree/routing.ts';

type Handler = (event: any, ctx: any) => any;

/** Absence has no positive signal to wait on; give in-flight socket traffic a beat before asserting nothing happened. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/** Enough of Pi's ExtensionAPI to drive the adapter: handlers, tools and commands are captured. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const api = {
    on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
  };
  const fire = async (event: string, payload: any, ctx: any) => { let result: any; for (const handler of handlers.get(event) ?? []) result = (await handler({ type: event, ...payload }, ctx)) ?? result; return result; };
  return { api, fire, tools, commands };
}
function fakeCtx(cwd: string) {
  const status: (string | undefined)[] = [];
  const notices: string[] = [];
  return { ctx: { cwd, hasUI: true, sessionManager: { getSessionId: () => 'ide-session' }, ui: { setStatus: (_key: string, text: string | undefined) => status.push(text), notify: (message: string) => notices.push(message) } }, status, notices };
}

type Connected = { ide: ReturnType<typeof fakeIde>; project: string } & ReturnType<typeof fakePi> & ReturnType<typeof fakeCtx>;

/** A running fake editor, a project with `a.ts`, its lock file, and the adapter already through session_start. */
async function withConnectedIde(body: (harness: Connected) => Promise<void>): Promise<void> {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const project = join(root, 'project');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    await mkdir(join(root, 'ide'), { recursive: true });
    await mkdir(project);
    await writeFile(join(project, 'a.ts'), 'line1\nline2\nline3\nline4\n');
    await writeFile(join(root, 'ide', `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [project], ideName: 'Neovim', authToken: token }));
    process.env.CLAUDE_CONFIG_DIR = root;
    const pi = fakePi();
    const context = fakeCtx(project);
    nvimIde(pi.api as any);
    await pi.fire('session_start', {}, context.ctx);
    await until(() => context.status.includes('Neovim ✓'));
    await body({ ide, project, ...pi, ...context });
    await pi.fire('session_shutdown', {}, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await ide.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a connected editor registers its tools and reports the selection in the status bar and system prompt', async () => {
  await withConnectedIde(async ({ ide, project, fire, tools, commands, ctx, status }) => {
    assert.deepEqual([...tools.keys()].sort(), ['nvim_context', 'nvim_diagnostics', 'nvim_open']);
    assert.deepEqual([...commands.keys()], ['vim']);

    // Ambient selection reaches the status bar and the system prompt; repaints only on change.
    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:2-3 ▮');
    const paints = status.length;
    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await settle();
    assert.equal(status.length, paints, 'identical selection does not repaint');

    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts'), lineStart: 3, lineEnd: 4 });
    ide.broadcast('at_mentioned', { filePath: join(project, 'missing.ts'), lineStart: 1, lineEnd: 1 });
    await settle();
    const turn = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.match(turn.systemPrompt, /^BASE\n\n# Editor context \(Neovim\)/);
    assert.match(turn.systemPrompt, /Selected lines 2-3:\n```\nline2\nline3\n```/);
    assert.match(turn.systemPrompt, /User sent from editor: .*a\.ts lines 3-4\n```\nline3\nline4\n```/);
    assert.match(turn.systemPrompt, /User sent from editor: .*missing\.ts lines 1-1(?:\n(?!```)|$)/, 'unreadable mention is listed without contents');
    const next = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.doesNotMatch(next.systemPrompt, /User sent from editor/, 'mentions are consumed by the turn that injected them');
    assert.match(next.systemPrompt, /Selected lines 2-3/, 'ambient selection persists');
  });
});

test('follow after edit opens the changed file, and /vim follow turns it off', async () => {
  await withConnectedIde(async ({ ide, project, fire, commands, ctx, notices }) => {
    await fire('tool_execution_start', { toolCallId: 't1', toolName: 'edit', args: { path: 'a.ts', edits: [] } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't1', toolName: 'edit', isError: false, result: { details: { firstChangedLine: 7 } } }, ctx);
    await until(() => ide.calls.length === 1);
    assert.deepEqual(ide.calls[0], { name: 'openFile', arguments: { filePath: join(project, 'a.ts'), preview: false, makeFrontmost: true, startLine: 7, endLine: 7 } });
    await fire('tool_execution_start', { toolCallId: 't2', toolName: 'write', args: { path: join(project, 'b.ts'), content: '' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't2', toolName: 'write', isError: false, result: {} }, ctx);
    await until(() => ide.calls.length === 2);
    assert.deepEqual(ide.calls[1].arguments, { filePath: join(project, 'b.ts'), preview: false, makeFrontmost: true }, 'a write with no changed line still opens the file');
    await fire('tool_execution_start', { toolCallId: 't3', toolName: 'edit', args: { path: 'a.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't3', toolName: 'edit', isError: true, result: {} }, ctx);
    await fire('tool_execution_start', { toolCallId: 't4', toolName: 'bash', args: { command: 'ls' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't4', toolName: 'bash', isError: false, result: {} }, ctx);
    await settle();
    assert.equal(ide.calls.length, 2, 'failed edits and non-file tools do not move the editor');

    await commands.get('vim').handler('follow off', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: off');
    await fire('tool_execution_start', { toolCallId: 't5', toolName: 'edit', args: { path: 'a.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't5', toolName: 'edit', isError: false, result: { details: { firstChangedLine: 1 } } }, ctx);
    await settle();
    assert.equal(ide.calls.length, 2, 'follow off suppresses the jump');
    await commands.get('vim').handler('follow nonsense', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: off', 'an unrecognised argument only reports the current setting');
    await commands.get('vim').handler('follow on', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: on');
  });
});

test('editor tools resolve paths, and a closed editor clears status, prompt and tools', async () => {
  await withConnectedIde(async ({ ide, project, fire, tools, commands, ctx, status, notices }) => {
    ide.broadcast('selection_changed', { text: 'line2', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:2 ▮');
    await commands.get('vim').handler('', ctx);
    assert.match(notices.at(-1)!, new RegExp(`^Editor link: Neovim on port ${ide.port()}, follow on, viewing .*a\\.ts$`));

    const open = await tools.get('nvim_open').execute('id', { path: 'a.ts', startLine: 2 }, undefined, undefined, ctx);
    assert.equal(open.content[0].text, `openFile(${JSON.stringify({ filePath: join(project, 'a.ts'), preview: false, makeFrontmost: true, startLine: 2, endLine: 2 })})`);
    const diagnostics = await tools.get('nvim_diagnostics').execute('id', { path: 'a.ts' }, undefined, undefined, ctx);
    assert.match(diagnostics.content[0].text, /^getDiagnostics\(\{"uri":"file:\/\/.*a\.ts"\}\)$/);
    const all = await tools.get('nvim_diagnostics').execute('id', {}, undefined, undefined, ctx);
    assert.equal(all.content[0].text, 'getDiagnostics({})');
    const context = await tools.get('nvim_context').execute('id', {}, undefined, undefined, ctx);
    assert.match(context.content[0].text, /Workspace folders:\ngetWorkspaceFolders\(\{\}\)\n\nOpen editors:\ngetOpenEditors\(\{\}\)\n\nCurrent selection:\ngetCurrentSelection\(\{\}\)/);

    await ide.close();
    await until(() => status.at(-1) === undefined);
    assert.equal(await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx), undefined);
    await assert.rejects(tools.get('nvim_context').execute('id', {}, undefined, undefined, ctx), /No editor connected/);
    await commands.get('vim').handler('', ctx);
    assert.match(notices.at(-1)!, /not connected/);
  });
});

test('session without an editor: no status, no prompt injection, shutdown is clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const { api, fire } = fakePi();
  const { ctx, status } = fakeCtx(root);
  try {
    nvimIde(api as any);
    await fire('session_start', {}, ctx);
    await settle();
    assert.deepEqual(status, []);
    assert.equal(await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx), undefined);
    await fire('session_shutdown', {}, ctx);
    assert.deepEqual(status, [], 'nothing was shown, so nothing is cleared');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('editor context renders selection, cursor and mentions, and nothing when disconnected', () => {
  assert.equal(editorContext({ connected: false, mentions: 0 }, []), undefined);
  const withSelection = editorContext({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'x'.repeat(maxSelectionChars + 1), filePath: '/f.ts', start: { line: 4, character: 0 }, end: { line: 6, character: 2 }, isEmpty: false } }, []);
  assert.match(withSelection!, /^# Editor context \(Neovim\)/);
  assert.match(withSelection!, /Selected lines 5-7:/);
  assert.match(withSelection!, /…\[truncated\]/);
  const cursor = editorContext({ connected: true, mentions: 0, selection: { text: '', filePath: '/g.ts', start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } }, [{ mention: { filePath: '/h.ts', lineStart: 2, lineEnd: 3 }, text: 'a\nb' }, { mention: { filePath: '/dir' } }]);
  assert.match(cursor!, /Active file: \/g\.ts \(cursor at line 1\)/);
  assert.match(cursor!, /User sent from editor: \/h\.ts lines 2-3\n```\na\nb\n```/);
  assert.match(cursor!, /User sent from editor: \/dir$/);
});

test('status text shows connection, active file, cursor line or selected range', () => {
  assert.equal(statusText({ connected: false, mentions: 0 }), undefined);
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0 }), 'Neovim ✓');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: '', filePath: '/w/math.ts', start: { line: 5, character: 0 }, end: { line: 5, character: 0 }, isEmpty: true } }), 'Neovim ✓ math.ts:6');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'abc', filePath: '/w/math.ts', start: { line: 4, character: 0 }, end: { line: 6, character: 1 }, isEmpty: false } }), 'Neovim ✓ math.ts:5-7 ▮');
  assert.equal(statusText({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'ab', filePath: '/w/math.ts', start: { line: 4, character: 0 }, end: { line: 4, character: 2 }, isEmpty: false } }), 'Neovim ✓ math.ts:5 ▮');
});


test('follow after edit opens the file inside the active worktree, not the original directory', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    const routed = join(project, 'checkout'); await mkdir(routed);
    setActiveCwd(project, routed, ctx.sessionManager.getSessionId());
    try {
      await fire('tool_execution_start', { toolCallId: 'w1', toolName: 'edit', args: { path: 'a.ts', edits: [] } }, ctx);
      await fire('tool_execution_end', { toolCallId: 'w1', toolName: 'edit', isError: false, result: { details: { firstChangedLine: 2 } } }, ctx);
      await until(() => ide.calls.length === 1);
      assert.equal(ide.calls[0].arguments.filePath, join(routed, 'a.ts'));
    } finally { setActiveCwd(project, undefined, ctx.sessionManager.getSessionId()); }
  });
});

test('nvim_open resolves relative paths against the active worktree', async () => {
  await withConnectedIde(async ({ ide, project, tools, ctx }) => {
    const routed = join(project, 'checkout'); await mkdir(routed);
    setActiveCwd(project, routed, ctx.sessionManager.getSessionId());
    try {
      await tools.get('nvim_open').execute('o1', { path: 'b.ts' }, undefined, undefined, ctx);
      assert.equal(ide.calls[0].arguments.filePath, join(routed, 'b.ts'));
    } finally { setActiveCwd(project, undefined, ctx.sessionManager.getSessionId()); }
  });
});

test('/vim reconnect drops and re-establishes the link', async () => {
  await withConnectedIde(async ({ commands, ctx, status }) => {
    const before = status.length;
    await commands.get('vim').handler('reconnect', ctx);
    await until(() => status.length >= before + 2);
    assert.deepEqual(status.slice(before), [undefined, 'Neovim ✓']);
  });
});

test('a mention past the line cap is clipped in the body but keeps the requested range in its header', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    await writeFile(join(project, 'big.ts'), Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join('\n'));
    ide.broadcast('at_mentioned', { filePath: join(project, 'big.ts'), lineStart: 1, lineEnd: 2500 });
    await settle();
    const turn = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.match(turn.systemPrompt, /User sent from editor: .*big\.ts lines 1-2500\n```\n(?:L\d+\n){1999}L2000\n```/);
  });
});
