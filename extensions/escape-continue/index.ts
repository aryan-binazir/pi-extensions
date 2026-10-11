import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { disable, enable, install, restoreQueuesAtContext } from './adapter.ts';

export default function escapeContinue(pi: ExtensionAPI): void {
  const adapter = install();
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') enable(ctx, adapter);
  });
  pi.on('context', (_event, ctx) => restoreQueuesAtContext(ctx, adapter));
  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.mode === 'tui') disable(ctx, adapter);
  });
}
