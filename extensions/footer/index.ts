import { statSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { isBashToolResult, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { findConfigLoader, statusText, type ConfigLoader, type PermissionConfig } from './adapter.ts';

import { permissionFooter, STATUS_KEY as KEY } from './footer.ts';
import { pullRequests, type PullRequests, changesPullRequest } from './pull-request.ts';

export default function autoPermissionsStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, changeTimer: ReturnType<typeof setTimeout> | undefined;
  let loader: ConfigLoader | undefined;
  let config: PermissionConfig | undefined, watcher: FSWatcher | undefined;
  let stamp: string | undefined, watching: string | undefined, watchingInode: number | undefined;
  let unavailable = 'Auto: unavailable';
  let previous: string | undefined;
  let generation = 0;
  let ownsFooter = false;
  let prs: PullRequests | undefined;

  const refresh = () => {
    if (!context?.hasUI) return;
    let text = unavailable;
    if (config) text = statusText(config, context.model);
    if (text !== previous) {
      context.ui.setStatus(KEY, text);
      previous = text;
    }
  };
  const readConfig = () => {
    if (!loader) return;
    let next: string | undefined;
    try {
      const info = statSync(loader.path);
      next = `${info.ino}:${info.mtimeMs}:${info.size}`;
    } catch {}
    if (next === stamp && (config || unavailable === 'Auto: config error')) return;
    stamp = next;
    try { config = loader.load(); }
    catch { config = undefined; unavailable = 'Auto: config error'; }
    refresh();
  };
  const observeConfig = () => {
    if (!loader) return;
    const parent = dirname(loader.path);
    let directory = parent;
    for (;;) {
      try {
        const inode = statSync(directory).ino;
        if (directory === watching && inode === watchingInode) return;
        const next = watch(directory, { persistent: false }, () => {
          // Bun can report only the temporary filename for an atomic replacement.
          if (changeTimer) clearTimeout(changeTimer);
          changeTimer = setTimeout(() => { changeTimer = undefined; observeConfig(); readConfig(); }, 50);
          changeTimer.unref();
        });
        next.unref();
        next.on('error', () => { next.close(); if (watcher === next) { watcher = undefined; watching = undefined; watchingInode = undefined; } });
        watcher?.close(); watcher = next; watching = directory; watchingInode = inode;
        return;
      } catch {
        const ancestor = dirname(directory);
        if (ancestor === directory) return;
        directory = ancestor;
      }
    }
  };
  const stop = (event?: { reason?: string }) => {
    ++generation;
    prs?.dispose(event?.reason === 'quit');
    if (timer) clearTimeout(timer);
    if (changeTimer) clearTimeout(changeTimer);
    timer = changeTimer = undefined;
    watcher?.close(); watcher = undefined; watching = undefined; watchingInode = undefined; stamp = undefined; config = undefined;
    if (context?.hasUI) context.ui.setStatus(KEY, undefined);
    if (ownsFooter) context?.ui.setFooter(undefined);
    ownsFooter = false;
    context = undefined; loader = undefined; previous = undefined; prs = undefined;
  };

  pi.on('session_start', (_event, ctx) => {
    stop();
    if (!ctx.hasUI) return;
    context = ctx;
    if (ctx.mode === 'tui') {
      ctx.ui.setFooter((tui, theme, data) => {
        const requestRender = () => tui.requestRender();
        prs = pullRequests((command, args, options) => pi.exec(command, args, options), requestRender);
        return permissionFooter(() => context ?? ctx, theme, data, requestRender, prs);
      });
      ownsFooter = true;
    }
    unavailable = 'Auto: unavailable';
    const version = generation;
    refresh();
    timer = setTimeout(() => {
      timer = undefined;
      void discover();
    }, 0);
    timer.unref();
    async function discover() {
      try {
        const found = await findConfigLoader(pi.getCommands());
        if (version !== generation) return;
        loader = found;
      } catch {
        if (version !== generation) return;
        unavailable = 'Auto: unavailable (adapter)';
      }
      observeConfig();
      readConfig();
      refresh();
    }
  });
  const adopt = (_event: unknown, ctx: ExtensionContext) => { if (context) { context = ctx; observeConfig(); readConfig(); refresh(); } };
  pi.on('model_select', adopt);
  pi.on('agent_start', adopt);
  pi.on('session_shutdown', stop);
  pi.on('agent_end', () => { prs?.refresh(false); });
  pi.on('tool_result', event => {
    if (isBashToolResult(event) && changesPullRequest(String(event.input.command ?? ''))) prs?.refresh();
  });
}
