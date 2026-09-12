import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolPath } from '../worktree/routing.ts';

const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
function canonical(path: string): string {
  let parent = path;
  while (true) {
    try { return resolve(realpathSync(parent), relative(parent, path)); }
    catch { const next = dirname(parent); if (next === parent) return resolve(path); parent = next; }
  }
}

/** Known write/edit targets are exact; opaque commands get a bounded conservative scan.
 * Exhausting that scan forces fresh review, never a claim that later text is safe. */
export function controlAction(tool: string, args: unknown, cwd: string, agentDir: string, policyFile: string, parentFile?: string, sessionFile?: string): 'deny' | 'review' | undefined {
  if (['read', 'grep', 'find', 'ls'].includes(tool)) return;
  const files = [policyFile, ...['sentinel.json', 'settings.json', 'models.json', 'auth.json', 'AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map(name => join(agentDir, name)), parentFile, sessionFile].filter((path): path is string => Boolean(path)).map(canonical);
  const directories = [join(agentDir, 'sessions'), join(agentDir, 'extensions'), fileURLToPath(new URL('.', import.meta.url))].map(canonical);
  const cache = new Map<string, boolean>();
  let exhausted = false;
  const protectedPath = (value: string) => {
    if (value.includes('\0')) return false;
    const candidate = resolveToolPath(value, cwd);
    if (candidate.length > 4096) { exhausted = true; return false; }
    const cached = cache.get(candidate);
    if (cached !== undefined) return cached;
    if (cache.size >= 32) { exhausted = true; return false; }
    const path = canonical(candidate);
    const protectedTarget = files.some(file => contains(path, file)) || directories.some(root => contains(root, path) || contains(path, root));
    cache.set(candidate, protectedTarget);
    return protectedTarget;
  };
  if (tool === 'write' || tool === 'edit') {
    if (!args || typeof args !== 'object' || !('path' in args) || typeof args.path !== 'string') return 'review';
    // File content is not a target path. Scanning it both over-blocks and stalls the event loop.
    return protectedPath(args.path) ? 'deny' : exhausted ? 'review' : undefined;
  }
  const values = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(values) : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];
  for (const value of values(args)) {
    if (value.length > 8192) return 'review';
    if (files.some(path => value.includes(path)) || directories.some(path => value.includes(path)) || protectedPath(value) || exhausted) return 'review';
    for (const token of value.match(/[^\s"'=<>;&|()]+/g) ?? []) if (protectedPath(token) || exhausted) return 'review';
  }
}
