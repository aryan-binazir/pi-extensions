import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** A session that this resolver itself rejected, as opposed to an incidental filesystem failure. */
class WaylandSessionError extends Error {}

/** Resolve once per backend; never change the parent process environment. */
export function linuxSessionEnvironment(env: NodeJS.ProcessEnv, uid = process.getuid?.()): NodeJS.ProcessEnv {
  if (env.WAYLAND_DISPLAY && (isAbsolute(env.WAYLAND_DISPLAY) || env.XDG_RUNTIME_DIR)) return { ...env };
  const runtime = env.XDG_RUNTIME_DIR || (uid === undefined ? undefined : `/run/user/${uid}`);
  const unavailable = (options?: { cause: unknown }) => new WaylandSessionError('Wayland unavailable: set WAYLAND_DISPLAY and XDG_RUNTIME_DIR to the intended desktop session', options);
  if (!runtime || !isAbsolute(runtime) || uid === undefined) throw unavailable();
  try {
    const directory = lstatSync(runtime);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) throw unavailable();
    // An explicit display is authoritative, even if stale. Never silently retarget it.
    if (env.WAYLAND_DISPLAY) return { ...env, XDG_RUNTIME_DIR: runtime };
    const sockets = readdirSync(runtime).filter(name => {
      if (!/^wayland-[A-Za-z0-9_.-]+$/.test(name)) return false;
      try {
        const entry = lstatSync(join(runtime, name));
        return entry.isSocket() && entry.uid === uid;
      } catch { return false; }
    });
    if (sockets.length > 1) throw new WaylandSessionError('Wayland session ambiguous: set WAYLAND_DISPLAY explicitly; multiple same-user sockets found');
    if (sockets.length !== 1) throw unavailable();
    return { ...env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sockets[0] };
  } catch (error) {
    if (error instanceof WaylandSessionError) throw error;
    throw unavailable({ cause: error });
  }
}
