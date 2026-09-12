import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export interface TaskSpec {
  task: string;
  cwd: string;
  model?: string;
  tools?: string[];
  preset?: 'reader' | 'writer';
  extensions?: string[];
  timeout?: number;
}
export interface TaskResult {
  id: string;
  task: string;
  cwd: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  output: string;
  stderr: string;
  usage: { input: number; output: number };
  error?: string;
  notificationError?: string;
}
export interface TaskHandle { id: string; done: Promise<TaskResult> }
interface ValidTask extends TaskSpec { tools: string[]; extensions: string[]; timeout: number }
interface Entry {
  spec: ValidTask;
  result: TaskResult;
  resolve: (result: TaskResult) => void;
  done: Promise<TaskResult>;
  process?: ChildProcess;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  groupKilled?: boolean;
  writer: boolean;
  finished: boolean;
}
export interface RegistryOptions {
  concurrency?: number;
  allowedTools?: () => string[];
  invocation?: (spec: ValidTask) => { command: string; args: string[]; env?: NodeJS.ProcessEnv };
  authorize?: (spec: ValidTask) => Promise<void>;
  onUpdate?: (task: TaskResult) => void;
  onComplete?: (task: TaskResult) => void;
}
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
const ALL_TOOLS = [...READ_TOOLS, 'write', 'edit', 'bash'];
const CAP = 64 * 1024;

export async function validateTask(spec: TaskSpec, allowedTools?: string[]): Promise<ValidTask> {
  if (!spec || typeof spec.task !== 'string' || !spec.task.trim() || spec.task.length > 32000) throw new Error('Task brief must contain 1–32000 characters');
  if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd)) throw new Error('Task cwd must be absolute');
  const cwd = await realpath(spec.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Task cwd must be a directory');
  if (spec.model !== undefined && (typeof spec.model !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(spec.model))) throw new Error('Model must be provider/model');
  if (spec.preset !== undefined && !['reader', 'writer'].includes(spec.preset)) throw new Error('Unknown preset');
  const tools = spec.tools ?? (spec.preset === 'reader' ? READ_TOOLS : ALL_TOOLS).filter(tool => !allowedTools || allowedTools.includes(tool));
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !ALL_TOOLS.includes(tool)) || new Set(tools).size !== tools.length) throw new Error('Invalid builtin tool selection');
  if (allowedTools && tools.some(tool => !allowedTools.includes(tool))) throw new Error('Explicit child tools exceed parent permissions');
  if (spec.preset === 'reader' && tools.some(tool => !READ_TOOLS.includes(tool))) throw new Error('Reader preset cannot grant write tools');
  const timeout = spec.timeout ?? 300000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600000) throw new Error('Timeout must be 10–3600000 milliseconds');
  if (spec.extensions !== undefined && (!Array.isArray(spec.extensions) || spec.extensions.length > 16)) throw new Error('Invalid extensions');
  const extensions: string[] = [];
  for (const path of spec.extensions ?? []) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Extension paths must be absolute');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error('Extension must be a file');
    extensions.push(canonical);
  }
  return { ...spec, cwd, tools: [...tools], extensions, timeout };
}

