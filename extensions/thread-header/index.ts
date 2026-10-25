import { stripVTControlCharacters } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';

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

  const install = (ctx: ExtensionContext, name: string | undefined) => {
    if (ctx.mode !== 'tui') return;
    const title = `π · ${sanitizeName(name)}`;
    ctx.ui.setHeader((_tui, theme) => ({
      render: width => [width > 0 ? theme.fg('accent', truncateToWidth(title, width)) : ''],
      invalidate() {},
    }));
    installed = true;
  };

  pi.on('session_start', (_event, ctx) => install(ctx, ctx.sessionManager.getSessionName()));
  pi.on('session_info_changed', (event, ctx) => install(ctx, event.name));
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode !== 'tui' || !installed) return;
    ctx.ui.setHeader(undefined);
    installed = false;
  });
}
