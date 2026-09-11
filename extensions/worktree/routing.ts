import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
// The extension loader and SDK consumers can have distinct module caches.
const key = Symbol.for('pi.agent-workflows.active-cwd.v1');
const registry = globalThis as unknown as Record<symbol, Map<string, string>>;
const paths = registry[key] ??= new Map<string, string>();
const identity = (cwd: string, sessionId?: string) => JSON.stringify([resolve(cwd), sessionId ?? 'default']);
export function getActiveCwd(originalCwd: string, sessionId?: string): string { return paths.get(identity(originalCwd, sessionId)) ?? originalCwd; }
export function setActiveCwd(originalCwd: string, cwd?: string, sessionId?: string): void {
  if (cwd) paths.set(identity(originalCwd, sessionId), resolve(cwd)); else paths.delete(identity(originalCwd, sessionId));
}

/** Pi 0.85.1 utils/paths normalizePath + tools/path-utils resolveToCwd semantics.
 * The SDK does not publicly export these helpers. Keep routing and permission
 * checks on the same interpretation before handing a path to the built-in tool.
 */
export function resolveToolPath(raw: string, cwd: string): string {
  let path = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
    const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) path = join(homedir(), path.slice(2));
  else if (path.startsWith('file://')) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
