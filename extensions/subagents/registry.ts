import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { thinkingLevel, thinkingPattern } from './thinking.ts';
import { abortable } from './cancellation.ts';
import { fileURLToPath } from 'node:url';
import { TIMEOUT_BOUNDS, validateTimeout, type SelectionProvenance, type TaskSpec, type ValidTask } from './task.ts';
import type { DelegationAdmission } from './scope.ts';
import type {Duplex} from 'node:stream';
import {attachConnectorBridge, type ConnectorBridge} from './connector-bridge.ts';
import { clipJson, taskView } from './presentation.ts';

export type CancellationCause = 'user' | 'cancel-all' | 'timeout' | 'shutdown' | 'stall' | 'workflow';
export interface TaskResult {
  cancellationCause?: CancellationCause;
  id: string;
  owner: 'parent' | 'workflow';
  profile?: string;
  configProvenance?: SelectionProvenance;
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
interface TaskHandle { id: string; done: Promise<TaskResult> }
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
  sigkillAttempted?: boolean;
  writer: boolean;
  finished: boolean;
  detachSignal?: () => void;
  connectorBridge?: ConnectorBridge;
  connectorController: AbortController;
  closeConnectorBridge?: () => void;
}
interface Activity {
  tasks?: 'changed' | 'completed';
  tracker?: 'update' | 'invalidate' | 'stop';
  background?: {id: string; active: boolean};
}
interface TrackedRun {
  controller: AbortController;
  done: Promise<void>;
}
interface RegistryOptions {
  concurrency?: number;
  admission: Pick<DelegationAdmission, 'queue' | 'launch'>;
  invocation?: (spec: ValidTask) => { command: string; args: string[]; env?: NodeJS.ProcessEnv; supervised?: boolean } | ChildProcess;
  onUpdate?: (task: TaskResult) => void;
  onComplete?: (task: TaskResult) => void;
  activity?: (event: Activity) => void;
  notify?: (content: string, options: {triggerTurn: boolean; deliverAs: 'followUp' | 'nextTurn'}) => void;
}
const CAP = 64 * 1024;
const RETAINED = 50;
const ACTIVE_STATUS = new Set<TaskResult['status']>(['queued', 'running']);
const HOOKS_EXTENSION = fileURLToPath(new URL('../hooks/index.ts', import.meta.url));
const FAST_ALIAS = new RegExp(`^(openai(?:-codex)?\\/.+)~fast(?=:${thinkingPattern}$|$)`);
function withoutFastAlias(model: string): string {
  return model.replace(FAST_ALIAS, '$1');
}


const SUPERVISOR = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url));

/** Overlay variables instead of copying: node's spawn walks the prototype chain,
 * so the child gets the same environment for one pass over intercepted process.env. */
function childEnv(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.assign(Object.create(base) as NodeJS.ProcessEnv, overrides);
}

function cloneResult(result: TaskResult): TaskResult {
  const {usage} = result;
  const snapshot: TaskResult = {
    id: result.id, owner: result.owner, profile: result.profile, configProvenance: result.configProvenance && {...result.configProvenance}, model: result.model, thinking: result.thinking,
    task: result.task, cwd: result.cwd, status: result.status,
    output: result.output, stderr: result.stderr, droppedRecords: result.droppedRecords,
    usage: {...usage},
  };
  if (usage.cost) snapshot.usage.cost = {...usage.cost};
  if (result.usageIncomplete !== undefined) snapshot.usageIncomplete = result.usageIncomplete;
  if (result.error !== undefined) snapshot.error = result.error;
  if (result.cancellationCause !== undefined) snapshot.cancellationCause = result.cancellationCause;
  if (result.notificationError !== undefined) snapshot.notificationError = result.notificationError;
  return snapshot;
}

