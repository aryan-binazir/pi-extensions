import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { createEditTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import nvimIde, { editorContext, statusText } from './index.ts';
import { maxSelectionChars } from './link.ts';
import { fakeIde, token, until, type CallResponder } from './test-support.ts';
import { setActiveCwd } from '../worktree/routing.ts';

type Handler = (event: any, ctx: any) => any;

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const api = {
    on: (event: string, handler: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: any) => commands.set(name, options),
  };
  const fire = async (event: string, payload: any, ctx: any) => {
    const dispatched = { type: event, systemPromptOptions: { sections: {} }, ...payload };
    let result: any;
    for (const handler of handlers.get(event) ?? []) result = (await handler(dispatched, ctx)) ?? result;
    const section = dispatched.systemPromptOptions.sections.editor_context;
    return section ? { systemPrompt: `${payload.systemPrompt}\n\n${section}`, forcedSystemPrompt: result?.systemPrompt } : result;
  };
  return { api, fire, tools, commands };
}
function fakeCtx(cwd: string) {
  const status: (string | undefined)[] = [];
  const notices: string[] = [];
  return { ctx: { cwd, hasUI: true, sessionManager: { getSessionId: () => 'ide-session' }, ui: { setStatus: (_key: string, text: string | undefined) => status.push(text), notify: (message: string) => notices.push(message) } }, status, notices };
}

type Connected = { ide: ReturnType<typeof fakeIde>; project: string } & ReturnType<typeof fakePi> & ReturnType<typeof fakeCtx>;

