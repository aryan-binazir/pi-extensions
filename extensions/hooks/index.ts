import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { catalog } from './catalog/index.ts';
import { createSwitchesReader, loadSwitches } from './config.ts';
import { createProtection } from './protection.ts';
import type { AdviseHook, Awaitable, BlockHook, GateHook, Hook, ToolCall } from './types.ts';

export interface HooksOptions {
  catalog: readonly Hook[];
  configPath: string;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const label = (id: string, text: string) => `[hooks: ${id}] ${text}`;
const usableWhileSwitchesAreBroken = new Set(['read', 'grep', 'find', 'ls', 'questionnaire']);
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
  const readConfig = createSwitchesReader(configPath);
  const protect = createProtection(configPath, known);
  let reportedUnloaded = '';
  const switchedOn = async <T extends Hook>(type: T['type'], ctx: ExtensionContext, read = readConfig): Promise<T[]> => {
    const { enabled, unloaded } = await loadSwitches(configPath, known, read);
    const names = unloaded.join(', ');
    if (names && names !== reportedUnloaded && ctx.hasUI) ctx.ui.notify(`hooks.yaml switches on hooks this session has not loaded: ${names}. Run /reload to load them.`, 'warning');
    reportedUnloaded = names;
    return catalog.filter((hook): hook is T => hook.type === type && enabled.has(hook.id));
  };
  const toolCall = (event: { toolName: string; input: unknown }, ctx: ExtensionContext): ToolCall =>
    ({ toolName: event.toolName, input: event.input as Record<string, unknown>, cwd: ctx.cwd });

  return function hooks(pi: ExtensionAPI) {
    pi.on('tool_call', async (event, ctx) => {
      let snapshot: ReturnType<typeof readConfig> | undefined;
      const read = () => snapshot ??= readConfig();
      const call = toolCall(event, ctx);
      const { said: unprotected, failed: protectionFailed } = await ask(() => protect(call, read));
      if (protectionFailed !== undefined) return { block: true, reason: label('protection', `The check failed, so the call was blocked: ${protectionFailed}`) };
      if (unprotected) return { block: true, reason: label('protection', unprotected) };
      let blockers: BlockHook[];
      try {
        blockers = await switchedOn<BlockHook>('block', ctx, read);
      } catch (error) {
        if (usableWhileSwitchesAreBroken.has(event.toolName)) return;
        return { block: true, reason: `[hooks] ${configPath} is invalid: ${message(error)}. Ask the user to fix it; agents cannot edit it.` };
      }
      for (const hook of blockers) {
        const { said, failed } = await ask(() => hook.check(call));
        const reason = failed === undefined ? said : `The hook failed, so the call was blocked: ${failed}`;
        if (reason) return { block: true, reason: label(hook.id, reason) };
      }
    });

    pi.on('tool_result', async (event, ctx) => {
      const advisers = await switchedOn<AdviseHook>('advise', ctx).catch(() => []);
      const call = toolCall(event, ctx);
      const notes = [];
      for (const hook of advisers) {
        const { said } = await ask(() => hook.check(call));
        if (said) notes.push({ type: 'text' as const, text: label(hook.id, said) });
      }
      if (!notes.length) return;
      return { content: [...event.content, ...notes], ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
    });

    if (!catalog.some(hook => hook.type === 'gate')) return;
    let continuationsThisPrompt = 0;
    pi.on('session_start', () => { continuationsThisPrompt = 0; });
    pi.on('input', event => { if (event.source !== 'extension') continuationsThisPrompt = 0; });
    pi.on('agent_before_settle', async (event, ctx) => {
      if (event.outcome !== 'completed') return;
      const gates = await switchedOn<GateHook>('gate', ctx).catch(() => []);
      const entries = [...event.entries];
      for (const hook of gates) {
        const { said, failed } = await ask(() => hook.check({ cwd: ctx.cwd, signal: ctx.signal }));
        if (failed !== undefined) entries.push(gateMessage(hook.id, `The gate failed and was skipped: ${failed}`));
        if (!said) continue;
        if (continuationsThisPrompt >= maxGateContinuations) {
          return { entries: [...entries, gateMessage(hook.id, `Still not done after ${maxGateContinuations} continuations, so the agent stopped: ${said}`)] };
        }
        continuationsThisPrompt++;
        return { entries: [...entries, gateMessage(hook.id, said)], continue: true };
      }
      if (entries.length > event.entries.length) return { entries };
    });
  };
}

export default createHooks({ catalog, configPath: fileURLToPath(new URL('../../personal-settings/hooks.yaml', import.meta.url)) });
