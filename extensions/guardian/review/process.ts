// Runs reviewer subprocesses with bounded output and whole-process-group cleanup.
import { spawn } from 'node:child_process';
import type { SandboxedProcess } from '../sandbox.ts';

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
}

/** Keeps the first and last halves of a stream so a runaway command cannot exhaust memory. */
class HeadTail {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omitted = 0;

  constructor(private readonly half: number) {}

  push(chunk: Buffer): void {
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

export function runBounded(command: string, args: readonly string[], options: BoundedRunOptions): Promise<BoundedRun> {
  return runStarted(async () => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return { child, finished: Promise.resolve() };
  }, options);
}

/** Like runBounded, for a process started in its own group with piped stdio, such as a sandboxed one. */
export async function runStarted(start: () => Promise<SandboxedProcess>, options: Omit<BoundedRunOptions, 'env'>): Promise<BoundedRun> {
  let started: SandboxedProcess;
  try {
    started = await start();
  } catch (error) {
    return { exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawnError: (error as Error).message };
  }
  const { child, finished } = started;
  return new Promise(resolve => {
    const stdout = new HeadTail(options.maxBytes / 2), stderr = new HeadTail(options.maxBytes / 2);
    let timedOut = false, aborted = false, settled = false;
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void finished.then(() => resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted, ...(spawnError ? { spawnError } : {}) }));
    };
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const onAbort = () => { aborted = true; killGroup(); };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, Math.max(0, options.timeoutMs));
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.stdin ?? '');
    child.on('error', error => finish(null, error.message));
    child.on('close', code => finish(code));
  });
}
