import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
// The extension loader and SDK consumers can have distinct module caches.
const key = Symbol.for('pi.agent-workflows.active-cwd.v1');
const registry = globalThis as unknown as Record<symbol, Map<string, string>>;
const paths = registry[key] ??= new Map<string, string>();
// Every routed tool call re-derives the same identity; path.resolve plus
// JSON.stringify dominate that. Memoize the last pair, which is the only one a
// live session asks for, and only when `resolve` cannot depend on process.cwd().
let memoCwd: string | undefined, memoSession: string | undefined, memoKey = '';
const identity = (cwd: string, sessionId?: string) => {
  if (cwd === memoCwd && sessionId === memoSession) return memoKey;
  const computed = JSON.stringify([resolve(cwd), sessionId ?? 'default']);
  if (isAbsolute(cwd)) { memoCwd = cwd; memoSession = sessionId; memoKey = computed; }
  return computed;
};
export function getActiveCwd(originalCwd: string, sessionId?: string): string { return paths.get(identity(originalCwd, sessionId)) ?? originalCwd; }
export function setActiveCwd(originalCwd: string, cwd?: string, sessionId?: string): void {
  if (cwd) paths.set(identity(originalCwd, sessionId), resolve(cwd)); else paths.delete(identity(originalCwd, sessionId));
}

const separators = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// An empty, "." or ".." segment is exactly what normalizeString rewrites, so a
// POSIX path with none is already its own path.resolve() output and joining two
// such paths with a separator yields the resolve() of the pair.
const unnormalizedAbsolute = /\/(?:\.\.?)?(?:\/|$)/;
const unnormalizedRelative = /(?:^|\/)(?:\.\.?)?(?:\/|$)/;
const posix = process.platform !== 'win32';
const windowsDrive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;
// The active directory is the same string on every routed call; scan it once.
let scannedCwd = '\0';
function joinable(cwd: string): boolean {
  if (cwd === scannedCwd) return true;
  if (cwd.length < 2 || cwd.charCodeAt(0) !== 47 /* / */ || unnormalizedAbsolute.test(cwd)) return false;
  scannedCwd = cwd;
  return true;
}

/** Pi 0.85.1 utils/paths normalizePath + tools/path-utils resolveToCwd semantics.
 * The SDK does not publicly export these helpers. Keep routing and permission
 * checks on the same interpretation before handing a path to the built-in tool.
 */
export function resolveToolPath(raw: string, cwd: string): string {
  let path = raw.replace(separators, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (!posix && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
    const match = path.match(windowsDrive);
    if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || (!posix && path.startsWith('~\\'))) path = join(homedir(), path.slice(2));
  else if (path.startsWith('file://')) path = fileURLToPath(path);
  if (isAbsolute(path)) {
    if (posix && path.length > 1 && !unnormalizedAbsolute.test(path)) return path;
    return resolve(path);
  }
  if (posix && !unnormalizedRelative.test(path) && joinable(cwd)) return `${cwd}/${path}`;
  return resolve(cwd, path);
}
