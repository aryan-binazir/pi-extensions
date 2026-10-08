import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
export const ALL_TOOLS = [...READ_TOOLS, 'write', 'edit', 'bash'];
export type ConnectorGrants = Record<string, 'read' | 'write'>;
interface DelegationScope { cwd: string; tools: string[]; delegatedTools?: ConnectorGrants; registeredTools?: string[]; callableTools?: string[] }

export function insideRoot(canonicalRoot: string, canonicalPath: string): boolean {
  const rel = relative(canonicalRoot, canonicalPath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function delegationScope(parent: DelegationScope) {
  const connectors = Object.entries(parent.delegatedTools ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .filter(([name]) => parent.tools.includes(name) && parent.callableTools?.includes(name));
  const tools = [...ALL_TOOLS.filter(tool => parent.tools.includes(tool)), ...connectors.map(([name]) => name)];
  const readTools = [...READ_TOOLS.filter(tool => tools.includes(tool)), ...connectors.filter(([, grant]) => grant === 'read').map(([name]) => name)];
  return {tools, readTools, replayIdentity: JSON.stringify({version: 2, cwd: parent.cwd, tools, readTools})};
}

export function assertToolSelection(tools: string[], parent: DelegationScope): void {
  const unavailable: string[] = [], disallowed: string[] = [], uncallable: string[] = [], denied: string[] = [];
  const allowed = delegationScope(parent).tools;
  for (const name of tools) {
    if (!ALL_TOOLS.includes(name) && parent.registeredTools) {
      if (!parent.registeredTools.includes(name)) {unavailable.push(name); continue;}
      if (!Object.hasOwn(parent.delegatedTools ?? {}, name)) {disallowed.push(name); continue;}
      if (!parent.callableTools?.includes(name)) {uncallable.push(name); continue;}
    }
    if (!allowed.includes(name)) denied.push(name);
  }
  const errors = [
    unavailable.length && `Unavailable child tools: ${unavailable.join(', ')}. Register these tools in the parent and /reload.`,
    disallowed.length && `Disallowed connector tools: ${disallowed.join(', ')}. Add exact read/write grants to user-scoped subagents.json and /reload.`,
    uncallable.length && `Connector tools are not callable in the parent: ${uncallable.join(', ')}. Enable a callable tool exposure in Pi and /reload.`,
    denied.length && `Explicit child tools exceed parent permissions: ${denied.join(', ')}. Activate these tools in the parent before delegating.`,
  ].filter(Boolean);
  if (errors.length) throw new Error(errors.join('\n'));
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
  assertToolSelection(task.tools, options.parent);
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
