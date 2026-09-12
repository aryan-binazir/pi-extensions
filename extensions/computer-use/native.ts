import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WaylandPointer } from './wayland.ts';
import { linuxSessionEnvironment } from './linux-session.ts';
import type { DesktopAction, DesktopBackend, DesktopResult } from './desktop.ts';

const maxBytes = 16 * 1024 * 1024;
export function pngResult(bytes: Buffer, output: string): DesktopResult {
  if (bytes.length < 24 || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Desktop returned an invalid or oversized PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 64_000_000) throw new Error('Desktop screenshot dimensions exceed limits');
  return { image: bytes.toString('base64'), mimeType: 'image/png', output, width, height, coordinates: 'Click x/y are fractions from 0 to 1 within this output.' };
}
export class LinuxDesktop implements DesktopBackend {
  private pointer?: WaylandPointer;
  private children = new Set<ChildProcessWithoutNullStreams>();
  private sessionEnv?: NodeJS.ProcessEnv;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  private environment() { return this.sessionEnv ??= linuxSessionEnvironment(this.env); }
  private wayland() {
    if (!this.pointer) {
      const env = this.environment(), display = env.WAYLAND_DISPLAY!;
      this.pointer = new WaylandPointer(isAbsolute(display) ? display : join(env.XDG_RUNTIME_DIR!, display));
    }
    return this.pointer;
  }
  private command(command: string, args: string[], signal: AbortSignal, input?: string): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env: this.environment(), stdio: 'pipe' }); this.children.add(child);
      const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
      const abort = () => { failure = new Error('Desktop command aborted'); child.kill('SIGKILL'); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { failure = new Error('Desktop command output exceeded limit'); child.kill('SIGKILL'); } else chunks.push(chunk); });
      // Tool stderr can contain desktop text. Never copy it into logs or errors.
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', error => { failure = new Error(`Desktop runtime ${command} unavailable; install its documented prerequisite`, { cause: error }); });
      child.on('close', code => { this.children.delete(child); signal.removeEventListener('abort', abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(`Desktop runtime ${command} failed (${code}); check compositor support and session permissions`)); else resolve(Buffer.concat(chunks)); });
      child.stdin.end(input); if (signal.aborted) abort();
    });
  }
  async run(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    if (action.action === 'accessibility') return { available: false, kind: 'accessibility', reason: 'Linux element accessibility is unavailable in this backend. Use screenshots; no accessibility tree is fabricated.' };
    if (action.action === 'type') { await this.command('wtype', ['-'], signal, action.text); return { dispatched: true, applicationOutcome: 'Inspect to verify text insertion' }; }
    if (action.action === 'screenshot') {
      const outputs = await this.wayland().outputs(signal), output = action.output ?? outputs[0];
      if (!output || !outputs.includes(output)) throw new Error('Named Wayland output unavailable; wl_output v4 is required');
      return pngResult(await this.command('grim', ['-o', output, '-s', '1', '-t', 'png', '-'], signal), output);
    }
    if (action.action === 'click') await this.wayland().click(action.output, action.x, action.y, action.button ?? 'left', signal);
    else await this.wayland().scroll(action.output, action.dx, action.dy, signal);
    return { dispatched: true, applicationOutcome: 'Compositor acknowledged the request; inspect to verify the application result' };
  }
  async close() {
    this.pointer?.close(); this.pointer = undefined;
    await Promise.all([...this.children].map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGKILL'); })));
    this.children.clear();
  }
}

export class MacDesktop implements DesktopBackend {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private failure?: Error;
  private serial = 0;
  private directory?: string;
  private closed = false;
  private setup?: Promise<void>;
  private exited?: Promise<void>;
  private pending?: { id: number; resolve(value: DesktopResult): void; reject(error: Error): void };
  private async ensure() {
    if (this.closed) throw new Error('macOS desktop session closed');
    if (this.child) return;
    this.directory ??= await mkdtemp(join(tmpdir(), 'pi-desktop-'));
    if (this.closed) { await rm(this.directory, { recursive: true, force: true }); this.directory = undefined; throw new Error('macOS desktop session closed'); }
    const child = spawn('/usr/bin/swift', [fileURLToPath(new URL('./macos.swift', import.meta.url))], { stdio: 'pipe', detached: true, env: { ...process.env, PI_DESKTOP_TMP: this.directory } }); this.child = child;
    this.exited = new Promise(resolve => child.once('close', () => resolve()));
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => this.fail(new Error('macOS Swift runtime unavailable; install Apple Command Line Tools')));
    child.on('close', () => this.fail(new Error('macOS desktop helper exited; check Swift Command Line Tools and Screen Recording/Accessibility permissions')));
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > maxBytes * 1.5) return this.fail(new Error('macOS response exceeds output limit'));
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (!this.pending || response.id !== this.pending.id || typeof response.ok !== 'boolean') throw new Error('Invalid macOS response');
          const pending = this.pending; this.pending = undefined;
          if (!response.ok) pending.reject(new Error(typeof response.error === 'string' ? response.error.slice(0, 500) : 'macOS desktop operation failed'));
          else if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) pending.reject(new Error('Invalid macOS result'));
          else if (response.result.image) {
            try { pending.resolve(pngResult(Buffer.from(response.result.image, 'base64'), 'main')); } catch (error) { pending.reject(error as Error); }
          } else pending.resolve(response.result);
        } catch { this.fail(new Error('Invalid macOS desktop protocol response')); }
      }
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('macOS Swift runtime unavailable; install Apple Command Line Tools'))); });
  }
  private fail(error: Error) {
    this.failure = error;
    const pending = this.pending; this.pending = undefined;
    if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); } }
    pending?.reject(error);
  }
  async run(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    signal.throwIfAborted(); this.setup ??= this.ensure(); await this.setup; signal.throwIfAborted();
    if (this.closed) throw new Error('macOS desktop session closed');
    if (this.failure) throw this.failure;
    const id = ++this.serial;
    const abort = () => this.fail(new Error('macOS desktop request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise((resolve, reject) => { this.pending = { id, resolve, reject }; this.child!.stdin.write(`${JSON.stringify({ id, ...action })}\n`); if (signal.aborted) abort(); });
    } finally { signal.removeEventListener('abort', abort); }
  }
  async close() {
    this.closed = true; this.fail(new Error('macOS desktop session closed')); await this.setup?.catch(() => {}); await this.exited;
    this.child = undefined; this.buffer = '';
    if (this.directory) await rm(this.directory, { recursive: true, force: true }); this.directory = undefined;
  }
}
export function nativeDesktop(): DesktopBackend {
  if (process.platform === 'linux') return new LinuxDesktop();
  if (process.platform === 'darwin') return new MacDesktop();
  throw new Error(`Desktop control unsupported on ${process.platform}`);
}
