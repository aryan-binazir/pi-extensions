import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { abortable } from './cancellation.ts';
import { fileURLToPath } from 'node:url';

export interface TaskSpec {
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  preset?: 'reader' | 'writer';
  extensions?: string[];
  timeout?: number;
}
export interface TaskResult {
  id: string;
  owner: 'parent' | 'workflow';
  model?: string;
  thinking?: string;
  task: string;
  cwd: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'stalled' | 'incomplete' | 'expired-in-queue';
  output: string;
  stderr: string;
  droppedRecords: number;
  usageIncomplete?: boolean;
  usage: {
    input: number; output: number;
    cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number;
    reasoning?: number; totalTokens?: number;
    cost?: {input: number; output: number; cacheRead: number; cacheWrite: number; total: number};
  };
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
  deadlineAt: number;
  process?: ChildProcess;
  supervised?: boolean;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  groupKilled?: boolean;
  writer: boolean;
  finished: boolean;
  detachSignal?: () => void;
}
export interface RegistryOptions {
  concurrency?: number;
  allowedTools?: () => string[];
  invocation?: (spec: ValidTask) => { command: string; args: string[]; env?: NodeJS.ProcessEnv; supervised?: boolean };
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
  // Fast aliases belong to the parent's extension; discovery-free children use
  // the real base model, preserving any explicit thinking suffix.
  const model = typeof spec.model === 'string' ? spec.model.replace(/^(openai(?:-codex)?\/.+)~fast(?=:(?:off|minimal|low|medium|high|xhigh|max)$|$)/, '$1') : spec.model;
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(model))) throw new Error('Model must be provider/model');
  if (spec.thinking !== undefined && !/^(off|minimal|low|medium|high|xhigh|max)$/.test(spec.thinking)) throw new Error('Invalid thinking level');
  if (spec.preset !== undefined && !['reader', 'writer'].includes(spec.preset)) throw new Error('Unknown preset');
  const tools = spec.tools ?? (spec.preset === 'reader' ? READ_TOOLS : ALL_TOOLS).filter(tool => !allowedTools || allowedTools.includes(tool));
  if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !ALL_TOOLS.includes(tool)) || new Set(tools).size !== tools.length) throw new Error('Invalid builtin tool selection');
  if (allowedTools && tools.some(tool => !allowedTools.includes(tool))) throw new Error('Explicit child tools exceed parent permissions');
  if (spec.preset === 'reader' && tools.some(tool => !READ_TOOLS.includes(tool))) throw new Error('Reader preset cannot grant write tools');
  const timeout = spec.timeout ?? 3600000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 3600000) throw new Error('Timeout must be 10–3600000 milliseconds');
  if (spec.extensions !== undefined && (!Array.isArray(spec.extensions) || spec.extensions.length > 16)) throw new Error('Invalid extensions');
  const extensions: string[] = [];
  for (const path of spec.extensions ?? []) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Extension paths must be absolute');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error('Extension must be a file');
    extensions.push(canonical);
  }
  return { ...spec, model, cwd, tools: [...tools], extensions, timeout };
}