export async function prepareTask(spec: TaskSpec, selectTools: (task: TaskSpec) => string[], hooksExtension = HOOKS_EXTENSION): Promise<ValidTask> {
  if (!spec || typeof spec.task !== 'string' || !spec.task.trim() || spec.task.length > 32000) throw new Error('Task brief must contain 1–32000 characters');
  if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd)) throw new Error('Task cwd must be absolute');
  const cwd = await realpath(spec.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Task cwd must be a directory');
  const model = typeof spec.model === 'string' ? withoutFastAlias(spec.model) : spec.model;
  if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(model))) throw new Error('Model must be provider/model');
  if (spec.thinking !== undefined && !thinkingLevel.test(spec.thinking)) throw new Error('Invalid thinking level');
  if (spec.preset !== undefined && !['reader', 'writer'].includes(spec.preset)) throw new Error('Unknown preset');
  const tools = selectTools(spec);
  const timeout = validateTimeout(spec.timeout, 'Timeout');
  if (spec.extensions !== undefined && (!Array.isArray(spec.extensions) || spec.extensions.length > 16)) throw new Error('Invalid extensions');
  const extensions: string[] = [];
  for (const path of spec.extensions ?? []) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Extension paths must be absolute');
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error('Extension must be a file');
    extensions.push(canonical);
  }
  let hooks: string;
  try {
    hooks = await realpath(hooksExtension);
    if (!(await stat(hooks)).isFile()) throw new Error('not a file');
  } catch (error) {
    throw new Error(`Subagents do not start without the hooks extension at ${hooksExtension}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...spec, model, cwd, tools: [...tools], extensions: extensions.filter(path => path !== hooks), hooks, timeout };
}

export class SubagentRegistry {
  private entries = new Map<string, Entry>();
  private notices: ReturnType<typeof taskView>[] = [];
  private overflowNotices = 0;
  private noticeTriggersTurn = false;
  private noticeTimer?: NodeJS.Timeout;
  private runs = new Set<TrackedRun>();
  private cancellingAll = false;
  private running = 0;
  private writers = new Set<string>();
  private closed = false;
  private lifecycle = new AbortController();
  private admissions = new AbortController();
  private readonly limit: number;
  constructor(private options: RegistryOptions) {
    this.limit = options.concurrency ?? 8;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 16) throw new Error('Concurrency must be 1–16');
  }
  get isShutdown(): boolean { return this.closed; }
  async spawn(spec: TaskSpec, signal?: AbortSignal, owner: TaskResult['owner'] = 'parent', connectorBridge?: ConnectorBridge): Promise<TaskHandle> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Registry is shut down');
    const timeout = Number.isInteger(spec?.timeout) && spec.timeout! >= TIMEOUT_BOUNDS.minimum && spec.timeout! <= TIMEOUT_BOUNDS.maximum ? spec.timeout! : TIMEOUT_BOUNDS.maximum;
    const deadlineAt = Date.now() + timeout;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Task admission deadline exceeded')), timeout);
    const admissionSignal = AbortSignal.any([this.lifecycle.signal, this.admissions.signal, deadline.signal, ...(signal ? [signal] : [])]);
    let validated: ValidTask;
    let writer: boolean;
    try {
      const admitted = await abortable(this.options.admission.queue(spec, admissionSignal, connectorBridge), admissionSignal);
      validated = admitted.task;
      if (!validated || typeof validated.task !== 'string' || !validated.task.trim() || validated.task.length > 32000) throw new Error('Task brief must contain 1–32000 characters');
      if (typeof validated.cwd !== 'string' || !isAbsolute(validated.cwd)) throw new Error('Task cwd must be absolute');
      validateTimeout(validated.timeout, 'Timeout');
      if (!Array.isArray(validated.extensions) || validated.extensions.length > 16) throw new Error('Invalid extensions');
      if (validated.extensions.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Extension paths must be absolute');
      connectorBridge = admitted.bridge;
      writer = admitted.writer;
      admissionSignal.throwIfAborted();
      if (Date.now() >= deadlineAt) throw new Error('Task admission deadline exceeded');
    } finally { clearTimeout(timer); }
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Registry is shut down');
    let outstanding = 0;
    for (const entry of this.entries.values()) if (!entry.finished) outstanding++;
    if (outstanding >= 1000) throw new Error('Outstanding task capacity reached; wait for queued work');
    let resolve!: Entry['resolve'];
    const done = new Promise<TaskResult>(r => { resolve = r; });
    const id = randomUUID();
    const entry: Entry = {
      spec: validated, result: { id, owner, profile: validated.profile, configProvenance: validated.configProvenance, model: validated.model, thinking: validated.thinking, task: validated.task, cwd: validated.cwd, status: 'queued', output: '', stderr: '', droppedRecords: 0, usage: {input: 0, output: 0} },
      resolve, done, deadlineAt, writer, finished: false,
      connectorBridge, connectorController: new AbortController(),
    };
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => this.cancelEntry(id, 'timeout'), Math.max(0, deadlineAt - Date.now()));
    if (signal) {
      const abort = () => { this.cancelEntry(id, owner === 'workflow' ? 'workflow' : 'user'); this.emitActivity({tracker: 'invalidate'}); };
      signal.addEventListener('abort', abort, {once: true});
      entry.detachSignal = () => signal.removeEventListener('abort', abort);
    }
    this.pump();
    this.emitActivity({tasks: 'changed', tracker: 'update'});
    this.emitActivity({background: {id, active: true}});
    void done.then(task => this.emitActivity({tasks: 'changed', tracker: task.status === 'cancelled' ? 'invalidate' : 'update'}));
    void done.then(() => this.emitActivity({background: {id, active: false}}));
    return { id, done };
  }
  list(offset = 0, limit = this.entries.size): TaskResult[] {
    const page: TaskResult[] = [];
    const end = offset + limit;
    let index = 0;
    for (const entry of this.entries.values()) {
      if (index >= end) break;
      if (index >= offset) page.push(cloneResult(entry.result));
      index++;
    }
    return page;
  }
  activeTasks(): {id: string; status: TaskResult['status']; task: string}[] {
    const active: {id: string; status: TaskResult['status']; task: string}[] = [];
    for (const {result} of this.entries.values())
      if (ACTIVE_STATUS.has(result.status)) active.push({id: result.id, status: result.status, task: result.task});
    return active;
  }
  hasActive(): boolean {
    for (const {result} of this.entries.values()) if (ACTIVE_STATUS.has(result.status)) return true;
    return false;
  }
  get(id: string): TaskResult | undefined { const entry = this.entries.get(id); return entry && cloneResult(entry.result); }
  private notificationFailed(ids: string[], error: unknown): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) entry.result.notificationError = `Completion notification failed: ${String(error).slice(0, 1000)}`;
    }
  }
  async track<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Registry is shut down');
    const controller = new AbortController();
    let settle!: () => void;
    const tracked: TrackedRun = {controller, done: new Promise<void>(resolve => { settle = resolve; })};
    this.runs.add(tracked);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    try { return await run(controller.signal); }
    finally {
      controller.abort();
      this.runs.delete(tracked);
      signal?.removeEventListener('abort', abort);
      settle();
    }
  }
  cancel(id: string): boolean {
    const cancelled = this.cancelEntry(id, 'user');
    if (cancelled) this.observe({tracker: 'invalidate'});
    return cancelled;
  }
  private cancelEntry(id: string, cause: CancellationCause): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.finished || !['queued', 'running'].includes(entry.result.status)) return false;
    clearTimeout(entry.timer);
    entry.result.cancellationCause = this.closed ? 'shutdown' : cause;
    const timeout = cause === 'timeout';
    entry.connectorController.abort();
    entry.closeConnectorBridge?.();
    entry.result.status = timeout ? (entry.result.status === 'queued' ? 'expired-in-queue' : 'timed-out') : 'cancelled';
    if (!entry.process) this.finish(entry);
    else {
      const ownerPipe = entry.process.stdio[3];
      if (entry.supervised) ownerPipe?.destroy();
      else this.signal(entry, 'SIGTERM');
      entry.killTimer ??= setTimeout(() => this.signal(entry, 'SIGKILL'), 2500);
    }
    return true;
  }
  wait(id: string): Promise<TaskResult> | undefined { return this.entries.get(id)?.done; }
  async cancelAll(): Promise<{cancelled: boolean; count: number}> {
    this.cancellingAll = true;
    this.observe({tracker: 'stop'});
    const runs = [...this.runs];
    const activeRuns = runs.filter(run => !run.controller.signal.aborted);
    this.admissions.abort(new Error('All tasks cancelled'));
    this.admissions = new AbortController();
    const entries = [...this.entries.values()].filter(entry => !entry.finished);
    let count = 0;
    try {
      for (const entry of entries) if (this.cancelEntry(entry.result.id, 'cancel-all')) count++;
      for (const run of activeRuns) run.controller.abort();
      await Promise.all(entries.map(entry => entry.done));
      await Promise.allSettled(runs.map(run => run.done));
      return {cancelled: count > 0 || activeRuns.length > 0, count};
    } finally {
      this.cancellingAll = false;
      if (!this.closed) this.emitActivity({tracker: 'update'});
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    this.observe({tasks: 'changed', tracker: 'stop'});
    clearTimeout(this.noticeTimer); this.noticeTimer = undefined; this.notices = []; this.overflowNotices = 0; this.noticeTriggersTurn = false;
    for (const run of this.runs) run.controller.abort();
    this.lifecycle.abort(new Error('Registry is shut down'));
    for (const entry of this.entries.values()) this.cancelEntry(entry.result.id, 'shutdown');
    await Promise.all([...this.entries.values()].map(e => e.done));
    await Promise.allSettled([...this.runs].map(run => run.done));
  }
  private emitActivity(event: Activity): void {
    if (this.closed || this.cancellingAll) event = {...event, tracker: undefined};
    this.observe(event);
  }
  // Activity only repaints UI; an observer failure must not interrupt cancellation or cleanup.
  private observe(event: Activity): void {
    try { this.options.activity?.(event); } catch {}
  }
  private queueNotice(task: TaskResult): void {
    if (this.closed || task.owner !== 'parent' || task.cancellationCause === 'cancel-all' || !this.options.notify) return;
    this.noticeTriggersTurn ||= task.status !== 'cancelled';
    if (this.notices.length < 16) this.notices.push(taskView(task, 4096)); else this.overflowNotices++;
    this.noticeTimer ??= setTimeout(() => this.flushNotices(), 250);
  }
  private flushNotices(): void {
    const pending = this.notices;
    const count = pending.length + this.overflowNotices;
    const triggerTurn = this.noticeTriggersTurn;
    this.notices = []; this.overflowNotices = 0; this.noticeTriggersTurn = false; this.noticeTimer = undefined;
    if (this.closed || !count) return;
    const tasks: ReturnType<typeof taskView>[] = [];
    for (const notice of pending) {
      const output = clipJson(notice.output, 1024, true);
      const compact = {...notice, output, outputTruncated: notice.outputTruncated || output.length < notice.output.length};
      if (Buffer.byteLength(JSON.stringify([...tasks, compact]), 'utf8') <= 12000) tasks.push(compact);
    }
    const value = count === 1 ? pending[0] : {tasks, additionalCompletions: count - tasks.length};
    try { this.options.notify?.(JSON.stringify(value), {triggerTurn, deliverAs: triggerTurn ? 'followUp' : 'nextTurn'}); }
    catch (error) { this.notificationFailed(pending.map(task => task.id), error); }
  }
  private signal(entry: Entry, signal: NodeJS.Signals) {
    if (!entry.process?.pid || entry.sigkillAttempted) return;
    if (signal === 'SIGKILL') entry.sigkillAttempted = true;
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
    if (Date.now() >= entry.deadlineAt) { this.cancelEntry(entry.result.id, 'timeout'); return; }
    this.running++;
    if (entry.writer) this.writers.add(entry.spec.cwd);
    entry.result.status = 'running';
    const tail = (field: 'output' | 'stderr') => {
      let buffer = entry.result[field];
      const trim = () => buffer.length > CAP ? (buffer = buffer.slice(-CAP)) : buffer;
      Object.defineProperty(entry.result, field, {configurable: true, enumerable: true, get: trim, set: value => { buffer = value; }});
      return (text: string) => { buffer += text; if (buffer.length > CAP * 2) trim(); };
    };
    const appendOutput = tail('output');
    const appendStderr = tail('stderr');
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
            toolCalls.set(event.toolCallId, createHash('sha256').update(JSON.stringify([event.toolName, event.args])).digest('hex'));
            if (toolCalls.size > 1024) toolCalls.delete(toolCalls.keys().next().value!);
          }
        }
        if (event.type === 'tool_execution_end') {
          const fingerprint = event.isError === true ? toolCalls.get(event.toolCallId) ?? '' : '';
          toolCalls.delete(event.toolCallId);
          consecutiveFailures = fingerprint ? (fingerprint === failedCall ? consecutiveFailures + 1 : 1) : 0;
          failedCall = fingerprint;
          if (consecutiveFailures >= 4 && this.cancelEntry(entry.result.id, 'stall')) {
            entry.result.status = 'stalled';
            entry.result.error = `Stopped after 4 identical consecutive failed tool calls: ${String(event.toolName).slice(0, 100)}`;
          }
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          appendOutput(String(event.assistantMessageEvent.delta));
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
        if ((this.options.onUpdate || this.options.activity) && ['message_update', 'message_end'].includes(event.type) && Date.now() - lastUpdateAt >= 100) {
          lastUpdateAt = Date.now();
          this.options.onUpdate?.(cloneResult(entry.result));
          this.emitActivity({tasks: 'changed'});
        }
      } catch {}
    };
    try {
      this.options.admission.launch(entry.spec);
      const invocation = this.options.invocation?.(entry.spec) ?? piInvocation(entry.spec, Boolean(entry.connectorBridge?.tools.length));
      entry.supervised = 'command' in invocation && invocation.supervised;
      entry.process = 'command' in invocation ? spawn(invocation.command, invocation.args, {cwd: entry.spec.cwd, env: childEnv(invocation.env ?? process.env, {PI_SUBAGENT_TIMEOUT_MS: String(Math.max(10, entry.deadlineAt - Date.now()))}), detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', entry.connectorBridge ? 'pipe' : 'ignore']}) : invocation;
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
      entry.process.stderr?.on('data', chunk => appendStderr(String(chunk)));
      entry.process.on('error', error => { entry.result.error = error.message; sawError = true; });
      entry.process.on('close', (exitCode, signal) => {
        const reported = /^\d{1,3}\n$/.test(control) && Number(control) <= 255 ? Number(control) : undefined;
        const code = entry.supervised && signal === 'SIGKILL' && reported !== undefined ? reported : exitCode;
        if (pending) consume(pending);
        if (assistantError && !entry.result.error) entry.result.error = assistantError;
        if (entry.result.status === 'running') {
          entry.result.status = code !== 0 || sawError || assistantError ? 'failed' : lastStopReason === 'stop' ? 'succeeded' : 'incomplete';
          if (entry.result.status === 'incomplete') entry.result.error = `Child did not produce a complete assistant result (${lastStopReason ?? 'missing terminal outcome'})`;
          if (entry.result.status === 'failed' && !entry.result.error) entry.result.error = `Child exited with code ${code}`;
        }
        this.finish(entry);
        toolCalls.clear(); pending = ''; pendingBytes = 0; control = '';
      });
      entry.process.on('exit', () => {
        this.signal(entry, 'SIGKILL');
        clearTimeout(entry.timer); clearTimeout(entry.killTimer);
      });
      if (entry.connectorBridge) entry.closeConnectorBridge = attachConnectorBridge(entry.process.stdio.at(5) as Duplex, entry.connectorBridge, entry.connectorController.signal);
    } catch (error) {
      entry.result.status = 'failed'; entry.result.error = String(error);
      if (entry.process) this.signal(entry, 'SIGKILL');
      else this.finish(entry);
    }
  }
  private reinsertAtEnd(entry: Entry) {
    this.entries.delete(entry.result.id);
    this.entries.set(entry.result.id, entry);
  }
  private finish(entry: Entry) {
    if (entry.finished) return;
    entry.finished = true;
    entry.connectorController.abort();
    entry.closeConnectorBridge?.();
    entry.connectorBridge = undefined;
    entry.closeConnectorBridge = undefined;
    this.reinsertAtEnd(entry);
    entry.detachSignal?.();
    clearTimeout(entry.timer); clearTimeout(entry.killTimer);
    const heldRunSlot = Boolean(entry.process) || entry.result.status === 'failed';
    if (heldRunSlot) { this.running--; if (entry.writer) this.writers.delete(entry.spec.cwd); }
    const snapshot = cloneResult(entry.result);
    try { this.options.onComplete?.(snapshot); this.emitActivity({tasks: 'completed'}); this.queueNotice(snapshot); } catch (error) { entry.result.notificationError = `Completion notification failed: ${String(error).slice(0,1000)}`; }
    finally {
      entry.resolve(cloneResult(entry.result));
      let finished = 0;
      for (const item of this.entries.values()) if (item.finished) finished++;
      let excess = finished - RETAINED;
      if (excess > 0) for (const item of this.entries.values()) {
        if (!item.finished) continue;
        this.entries.delete(item.result.id);
        if (--excess === 0) break;
      }
      this.pump();
    }
  }
}

export function piInvocation(spec: ValidTask, connectors = false) {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', spec.tools.join(','), '--system-prompt', 'You are a delegated agent. Your only task context is the explicit brief below. Use only the configured tools and assigned workspace. Do not assume parent conversation context.'];
  if (spec.model) args.push('--model', spec.model);
  if (spec.thinking) args.push('--thinking', spec.thinking);
  args.push('-e', spec.hooks);
  if (connectors) args.push('-e', fileURLToPath(new URL('./connector-bridge.ts', import.meta.url)));
  for (const extension of new Set(spec.extensions)) args.push('-e', extension);
  args.push('--', spec.task.startsWith('@') ? `\n${spec.task}` : spec.task);
  const env = childEnv(process.env, {PI_SUBAGENT_TIMEOUT_MS: String(spec.timeout), PI_SUBAGENT_TOOL_BRIDGE: connectors ? '1' : ''});
  return {
    command: 'node',
    supervised: true,
    args: [SUPERVISOR, 'pi', ...args],
    env,
  };
}