async function withConnectedIde(body: (harness: Connected) => Promise<void>, onCall?: CallResponder): Promise<void> {
  const ide = fakeIde(undefined, onCall);
  await once(ide.server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const project = join(root, 'project');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const pi = fakePi();
  const context = fakeCtx(project);
  try {
    await mkdir(join(root, 'ide'), { recursive: true });
    await mkdir(project);
    await writeFile(join(project, 'a.ts'), 'line1\nline2\nline3\nline4\n');
    await writeFile(join(root, 'ide', `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [project], ideName: 'Neovim', authToken: token }));
    process.env.CLAUDE_CONFIG_DIR = root;
    nvimIde(pi.api as any);
    await pi.fire('session_start', {}, context.ctx);
    await until(() => context.status.includes('Neovim ✓'));
    await body({ ide, project, ...pi, ...context });
  } finally {
    await pi.fire('session_shutdown', {}, context.ctx);
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await ide.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a connected editor registers its tools and reports the selection in the status bar and system prompt', async () => {
  await withConnectedIde(async ({ ide, project, fire, tools, commands, ctx, status }) => {
    assert.deepEqual([...tools.keys()].sort(), ['nvim_context', 'nvim_diagnostics', 'nvim_open']);
    assert.deepEqual([...commands.keys()], ['vim']);

    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:2-3 ▮');
    const paints = status.length;
    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await settle();
    assert.equal(status.length, paints, 'identical selection does not repaint');

    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts'), lineStart: 2, lineEnd: 3 });
    ide.broadcast('at_mentioned', { filePath: join(project, 'missing.ts'), lineStart: 0, lineEnd: 0 });
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

test('editor context is a deterministic request snapshot, not a forced leading prompt', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx, status }) => {
    const options = { sections: {} as Record<string, string> };
    ide.broadcast('selection_changed', { text: 'line2', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:2 ▮');
    assert.deepEqual(options.sections, {}, 'unsubmitted editor notifications do not write prompt sections');
    const first = await fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: options }, ctx);
    assert.match(options.sections.editor_context, /Selected lines 2-2:\n```\nline2\n```/);
    assert.equal(first.forcedSystemPrompt, undefined);
    const nextOptions = { sections: {} as Record<string, string> };
    await fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: nextOptions }, ctx);
    assert.equal(nextOptions.sections.editor_context, options.sections.editor_context);
  });
});

test('editor sends are acknowledged only after the submitted snapshot is assigned', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts'), lineStart: 1, lineEnd: 1 });
    await settle();
    const sections = new Proxy({}, { set() { throw new Error('request preparation failed'); } });
    await assert.rejects(fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: { sections } }, ctx), /request preparation failed/);
    const retry = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(retry.systemPrompt.includes('User sent from editor:'), 'failed preparation retains the send');
    assert.ok(retry.systemPrompt.includes('line2'));
    const next = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(!next.systemPrompt.includes('User sent from editor:'), 'a successful snapshot consumes its own sends');
  });
});

test('submitted absolute editor sends remain available after the editor disconnects', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx, status }) => {
    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts'), lineStart: 0, lineEnd: 0 });
    await settle();
    await ide.close();
    await until(() => status.at(-1) === undefined);
    const turn = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(turn?.systemPrompt.includes('User sent from editor:'), 'a disconnect does not discard an explicitly sent file');
    assert.ok(turn.systemPrompt.includes('line1'));
    assert.equal(await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx), undefined);
  });
});

test('unresolvable editor sends are reported once rather than silently discarded or guessed', async () => {
  await withConnectedIde(async ({ ide, fire, ctx, notices }) => {
    ide.broadcast('at_mentioned', { filePath: 'unresolved.ts', lineStart: 0, lineEnd: 0 });
    await settle();
    const turn = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(!turn.systemPrompt.includes('unresolved.ts'), 'the model must not guess a relative editor path');
    assert.ok(notices.some(notice => notice.includes('1 editor send could not be resolved')));
    await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.equal(notices.length, 1, 'the failed send is reported once for its submitted batch');
  });
});

test('a large live selection is explicitly marked as incomplete after receipt', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx, status }) => {
    ide.broadcast('selection_changed', { text: 'x'.repeat(maxSelectionChars - 1) + '😀tail', filePath: join(project, 'a.ts'), selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 50006 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:1 ▮');
    const turn = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.match(turn.systemPrompt, /truncated selection/);
    assert.doesNotMatch(turn.systemPrompt, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, 'clipping does not split a surrogate pair');
    assert.doesNotMatch(turn.systemPrompt, /tail/);
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

test('a burst of edits reveals only the latest destination', async () => {
  await withConnectedIde(async ({ ide, fire, ctx }) => {
    for (const path of ['first.ts', 'middle.ts', 'latest.ts']) {
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
    }
    await until(() => ide.calls.length > 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(ide.calls.map(call => call.arguments.filePath.split('/').at(-1)), ['latest.ts']);
  });
});

test('the latest edit made during a reconnect is revealed when the editor becomes ready', async () => {
  await withConnectedIde(async ({ ide, fire, commands, ctx, status }) => {
    await commands.get('vim').handler('reconnect', ctx);
    assert.equal(status.at(-1), undefined);
    for (const path of ['older.ts', 'latest.ts']) {
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
    }
    await until(() => status.at(-1) === 'Neovim ✓');
    await until(() => ide.calls.length > 0);
    assert.deepEqual(ide.calls.map(call => call.arguments.filePath.split('/').at(-1)), ['latest.ts']);
  });
});

test('a follow interrupted before its reply is replayed after reconnecting', async () => {
  let attempts = 0;
  await withConnectedIde(async ({ ide, fire, commands, ctx, status, notices }) => {
    await fire('tool_execution_start', { toolCallId: 'edit', toolName: 'write', args: { path: 'a.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'edit', toolName: 'write', isError: false, result: {} }, ctx);
    await until(() => status.at(-1) === undefined);
    await commands.get('vim').handler('reconnect', ctx);
    await until(() => attempts === 2);
    assert.equal(ide.calls.length, 2);
    assert.equal(ide.calls[0].arguments.filePath, ide.calls[1].arguments.filePath);
    assert.ok(!notices.some(notice => notice.includes('Could not reveal')));
  }, (call, _reply, socket) => {
    if (call.name !== 'openFile') return false;
    attempts++;
    if (attempts === 1) { socket.terminate(); return true; }
    return false;
  });
});

test('follow errors warn once per failure episode and do not automatically retry', async () => {
  await withConnectedIde(async ({ ide, fire, tools, ctx, notices }) => {
    for (const [i, path] of ['bad1.ts', 'bad2.ts', 'good.ts', 'bad3.ts'].entries()) {
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
      await until(() => ide.calls.filter(call => call.name === 'openFile').length === i + 1);
      await tools.get('nvim_diagnostics').execute('barrier', {}, undefined, undefined, ctx);
      assert.equal(notices.filter(notice => notice.includes('Could not reveal')).length, i === 3 ? 2 : 1);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(ide.calls.filter(call => call.name === 'openFile').length, 4, 'connected tool errors do not retry themselves');
  }, (call, reply) => {
    if (!String(call.arguments.filePath).includes('bad')) return false;
    reply({ content: [{ type: 'text', text: 'File cannot be opened' }], isError: true });
    return true;
  });
});

test('a stalled follow expires within five seconds so the newer edit can be revealed', async () => {
  await withConnectedIde(async ({ ide, fire, ctx, notices }) => {
    for (const path of ['stalled.ts', 'newer.ts']) {
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
      if (path === 'stalled.ts') await until(() => ide.calls.length === 1);
    }
    await until(() => ide.calls.length === 2, 6500);
    assert.equal(ide.calls[1].arguments.filePath.split('/').at(-1), 'newer.ts');
    assert.equal(notices.filter(notice => notice.includes('Could not reveal')).length, 1);
  }, call => String(call.arguments.filePath).endsWith('stalled.ts'));
});

test('an explicit editor open takes priority over a pending automatic follow', async () => {
  await withConnectedIde(async ({ ide, fire, tools, ctx }) => {
    await fire('tool_execution_start', { toolCallId: 'edit', toolName: 'write', args: { path: 'automatic.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'edit', toolName: 'write', isError: false, result: {} }, ctx);
    await tools.get('nvim_open').execute('open', { path: 'explicit.ts' }, undefined, undefined, ctx);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(ide.calls.map(call => call.arguments.filePath.split('/').at(-1)), ['explicit.ts']);
  });
});

test('a disconnected explicit open cancels the old destination before reporting no editor', async () => {
  await withConnectedIde(async ({ ide, fire, commands, tools, ctx, status }) => {
    await commands.get('vim').handler('reconnect', ctx);
    await fire('tool_execution_start', { toolCallId: 'queued', toolName: 'write', args: { path: 'old.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'queued', toolName: 'write', isError: false, result: {} }, ctx);
    await assert.rejects(tools.get('nvim_open').execute('explicit', { path: 'new.ts' }, undefined, undefined, ctx), /No editor connected/);
    await until(() => status.at(-1) === 'Neovim ✓');
    await new Promise(resolve => setTimeout(resolve, 150));
    await tools.get('nvim_diagnostics').execute('barrier', {}, undefined, undefined, ctx);
    assert.deepEqual(ide.calls.filter(call => call.name === 'openFile'), []);
  });
});

test('a successful explicit open starts a new automatic failure episode', async () => {
  await withConnectedIde(async ({ fire, tools, ctx, notices }) => {
    for (const path of ['bad1.ts', 'bad2.ts']) {
      if (path === 'bad2.ts') await tools.get('nvim_open').execute('explicit', { path: 'good.ts' }, undefined, undefined, ctx);
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
      await new Promise(resolve => setTimeout(resolve, 150));
      await tools.get('nvim_diagnostics').execute('barrier', {}, undefined, undefined, ctx);
    }
    assert.equal(notices.filter(notice => notice.includes('Could not reveal')).length, 2);
  }, (call, reply) => {
    if (call.name !== 'openFile' || !String(call.arguments.filePath).includes('bad')) return false;
    reply({ content: [{ type: 'text', text: 'Cannot reveal' }], isError: true });
    return true;
  });
});

test('follow off cancels queued destinations and ignores late replies from a stalled jump', async () => {
  let lateReply: ((result: unknown) => void) | undefined;
  await withConnectedIde(async ({ ide, fire, commands, ctx, notices }) => {
    const edit = async (path: string) => {
      await fire('tool_execution_start', { toolCallId: path, toolName: 'write', args: { path } }, ctx);
      await fire('tool_execution_end', { toolCallId: path, toolName: 'write', isError: false, result: {} }, ctx);
    };
    await edit('stalled.ts');
    await until(() => lateReply !== undefined);
    await edit('queued.ts');
    await commands.get('vim').handler('follow off', ctx);
    await edit('while-off.ts');
    await commands.get('vim').handler('follow on', ctx);
    await edit('fresh.ts');
    await until(() => ide.calls.length === 2);
    lateReply!({ content: [{ type: 'text', text: 'late failure' }], isError: true });
    await edit('final.ts');
    await until(() => ide.calls.length === 3);
    assert.deepEqual(ide.calls.map(call => call.arguments.filePath.split('/').at(-1)), ['stalled.ts', 'fresh.ts', 'final.ts']);
    assert.ok(!notices.some(notice => notice.includes('Could not reveal')));
  }, (call, reply) => {
    if (!String(call.arguments.filePath).endsWith('stalled.ts')) return false;
    lateReply = reply;
    return true;
  });
});

test('session replacement clears queued follows and sends and paints the new session status', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts') });
    await settle();
    await fire('tool_execution_start', { toolCallId: 'old', toolName: 'write', args: { path: 'old-session.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'old', toolName: 'write', isError: false, result: {} }, ctx);
    const next = fakeCtx(project);
    await fire('session_start', {}, next.ctx);
    await until(() => next.status.includes('Neovim ✓'));
    const turn = await fire('before_agent_start', { systemPrompt: 'BASE' }, next.ctx);
    assert.ok(!turn.systemPrompt.includes('User sent from editor:'));
    await fire('tool_execution_start', { toolCallId: 'fresh', toolName: 'write', args: { path: 'new-session.ts' } }, next.ctx);
    await fire('tool_execution_end', { toolCallId: 'fresh', toolName: 'write', isError: false, result: {} }, next.ctx);
    await until(() => ide.calls.length === 1);
    assert.equal(ide.calls[0].arguments.filePath.split('/').at(-1), 'new-session.ts');
  });
});

test('an expired disconnected destination is not replayed ahead of a fresh edit', async t => {
  await withConnectedIde(async ({ ide, fire, commands, ctx, status }) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    await commands.get('vim').handler('reconnect', ctx);
    await fire('tool_execution_start', { toolCallId: 'stale', toolName: 'write', args: { path: 'stale.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'stale', toolName: 'write', isError: false, result: {} }, ctx);
    t.mock.timers.setTime(31000);
    await until(() => status.at(-1) === 'Neovim ✓');
    await new Promise(resolve => setTimeout(resolve, 150));
    await fire('tool_execution_start', { toolCallId: 'fresh', toolName: 'write', args: { path: 'fresh.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 'fresh', toolName: 'write', isError: false, result: {} }, ctx);
    await until(() => ide.calls.length > 0);
    assert.deepEqual(ide.calls.map(call => call.arguments.filePath.split('/').at(-1)), ['fresh.ts']);
    t.mock.timers.reset();
  });
});

test('follow opens the actual files written and edited by Pi with normalized paths in the active worktree', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    const routed = join(project, 'checkout');
    await mkdir(routed);
    const previousHome = process.env.HOME;
    process.env.HOME = routed;
    setActiveCwd(project, routed, ctx.sessionManager.getSessionId());
    try {
      assert.equal(homedir(), routed);
      const cases = [
        { path: '@written.ts', file: 'written.ts' },
        { path: pathToFileURL(join(routed, 'url file.ts')).href, file: 'url file.ts' },
        { path: '~/home.ts', file: 'home.ts' },
        { path: 'unicode\u00a0space.ts', file: 'unicode space.ts' },
        { path: 'narrow\u202fspace.ts', file: 'narrow space.ts' },
      ];
      const write = createWriteTool(routed);
      for (const [i, { path, file }] of cases.entries()) {
        const toolCallId = `write-${i}`;
        const args = { path, content: 'written' };
        await fire('tool_execution_start', { toolCallId, toolName: 'write', args }, ctx);
        const result = await write.execute(toolCallId, args, undefined);
        assert.equal(await readFile(join(routed, file), 'utf8'), 'written');
        await fire('tool_execution_end', { toolCallId, toolName: 'write', result, isError: false }, ctx);
        await until(() => ide.calls.length === i + 1);
        assert.equal(ide.calls[i].arguments.filePath, join(routed, file), path);
      }
      const args = { path: '@written.ts', edits: [{ oldText: 'written', newText: 'edited' }] };
      await fire('tool_execution_start', { toolCallId: 'edit-at', toolName: 'edit', args }, ctx);
      const result = await createEditTool(routed).execute('edit-at', args, undefined);
      assert.equal(await readFile(join(routed, 'written.ts'), 'utf8'), 'edited');
      await fire('tool_execution_end', { toolCallId: 'edit-at', toolName: 'edit', result, isError: false }, ctx);
      await until(() => ide.calls.length === cases.length + 1);
      assert.deepEqual(ide.calls.at(-1)?.arguments, { filePath: join(routed, 'written.ts'), preview: false, makeFrontmost: true, startLine: 1, endLine: 1 });
    } finally {
      setActiveCwd(project, undefined, ctx.sessionManager.getSessionId());
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
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

for (const [mode, message] of [['disconnect', 'IDE disconnected'], ['reconnect', 'reconnecting'], ['stop', 'IDE link stopped']] as const) {
  test(`pending nvim_context settles when the editor link ${mode}s`, async () => {
    await withConnectedIde(async ({ ide, fire, tools, commands, ctx }) => {
      for (const client of ide.server.clients) {
        client.removeAllListeners('message');
        client.on('message', raw => {
          const request = JSON.parse(raw.toString());
          if (request.method === 'tools/call') ide.calls.push(request.params);
        });
      }
      const controller = new AbortController();
      let error: Error | undefined;
      const execution = tools.get('nvim_context').execute('pending', {}, controller.signal, undefined, ctx).catch((failure: Error) => { error = failure; });
      await until(() => ide.calls.length === 3);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 3);

      if (mode === 'disconnect') {
        for (const client of ide.server.clients) client.terminate();
      } else if (mode === 'reconnect') await commands.get('vim').handler('reconnect', ctx);
      else await fire('session_shutdown', {}, ctx);
      await until(() => error !== undefined, 1000);
      assert.equal(error?.message, message);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      controller.abort();
      await execution;
    });
  });
}

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

test('editor context renders selection, cursor and mentions, and nothing when disconnected', async () => {
  assert.equal((await editorContext({ connected: false, mentions: 0 }, [])).text, undefined);
  const withSelection = (await editorContext({ connected: true, ideName: 'Neovim', mentions: 0, selection: { text: 'x'.repeat(maxSelectionChars), truncated: true, filePath: '/f.ts', start: { line: 4, character: 0 }, end: { line: 6, character: 2 }, isEmpty: false } }, [])).text;
  assert.match(withSelection!, /^# Editor context \(Neovim\)/);
  assert.match(withSelection!, /Selected lines 5-7:/);
  assert.match(withSelection!, /truncated selection/);
  const cursor = (await editorContext({ connected: true, mentions: 0, selection: { text: '', filePath: '/g.ts', start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } }, [{ mention: { filePath: '/h.ts', lineStart: 2, lineEnd: 3 }, text: 'a\nb' }, { mention: { filePath: '/dir' } }])).text;
  assert.match(cursor!, /Active file: \/g\.ts \(cursor at line 1\)/);
  assert.match(cursor!, /User sent from editor: \/h\.ts lines 2-3\n```\na\nb\n```/);
  assert.match(cursor!, /User sent from editor: \/dir$/m);
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

test('editor tools normalize file paths against the active worktree', async () => {
  await withConnectedIde(async ({ ide, project, tools, ctx }) => {
    const routed = join(project, 'checkout');
    await mkdir(routed);
    const previousHome = process.env.HOME;
    process.env.HOME = routed;
    setActiveCwd(project, routed, ctx.sessionManager.getSessionId());
    try {
      assert.equal(homedir(), routed);
      const paths = ['b.ts', '@b.ts', pathToFileURL(join(routed, 'b.ts')).href, '~/b.ts', 'unicode\u00a0space.ts'];
      for (const path of paths) {
        const expected = join(routed, path.startsWith('unicode') ? 'unicode space.ts' : 'b.ts');
        await tools.get('nvim_open').execute('open', { path }, undefined, undefined, ctx);
        assert.equal(ide.calls.at(-1)?.arguments.filePath, expected, path);
        await tools.get('nvim_diagnostics').execute('diagnostics', { path }, undefined, undefined, ctx);
        assert.deepEqual(ide.calls.at(-1)?.arguments, { uri: pathToFileURL(expected).href }, path);
      }
    } finally {
      setActiveCwd(project, undefined, ctx.sessionManager.getSessionId());
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
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
    ide.broadcast('at_mentioned', { filePath: join(project, 'big.ts'), lineStart: 0, lineEnd: 2499 });
    await settle();
    const turn = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.match(turn.systemPrompt, /User sent from editor: .*big\.ts lines 1-2500\n```\n(?:L\d+\n){1999}L2000\n```/);
    assert.match(turn.systemPrompt, /truncated: showing lines 1-2000 of requested 1-2500/);
  });
});

test('the truncation note names the actual final line shown after reserving references', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    await writeFile(join(project, 'long.ts'), Array.from({ length: 1900 }, (_, index) => `L${index + 1}:` + 'x'.repeat(65)).join('\n'));
    ide.broadcast('at_mentioned', { filePath: join(project, 'long.ts'), lineStart: 0, lineEnd: 1899 });
    await settle();
    const turn = await fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    const body = /```\n([\s\S]*?)\n```/.exec(turn.systemPrompt)![1];
    const lastLine = Number(/L(\d+):[^\n]*$/.exec(body)![1]);
    assert.ok(turn.systemPrompt.includes(`showing lines 1-${lastLine}`), 'the reported range matches the displayed source');
    assert.equal((turn.systemPrompt.match(/\[truncated:/g) ?? []).length, 1, 'one budget produces one truncation notice');
  });
});

test('range reads stay bounded on a huge single-line regular file', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    const path = join(project, 'huge.txt');
    await writeFile(path, '');
    await truncate(path, 600_000_000);
    ide.broadcast('at_mentioned', { filePath: path, lineStart: 0, lineEnd: 0 });
    await settle();
    const options = { sections: {} as Record<string, string> };
    await fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: options }, ctx);
    assert.ok(options.sections.editor_context.length <= 100000);
    assert.ok(options.sections.editor_context.includes('truncated: showing lines 1-1'));
    ide.broadcast('at_mentioned', { filePath: path, lineStart: 1, lineEnd: 1 });
    await settle();
    await fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: options }, ctx);
    assert.ok(options.sections.editor_context.includes('source scan limit reached'));
  });
});

test('a submitted editor snapshot has one shared budget while retaining send references', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    for (const file of ['first.ts', 'second.ts', 'third.ts']) {
      await writeFile(join(project, file), 'SOURCE_' + file + ':' + 'x'.repeat(60000));
      ide.broadcast('at_mentioned', { filePath: join(project, file), lineStart: 0, lineEnd: 0 });
    }
    await settle();
    const options = { sections: {} as Record<string, string> };
    await fire('before_agent_start', { systemPrompt: 'BASE', systemPromptOptions: options }, ctx);
    const snapshot = options.sections.editor_context;
    assert.ok(snapshot.length <= 100000, `snapshot exceeded shared budget: ${snapshot.length}`);
    for (const file of ['first.ts', 'second.ts', 'third.ts']) assert.ok(snapshot.includes(`User sent from editor: ${join(project, file)} lines 1-1`));
    assert.ok(snapshot.includes('SOURCE_first.ts:'));
    assert.ok(snapshot.includes('context budget'));
  });
});

test('ClaudeCodeSend includes exactly the selected rows, including row zero', async () => {
  await withConnectedIde(async ({ ide, project, fire, ctx }) => {
    for (const { wire, header, text } of [
      { wire: { lineStart: 0, lineEnd: 0 }, header: '1-1', text: 'line1' },
      { wire: { lineStart: 1, lineEnd: 1 }, header: '2-2', text: 'line2' },
      { wire: { lineStart: 1, lineEnd: 2 }, header: '2-3', text: 'line2\nline3' },
      { wire: { lineStart: 0, lineEnd: 2 }, header: '1-3', text: 'line1\nline2\nline3' },
      { wire: { lineStart: 0 }, header: '1-1', text: 'line1' },
    ]) {
      const filePath = join(project, 'a.ts');
      ide.broadcast('at_mentioned', { filePath, ...wire });
      await settle();
      const turn = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
      assert.equal(turn.systemPrompt.slice(turn.systemPrompt.indexOf('User sent from editor:')),
        `User sent from editor: ${filePath} lines ${header}\n\`\`\`\n${text}\n\`\`\``);
    }
  });
});

