import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHooks } from './index.ts';
import type { Hook } from './types.ts';

export interface Harness {
  dir: string;
  configure(yaml: string): Promise<void>;
  emit(event: string, payload: Record<string, unknown>): Promise<any>;
  call(toolName: string, input: Record<string, unknown>, toolCallId?: string): Promise<any>;
  notices: string[];
}

export async function withHooks(catalog: Hook[], yaml: string | undefined, body: (harness: Harness) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-hooks-'));
  const configPath = join(dir, 'hooks.yaml');
  const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
  const notices: string[] = [];
  const ctx = { cwd: dir, hasUI: true, ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getSessionId: () => 'test-session' } };
  try {
    if (yaml !== undefined) await writeFile(configPath, yaml);
    createHooks({ catalog, configPath })({ on: (name: string, handler: any) => { (handlers[name] ??= []).push(handler); } } as any);
    const emit = async (event: string, payload: Record<string, unknown>) => {
      let result;
      for (const handler of handlers[event] ?? []) result = await handler({ type: event, ...payload }, ctx);
      return result;
    };
    await body({
      dir,
      configure: text => writeFile(configPath, text),
      emit,
      call: (toolName, input, toolCallId = 'call') => emit('tool_call', { toolName, toolCallId, input }),
      notices,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
