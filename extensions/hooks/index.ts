import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getActiveCwd } from '../worktree/routing.ts';
import { loadEnabled } from './config.ts';
import type { AdviseHook, Awaitable, BlockHook, GateHook, Hook, ToolCall } from './types.ts';

export interface HooksOptions {
  catalog: readonly Hook[];
  configPath: string;
}

const activeCwd = (ctx: ExtensionContext) => getActiveCwd(ctx.cwd, ctx.sessionManager.getSessionId());
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const label = (id: string, text: string) => `[hooks: ${id}] ${text}`;
// Diagnosis and asking the user stay possible while the switches are broken.
const recoveryTools = new Set(['read', 'grep', 'find', 'ls', 'questionnaire']);
const maxGateContinuations = 3;
const gateMessage = (id: string, text: string) => ({ type: 'custom_message' as const, customType: 'hooks', content: label(id, text), display: true });

async function ask(check: () => Awaitable<string | undefined>): Promise<{ said?: string; failed?: string }> {
  try {
    return { said: await check() };
  } catch (error) {
    return { failed: message(error) };
  }
}

export function createHooks({ catalog, configPath }: HooksOptions) {
  const known = new Set(catalog.map(hook => hook.id));
  const switchedOn = async <T extends Hook>(type: T['type']): Promise<T[]> => {
    const enabled = await loadEnabled(configPath, known);
    return catalog.filter((hook): hook is T => hook.type === type && enabled.has(hook.id));
  };
  const toolCall = (event: { toolName: string; input: unknown }, ctx: ExtensionContext): ToolCall =>
    ({ toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: activeCwd(ctx) });

  return function hooks(pi: ExtensionAPI) {
    pi.on('tool_call', async (event, ctx) => {
      let blockers: BlockHook[];
      try {
        blockers = await switchedOn<BlockHook>('block');
      } catch (error) {
        if (recoveryTools.has(event.toolName)) return;
        return { block: true, reason: `[hooks] ${configPath} is invalid: ${message(error)}. Ask the user to fix it; agents cannot edit it.` };
      }
      const call = toolCall(event, ctx);
      for (const hook of blockers) {
        const { said, failed } = await ask(() => hook.check(call));
        const reason = failed === undefined ? said : `The hook failed, so the call was blocked: ${failed}`;
        if (reason) return { block: true, reason: label(hook.id, reason) };
      }
    });

    pi.on('tool_result', async (event, ctx) => {
      const advisers = await switchedOn<AdviseHook>('advise').catch(() => []);
      const call = toolCall(event, ctx);
      const notes = [];
      for (const hook of advisers) {
        const { said } = await ask(() => hook.check(call));
        if (said) notes.push({ type: 'text' as const, text: label(hook.id, said) });
      }
      if (!notes.length) return;
      return { content: [...event.content, ...notes], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
    });

    // Continuations are capped per human prompt; extension-sent input must not reset the cap.
    let continuations = 0;
    pi.on('session_start', () => { continuations = 0; });
    pi.on('input', event => { if (event.source !== 'extension') continuations = 0; });
    pi.on('agent_before_settle', async (event, ctx) => {
      if (event.outcome !== 'completed') return;
      const gates = await switchedOn<GateHook>('gate').catch(() => []);
      for (const hook of gates) {
        const { said, failed } = await ask(() => hook.check({ cwd: activeCwd(ctx), signal: ctx.signal }));
        if (failed !== undefined) return { entries: [...event.entries, gateMessage(hook.id, `The gate failed and was skipped: ${failed}`)] };
        if (!said) continue;
        if (continuations >= maxGateContinuations) {
          return { entries: [...event.entries, gateMessage(hook.id, `Still not done after ${maxGateContinuations} continuations, so the agent stopped: ${said}`)] };
        }
        continuations++;
        return { entries: [...event.entries, gateMessage(hook.id, said)], continue: true };
      }
    });
  };
}