/** Separate context windows, not an OS sandbox. All children share host permissions. */
export class SubagentRegistry {
  private entries = new Map<string, Entry>();
  private running = 0;
  private writers = new Set<string>();
  private closed = false;
  private lifecycle = new AbortController();
  private admissions = new AbortController();
  private readonly limit: number;
  constructor(private options: RegistryOptions = {}) {
    this.limit = options.concurrency ?? 4;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 16) throw new Error('Concurrency must be 1–16');
  }
  async spawn(spec: TaskSpec, signal?: AbortSignal, owner: TaskResult['owner'] = 'parent'): Promise<TaskHandle> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Registry is shut down');
    const timeout = Number.isInteger(spec?.timeout) && spec.timeout! >= 10 && spec.timeout! <= 3600000 ? spec.timeout! : 3600000;
    const deadlineAt = Date.now() + timeout;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Task admission deadline exceeded')), timeout);
    const admissionSignal = AbortSignal.any([this.lifecycle.signal, this.admissions.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let validated: ValidTask;
    try {
      validated = await abortable(validateTask(spec, this.options.allowedTools?.()), admissionSignal);
      admissionSignal.throwIfAborted();
      await abortable(this.options.authorize?.(validated), admissionSignal);
      if (Date.now() >= deadlineAt) throw new Error('Task admission deadline exceeded');
    } finally { clearTimeout(timer); }
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Registry is shut down');
    if ([...this.entries.values()].filter(entry => !entry.finished).length >= 1000) throw new Error('Outstanding task capacity reached; wait for queued work');
    let resolve!: Entry['resolve'];
    const done = new Promise<TaskResult>(r => { resolve = r; });
    const id = randomUUID();
    const entry: Entry = {
      spec: validated, result: { id, owner, model: validated.model, thinking: validated.thinking, task: validated.task, cwd: validated.cwd, status: 'queued', output: '', stderr: '', droppedRecords: 0, usage: {input: 0, output: 0} },
      resolve, done, deadlineAt, writer: validated.extensions.length > 0 || validated.tools.some(tool => !READ_TOOLS.includes(tool)), finished: false,
    };
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => this.cancel(id, true), Math.max(0, deadlineAt - Date.now()));
    if (signal) {
      const abort = () => this.cancel(id);
      signal.addEventListener('abort', abort, {once: true});
      entry.detachSignal = () => signal.removeEventListener('abort', abort);
    }
    this.pump();
    return { id, done };
  }
  list(offset = 0, limit = this.entries.size): TaskResult[] { return [...this.entries.values()].slice(offset, offset + limit).map(e => structuredClone(e.result)); }
  get(id: string): TaskResult | undefined { const entry = this.entries.get(id); return entry && structuredClone(entry.result); }
  notificationFailed(ids: string[], error: unknown): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) entry.result.notificationError = `Completion notification failed: ${String(error).slice(0, 1000)}`;
    }
  }
  cancel(id: string, timeout = false): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.finished || !['queued', 'running'].includes(entry.result.status)) return false;
    clearTimeout(entry.timer);
    entry.result.status = timeout ? (entry.result.status === 'queued' ? 'expired-in-queue' : 'timed-out') : 'cancelled';
    if (!entry.process) this.finish(entry);
    else {
      // The adapter broadcasts SIGTERM once on owner-pipe EOF. Broadcasting
      // here as well would deliver two signals to Pi and its descendants.
      if (entry.supervised) entry.process.stdio[3]?.destroy();
      else this.signal(entry, 'SIGTERM');
      entry.killTimer ??= setTimeout(() => this.signal(entry, 'SIGKILL'), 2500);
    }
    return true;
  }
  wait(id: string): Promise<TaskResult> | undefined { return this.entries.get(id)?.done; }
  async cancelAll(): Promise<number> {
    this.admissions.abort(new Error('All tasks cancelled'));
    this.admissions = new AbortController();
    const entries = [...this.entries.values()].filter(entry => !entry.finished);
    let count = 0;
    for (const entry of entries) if (this.cancel(entry.result.id)) count++;
    await Promise.all(entries.map(entry => entry.done));
    return count;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.lifecycle.abort(new Error('Registry is shut down'));
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
    if (Date.now() >= entry.deadlineAt) { this.cancel(entry.result.id, true); return; }
    this.running++;
    if (entry.writer) this.writers.add(entry.spec.cwd);
    entry.result.status = 'running';
    let pending = '';
    let pendingBytes = 0;
    let skipping = false;
    let sawError = false;
    let assistantError: string | undefined;
    let lastStopReason: string | undefined;
    let failedCall = '';
    let consecutiveFailures = 0;
    const toolCalls = new Map<string, string>();
    let lastUpdateAt = 0;
    const consume = (line: string) => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && event.toolCallId.length <= 256) {
          toolCalls.delete(event.toolCallId);
          if (event.args !== undefined) {
            // Retain only bounded fingerprints, never the potentially large arguments.
            toolCalls.set(event.toolCallId, createHash('sha256').update(JSON.stringify([event.toolName, event.args])).digest('hex'));
            if (toolCalls.size > 1024) toolCalls.delete(toolCalls.keys().next().value!);
          }
        }
        if (event.type === 'tool_execution_end') {
          const fingerprint = event.isError === true ? toolCalls.get(event.toolCallId) ?? '' : '';
          toolCalls.delete(event.toolCallId);
          consecutiveFailures = fingerprint ? (fingerprint === failedCall ? consecutiveFailures + 1 : 1) : 0;
          failedCall = fingerprint;
          if (consecutiveFailures >= 4 && this.cancel(entry.result.id)) {
            entry.result.status = 'stalled';
            entry.result.error = `Stopped after 4 identical consecutive failed tool calls: ${String(event.toolName).slice(0, 100)}`;
          }
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          entry.result.output = (entry.result.output + String(event.assistantMessageEvent.delta)).slice(-CAP);
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const message = event.message;
          lastStopReason = message.stopReason;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning', 'totalTokens'] as const) {
            const value = message.usage?.[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
              entry.result.usage[key] = (entry.result.usage[key] ?? 0) + value;
          }
          if (message.usage?.cost && typeof message.usage.cost === 'object') {
            const cost = entry.result.usage.cost ??= {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0};
            for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
              const value = message.usage.cost[key];
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) cost[key] += value;
            }
          }
          const finalText = (message.content ?? []).filter((c: {type: string; text?: string}) => c.type === 'text' && c.text).map((c: {text: string}) => c.text).join('\n').slice(-CAP);
          if (finalText) entry.result.output = finalText;
          assistantError = message.stopReason === 'error' || message.stopReason === 'aborted'
            ? String(message.errorMessage ?? message.stopReason).slice(0, CAP) : undefined;
        }
        if (this.options.onUpdate && ['message_update', 'message_end'].includes(event.type) && Date.now() - lastUpdateAt >= 100) {
          lastUpdateAt = Date.now();
          this.options.onUpdate(structuredClone(entry.result));
        }
      } catch { /* Non-JSON diagnostic output is retained separately by stderr. */ }
    };
    try {
      const allowed = this.options.allowedTools?.();
      if (allowed && entry.spec.tools.some(tool => !allowed.includes(tool))) throw new Error('Child tools exceed current parent permissions at launch');
      const invocation = this.options.invocation?.(entry.spec) ?? piInvocation(entry.spec);
      entry.supervised = invocation.supervised;
      entry.process = spawn(invocation.command, invocation.args, {cwd: entry.spec.cwd, env: {...(invocation.env ?? process.env), PI_SUBAGENT_TIMEOUT_MS: String(Math.max(10, entry.deadlineAt - Date.now()))}, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']});
      entry.process.stdout?.setEncoding('utf8');
      entry.process.stderr?.setEncoding('utf8');
      entry.process.stdout?.on('data', chunk => {
        const text = String(chunk);
        let offset = 0;
        while (offset < text.length) {
          const end = text.indexOf('\n', offset);
          const segment = text.slice(offset, end < 0 ? text.length : end);
          if (!skipping) {
            const bytes = Buffer.byteLength(segment, 'utf8');
            if (pendingBytes + bytes > CAP * 4) {
              const prefix = (pending + segment.slice(0, 4096)).slice(0, 4096);
              const kind = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1];
              const nonAssistantMessage = kind === 'message_end' && /"message"\s*:\s*\{\s*"role"\s*:\s*"(?:toolResult|user)"/.test(prefix);
              if (!nonAssistantMessage && (!kind || !['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'message_update', 'agent_end', 'turn_end', 'entry_appended', 'message_start', 'compaction_end'].includes(kind))) {
                lastStopReason = undefined;
                assistantError = undefined;
                entry.result.usageIncomplete = true;
              }
              skipping = true;
              entry.result.droppedRecords++;
              pending = '';
              failedCall = ''; consecutiveFailures = 0; toolCalls.clear();
            } else { pending += segment; pendingBytes += bytes; }
          }
          if (end < 0) break;
          if (!skipping) consume(pending);
          pending = ''; pendingBytes = 0; skipping = false;
          offset = end + 1;
        }
      });
      let control = '';
      entry.process.stdio[4]?.on('data', chunk => { control = (control + String(chunk)).slice(0, 16); });
      entry.process.stderr?.on('data', chunk => { entry.result.stderr = (entry.result.stderr + String(chunk)).slice(-CAP); });
      entry.process.on('error', error => { entry.result.error = error.message; sawError = true; });
      entry.process.on('close', (exitCode, signal) => {
        const reported = /^\d{1,3}\n$/.test(control) && Number(control) <= 255 ? Number(control) : undefined;
        const code = invocation.supervised && signal === 'SIGKILL' && reported !== undefined ? reported : exitCode;
        if (pending) consume(pending);
        if (assistantError && !entry.result.error) entry.result.error = assistantError;
        if (entry.result.status === 'running') {
          entry.result.status = code !== 0 || sawError || assistantError ? 'failed' : lastStopReason === 'stop' ? 'succeeded' : 'incomplete';
          if (entry.result.status === 'incomplete') entry.result.error = `Child did not produce a complete assistant result (${lastStopReason ?? 'missing terminal outcome'})`;
          if (entry.result.status === 'failed' && !entry.result.error) entry.result.error = `Child exited with code ${code}`;
        }
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
    entry.detachSignal?.();
    clearTimeout(entry.timer); clearTimeout(entry.killTimer);
    // Queued cancellation does not hold a process slot.
    if (entry.process || entry.result.status === 'failed') { this.running--; if (entry.writer) this.writers.delete(entry.spec.cwd); }
    const snapshot = structuredClone(entry.result);
    try { this.options.onComplete?.(snapshot); } catch (error) { entry.result.notificationError = `Completion notification failed: ${String(error).slice(0,1000)}`; }
    finally {
      entry.resolve(structuredClone(entry.result));
      const finished = [...this.entries.values()].filter(item => item.finished);
      for (const old of finished.slice(0, Math.max(0, finished.length - 50))) this.entries.delete(old.result.id);
      this.pump();
    }
  }
}

export function piInvocation(spec: ValidTask, extra?: {env: Record<string, string>; extensions: string[]}) {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', spec.tools.join(','), '--system-prompt', 'You are a delegated agent. Your only task context is the explicit brief below. Use only the configured tools and assigned workspace. Do not assume parent conversation context.'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.thinking) args.push('--thinking', spec.thinking);
  // The inherited guard runs last, after any user-approved argument-transforming hooks.
  for (const extension of [...new Set([...spec.extensions.filter(path => !extra?.extensions.includes(path)), ...(extra?.extensions ?? [])])]) args.push('-e', extension);
  args.push('--', spec.task);
  return {
    command: 'node',
    supervised: true,
    args: [fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url)), 'pi', ...args],
    env: {...process.env, ...extra?.env, PI_SUBAGENT_TIMEOUT_MS: String(spec.timeout)},
  };
}
