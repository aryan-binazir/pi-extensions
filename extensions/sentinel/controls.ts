import { realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolPath } from '../worktree/routing.ts';

const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\') && !suffix.startsWith('/'));
};
function canonical(path: string): string {
  let parent = path;
  while (true) {
    try { return resolve(realpathSync(parent), relative(parent, path)); }
    catch { const next = dirname(parent); if (next === parent) return resolve(path); parent = next; }
  }
}

/** Recognized control-plane writes require the human to turn auto off first.
 * Shell strings only get fresh review: this is not a shell parser or OS boundary. */
export function controlAction(tool: string, args: unknown, cwd: string, agentDir: string, policyFile: string, parentFile?: string, sessionFile?: string): 'deny' | 'review' | undefined {
  const files = [policyFile, ...['sentinel.json', 'settings.json', 'models.json', 'auth.json', 'AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map(name => join(agentDir, name)), parentFile, sessionFile].filter((path): path is string => Boolean(path)).map(canonical);
  const directories = [join(agentDir, 'sessions'), join(agentDir, 'extensions'), fileURLToPath(new URL('.', import.meta.url))].map(canonical);
  const protectedPath = (value: string) => {
    if (value.length > 4096 || value.includes('\0')) return false;
    const path = canonical(resolveToolPath(value, cwd));
    return files.includes(path) || directories.some(root => contains(root, path));
  };
  if ((tool === 'write' || tool === 'edit') && args && typeof args === 'object' && 'path' in args && typeof args.path === 'string' && protectedPath(args.path)) return 'deny';
  if (['read', 'grep', 'find', 'ls'].includes(tool)) return;
  const values = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(values) : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];
  for (const value of values(args)) {
    if (files.some(path => value.includes(path)) || directories.some(path => value.includes(path)) || protectedPath(value)) return 'review';
    for (const token of value.match(/[^\s"'=<>;&|()]+/g) ?? []) if (protectedPath(token)) return 'review';
  }
}
