import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { editorContext } from './context.ts';
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { Type } from 'typebox';
import { IdeLink, type LinkState } from './link.ts';
import { resolveToolPath } from '../tool-path.ts';
import { FollowQueue } from './follow.ts';

export { editorContext, maxEditorContextChars } from './context.ts';

const statusKey = 'nvim-ide';
// Session replacement re-runs the factory and /reload re-evaluates this module, so the preference lives for the process.
const followKey = Symbol.for('pi-interactive:nvim-ide.follow.v1');
const prefs = globalThis as unknown as Record<symbol, boolean | undefined>;
const following = () => prefs[followKey] !== false;
export function statusText(state: LinkState): string | undefined {
  if (!state.connected) return undefined;
  const name = state.ideName ?? 'IDE';
  const sel = state.selection;
  if (!sel) return `${name} ✓`;
  const file = basename(sel.filePath);
  const range = sel.isEmpty || sel.start.line === sel.end.line ? `${sel.start.line + 1}` : `${sel.start.line + 1}-${sel.end.line + 1}`;
  return `${name} ✓ ${file}:${range}${sel.isEmpty ? '' : ' ▮'}`;
}

export default function nvimIde(pi: ExtensionAPI): void {
  let link: IdeLink | undefined;
  let ctx: ExtensionContext | undefined;
  let sessionCwd = '';
  const workspaceCwd = () => sessionCwd;
  const warn = (message: string) => { try { if (ctx?.hasUI) ctx.ui.notify(message, 'warning'); } catch {} };
  const follow = new FollowQueue({ link: () => link, cwd: workspaceCwd, following, warn });
  const editPaths = new Map<string, { path: string; cwd: string }>();
  let shown: string | undefined;
  let paintTimer: NodeJS.Timeout | undefined;
  const paint = (state: LinkState) => { if (paintTimer) { clearTimeout(paintTimer); paintTimer = undefined; } const text = statusText(state); if (text === shown || !ctx?.hasUI) return; shown = text; ctx.ui.setStatus(statusKey, text); };
  const need = (): IdeLink => { if (!link?.connected) throw new Error('Open Neovim with claudecode.nvim in the session directory.'); return link; };

  pi.on('session_start', async (_event, context) => {
    follow.reset();
    editPaths.clear();
    ctx = context;
    paint({ connected: false, mentions: 0 });
    const previous = link;
    link = undefined;
    await previous?.stop();
    sessionCwd = context.cwd;
    const current = new IdeLink({ cwd: workspaceCwd, onChange: state => {
      if (link !== current) return;
      if (!state.connected || shown === undefined) paint(state);
      else if (!paintTimer && statusText(state) !== shown) {
        paintTimer = setTimeout(() => { paintTimer = undefined; if (link === current) paint(current.state); }, 300);
        paintTimer.unref();
      }
      follow.update();
    } });
    link = current;
    current.start();
  });
  pi.on('session_shutdown', async () => { follow.cancel(); editPaths.clear(); const current = link; link = undefined; await current?.stop(); paint({ connected: false, mentions: 0 }); });

  pi.on('before_agent_start', async (event, context) => {
    sessionCwd = context.cwd;
    const current = link;
    if (!current) return;
    follow.update();
    await current.retarget();
    const batch = await current.prepareMentions();
    const notices: string[] = [];
    if (batch.undelivered) notices.push(`${batch.undelivered} editor send${batch.undelivered === 1 ? '' : 's'} could not be resolved. Re-send the file from the editor.`);
    if (batch.dropped) notices.push(`${batch.dropped} editor send${batch.dropped === 1 ? '' : 's'} dropped because the queue was full or initialization was interrupted. Re-send the file from the editor.`);
    const snapshot = await editorContext(current.state, batch.mentions.map(mention => ({ mention })), notices);
    if (link !== current) return;
    if (snapshot.text) event.systemPromptOptions.sections.editor_context = snapshot.text;
    if (snapshot.omittedReferences) notices.push(`${snapshot.omittedReferences} editor references omitted by the context budget. Re-send fewer files.`);
    if (notices.length) warn(notices.join('\n'));
    batch.acknowledge();
  });

  pi.on('tool_execution_start', (event, context) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    const path = (event.args as { path?: unknown })?.path;
    if (typeof path === 'string') {
      const cwd = context.cwd;
      editPaths.set(event.toolCallId, { path: resolveToolPath(path, cwd), cwd });
    }
  });
  pi.on('tool_execution_end', event => {
    const edit = editPaths.get(event.toolCallId);
    editPaths.delete(event.toolCallId);
    if (edit && !event.isError) follow.enqueue(edit.path, edit.cwd);
  });

  pi.registerTool({
    name: 'nvim_context',
    label: 'Editor context',
    description: 'Read what the user has open in the connected editor: workspace folders, open buffers, and the current selection.',
    promptSnippet: 'Read the connected editor\'s open buffers and current selection',
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const ide = need();
      const [folders, editors, selection] = await Promise.all([ide.call('getWorkspaceFolders', {}, signal), ide.call('getOpenEditors', {}, signal), ide.call('getCurrentSelection', {}, signal)]);
      const text = `Workspace folders:\n${folders}\n\nOpen editors:\n${editors}\n\nCurrent selection:\n${selection}`;
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  });
  pi.registerTool({
    name: 'nvim_diagnostics',
    label: 'Editor diagnostics',
    description: 'Language-server diagnostics from the connected editor for one file, or for every open buffer when path is omitted.',
    promptSnippet: 'Get LSP diagnostics from the connected editor',
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: 'File path; omit for all open buffers' })) }),
    async execute(_id, params, signal, _update, context) {
      const args = params.path ? { uri: pathToFileURL(resolveToolPath(params.path, context.cwd)).href } : {};
      return { content: [{ type: 'text' as const, text: await need().call('getDiagnostics', args, signal) }], details: undefined };
    },
  });
  pi.registerTool({
    name: 'nvim_open',
    label: 'Open in editor',
    description: 'Open a file in the connected editor, optionally selecting a line range, so the user can see it.',
    promptSnippet: 'Open a file at a line range in the connected editor',
    parameters: Type.Object({ path: Type.String(), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, params, signal, _update, context) {
      follow.cancel();
      const ide = need();
      const args: Record<string, unknown> = { filePath: resolveToolPath(params.path, context.cwd), preview: false, makeFrontmost: true };
      const start = params.startLine, end = params.endLine ?? params.startLine, shift = ide.openFileLineOffset;
      if (start && end) { args.startLine = start + shift; args.endLine = end + shift; }
      let text = await ide.call('openFile', args, signal);
      follow.succeeded(ide);
      if (start && end && shift) text = text.replace(`selected lines ${start + shift} to ${end + shift}`, `selected lines ${start} to ${end}`);
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  });

  pi.registerCommand('vim', {
    description: 'Editor link: status (default), follow on|off, reconnect',
    async handler(args, context) {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const say = (message: string, type: 'info' | 'warning' = 'info') => { if (context.hasUI) context.ui.notify(message, type); };
      if (words[0] === 'follow') {
        if (words[1] === 'on' || words[1] === 'off') prefs[followKey] = words[1] === 'on';
        follow.update();
        say(`Editor follows pi edits: ${following() ? 'on' : 'off'}`);
        return;
      }
      if (words[0] === 'reconnect') { link?.reconnect(); say('Editor link: rediscovering'); return; }
      const state = link?.state;
      if (!state?.connected) { say('Editor link: waiting for claudecode.nvim in the session directory.', 'warning'); return; }
      say(`Editor link: ${state.ideName} on port ${state.port}, follow ${following() ? 'on' : 'off'}${state.selection ? `, viewing ${state.selection.filePath}` : ''}`);
    },
  });
}