test('relative editor mentions read the live editor root from a child Pi directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mention-'));
  const project = join(root, 'project');
  const nested = join(project, 'nested');
  let editorRoot = project;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    else if (message.method === 'tools/call') {
      assert.deepEqual(message.params, { name: 'getWorkspaceFolders', arguments: {} });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, rootPath: editorRoot }) }] } }));
    }
  }));
  await once(server, 'listening');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const previousCwd = process.cwd();
  const pi = fakePi();
  const { ctx, status } = fakeCtx(nested);
  const send = (filePath: string, range = false) => {
    for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method: 'at_mentioned', params: { filePath, ...(range ? { lineStart: 2, lineEnd: 2 } : {}) } }));
  };
  try {
    await mkdir(nested, { recursive: true });
    await mkdir(join(root, 'ide'));
    await writeFile(join(project, 'selected.ts'), 'EDITOR_FIRST\nEDITOR_SECOND\n');
    await writeFile(join(nested, 'selected.ts'), 'WRONG_FIRST\nWRONG_SECOND\n');
    await writeFile(join(root, 'ide', `${(server.address() as { port: number }).port}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [project], ideName: 'Neovim', authToken: token }));
    process.env.CLAUDE_CONFIG_DIR = root;
    process.chdir(nested);
    nvimIde(pi.api as any);
    await pi.fire('session_start', {}, ctx);
    await until(() => status.includes('Neovim ✓'));
    send('selected.ts', true);
    await settle();
    const turn = await pi.fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(turn.systemPrompt.includes(`User sent from editor: ${join(project, 'selected.ts')} lines 2-2`));
    assert.match(turn.systemPrompt, /```\nEDITOR_SECOND\n```/);
    assert.doesNotMatch(turn.systemPrompt, /WRONG_/);
    const next = await pi.fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.doesNotMatch(next.systemPrompt, /User sent from editor/);

    await writeFile(join(project, 'editor-only.ts'), 'ROOT_ONLY_FIRST\nROOT_ONLY_SECOND\n');
    await mkdir(join(project, 'folder'));
    send('editor-only.ts', true);
    send('folder');
    send(join(project, 'selected.ts'), true);
    await settle();
    const extra = await pi.fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
    assert.ok(extra.systemPrompt.includes(`User sent from editor: ${join(project, 'editor-only.ts')} lines 2-2\n` + '```\nROOT_ONLY_SECOND'));
    assert.ok(extra.systemPrompt.includes(`User sent from editor: ${join(project, 'folder')}\nUser sent from editor: ${join(project, 'selected.ts')}`));
    assert.match(extra.systemPrompt, /```\nEDITOR_SECOND\n```/);

    editorRoot = join(root, 'other');
    await mkdir(editorRoot);
    await writeFile(join(editorRoot, 'selected.ts'), 'CHANGED_FIRST\nCHANGED_SECOND\n');
    setActiveCwd(nested, project, ctx.sessionManager.getSessionId());
    try {
      send('selected.ts', true);
      await settle();
      const changed = await pi.fire('before_agent_start', { systemPrompt: 'BASE' }, ctx);
      assert.ok(changed.systemPrompt.includes(`User sent from editor: ${join(editorRoot, 'selected.ts')} lines 2-2`));
      assert.match(changed.systemPrompt, /```\nCHANGED_SECOND\n```/);
      assert.doesNotMatch(changed.systemPrompt, /EDITOR_|WRONG_/);
    } finally { setActiveCwd(nested, undefined, ctx.sessionManager.getSessionId()); }
  } finally {
    await pi.fire('session_shutdown', {}, ctx);
    process.chdir(previousCwd);
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    for (const client of server.clients) client.terminate();
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
