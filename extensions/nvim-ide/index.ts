import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { editorContext } from './context.ts';
import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { Type } from 'typebox';
import { IdeLink, type LinkState } from './link.ts';
import { getActiveCwd, resolveToolPath } from '../worktree/routing.ts';

export { editorContext, maxEditorContextChars } from './context.ts';

const statusKey = 'nvim-ide';
const followWindowMs = 100;
const followTimeoutMs = 5000;
const replayAgeMs = 30_000;
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
  let follow = true;
  let seenEditor = false;
  let followFailed = false;
  const warn = (message: string) => { try { if (ctx?.hasUI) ctx.ui.notify(message, 'warning'); } catch {} };
  let pendingFollow: { args: Record<string, unknown>; at: number } | undefined;
  let followTimer: NodeJS.Timeout | undefined;
  let inFlight: AbortController | undefined;
  const cancelFollow = () => {
    if (followTimer) clearTimeout(followTimer);
    followTimer = undefined;
    pendingFollow = undefined;
    const controller = inFlight;
    inFlight = undefined;
    controller?.abort();
  };
  const scheduleFollow = () => {
    if (!follow || !pendingFollow || !link?.connected || followTimer || inFlight) return;
    followTimer = setTimeout(() => {
      followTimer = undefined;
      const current = link, destination = pendingFollow;
      if (!follow || !destination || !current?.connected) return;
      pendingFollow = undefined;
      if (Date.now() - destination.at > replayAgeMs) return;
      const controller = new AbortController();
      inFlight = controller;
      const deadline = setTimeout(() => controller.abort(), followTimeoutMs);
      deadline.unref();
      void current.call('openFile', destination.args, controller.signal).then(() => {
        if (inFlight === controller && link === current) followFailed = false;
      }).catch(error => {
        if (inFlight !== controller || link !== current) return;
        if (!current.connected) pendingFollow ??= destination;
        else if (!followFailed) {
          followFailed = true;
          warn(`Could not reveal ${basename(String(destination.args.filePath))} in the editor: ${error instanceof Error ? error.message : String(error)}`);
        }
      }).finally(() => {
        clearTimeout(deadline);
        if (inFlight !== controller) return;
        inFlight = undefined;
        scheduleFollow();
      });
    }, followWindowMs);
    followTimer.unref();
  };
  const editPaths = new Map<string, string>();
  const activeCwd = (context: ExtensionContext) => getActiveCwd(context.cwd, context.sessionManager.getSessionId());
  let shown: string | undefined;
  const paint = (state: LinkState) => { const text = statusText(state); if (text === shown || !ctx?.hasUI) return; shown = text; ctx.ui.setStatus(statusKey, text); };
  const need = (): IdeLink => { if (!link?.connected) throw new Error('No editor connected. Start Neovim with claudecode.nvim in this directory.'); return link; };

  pi.on('session_start', async (_event, context) => {
    cancelFollow();
    editPaths.clear();
    ctx = context;
    paint({ connected: false, mentions: 0 });
    const previous = link;
    link = undefined;
    seenEditor = false;
    followFailed = false;
    await previous?.stop();
    const current = new IdeLink({ cwd: context.cwd, onChange: state => {
      if (link !== current) return;
      if (state.connected) seenEditor = true;
      paint(state);
      scheduleFollow();
    } });
    link = current;
    current.start();
  });
  pi.on('session_shutdown', async () => { cancelFollow(); editPaths.clear(); const current = link; link = undefined; await current?.stop(); paint({ connected: false, mentions: 0 }); });

  pi.on('before_agent_start', async event => {
    const current = link;
    if (!current) return;
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
    if (typeof path === 'string') editPaths.set(event.toolCallId, resolveToolPath(path, activeCwd(context)));
  });
  pi.on('tool_execution_end', event => {
    const path = editPaths.get(event.toolCallId);
    editPaths.delete(event.toolCallId);
    if (!path || event.isError || !follow || !seenEditor) return;
    const line = (event.result as { details?: { firstChangedLine?: unknown } })?.details?.firstChangedLine;
    const args: Record<string, unknown> = { filePath: path, preview: false, makeFrontmost: true };
    if (Number.isInteger(line)) { args.startLine = line; args.endLine = line; }
    pendingFollow = { args, at: Date.now() };
    scheduleFollow();
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
      const args = params.path ? { uri: pathToFileURL(resolveToolPath(params.path, activeCwd(context))).href } : {};
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
      const ide = need();
      cancelFollow();
      const args: Record<string, unknown> = { filePath: resolveToolPath(params.path, activeCwd(context)), preview: false, makeFrontmost: true };
      if (params.startLine) { args.startLine = params.startLine; args.endLine = params.endLine ?? params.startLine; }
      return { content: [{ type: 'text' as const, text: await ide.call('openFile', args, signal) }], details: undefined };
    },
  });

  pi.registerCommand('vim', {
    description: 'Editor link: status (default), follow on|off, reconnect',
    async handler(args, context) {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const say = (message: string, type: 'info' | 'warning' = 'info') => { if (context.hasUI) context.ui.notify(message, type); };
      if (words[0] === 'follow') {
        if (words[1] === 'on' || words[1] === 'off') follow = words[1] === 'on';
        if (!follow) cancelFollow();
        say(`Editor follows pi edits: ${follow ? 'on' : 'off'}`);
        return;
      }
      if (words[0] === 'reconnect') { link?.reconnect(); say('Editor link: rediscovering'); return; }
      const state = link?.state;
      if (!state?.connected) { say('Editor link: not connected. Looking for a claudecode.nvim lock file whose workspace contains this directory.', 'warning'); return; }
      say(`Editor link: ${state.ideName} on port ${state.port}, follow ${follow ? 'on' : 'off'}${state.selection ? `, viewing ${state.selection.filePath}` : ''}`);
    },
  });
}
