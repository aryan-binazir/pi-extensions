import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { disable, enable, install, restoreAfterPrompt } from './adapter.ts';

export default function escapeContinue(pi: ExtensionAPI): void {
  install();
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') enable(ctx);
  });
  pi.on('context', (_event, ctx) => restoreAfterPrompt(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui') disable(ctx);
  });
}
