import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { isAbsolute, join } from 'node:path';
import { WaylandPointer } from './wayland.ts';
import { linuxSessionEnvironment } from './linux-session.ts';
import type { DesktopAction, DesktopBackend, DesktopResult } from './desktop.ts';

const maxBytes = 16 * 1024 * 1024;
const commandOwner = `
{ read -r _ <&3; kill -KILL 0; } </dev/null >/dev/null 2>&1 &
if ! command -v "$1" >/dev/null 2>&1; then printf 'unavailable\\n' >&3; exit 127; fi
exec "$@" 3>&-
`;
export function pngResult(bytes: Buffer, output: string): DesktopResult {
  if (bytes.length < 24 || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Desktop returned an invalid or oversized PNG');
  return { image: bytes.toString('base64'), mimeType: 'image/png', output, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), coordinates: 'Click x/y are fractions from 0 to 1 within this output.' };
}
export class LinuxDesktop implements DesktopBackend {
  private pointer?: WaylandPointer;
  private children = new Set<{ stop(): void; settled: Promise<void> }>();
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
      const child = spawn('/bin/sh', ['-c', commandOwner, 'desktop-command', command, ...args], { env: this.environment(), detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      const lifetime = child.stdio[3] as Duplex;
      const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
      let status: number | null = null, exited = false, stopping = false, stdoutEnded = false, stderrEnded = false;
      let drain: NodeJS.Timeout | undefined;
      let childClosed = false, lifetimeClosed = false;
      let reaped!: () => void;
      const drainPipes = () => { drain ??= setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); lifetime.destroy(); }, 250); };
      const owned = { stop: () => { if (stopping) return; stopping = true; lifetime.end(); if (exited) drainPipes(); }, settled: new Promise<void>(resolve => { reaped = resolve; }) };
      this.children.add(owned);
      const unavailable = (cause: unknown) => { failure = new Error(`Desktop runtime ${command} unavailable; install its documented prerequisite`, { cause }); };
      const abort = () => { failure = new Error('Desktop command aborted'); owned.stop(); };
      const complete = () => { if (exited && stdoutEnded && stderrEnded) { signal.removeEventListener('abort', abort); owned.stop(); } };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { failure = new Error('Desktop command output exceeded limit'); owned.stop(); } else chunks.push(chunk); });
      child.stdout!.on('end', () => { stdoutEnded = true; complete(); });
      child.stderr!.on('end', () => { stderrEnded = true; complete(); });
      child.stderr!.resume(); child.stdin!.on('error', () => {});
      lifetime.on('error', () => {});
      lifetime.once('data', () => unavailable(new Error('Command unavailable')));
      child.on('error', error => unavailable(error));
      child.on('exit', code => { status = code; exited = true; if (stopping) drainPipes(); complete(); });
      const settle = () => {
        if (!childClosed || !lifetimeClosed) return;
        clearTimeout(drain); this.children.delete(owned); signal.removeEventListener('abort', abort); reaped();
        if (failure) reject(failure);
        else if (status !== 0) reject(new Error(`Desktop runtime ${command} failed (${status}); check compositor support and session permissions`));
        else resolve(Buffer.concat(chunks));
      };
      lifetime.once('close', () => { lifetimeClosed = true; settle(); });
      child.once('close', () => { childClosed = true; lifetime.destroy(); settle(); });
      child.stdin!.end(input); if (signal.aborted) abort();
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
    await Promise.all([...this.children].map(child => { child.stop(); return child.settled; }));
    this.children.clear();
  }
}

export function nativeDesktop(): DesktopBackend {
  if (process.platform === 'linux') return new LinuxDesktop();
  throw new Error(`Desktop control unsupported on ${process.platform}`);
}
