import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
export const ALL_TOOLS = [...READ_TOOLS, 'write', 'edit', 'bash'];
interface DelegationScope { cwd: string; tools: string[] }

/** True when `path` is `root` or below it. Both must already be canonical. */
export function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Launch-time scope only: child builtins and trusted extensions are not sandboxed. */
export function delegationScope(parent: DelegationScope) {
  const tools = ALL_TOOLS.filter(tool => parent.tools.includes(tool));
  return { tools, replayIdentity: JSON.stringify({ version: 1, cwd: parent.cwd, tools }) };
}

function sensitiveComponent(name: string) {
  return ['.git', '.pi', '.agents', '.codex', 'AGENTS.md', 'CLAUDE.md', 'id_rsa', 'id_ed25519', 'auth.json', 'credentials', 'credentials.json'].includes(name) || /^\.env(?:\.|$)|^credentials(?:\.|$)/i.test(name);
}

export async function assertWorkspacePath(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root), target = await realpath(path);
  if (!insideRoot(canonicalRoot, target)) throw new Error('Path is outside parent workspace');
  if (relative(canonicalRoot, target).split(sep).some(sensitiveComponent)) throw new Error('Path is sensitive or repository control data');
}

export async function assertChildTask(task: { cwd: string; tools: string[]; extensions?: string[] }, options: { parent: DelegationScope; approve?: (request: string) => Promise<boolean> }): Promise<void> {
  await assertWorkspacePath(options.parent.cwd, task.cwd);
  const allowed = delegationScope(options.parent).tools;
  if (task.tools.some(tool => !allowed.includes(tool))) throw new Error('Child tools exceed parent permissions');
  if (task.extensions?.length) {
    for (const extension of task.extensions) {
      if (!isAbsolute(extension)) throw new Error('Child extensions must be absolute local paths');
      if (!(await stat(await realpath(extension))).isFile()) throw new Error('Child extension must be a file');
    }
    if (!options.approve) throw new Error('Child extension loading was not approved');
    if (!await options.approve(`Load trusted local child extensions with host privileges? ${JSON.stringify(task.extensions)}`))
      throw Object.assign(new Error('Child extension loading was not approved'), {retryable: false});
  }
}

export async function assertWorkflowRead(parent: DelegationScope, path: string): Promise<void> {
  if (!delegationScope(parent).tools.includes('read')) throw new Error('Read is outside parent permissions');
  await assertWorkspacePath(parent.cwd, path);
}
