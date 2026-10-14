import type { TestContext } from 'node:test';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { install } from './adapter.ts';

export const versions = ['0.87 boolean preflight', '0.99 baseline', '0.99 missing idle getter', '1.2 early streaming'] as const;

export function versionSession(t: TestContext, session: AgentSession, version: typeof versions[number]): void {
  if (version === '0.87 boolean preflight') {
    const prompt = session.prompt.bind(session);
    session.prompt = (text, options) => {
      const observe = options?.preflightResult as unknown as ((success: boolean) => void) | undefined;
      return prompt(text, { ...options, preflightResult: () => observe?.(true) });
    };
  } else if (version === '0.99 missing idle getter') {
    const state = install(), abort = state.rawAborts.get(session)!;
    const prompt = session.prompt.bind(session);
    session.prompt = (text, options) => {
      delete (session as unknown as { isIdle?: boolean }).isIdle;
      return prompt(text, options);
    };
    state.rawAborts.set(session, async () => {
      await abort();
      Object.defineProperty(session, 'isIdle', { value: undefined, configurable: true });
      setImmediate(() => { delete (session as unknown as { isIdle?: boolean }).isIdle; });
    });
    t.after(() => { delete (session as unknown as { isIdle?: boolean }).isIdle; });
  } else if (version === '1.2 early streaming') {
    const preparation = session as unknown as {
      _isAgentRunActive: boolean;
      _normalizePromptImages(images: unknown): Promise<unknown>;
    };
    const normalize = preparation._normalizePromptImages;
    preparation._normalizePromptImages = async images => {
      const active = preparation._isAgentRunActive;
      preparation._isAgentRunActive = true;
      try { return await normalize.call(session, images); }
      finally { preparation._isAgentRunActive = active; }
    };
  }
}
