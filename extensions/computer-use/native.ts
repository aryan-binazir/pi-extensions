import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { WaylandPointer } from './wayland.ts';
import { linuxSessionEnvironment } from './linux-session.ts';
import type { DesktopAction, DesktopBackend, DesktopResult } from './desktop.ts';

const maxBytes = 16 * 1024 * 1024;
const waitForClipboard = String.raw`
set -eu
while :; do
  types=$(wl-paste --list-types 2>&1) || [ "$types" = 'Nothing is copied' ]
  case "
$types
" in *"
text/plain;charset=utf-8
"*) exit 0;; esac
  sleep 0.01
done
`;
const commandOwner = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const stop = () => process.kill(-process.pid, 'SIGKILL');
const report = value => writeSync(2, JSON.stringify(value) + '\n');
process.on('uncaughtException', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
let request = '';
const receive = chunk => {
  request += chunk;
  const end = request.indexOf('\n');
  if (end < 0) return;
  process.stdin.removeListener('data', receive);
  const { command, args, input, bun, cwd } = JSON.parse(request.slice(0, end));
  if (bun === null) delete process.env.BUN_BE_BUN;
  else process.env.BUN_BE_BUN = bun;
  const child = spawn(command, args, { cwd, stdio: 'pipe' });
  let error;
  child.on('error', failure => { error = { message: failure.message, code: failure.code, errno: failure.errno, syscall: failure.syscall, path: failure.path, spawnargs: failure.spawnargs }; });
  child.stdout.on('data', chunk => { for (let offset = 0; offset < chunk.length;) offset += writeSync(1, chunk, offset, chunk.length - offset); });
  child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input);
  child.once('close', code => { report({ code, error }); process.exit(0); });
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', receive);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
`;
export function pngResult(bytes: Buffer, output: string): DesktopResult {
  if (bytes.length < 24 || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Desktop returned an invalid or oversized PNG');
  return { image: bytes.toString('base64'), mimeType: 'image/png', output, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), coordinates: 'Click x/y are fractions from 0 to 1 within this output.' };
}
export class LinuxDesktop implements DesktopBackend {
  private pointer?: WaylandPointer;
  private children = new Set<{ stop(): void; settled: Promise<void> }>();
  private sessionEnv?: NodeJS.ProcessEnv;
  private clipboard?: { stop(): void; settled: Promise<void> };
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly textEntry: 'type' | 'paste' = 'type') {}
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
      const env = this.environment();
      const child = spawn(process.execPath, ['-e', commandOwner], { cwd: '/', env: { ...env, BUN_BE_BUN: '1' }, detached: true, stdio: 'pipe' });
      const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
      let drain: NodeJS.Timeout | undefined;
      let reaped!: () => void;
      const owned = {
        stop: () => {
          child.stdin.end();
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        },
        settled: new Promise<void>(resolve => { reaped = resolve; }),
      };
      this.children.add(owned);
      const unavailable = (cause: unknown) => new Error(`Desktop runtime ${command} unavailable; install its documented prerequisite`, { cause });
      const abort = () => { failure = new Error('Desktop command aborted'); owned.stop(); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { failure = new Error('Desktop command output exceeded limit'); owned.stop(); } else chunks.push(chunk); });
      child.stdin.on('error', () => {});
      let report = '';
      child.stderr.on('data', (chunk: Buffer) => { report += chunk.subarray(0, Math.max(0, 16384 - report.length)).toString(); });
      child.on('error', error => { failure = unavailable(error); });
      child.on('exit', () => { drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 250); });
      child.once('close', () => {
        clearTimeout(drain); this.children.delete(owned); signal.removeEventListener('abort', abort); reaped();
        let result: { code: number | null; error?: { message: string; code?: string; errno?: number; syscall?: string; path?: string; spawnargs?: string[] } } | undefined;
        try { result = JSON.parse(report) as typeof result; } catch {}
        if (failure) reject(failure);
        else if (result?.error) reject(unavailable(Object.assign(new Error(result.error.message), result.error)));
        else if (!result || result.code !== 0) reject(new Error(`Desktop runtime ${command} failed (${result?.code ?? null}); check compositor support and session permissions`));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.write(JSON.stringify({ command, args, input, bun: env.BUN_BE_BUN ?? null, cwd: process.cwd() }) + '\n');
      if (signal.aborted) abort();
    });
  }
  private async paste(text: string, signal: AbortSignal) {
    this.clipboard?.stop(); await this.clipboard?.settled;
    await this.command('wl-copy', ['--clear'], signal);
    const control = new AbortController();
    const active = AbortSignal.any([signal, control.signal]);
    let ended = false, failure: unknown;
    const copying = this.command('wl-copy', ['--foreground', '--type', 'text/plain;charset=utf-8'], control.signal, text);
    const settled = copying.then(() => { ended = true; }, error => { ended = true; failure = error; });
    this.clipboard = { stop: () => control.abort(), settled };
    const abort = () => control.abort();
    signal.addEventListener('abort', abort, { once: true });
    const stopped = () => { throw failure ?? new Error('Isolated clipboard stopped'); };
    try {
      signal.throwIfAborted();
      await Promise.race([this.command('/bin/sh', ['-c', waitForClipboard], active), settled.then(stopped)]);
      await this.command('wtype', ['-s', '200', '-M', 'ctrl', '-k', 'v', '-m', 'ctrl', '-s', '100'], active);
      if (ended) stopped();
    } catch (error) { control.abort(); await settled; throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
  async run(action: DesktopAction, signal: AbortSignal): Promise<DesktopResult> {
    if (action.action === 'accessibility') return { available: false, kind: 'accessibility', reason: 'Linux element accessibility is unavailable in this backend. Use screenshots; no accessibility tree is fabricated.' };
    if (action.action === 'type') {
      if (this.textEntry === 'paste') { if (action.text) await this.paste(action.text, signal); }
      else await this.command('wtype', ['-'], signal, action.text);
      return { dispatched: true, applicationOutcome: 'Inspect to verify text insertion' };
    }
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
    this.clipboard = undefined;
  }
}

export function nativeDesktop(): DesktopBackend {
  if (process.platform === 'linux') return new LinuxDesktop();
  throw new Error(`Desktop control unsupported on ${process.platform}`);
}
