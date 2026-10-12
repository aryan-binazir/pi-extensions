import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const unnormalizedAbsolute = /\/(?:\.\.?)?(?:\/|$)/;
const unnormalizedRelative = /(?:^|\/)(?:\.\.?)?(?:\/|$)/;
const posix = process.platform !== 'win32';
const windowsDrive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;
let scannedCwd = '\0';
function joinable(cwd: string): boolean {
  if (cwd === scannedCwd) return true;
  if (cwd.length < 2 || cwd[0] !== '/' || unnormalizedAbsolute.test(cwd)) return false;
  scannedCwd = cwd;
  return true;
}

export function resolveToolPath(raw: string, cwd: string): string {
  let path = raw.replace(unicodeSpaces, ' ');
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
