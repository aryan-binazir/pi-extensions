// Write and edit approval, ported from openai/codex codex-rs/core/src/safety.rs @ ce0323f (Apache-2.0); see
// docs/licenses/README.md. Codex applies patches inside the sandbox; Pi's write and edit tools mutate in-process,
// so Guardian overrides them and gates each mutation where Pi hands over the absolute path it resolved. Paths are
// canonicalized there, following leaf symlinks, and checked against the same writable roots Seatbelt enforces.
import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createEditToolDefinition, createWriteToolDefinition, type EditOperations, type ToolDefinition, type WriteOperations,
} from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ApprovalContext, ApprovalDecision, ApprovalRequest } from './approvals.ts';
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

/**
 * Resolves a path for the writable-root check: existing ancestors are canonicalized and a leaf symlink is
 * followed even when its target is missing, so a dangling link cannot redirect a write out of the workspace.
 */
export function canonicalTarget(path: string, depth = 0): string {
  if (depth >= 32) return path;
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    const tail = () => [...missing].reverse();
    // Check the link itself first: realpath cannot resolve a symlink whose target is missing.
    if (lstatOrUndefined(current)?.isSymbolicLink()) {
      return canonicalTarget(join(resolve(dirname(current), readlinkSync(current)), ...tail()), depth + 1);
    }
    try {
      return join(realpathSync(current), ...tail());
    } catch {
      if (dirname(current) === current) return path;
      missing.push(basename(current));
    }
  }
}

const lstatOrUndefined = (path: string) => { try { return lstatSync(path); } catch { return undefined; } };
/** A regular file with more than one link shares its contents with another path, which may sit outside the roots. */
const hasOtherLinks = (path: string) => {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.nlink > 1;
  } catch { return false; }
};

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
// macOS volumes are case-insensitive by default; Seatbelt resolves `.GIT` to the protected `.git`.
const fold = (path: string) => process.platform === 'darwin' ? path.toLowerCase() : path;

function canWrite(path: string, context: FileSafetyContext): boolean {
  const { config, cwd } = context;
  if (config.sandbox.mode === 'read-only') return false;
  if (hasOtherLinks(path)) return false;
  if (config.sandbox.mode === 'danger-full-access') return true;
  const target = fold(canonicalTarget(path));
  return workspaceWriteRoots({ mode: 'workspace-write', networkAccess: config.sandbox.networkAccess, writableRoots: config.sandbox.writableRoots,
    excludeTmpdirEnvVar: config.sandbox.excludeTmpdirEnvVar, excludeSlashTmp: config.sandbox.excludeSlashTmp }, cwd, context.env ?? process.env)
    .some(({ root, readOnlySubpaths }) => {
      const canonicalRoot = fold(canonicalTarget(root));
      if (!within(target, canonicalRoot)) return false;
      const carveouts = [...readOnlySubpaths, ...PROTECTED_METADATA_PATH_NAMES.map(name => join(root, name))].map(subpath => fold(canonicalTarget(subpath)));
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

export interface FileRuntime {
  config(): GuardianConfig;
  sandboxAvailable: boolean;
  approvals: { request(request: ApprovalRequest, ctx: ApprovalContext, signal?: AbortSignal): Promise<ApprovalDecision> };
}

/**
 * Assesses every mutation of one tool call, and asks you at most once: a tool call is one logical change, so
 * creating the parent directory and writing the file share a decision, as one Codex patch does.
 */
function createGate(runtime: FileRuntime, tool: 'write' | 'edit', input: Input, cwd: string, ctx: ApprovalContext, signal: AbortSignal | undefined) {
  let approval: Promise<void> | undefined;
  return async (path: string): Promise<void> => {
    const safety = assessFileChange(path, { config: runtime.config(), cwd, sandboxAvailable: runtime.sandboxAvailable });
    if (safety === 'auto_approve') return;
    if (typeof safety === 'object') throw new Error(safety.reason);
    return approval ??= (async () => {
      const decision = await runtime.approvals.request({
        action: fileChangeAction(tool, input, path, cwd), summary: `${tool} ${path}`,
      }, ctx, signal);
      if (decision.type !== 'approved') throw new Error(decision.message);
    })();
  };
}

type Gate = (path: string) => Promise<void>;

/** Parent directories are created only after the write itself is allowed, so a denial leaves nothing behind. */
function gatedWriteOperations(gate: Gate): WriteOperations {
  let parent: string | undefined;
  return {
    async mkdir(dir) { parent = dir; },
    async writeFile(path, content) {
      await gate(path);
      if (parent !== undefined) await mkdir(parent, { recursive: true });
      await writeFile(path, content, 'utf8');
    },
  };
}

const gatedEditOperations = (gate: Gate): EditOperations => ({
  readFile: path => readFile(path),
  access: async () => {},
  async writeFile(path, content) { await gate(path); await writeFile(path, content, 'utf8'); },
});

type AnyFileTool = ToolDefinition<never, never, never>;

/** Pi's `write` and `edit`, with every mutation gated at the path Pi resolved. */
export function createGuardianFileTools(runtime: FileRuntime, defaultCwd: string): AnyFileTool[] {
  const wrap = (name: 'write' | 'edit', build: (cwd: string, gate: Gate) => unknown): AnyFileTool => ({
    ...(build(defaultCwd, async () => {}) as AnyFileTool),
    async execute(toolCallId: string, params: Input, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ApprovalContext & { cwd?: string }) {
      const cwd = ctx?.cwd ?? defaultCwd;
      const gated = build(cwd, createGate(runtime, name, params, cwd, ctx, signal)) as AnyFileTool;
      return (gated.execute as unknown as (...args: unknown[]) => unknown)(toolCallId, params, signal, onUpdate, ctx);
    },
  } as unknown as AnyFileTool);
  return [
    wrap('write', (cwd, gate) => createWriteToolDefinition(cwd, { operations: gatedWriteOperations(gate) })),
    wrap('edit', (cwd, gate) => createEditToolDefinition(cwd, { operations: gatedEditOperations(gate) })),
  ];
}
