import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

export function sanitizeName(name: string | undefined): string {
  const plain = (name ?? '')
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, '')
    .replace(/(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu, '');
  return stripVTControlCharacters(plain)
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim() || 'Unnamed thread';
}

export default function threadHeader(pi: ExtensionAPI): void {
  let installed = false;
  let enabled = true;
  let title = '';
  let requestRender: (() => void) | undefined;

  const install = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui' || !enabled) return;
    title = `π · ${sanitizeName(ctx.sessionManager.getSessionName())}`;
    ctx.ui.setHeader(tui => {
      const overlay = tui.showOverlay({
        render(width) {
          const text = width > 0 ? truncateToWidth(title, width) : '';
          return [ctx.ui.theme.fg('accent', text) + ' '.repeat(Math.max(0, width - visibleWidth(text)))];
        },
        invalidate() {},
      }, { row: 0, col: 0, width: '100%', maxHeight: 1, nonCapturing: true });
      requestRender = () => tui.requestRender();
      return {
        render: () => [],
        invalidate() {},
        dispose() { overlay.hide(); requestRender = undefined; },
      };
    });
    installed = true;
  };

  pi.on('session_start', (_event, ctx) => install(ctx));
  pi.on('session_info_changed', (event, ctx) => {
    if (ctx.mode !== 'tui') return;
    title = `π · ${sanitizeName(event.name)}`;
    requestRender?.();
  });
  const remove = (ctx: ExtensionContext) => {
    if (ctx.mode !== 'tui' || !installed) return;
    ctx.ui.setHeader(undefined);
    requestRender = undefined;
    installed = false;
  };
  pi.on('session_shutdown', (_event, ctx) => remove(ctx));
  pi.registerCommand('thread-header', {
    description: 'Show or hide the fixed top line: /thread-header on|off',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') return;
      const action = args.trim().toLowerCase();
      if (action && action !== 'on' && action !== 'off') {
        ctx.ui.notify('Usage: /thread-header [on|off]', 'warning');
        return;
      }
      enabled = action ? action === 'on' : !enabled;
      if (enabled) install(ctx); else remove(ctx);
    },
  });
}
