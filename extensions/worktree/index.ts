import { createBashToolDefinition, createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Worktrees } from './manager.ts';
import { getActiveCwd, resolveToolPath, setActiveCwd } from './routing.ts';
const entryType = 'agent-workflows:worktree';
export default function worktree(pi: ExtensionAPI): void {
  const paint = (ctx: ExtensionContext) => { if (ctx.hasUI) ctx.ui.setStatus(entryType, getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()) === ctx.cwd ? undefined : `Worktree: ${getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId())}`); };
  let previousSession: { cwd: string; id: string } | undefined;
  const restore = async (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (previousSession && (previousSession.cwd !== ctx.cwd || previousSession.id !== id)) setActiveCwd(previousSession.cwd, undefined, previousSession.id);
    previousSession = { cwd: ctx.cwd, id };
    setActiveCwd(ctx.cwd, undefined, ctx.sessionManager.getSessionId());
    let path: unknown;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === entryType) {
        const data = entry.data as { version?: number; path?: unknown } | undefined;
        path = data?.version === 1 ? data.path : undefined;
      }
    }
    if (typeof path === 'string' && isAbsolute(path)) {
      try {
        if ((await stat(path)).isDirectory()) {
          const canonical = await realpath(path);
          if (canonical !== await realpath(ctx.cwd)) setActiveCwd(ctx.cwd, canonical, ctx.sessionManager.getSessionId());
        }
      }
      catch { if (ctx.hasUI) ctx.ui.notify('Saved worktree no longer exists; using original session directory', 'warning'); }
    }
    paint(ctx);
  };
  const activate = (ctx: ExtensionContext, path: string) => { setActiveCwd(ctx.cwd, path, ctx.sessionManager.getSessionId()); pi.appendEntry(entryType, { version: 1, path }); paint(ctx); };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => { setActiveCwd(ctx.cwd, undefined, ctx.sessionManager.getSessionId()); paint(ctx); });
  pi.on('tool_call', (event, ctx) => {
    if (!['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(event.toolName)) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path === 'string') input.path = resolveToolPath(input.path, getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()));
    else if (input.path === undefined && ['grep', 'find', 'ls'].includes(event.toolName)) input.path = getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
  });
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    execute(id, params, signal, onUpdate, ctx) { return createBashToolDefinition(getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()), { spawnHook: context => ({ ...context, cwd: getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()) }) }).execute(id, params, signal, onUpdate, ctx); },
  });
  pi.on('user_bash', (_event, ctx) => {
    const local = createLocalBashOperations();
    return { operations: { exec: (command, _cwd, options) => local.exec(command, getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()), options) } };
  });
  pi.on('before_agent_start', (event, ctx) => ({ systemPrompt: `${event.systemPrompt}\n\nActive worktree directory: ${getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId())}. Built-in bash, user shell, and relative file tools use this directory. Absolute paths are unchanged. Pi's original session directory remains ${ctx.cwd}; session storage, loaded context/resources, and arbitrary extension internals are not relocated. Subagents resolve defaults against the active worktree. Inspect this checkout's instructions before editing.` }));
  pi.registerCommand('worktree', {
    description: 'Worktree: <name> [--branch branch] [--base ref], list, original, remove <path> [--force], cleanup [--force]',
    async handler(args, ctx) {
      if (!ctx.isIdle()) { if (ctx.hasUI) ctx.ui.notify('Wait for the active turn before switching worktrees', 'warning'); return; }
      try {
        const words = commandWords(args);
        const command = words.shift() ?? 'list';
        const trees = new Worktrees(ctx.cwd);
        if (command === 'original') { activate(ctx, ctx.cwd); return; }
        if (command === 'list') { if (ctx.hasUI) ctx.ui.notify((await trees.list()).map(item => `${item.branch || '(detached)'} ${item.path}`).join('\n'), 'info'); return; }
        if (!ctx.hasUI) throw new Error('Worktree mutations require an interactive confirmation UI');
        if (command === 'remove' || command === 'cleanup') {
          const force = words.includes('--force');
          const confirm = (message: string) => ctx.ui.confirm('Remove worktree', message);
          const path = resolve(getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId()), words.filter(word => word !== '--force').join(' ') || '.');
          const results = command === 'cleanup' ? await trees.cleanup({ force, confirm }) : [{ path, ...await trees.remove(path, { force, confirm }) }];
          if (results.some(result => result.removed && resolve(result.path) === resolve(getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId())))) activate(ctx, ctx.cwd);
          ctx.ui.notify(results.map(result => `${result.path}: ${result.removed ? 'removed' : result.reason}`).join('\n') || 'No worktrees to clean', 'info');
          return;
        }
        const options: { branch?: string; base?: string } = {};
        while (words.length) {
          const flag = words.shift(); const value = words.shift();
          if (!value || (flag !== '--branch' && flag !== '--base')) throw new Error('Usage: /worktree <name> [--branch branch] [--base ref]');
          options[flag === '--branch' ? 'branch' : 'base'] = value;
        }
        const checkout = await trees.open(command, options); activate(ctx, checkout.path);
        ctx.ui.notify(`Active worktree: ${checkout.path}. Pi session storage remains at ${ctx.cwd}.`, 'info');
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); else throw error; }
    },
  });
}

// Split command arguments without changing spaces inside quoted paths.
function commandWords(args: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (const character of args) {
    if (quote) {
      if (character === quote) quote = ''; else word += character;
    } else if (character === '"' || character === "'") {
      quote = character; started = true;
    } else if (/\s/.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += character; started = true; }
  }
  if (quote) throw new Error('Unclosed quote in worktree command');
  if (started) words.push(word);
  return words;
}
