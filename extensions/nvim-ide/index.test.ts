import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import nvimIde from './index.ts';

const token = 'a3f1c2d4e5f60718293a4b5c6d7e8f90';
type Handler = (event: any, ctx: any) => any;

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
  return { ctx: { cwd, hasUI: true, ui: { setStatus: (_key: string, text: string | undefined) => status.push(text), notify: (message: string) => notices.push(message) } }, status, notices };
}
function fakeIde() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers['x-claude-code-ide-authorization'] === token });
  const calls: { name: string; arguments: any }[] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (message.method === 'initialize') reply({});
    else if (message.method === 'tools/call') { calls.push(message.params); reply({ content: [{ type: 'text', text: `${message.params.name}(${JSON.stringify(message.params.arguments)})` }] }); }
  }));
  const port = () => (server.address() as { port: number }).port;
  const broadcast = (method: string, params: unknown) => { for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method, params })); };
  return { server, calls, port, broadcast, close: () => new Promise<void>(done => { for (const client of server.clients) client.terminate(); server.close(() => done()); }) };
}
const until = (check: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => { const start = Date.now(); const tick = () => check() ? resolve() : Date.now() - start > ms ? reject(new Error('timeout')) : setTimeout(tick, 10); tick(); });

test('adapter end to end: status, prompt context, mentions, follow-after-edit, tools and /vim', async () => {
  const ide = fakeIde();
  await once(ide.server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'pi-ide-'));
  const project = join(root, 'project');
  await mkdir(join(root, 'ide'), { recursive: true });
  await mkdir(project);
  await writeFile(join(project, 'a.ts'), 'line1\nline2\nline3\nline4\n');
  await writeFile(join(root, 'ide', `${ide.port()}.lock`), JSON.stringify({ pid: process.pid, transport: 'ws', workspaceFolders: [project], ideName: 'Neovim', authToken: token }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const { api, fire, tools, commands } = fakePi();
  const { ctx, status, notices } = fakeCtx(project);
  try {
    nvimIde(api as any);
    assert.deepEqual([...tools.keys()].sort(), ['nvim_context', 'nvim_diagnostics', 'nvim_open']);
    assert.deepEqual([...commands.keys()], ['vim']);

    await fire('session_start', {}, ctx);
    await until(() => status.includes('Neovim ✓'));

    // Ambient selection reaches the status bar and the system prompt; repaints only on change.
    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await until(() => status.at(-1) === 'Neovim ✓ a.ts:2-3 ▮');
    const paints = status.length;
    ide.broadcast('selection_changed', { text: 'line2\nline3', filePath: join(project, 'a.ts'), selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 5 }, isEmpty: false } });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(status.length, paints, 'identical selection does not repaint');

    ide.broadcast('at_mentioned', { filePath: join(project, 'a.ts'), lineStart: 3, lineEnd: 4 });
    ide.broadcast('at_mentioned', { filePath: join(project, 'missing.ts'), lineStart: 1, lineEnd: 1 });
    await new Promise(r => setTimeout(r, 50));
    const turn = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.match(turn.systemPrompt, /^BASE\n\n# Editor context \(Neovim\)/);
    assert.match(turn.systemPrompt, /Selected lines 2-3:\n```\nline2\nline3\n```/);
    assert.match(turn.systemPrompt, /User sent from editor: .*a\.ts lines 3-4\n```\nline3\nline4\n```/);
    assert.match(turn.systemPrompt, /User sent from editor: .*missing\.ts lines 1-1(?:\n(?!```)|$)/, 'unreadable mention is listed without contents');
    const next = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.doesNotMatch(next.systemPrompt, /User sent from editor/, 'mentions are consumed by the turn that injected them');
    assert.match(next.systemPrompt, /Selected lines 2-3/, 'ambient selection persists');

    // Follow after edit: successful edit opens the file at the first changed line; errors and writes without a line still open the file.
    await fire('tool_execution_start', { toolCallId: 't1', toolName: 'edit', args: { path: 'a.ts', edits: [] } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't1', toolName: 'edit', isError: false, result: { details: { firstChangedLine: 7 } } }, ctx);
    await until(() => ide.calls.length === 1);
    assert.deepEqual(ide.calls[0], { name: 'openFile', arguments: { filePath: join(project, 'a.ts'), preview: false, makeFrontmost: true, startLine: 7, endLine: 7 } });
    await fire('tool_execution_start', { toolCallId: 't2', toolName: 'write', args: { path: join(project, 'b.ts'), content: '' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't2', toolName: 'write', isError: false, result: {} }, ctx);
    await until(() => ide.calls.length === 2);
    assert.deepEqual(ide.calls[1].arguments, { filePath: join(project, 'b.ts'), preview: false, makeFrontmost: true });
    await fire('tool_execution_start', { toolCallId: 't3', toolName: 'edit', args: { path: 'a.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't3', toolName: 'edit', isError: true, result: {} }, ctx);
    await fire('tool_execution_start', { toolCallId: 't4', toolName: 'bash', args: { command: 'ls' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't4', toolName: 'bash', isError: false, result: {} }, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ide.calls.length, 2, 'failed edits and non-file tools do not move the editor');

    await commands.get('vim').handler('follow off', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: off');
    await fire('tool_execution_start', { toolCallId: 't5', toolName: 'edit', args: { path: 'a.ts' } }, ctx);
    await fire('tool_execution_end', { toolCallId: 't5', toolName: 'edit', isError: false, result: { details: { firstChangedLine: 1 } } }, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ide.calls.length, 2, 'follow off suppresses the jump');
    await commands.get('vim').handler('follow nonsense', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: off');
    await commands.get('vim').handler('follow on', ctx);
    assert.equal(notices.at(-1), 'Editor follows pi edits: on');
    await commands.get('vim').handler('', ctx);
    assert.match(notices.at(-1)!, new RegExp(`^Editor link: Neovim on port ${ide.port()}, follow on, viewing .*a\\.ts$`));

    // Tools route to the IDE with resolved paths.
    const open = await tools.get('nvim_open').execute('id', { path: 'a.ts', startLine: 2 }, undefined, undefined, ctx);
    assert.equal(open.content[0].text, `openFile(${JSON.stringify({ filePath: join(project, 'a.ts'), preview: false, makeFrontmost: true, startLine: 2, endLine: 2 })})`);
    const diagnostics = await tools.get('nvim_diagnostics').execute('id', { path: 'a.ts' }, undefined, undefined, ctx);
    assert.match(diagnostics.content[0].text, /^getDiagnostics\(\{"uri":"file:\/\/.*a\.ts"\}\)$/);
    const all = await tools.get('nvim_diagnostics').execute('id', {}, undefined, undefined, ctx);
    assert.equal(all.content[0].text, 'getDiagnostics({})');
    const context = await tools.get('nvim_context').execute('id', {}, undefined, undefined, ctx);
    assert.match(context.content[0].text, /Workspace folders:\ngetWorkspaceFolders\(\{\}\)\n\nOpen editors:\ngetOpenEditors\(\{\}\)\n\nCurrent selection:\ngetCurrentSelection\(\{\}\)/);

    // Editor goes away: status clears, prompt is untouched, tools fail clearly, /vim explains.
    await ide.close();
    await until(() => status.at(-1) === undefined);
    const alone = await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx);
    assert.equal(alone, undefined);
    await assert.rejects(tools.get('nvim_context').execute('id', {}, undefined, undefined, ctx), /No editor connected/);
    await commands.get('vim').handler('', ctx);
    assert.match(notices.at(-1)!, /not connected/);

    await fire('session_shutdown', {}, ctx);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await ide.close();
    await rm(root, { recursive: true, force: true });
  }
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
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(status, []);
    assert.equal(await fire('before_agent_start', { prompt: 'x', systemPrompt: 'BASE' }, ctx), undefined);
    await fire('session_shutdown', {}, ctx);
    assert.deepEqual(status, [], 'nothing was shown, so nothing is cleared');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
