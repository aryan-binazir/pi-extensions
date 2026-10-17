// Write and edit approval, ported from openai/codex codex-rs/core/src/safety.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Codex applies patches inside the sandbox; Pi's write and edit tools run in-process,
// so paths are canonicalized here and checked against the same writable roots and carveouts Seatbelt enforces.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GuardianConfig } from './config.ts';
import { truncateText } from './review/context.ts';
import { PROTECTED_METADATA_PATH_NAMES, workspaceWriteRoots } from './seatbelt.ts';

const PATCH_REJECTED_OUTSIDE_PROJECT_REASON = 'writing outside of the project; rejected by user approval settings';
const PATCH_REJECTED_READ_ONLY_REASON = 'writing is blocked by read-only sandbox; rejected by user approval settings';
const MAX_CHANGE_TOKENS = 8_000;

export type FileSafety = 'auto_approve' | 'ask_user' | { type: 'reject'; reason: string };

export interface FileSafetyContext {
  config: GuardianConfig;
  cwd: string;
  sandboxAvailable: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Pi's tool path resolution: `~` expands to the home directory and relative paths resolve against cwd. */
export function resolveToolPath(path: string, cwd: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** Resolves the nearest existing ancestor so symlinks cannot redirect a write outside its root. */
function canonical(path: string): string {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      if (dirname(current) === current) return path;
      missing.push(basename(current));
    }
  }
}

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
// macOS volumes are case-insensitive by default; Seatbelt resolves `.GIT` to the protected `.git`.
const fold = (path: string) => process.platform === 'darwin' ? path.toLowerCase() : path;

function canWrite(path: string, context: FileSafetyContext): boolean {
  const { config, cwd } = context;
  if (config.sandbox.mode === 'danger-full-access') return true;
  if (config.sandbox.mode === 'read-only') return false;
  const target = fold(canonical(path));
  return workspaceWriteRoots({ mode: 'workspace-write', networkAccess: config.sandbox.networkAccess, writableRoots: config.sandbox.writableRoots,
    excludeTmpdirEnvVar: config.sandbox.excludeTmpdirEnvVar, excludeSlashTmp: config.sandbox.excludeSlashTmp }, cwd, context.env ?? process.env)
    .some(({ root, readOnlySubpaths }) => {
      const canonicalRoot = fold(canonical(root));
      if (!within(target, canonicalRoot)) return false;
      const carveouts = [...readOnlySubpaths, ...PROTECTED_METADATA_PATH_NAMES.map(name => join(root, name))].map(subpath => fold(canonical(subpath)));
      return !carveouts.some(carveout => within(target, carveout));
    });
}

export function assessFileChange(path: string, context: FileSafetyContext): FileSafety {
  const { config } = context;
  if (!config.enabled) return 'auto_approve';
  if (config.approvalPolicy === 'unless-trusted') return 'ask_user';
  const unrestricted = config.sandbox.mode === 'danger-full-access';
  if (canWrite(path, context) && (unrestricted || context.sandboxAvailable)) return 'auto_approve';
  if (config.approvalPolicy === 'never') {
    return { type: 'reject', reason: config.sandbox.mode === 'read-only' ? PATCH_REJECTED_READ_ONLY_REASON : PATCH_REJECTED_OUTSIDE_PROJECT_REASON };
  }
  return 'ask_user';
}

type Input = { path: string; content?: unknown; edits?: unknown };

/** The planned change as the reviewer sees it; large bodies keep both ends around an omission marker. */
export function fileChangeAction(tool: 'write' | 'edit', input: Input, path: string, cwd: string): Record<string, unknown> {
  const cap = (text: unknown) => typeof text === 'string' ? truncateText(text, MAX_CHANGE_TOKENS) : text;
  const change = tool === 'write'
    ? { content: cap(input.content) }
    : { edits: Array.isArray(input.edits) ? input.edits.map(edit => ({ ...edit, oldText: cap(edit?.oldText), newText: cap(edit?.newText) })) : input.edits };
  return { tool, cwd, files: [path], ...change, environment_id: 'local' };
}
