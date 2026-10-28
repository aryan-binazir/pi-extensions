import { type ChildProcess, spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { SandboxedProcess } from '../sandbox.ts';

const EXIT_STDIO_GRACE_MS = 100;

/** Kills a child started with `detached: true` together with everything in its process group. */
export function killProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/**
 * Pi's `waitForChildProcess`, which it does not export: after `exit`, keep reading until both pipes end or fall idle,
 * so a tail still in the pipe is not lost, and a descendant that left the group holding them open cannot hang the call.
 */
export function waitForChildProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false, exited = false, stdoutEnded = !child.stdout, stderrEnded = !child.stderr;
    let idle: NodeJS.Timeout | undefined;
    const finalize = () => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    };
    const armIdleTimer = () => { clearTimeout(idle); idle = setTimeout(finalize, EXIT_STDIO_GRACE_MS); };
    const maybeFinalize = () => { if (exited && stdoutEnded && stderrEnded) finalize(); };
    child.stdout?.once('end', () => { stdoutEnded = true; maybeFinalize(); });
    child.stderr?.once('end', () => { stderrEnded = true; maybeFinalize(); });
    child.stdout?.on('data', () => { if (exited) armIdleTimer(); });
    child.stderr?.on('data', () => { if (exited) armIdleTimer(); });
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(idle); reject(error); });
    child.once('exit', () => { exited = true; maybeFinalize(); if (!settled) armIdleTimer(); });
    child.once('close', finalize);
  });
}

export interface BoundedRun {
  exitCode: number | null;
  /** Head and tail of stdout, with an omission note between them when output exceeded the cap. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

export interface BoundedRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Bytes kept per stream: half from the start, half from the end. */
  maxBytes: number;
  onData?: (chunk: Buffer) => void;
}

class HeadTail {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omitted = 0;

  constructor(private readonly half: number) {}

  push(chunk: Buffer): void {
    if (this.half <= 0) return;
    if (this.head.length < this.half) {
      const take = Math.min(this.half - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    if (!chunk.length) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes - this.tail[0].length >= this.half) {
      this.tailBytes -= this.tail[0].length;
      this.omitted += this.tail.shift()!.length;
    }
    if (this.tailBytes > this.half) {
      const excess = this.tailBytes - this.half;
      this.tail[0] = this.tail[0].subarray(excess);
      this.tailBytes -= excess;
      this.omitted += excess;
    }
  }

  text(): string {
    const tail = Buffer.concat(this.tail).toString();
    return this.omitted ? `${this.head.toString()}\n[... ${this.omitted} bytes omitted ...]\n${tail}` : `${this.head.toString()}${tail}`;
  }
}

export async function runBounded(command: string, args: readonly string[], options: BoundedRunOptions): Promise<BoundedRun> {
  let report = '', reported = Promise.resolve();
  const run = await runStarted(async () => {
    // A live group leader can kill its own group after the command is reaped without looking up a stale PID.
    // Ignore SIGPIPE only after the command exits, so a closed report pipe cannot skip group cleanup.
    const child = spawn('/bin/sh', ['-c', 's=0; (exec "$@") 3>&- || s=$?; trap "" PIPE; printf "%s\\n" "$s" >&3 || :; kill -s KILL 0', 'sh', command, ...args], {
      cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const status = child.stdio[3]!;
    status.on('data', (chunk: Buffer) => { report = (report + chunk.toString()).slice(0, 8); });
    reported = new Promise<void>(resolve => { status.once('close', resolve); });
    return { child, finished: reported };
  }, options);
  if (run.timedOut || run.aborted || run.spawnError) return run;
  await reported;
  const exitCode = /^\d{1,3}\n$/.test(report) && Number(report) <= 255 ? Number(report) : null;
  return { ...run, exitCode, ...(exitCode === 126 || exitCode === 127 ? { spawnError: run.stderr.trim() || `command could not start (exit ${exitCode})` } : {}) };
}

export function raceAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    value.then(result => { signal.removeEventListener('abort', onAbort); resolve(result); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** One timer-backed deadline covers preparation, execution, and completion cleanup. */
export async function runStarted(start: (signal: AbortSignal) => Promise<SandboxedProcess>, options: Omit<BoundedRunOptions, 'env'>): Promise<BoundedRun> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const stdout = new HeadTail(options.maxBytes / 2), stderr = new HeadTail(options.maxBytes / 2);
  let timedOut = false, spawnError: string | undefined, exitCode: number | null = null;
  let started: SandboxedProcess | undefined;
  let completed = false, stopped = false;
  const timer = Number.isFinite(options.timeoutMs)
    ? setTimeout(() => { timedOut = true; controller.abort(new Error('command deadline exceeded')); }, Math.max(0, options.timeoutMs))
    : undefined;
  const starting = Promise.resolve().then(() => { signal.throwIfAborted(); return start(signal); });
  const stop = () => {
    if (!started || stopped) return;
    if (started.child.exitCode !== null || started.child.signalCode !== null) { completed = true; return; }
    stopped = true;
    killProcessGroup(started.child);
    started.child.stdin?.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    started = await raceAbort(starting, signal);
    const { child, finished } = started;
    const onExit = () => { completed = !stopped; signal.removeEventListener('abort', stop); };
    child.once('exit', onExit);
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); options.onData?.(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); options.onData?.(chunk); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
    const reaped = waitForChildProcess(child);
    try {
      if (signal.aborted) stop();
      await raceAbort(reaped, signal);
      completed = true;
    } finally {
      if (signal.aborted) {
        stop();
        const drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, EXIT_STDIO_GRACE_MS);
        try { await reaped.catch(() => {}); } finally { clearTimeout(drain); }
      }
      child.removeListener('exit', onExit);
      signal.removeEventListener('abort', stop);
      exitCode = child.exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : null);
    }
    await raceAbort(finished, signal);
  } catch (error) {
    if (!signal.aborted) spawnError = (error as Error).message;
    if (!started) {
      void starting.then(late => {
        void waitForChildProcess(late.child).catch(() => {});
        killProcessGroup(late.child);
        late.child.stdin?.destroy();
        late.child.stdout.destroy();
        late.child.stderr.destroy();
        void late.finished.catch(() => {});
      }, () => {});
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
  return { exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut: timedOut && !completed, aborted: !completed && (options.signal?.aborted ?? false), ...(spawnError ? { spawnError } : {}) };
}
