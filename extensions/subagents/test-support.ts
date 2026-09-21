import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import subagents from './index.ts';

// Synthetic catalog; no authentication files or provider requests in fixtures.
export function fixtureModelRegistry() {
  const models = ['test/fixture', 'test/selected', 'test/different', 'openai-codex/gpt-6-astra', 'openai-codex/gpt-5.6-luna'].map(value => {
    const [provider, id] = value.split('/'); return {provider, id, reasoning: true};
  });
  return {
    find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    getAvailable: () => models,
    getApiKeyAndHeaders: async () => ({ok: false, error: 'Fixture tracker unavailable'}),
  };
}

/** Poll a positive condition instead of sleeping for a guessed duration. */
export async function until<T>(probe: () => T | Promise<T>, what: string, budget = 4000): Promise<NonNullable<T>> {
  const end = Date.now() + budget;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export interface Host {
  cwd: string;
  agentDir: string;
  ctx: any;
  tools: Map<string, any>;
  hooks: Map<string, any>;
  commands: Map<string, any>;
  /** One entry per pi.sendMessage: the raw message, its parsed content and the delivery options. */
  notifications: {type: string; task: any; message: any; options: any}[];
  activity: {id: string; active: boolean}[];
  widgets: Map<string, string[]>;
  statuses: Map<string, string>;
  uiNotices: string[];
  execute(name: string, args?: any, signal?: AbortSignal): Promise<any>;
  start(event?: any): Promise<void>;
  shutdown(event?: any): Promise<void>;
}

export interface HostOptions {
  /** mkdtemp prefix; the temporary directory is the workspace and the PATH head. */
  prefix: string;
  /** Body of the fake `pi` executable placed on PATH, after its node shebang. */
  pi?: string;
  /** Builtins the parent still holds, as a list or a getter a test can change. */
  tools?: string[] | (() => string[]);
  /** Fields layered over the default ExtensionContext double. */
  ctx?: Record<string, unknown>;
  /** session_start event, or false to leave the extension unstarted. */
  start?: false | Record<string, unknown>;
  /** Runs with the workspace and PATH in place, before session_start. */
  before?: (host: Host) => Promise<void>;
}

/**
 * Register the subagents extension against a disposable workspace: a fake `pi`
 * on PATH, a private agent directory, and recording doubles for every host
 * surface the extension writes to. Callers supply only the fake-pi script.
 */
export async function withHost(options: HostOptions, run: (host: Host) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), options.prefix));
  const agentDir = join(cwd, 'agent');
  const priorPath = process.env.PATH, priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tools = new Map<string, any>(), hooks = new Map<string, any>(), commands = new Map<string, any>();
  const notifications: Host['notifications'] = [], activity: Host['activity'] = [], uiNotices: string[] = [];
  const widgets = new Map<string, string[]>(), statuses = new Map<string, string>();
  const active = options.tools ?? ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
  const ctx: any = {
    modelRegistry: fixtureModelRegistry(), cwd, model: {provider: 'test', id: 'fixture'}, thinkingLevel: 'off',
    hasUI: true, sessionManager: {getSessionId: () => cwd},
    ui: {
      notify: (text: string) => uiNotices.push(text),
      setStatus: (key: string, value?: string) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      setWidget: (key: string, value?: string[]) => { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
      editor: async (_title: string, source: string) => source,
      confirm: async () => true,
    },
    ...options.ctx,
  };
  try {
    await mkdir(agentDir, {recursive: true});
    if (options.pi !== undefined) {
      await writeFile(join(cwd, 'pi'), `#!${process.execPath}\n${options.pi}`);
      await chmod(join(cwd, 'pi'), 0o700);
    }
    process.env.PATH = `${cwd}:${priorPath ?? ''}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    subagents({
      getActiveTools: typeof active === 'function' ? active : () => active,
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, hook: any) => hooks.set(name, hook),
      sendMessage: (message: any, deliveryOptions: any) => notifications.push({type: message.customType, task: JSON.parse(message.content), message, options: deliveryOptions}),
      events: {emit: (name: string, value: any) => { if (name === 'pi-interactive:background-activity') activity.push(value); }},
    } as any);
    const host: Host = {
      cwd, agentDir, ctx, tools, hooks, commands, notifications, activity, widgets, statuses, uiNotices,
      execute: (name, args = {}, signal) => tools.get(name).execute(name, args, signal, undefined, ctx),
      start: (event = {}) => hooks.get('session_start')(event, ctx),
      shutdown: (event = {}) => hooks.get('session_shutdown')(event, ctx),
    };
    await options.before?.(host);
    if (options.start !== false) await host.start(options.start ?? {});
    await run(host);
  } finally {
    await hooks.get('session_shutdown')?.();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
}
