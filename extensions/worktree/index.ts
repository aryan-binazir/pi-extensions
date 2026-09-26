import { createBashToolDefinition, createLocalBashOperations, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getActiveCwd, resolveToolPath, setActiveCwd } from './routing.ts';
const entryType = 'agent-workflows:worktree';
const routedTools = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls']);
const directoryTools = new Set(['grep', 'find', 'ls']);
const activeCwd = (ctx: ExtensionContext): string => getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
const activeWorktreeNotice = (active: string, original: string): string => [
  `Active worktree directory: ${active}.`,
  'Built-in bash, user shell, and relative file tools use this directory.',
  'Absolute paths are unchanged.',
  `Pi's original session directory remains ${original};`,
  'session storage, loaded context/resources, and arbitrary extension internals are not relocated.',
  'Subagents resolve defaults against the active worktree.',
  'Inspect this checkout\'s instructions before editing.',
].join(' ');
export default function worktree(pi: ExtensionAPI): void {
  const paint = (ctx: ExtensionContext) => { if (ctx.hasUI) { const active = activeCwd(ctx); ctx.ui.setStatus(entryType, active === ctx.cwd ? undefined : `Worktree: ${active}`); } };
  let previousSession: { cwd: string; id: string } | undefined;
  const restore = async (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    if (previousSession && (previousSession.cwd !== ctx.cwd || previousSession.id !== id)) setActiveCwd(previousSession.cwd, undefined, previousSession.id);
    previousSession = { cwd: ctx.cwd, id };
    setActiveCwd(ctx.cwd, undefined, id);
    let path: unknown;
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === 'custom' && entry.customType === entryType) {
        const data = entry.data as { version?: number; path?: unknown } | undefined;
        path = data?.version === 1 ? data.path : undefined;
        break;
      }
    }
    if (typeof path === 'string' && isAbsolute(path)) {
      try {
        const canonical = await realpath(path);
        if (canonical !== await realpath(ctx.cwd)) {
          const { Worktrees } = await import('./manager.ts');
          const trees = new Worktrees(ctx.cwd);
          const checkout = (await trees.list()).find(item => resolve(item.path) === resolve(path) || item.path === canonical);
          if (!checkout || !await trees.matches(checkout)) throw new Error('Saved checkout is unavailable');
          setActiveCwd(ctx.cwd, canonical, id);
        }
      }
      catch { if (ctx.hasUI) ctx.ui.notify('Saved worktree is unavailable or invalid; using original session directory', 'warning'); }
    }
    paint(ctx);
  };
  const activate = (ctx: ExtensionContext, path: string) => { setActiveCwd(ctx.cwd, path, ctx.sessionManager.getSessionId()); pi.appendEntry(entryType, { version: 1, path }); paint(ctx); };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => { setActiveCwd(ctx.cwd, undefined, ctx.sessionManager.getSessionId()); paint(ctx); });
  pi.on('tool_call', (event, ctx) => {
    if (!routedTools.has(event.toolName)) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path === 'string') input.path = resolveToolPath(input.path, activeCwd(ctx));
    else if (input.path === undefined && directoryTools.has(event.toolName)) input.path = activeCwd(ctx);
  });
  const bashMetadata = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...bashMetadata,
    execute(id, params, signal, onUpdate, ctx) {
      const cwd = activeCwd(ctx);
      return createBashToolDefinition(cwd, { spawnHook: context => ({ ...context, cwd }) }).execute(id, params, signal, onUpdate, ctx);
    },
  });
  pi.on('user_bash', (_event, ctx) => {
    const local = createLocalBashOperations();
    return { operations: { exec: (command, _cwd, options) => local.exec(command, activeCwd(ctx), options) } };
  });
  pi.on('before_agent_start', (event, ctx) => ({ systemPrompt: `${event.systemPrompt}\n\n${activeWorktreeNotice(activeCwd(ctx), ctx.cwd)}` }));
  pi.registerCommand('worktree', {
    description: 'Worktree: <name> [--branch branch] [--base ref], list, original, remove <path> [--force], cleanup [--force]',
    async handler(args, ctx) {
      if (!ctx.isIdle()) { if (ctx.hasUI) ctx.ui.notify('Wait for the active turn before switching worktrees', 'warning'); return; }
      try {
        const words = commandWords(args);
        const command = words.shift() ?? 'list';
        if (command === 'original') { activate(ctx, ctx.cwd); return; }
        const { Worktrees } = await import('./manager.ts');
        const trees = new Worktrees(ctx.cwd);
        if (command === 'list') { if (ctx.hasUI) ctx.ui.notify((await trees.list()).map(item => `${item.branch || '(detached)'} ${item.path}`).join('\n'), 'info'); return; }
        if (!ctx.hasUI) throw new Error('Worktree mutations require an interactive confirmation UI');
        if (command === 'remove' || command === 'cleanup') {
          const force = words.includes('--force');
          const paths = words.filter(word => word !== '--force');
          if (command === 'remove' && (paths.length !== 1 || !paths[0])) throw new Error('Usage: /worktree remove <path> [--force]');
          const confirm = (message: string) => ctx.ui.confirm('Remove worktree', message);
          const path = command === 'remove' ? await realpath(resolve(activeCwd(ctx), paths[0])) : undefined;
          const results = command === 'cleanup' ? await trees.cleanup({ force, confirm }) : [{ path: path!, ...await trees.remove(path!, { force, confirm }) }];
          if (results.some(result => result.removed && resolve(result.path) === resolve(activeCwd(ctx)))) activate(ctx, ctx.cwd);
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
