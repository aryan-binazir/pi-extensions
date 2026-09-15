import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { findConfigLoader, statusText, type ConfigLoader } from './adapter.ts';

import { permissionFooter, STATUS_KEY as KEY } from './footer.ts';

/** Display only: never changes permission policy, tools or prompts. */
export default function autoPermissionsStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let loader: ConfigLoader | undefined;
  let unavailable = 'Auto: unavailable';
  let previous: string | undefined;
  let generation = 0;
  let ownsFooter = false;

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
    context = undefined; loader = undefined; previous = undefined;
  };

  pi.on('session_start', async (_event, ctx) => {
    stop();
    if (!ctx.hasUI) return;
    context = ctx;
    if (ctx.mode === 'tui') {
      ctx.ui.setFooter((tui, theme, data) => permissionFooter(() => context ?? ctx, theme, data, () => tui.requestRender()));
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
    // A single session-owned timer also catches external edits while idle.
    timer = setInterval(refresh, 1000);
    timer.unref();
  });
  pi.on('model_select', (_event, ctx) => { if (context) { context = ctx; refresh(); } });
  pi.on('agent_start', (_event, ctx) => { if (context) { context = ctx; refresh(); } });
  pi.on('session_shutdown', stop);
}
