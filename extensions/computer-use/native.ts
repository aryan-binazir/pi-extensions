import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
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

export function nativeDesktop(): DesktopBackend {
  if (process.platform === 'linux') return new LinuxDesktop();
  throw new Error(`Desktop control unsupported on ${process.platform}`);
}
