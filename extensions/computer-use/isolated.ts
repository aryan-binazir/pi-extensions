import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WaylandPointer } from './wayland.ts';

export interface IsolatedDesktop {
  readonly env: NodeJS.ProcessEnv;
  readonly stopped: boolean;
  readonly exited: Promise<void>;
  readonly output: string;
  close(): Promise<void>;
}

export async function startIsolatedDesktop(url: string, signal: AbortSignal, host: NodeJS.ProcessEnv = process.env): Promise<IsolatedDesktop> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  deadline.throwIfAborted();
  const path = (host.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(isAbsolute).join(':');
  for (const binary of ['bwrap', 'sway', 'swaymsg', 'chromium', 'wl-copy', 'wl-paste']) {
    let found = false;
    for (const directory of path.split(':')) {
      try { await access(join(directory, binary), constants.X_OK); found = true; break; } catch {}
    }
    if (!found) throw new Error(`Isolated desktop prerequisite ${binary} unavailable; install it and /reload`);
  }
  let root = '/tmp';
  if (host.XDG_RUNTIME_DIR && isAbsolute(host.XDG_RUNTIME_DIR) && Buffer.byteLength(join(host.XDG_RUNTIME_DIR, 'pi-cu-XXXXXX', 'wayland-1234567890')) <= 107) {
    try {
      const entry = await lstat(host.XDG_RUNTIME_DIR);
      if (entry.isDirectory() && entry.uid === process.getuid?.() && (entry.mode & 0o077) === 0) root = host.XDG_RUNTIME_DIR;
    } catch {}
  }
  const directory = await mkdtemp(join(root, 'pi-cu-'));
  let cleanup: (() => Promise<void>) | undefined;
  let pointer: WaylandPointer | undefined;
  try {
    await mkdir(join(directory, 'home'), { mode: 0o700 });
    await writeFile(join(directory, 'sway.conf'), 'xwayland disable\noutput * mode 1280x720\nseat seat0 fallback true\ndefault_border none\nfocus_follows_mouse no\nexec /bin/sh "$XDG_RUNTIME_DIR/browser.sh"\n');
    await writeFile(join(directory, 'browser.sh'), 'chromium --ozone-platform=wayland --user-data-dir="$XDG_RUNTIME_DIR/profile" --no-first-run --no-default-browser-check --password-store=basic -- "$PI_COMPUTER_URL"\nexec swaymsg exit\n');
    const env: NodeJS.ProcessEnv = {
      PATH: path, HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'home', '.config'),
      XDG_CACHE_HOME: join(directory, 'home', '.cache'), XDG_DATA_HOME: join(directory, 'home', '.local', 'share'),
      XDG_RUNTIME_DIR: directory, TMPDIR: directory, PI_COMPUTER_URL: url,
      WLR_BACKENDS: 'headless', WLR_RENDERER: 'pixman', WLR_LIBINPUT_NO_DEVICES: '1', WLR_HEADLESS_OUTPUTS: '1',
    };
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) if (host[key]) env[key] = host[key];
    deadline.throwIfAborted();
    const args = ['--new-session', '--die-with-parent', '--unshare-pid', '--dev-bind', '/', '/', '--proc', '/proc'];
    const userRuntime = `/run/user/${process.getuid?.()}`;
    try { if ((await lstat(userRuntime)).isDirectory()) args.push('--tmpfs', userRuntime, '--bind', directory, directory); } catch {}
    args.push('--info-fd', '3', '--', 'sway', '--unsupported-gpu', '--config', join(directory, 'sway.conf'));
    const child = spawn('bwrap', args, { env, cwd: '/', stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let stopped = false, stderr = '', metadata = '', namespace: { pid: number; id: number } | undefined;
    let failure: Error | undefined;
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.subarray(0, Math.max(0, 4096 - Buffer.byteLength(stderr))).toString(); });
    child.stdio[3]!.on('data', (chunk: Buffer) => {
      metadata += chunk.subarray(0, Math.max(0, 4096 - metadata.length)).toString();
      try {
        const info = JSON.parse(metadata) as Record<string, number>;
        if (Number.isSafeInteger(info['child-pid']) && info['child-pid'] > 0 && Number.isSafeInteger(info['pid-namespace'])) namespace = { pid: info['child-pid'], id: info['pid-namespace'] };
      } catch {}
    });
    child.once('error', error => { failure = error; });
    const exited = new Promise<void>(resolve => {
      child.once('exit', () => { stopped = true; resolve(); });
      child.once('error', () => { stopped = true; resolve(); });
    });
    const reaped = new Promise<void>(resolve => child.once('close', () => { stopped = true; resolve(); }));
    const stop = () => { if (!stopped) child.kill('SIGKILL'); };
    const finished = reaped.then(async () => {
      if (namespace) {
        const until = Date.now() + 3000;
        for (;;) {
          try {
            if (await readlink(`/proc/${namespace.pid}/ns/pid`) !== `pid:[${namespace.id}]`) break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ESRCH') break;
            if (code !== 'EACCES') throw error;
          }
          try {
            const stat = await readFile(`/proc/${namespace.pid}/stat`, 'utf8');
            if (/^[ZX] /.test(stat.slice(stat.lastIndexOf(')') + 2))) break;
          } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) break; throw error; }
          if (Date.now() >= until) throw new Error('Isolated desktop namespace did not stop; private directory retained');
          await delay(10);
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    void finished.catch(() => {});
    cleanup = async () => { pointer?.close(); stop(); await finished; };
    const abort = () => stop();
    deadline.addEventListener('abort', abort, { once: true });
    try {
      if (deadline.aborted) stop();
      const ready = async () => {
        for (;;) {
          deadline.throwIfAborted();
          if (stopped) throw new Error(`Isolated desktop startup failed: ${failure?.message ?? (stderr.trim() || 'process exited')}`);
          const sockets = [];
          for (const name of await readdir(directory)) {
            if (!/^wayland-[A-Za-z0-9_.-]+$/.test(name)) continue;
            const socket = join(directory, name), entry = await lstat(socket);
            if (entry.isSocket() && entry.uid === process.getuid?.()) sockets.push(socket);
          }
          if (sockets.length > 1) throw new Error('Isolated desktop returned multiple Wayland sockets');
          if (sockets.length === 1) {
            if (Buffer.byteLength(sockets[0]) > 107) throw new Error('Isolated Wayland socket path exceeds Unix limit');
            pointer = new WaylandPointer(sockets[0]);
            for (;;) {
              const outputs = await pointer.outputs(deadline);
              if (outputs[0]) {
                await pointer.preparePointer(outputs[0], deadline);
                return { socket: sockets[0], output: outputs[0] };
              }
              await delay(20, undefined, { signal: deadline });
            }
          }
          await delay(20, undefined, { signal: deadline });
        }
      };
      const readyOutput = await Promise.race([ready(), exited.then(() => { throw new Error(`Isolated desktop startup failed: ${failure?.message ?? (stderr.trim() || 'process exited')}`); })]);
      deadline.throwIfAborted();
      if (stopped) throw new Error('Isolated desktop stopped during startup');
      return { env: Object.freeze({ ...env, WAYLAND_DISPLAY: readyOutput.socket }), output: readyOutput.output, exited, get stopped() { return stopped; }, close: cleanup };
    } finally {
      deadline.removeEventListener('abort', abort);
    }
  } catch (error) {
    if (cleanup) await cleanup(); else await rm(directory, { recursive: true, force: true });
    throw deadline.aborted ? deadline.reason : error;
  }
}
