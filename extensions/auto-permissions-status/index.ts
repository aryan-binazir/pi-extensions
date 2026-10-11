import { isBashToolResult, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { findConfigLoader, statusText, type ConfigLoader } from './adapter.ts';

import { permissionFooter, STATUS_KEY as KEY } from './footer.ts';
import { pullRequests, type PullRequests } from './pull-request.ts';

export default function autoPermissionsStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let loader: ConfigLoader | undefined;
  let unavailable = 'Auto: unavailable';
  let previous: string | undefined;
  let generation = 0;
  let ownsFooter = false;
  let prs: PullRequests | undefined;

  const refresh = () => {
    if (!context?.hasUI) return;
    let text = unavailable;
    if (loader) {
      try { text = statusText(loader(), context.model); }
      catch { text = 'Auto: config error'; }
    }
    if (text !== previous) {
      context.ui.setStatus(KEY, text);
      previous = text;
    }
  };
  const stop = () => {
    ++generation;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (context?.hasUI) context.ui.setStatus(KEY, undefined);
    if (ownsFooter) context?.ui.setFooter(undefined);
    ownsFooter = false;
    context = undefined; loader = undefined; previous = undefined; prs = undefined;
  };

  pi.on('session_start', async (_event, ctx) => {
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
    try {
      const found = await findConfigLoader(pi.getCommands());
      if (version !== generation) return;
      loader = found;
    } catch {
      if (version !== generation) return;
      unavailable = 'Auto: unavailable (adapter)';
    }
    refresh();
    // The settings menu writes config without emitting a public change event.
    timer = setInterval(refresh, 1000);
    timer.unref();
  });
  const adopt = (_event: unknown, ctx: ExtensionContext) => { if (context) { context = ctx; refresh(); } };
  pi.on('model_select', adopt);
  pi.on('agent_start', adopt);
  pi.on('session_shutdown', stop);
  pi.on('agent_end', () => { prs?.refresh(); });
  pi.on('tool_result', event => {
    if (isBashToolResult(event) && /\b(git|gh)\b/.test(String(event.input.command ?? ''))) prs?.refresh();
  });
}