/** Separate context windows, not an OS sandbox. All children share host permissions. */
export class SubagentRegistry {
  private entries = new Map<string, Entry>();
  private running = 0;
  private writers = new Set<string>();
  private closed = false;
  private readonly limit: number;
  constructor(private options: RegistryOptions = {}) {
    this.limit = options.concurrency ?? 4;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 16) throw new Error('Concurrency must be 1–16');
  }
  async spawn(spec: TaskSpec): Promise<TaskHandle> {
    if (this.closed) throw new Error('Registry is shut down');
    const validated = await validateTask(spec, this.options.allowedTools?.());
    await this.options.authorize?.(validated);
    if (this.closed) throw new Error('Registry is shut down');
    if (this.entries.size >= 1000) throw new Error('Session task limit reached');
    let resolve!: Entry['resolve'];
    const done = new Promise<TaskResult>(r => { resolve = r; });
    const id = randomUUID();
    const entry: Entry = {
      spec: validated, result: { id, task: validated.task, cwd: validated.cwd, status: 'queued', output: '', stderr: '', usage: {input: 0, output: 0} },
      resolve, done, writer: validated.extensions.length > 0 || validated.tools.some(tool => !READ_TOOLS.includes(tool)), finished: false,
    };
    this.entries.set(id, entry);
    this.pump();
    return { id, done };
  }
  list(): TaskResult[] { return [...this.entries.values()].map(e => structuredClone(e.result)); }
  cancel(id: string, timeout = false): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.finished) return false;
    entry.result.status = timeout ? 'timed-out' : 'cancelled';
    if (!entry.process) this.finish(entry);
    else {
      this.signal(entry, 'SIGTERM');
      entry.killTimer ??= setTimeout(() => this.signal(entry, 'SIGKILL'), 200);
    }
    return true;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) this.cancel(entry.result.id);
    await Promise.all([...this.entries.values()].map(e => e.done));
  }
  private signal(entry: Entry, signal: NodeJS.Signals) {
    if (!entry.process?.pid || entry.groupKilled) return;
    // A SIGKILL attempt is final: the pid and process group may be recycled afterwards.
    if (signal === 'SIGKILL') entry.groupKilled = true;
    try { process.kill(-entry.process.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') entry.process.kill(signal); }
  }
  private pump() {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      if (this.running >= this.limit) break;
      if (entry.result.status !== 'queued' || (entry.writer && this.writers.has(entry.spec.cwd))) continue;
      this.start(entry);
    }
  }
  private start(entry: Entry) {
    this.running++;
    if (entry.writer) this.writers.add(entry.spec.cwd);
    entry.result.status = 'running';
    let pending = '';
    let sawError = false;
    const consume = (line: string) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          entry.result.output = (entry.result.output + String(event.assistantMessageEvent.delta)).slice(-CAP);
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const message = event.message;
          entry.result.usage.input += Number(message.usage?.input) || 0;
          entry.result.usage.output += Number(message.usage?.output) || 0;
          if (!entry.result.output) entry.result.output = (message.content ?? []).filter((c: {type: string}) => c.type === 'text').map((c: {text: string}) => c.text).join('\n').slice(-CAP);
          if (message.stopReason === 'error' || message.stopReason === 'aborted') { sawError = true; entry.result.error = String(message.errorMessage ?? message.stopReason).slice(0, CAP); }
        }
        this.options.onUpdate?.(structuredClone(entry.result));
      } catch { /* Non-JSON diagnostic output is retained separately by stderr. */ }
    };
    try {
      const invocation = this.options.invocation?.(entry.spec) ?? piInvocation(entry.spec);
      entry.process = spawn(invocation.command, invocation.args, {cwd: entry.spec.cwd, env: invocation.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      entry.timer = setTimeout(() => this.cancel(entry.result.id, true), entry.spec.timeout);
      entry.process.stdout?.setEncoding('utf8');
      entry.process.stderr?.setEncoding('utf8');
      entry.process.stdout?.on('data', chunk => {
        pending += String(chunk);
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
        if (pending.length > CAP * 4) { entry.result.error = 'Child output record exceeds limit'; sawError = true; this.signal(entry, 'SIGKILL'); pending = ''; }
      });
      entry.process.stderr?.on('data', chunk => { entry.result.stderr = (entry.result.stderr + String(chunk)).slice(-CAP); });
      entry.process.on('error', error => { entry.result.error = error.message; sawError = true; });
      entry.process.on('close', code => {
        if (pending) consume(pending);
        if (entry.result.status === 'running') entry.result.status = code === 0 && !sawError ? 'succeeded' : 'failed';
        this.finish(entry);
      });
      // Reap descendants even when they inherited pipes from an exited parent.
      entry.process.on('exit', () => {
        this.signal(entry, 'SIGKILL');
        clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      });
    } catch (error) {
      entry.result.status = 'failed'; entry.result.error = String(error); this.finish(entry);
    }
  }
  private finish(entry: Entry) {
    if (entry.finished) return;
    entry.finished = true;
    clearTimeout(entry.timer); clearTimeout(entry.killTimer);
    // Queued cancellation does not hold a process slot.
    if (entry.process || entry.result.status === 'failed') { this.running--; if (entry.writer) this.writers.delete(entry.spec.cwd); }
    const snapshot = structuredClone(entry.result);
    try { this.options.onComplete?.(snapshot); } catch (error) { entry.result.notificationError = `Completion notification failed: ${String(error).slice(0,1000)}`; }
    finally { entry.resolve(structuredClone(entry.result)); this.pump(); }
  }
}

export function piInvocation(spec: ValidTask, extra?: {env: Record<string, string>; extensions: string[]}) {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', spec.tools.join(','), '--system-prompt', 'You are a delegated agent. Your only task context is the explicit brief below. Use only the configured tools and assigned workspace. Do not assume parent conversation context.'];
  if (spec.model) args.push('--model', spec.model);
  // The inherited guard runs last, after any user-approved argument-transforming hooks.
  for (const extension of [...new Set([...spec.extensions.filter(path => !extra?.extensions.includes(path)), ...(extra?.extensions ?? [])])]) args.push('-e', extension);
  args.push('--', spec.task);
  return {command: 'pi', args, env: {...process.env, ...extra?.env}};
}
