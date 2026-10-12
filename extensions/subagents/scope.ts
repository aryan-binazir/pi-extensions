import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { availableModel, assertTaskFields, resolveProfile, type ProfileConfig } from './profiles.ts';
import { ALL_TOOLS, READ_TOOLS, type ConnectorGrants, type TaskSpec, type ValidTask } from './task.ts';
import { prepareTask } from './registry.ts';
import { CONNECTOR_FRAME_LIMIT, type ConnectorBridge } from './connector-bridge.ts';

interface DelegationScope { cwd: string; tools: string[]; delegatedTools?: ConnectorGrants; registeredTools?: string[]; callableTools?: string[]; builtinTools?: string[] }

export function insideRoot(canonicalRoot: string, canonicalPath: string): boolean {
  const rel = relative(canonicalRoot, canonicalPath);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function delegationScope(parent: DelegationScope) {
  const connectors = Object.entries(parent.delegatedTools ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([name]) => parent.tools.includes(name) && parent.callableTools?.includes(name) && !parent.builtinTools?.includes(name));
  const tools = [...ALL_TOOLS.filter(tool => parent.tools.includes(tool)), ...connectors.map(([name]) => name)];
  const readTools = [...READ_TOOLS.filter(tool => tools.includes(tool)), ...connectors.filter(([, grant]) => grant === 'read').map(([name]) => name)];
  return {tools, readTools, replayIdentity: JSON.stringify(connectors.length ? {version: 2, cwd: parent.cwd, tools, readTools} : {version: 1, cwd: parent.cwd, tools})};
}

export function assertToolSelection(tools: string[], parent: DelegationScope): void {
  const unavailable: string[] = [], disallowed: string[] = [], uncallable: string[] = [], denied: string[] = [], builtin: string[] = [];
  const allowed = delegationScope(parent).tools;
  for (const name of tools) {
    if (connectorTools([name]).length && parent.registeredTools) {
      if (parent.builtinTools?.includes(name)) {builtin.push(name); continue;}
      if (!parent.registeredTools.includes(name)) {unavailable.push(name); continue;}
      if (!Object.hasOwn(parent.delegatedTools ?? {}, name)) {disallowed.push(name); continue;}
      if (!parent.callableTools?.includes(name)) {uncallable.push(name); continue;}
    }
    if (!allowed.includes(name)) denied.push(name);
  }
  const errors = [
    unavailable.length && `Unavailable child tools: ${unavailable.join(', ')}. Register these tools in the parent and /reload.`,
    builtin.length && `Pi core tools cannot receive connector grants: ${builtin.join(', ')}. Use the supported built-in child tools.`,
    disallowed.length && `Disallowed connector tools: ${disallowed.join(', ')}. Add exact read/write grants to user-scoped subagents.json and /reload.`,
    uncallable.length && `Connector tools are not callable in the parent: ${uncallable.join(', ')}. Enable a callable tool exposure in Pi and /reload.`,
    denied.length && `Explicit child tools exceed parent permissions: ${denied.join(', ')}. Activate these tools in the parent before delegating. For Pi MCP, set the selected tools' toolExposure to direct in user-scoped mcp.json and /reload.`,
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

export function validateTask(spec: TaskSpec, allowedTools?: string[], readTools = READ_TOOLS, hooksExtension?: string): Promise<ValidTask> {
  return prepareTask(spec, spec => {
    const tools = spec.tools ?? (spec.preset === 'reader' ? READ_TOOLS : ALL_TOOLS).filter(tool => !allowedTools || allowedTools.includes(tool));
    if (!Array.isArray(tools) || tools.some(tool => typeof tool !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool)) || new Set(tools).size !== tools.length) throw new Error('Invalid child tool selection; use unique exact tool names');
    const unknown = connectorTools(tools).filter(tool => !allowedTools?.includes(tool));
    if (unknown.length) throw new Error(`Unavailable or disallowed child tools: ${unknown.join(', ')}. Configure exact connector grants in user-scoped subagents.json and activate the tools in the parent.`);
    const denied = allowedTools && tools.filter(tool => !allowedTools.includes(tool));
    if (denied?.length) throw new Error(`Explicit child tools exceed parent permissions: ${denied.join(', ')}`);
    assertReaderSelection(spec.preset, tools, readTools);
    return tools;
  }, hooksExtension);
}

function assertReaderSelection(preset: TaskSpec['preset'], tools: string[], readTools: string[]): void {
  const writes = tools.filter(tool => !readTools.includes(tool));
  if (preset === 'reader' && writes.length) throw new Error(`Reader preset cannot grant write tools: ${writes.join(', ')}`);
}

export function connectorTools(tools: string[]): string[] {
  return tools.filter(name => !ALL_TOOLS.includes(name));
}

export interface AdmissionResult { task: ValidTask; writer: boolean; bridge?: ConnectorBridge }
interface AdmissionSource {
  cwd: () => string;
  tools: () => string[];
  definitions?: ExtensionAPI['getAllTools'];
  grants: () => ConnectorGrants | undefined;
  config: (ctx: ExtensionContext) => ProfileConfig;
  selection: () => ExtensionContext | undefined;
  approve?: (title: string, request: string, signal: AbortSignal, ctx?: ExtensionContext) => Promise<boolean>;
}
export interface WorkflowAdmission {
  policyIdentity: string;
  profileIdentity?: string;
  identityDefaults?: Pick<TaskSpec, 'model' | 'thinking'>;
  admit: (input: Omit<TaskSpec, 'cwd'> & {cwd?: string}, cwd: string) => Promise<ValidTask>;
  replay: (task: ValidTask, signal: AbortSignal) => Promise<void>;
  request: (task: ValidTask) => {task: ValidTask; bridge?: ConnectorBridge};
  read: (path: string) => Promise<void>;
}

function validateBridge(task: ValidTask, bridge?: ConnectorBridge): ConnectorBridge | undefined {
  const connectors = connectorTools(task.tools);
  if (connectors.some(name => !bridge?.tools.some(tool => tool.name === name))) throw new Error(`Child connector tools require a callable parent bridge: ${connectors.join(', ')}`);
  if (bridge) {
    bridge = {...bridge, tools: bridge.tools.filter(tool => connectors.includes(tool.name))};
    if (Buffer.byteLength(JSON.stringify({type: 'tools', tools: bridge.tools})) + 1 > CONNECTOR_FRAME_LIMIT) throw new Error(`Connector definitions exceed 1 MiB: ${connectors.join(', ')}. Reduce the selected tools or their schemas/descriptions.`);
  }
  return bridge;
}

export class DelegationAdmission {
  constructor(private source: AdmissionSource) {}
  private parent(): DelegationScope {
    const registered = this.source.definitions?.();
    return {
      cwd: this.source.cwd(), tools: this.source.tools(), delegatedTools: this.source.grants(),
      registeredTools: registered?.map(tool => tool.name),
      callableTools: registered?.filter(tool => ['direct', 'deferred', 'codemode', 'codemode-deferred'].includes(tool.exposure ?? 'direct')).map(tool => tool.name),
      builtinTools: registered?.filter(tool => tool.sourceInfo?.path.startsWith('builtin:') && tool.sourceInfo.path !== 'builtin:mcp').map(tool => tool.name),
    };
  }
  private normalize(raw: Omit<TaskSpec, 'cwd'> & {cwd?: string}, ctx: ExtensionContext, config = this.source.config(ctx)): TaskSpec {
    assertTaskFields(raw);
    if (Array.isArray(raw.tools) && raw.tools.every(name => typeof name === 'string')) assertToolSelection(raw.tools, this.parent());
    if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error('Invalid child cwd');
    const task = {...raw, cwd: resolve(ctx.cwd, raw.cwd ?? '.')};
    return resolveProfile(task, config, ctx);
  }
  direct(raw: Omit<TaskSpec, 'cwd'> & {cwd?: string}, ctx?: ExtensionToolContext): {task: TaskSpec; bridge?: ConnectorBridge} {
    ctx ??= this.source.selection() as ExtensionToolContext;
    if (!ctx) throw new Error('A selected parent model or explicit provider/model is required');
    const task = this.normalize(raw, ctx);
    return {task, bridge: this.bridge(task, ctx)};
  }
  private bridge(task: TaskSpec, ctx: ExtensionToolContext): ConnectorBridge | undefined {
    const names = connectorTools(task.tools ?? []);
    if (!names.length) return undefined;
    const spawningCwd = this.parent().cwd;
    assertToolSelection(names, this.parent());
    if (typeof ctx.executeTool !== 'function' || !ctx.tools || names.some(name => !ctx.tools.some(tool => tool.name === name))) throw new Error(`Parent Pi cannot execute delegated tools: ${names.join(', ')}. Requires Pi 0.99.1+ tools/executeTool support.`);
    const definitions = this.source.definitions!();
    return {
      tools: names.map(name => {
        const tool = definitions.find(tool => tool.name === name)!;
        return {name: tool.name, description: tool.description, parameters: tool.parameters, annotations: tool.annotations, namespace: tool.namespace};
      }),
      execute: async (name, args, signal) => {
        signal.throwIfAborted();
        if (this.parent().cwd !== spawningCwd) throw new Error('Subagent parent workspace changed; resubmit task');
        if (task.configProvenance?.config !== this.source.config(ctx).identity) throw new Error('Subagent delegation configuration changed; resubmit task');
        assertToolSelection([name], this.parent());
        assertReaderSelection(task.preset, [name], delegationScope(this.parent()).readTools);
        if (!ctx.tools.some(tool => tool.name === name)) throw new Error(`Connector tool is no longer callable in the parent: ${name}`);
        const outcome = await ctx.executeTool(name, args, {signal});
        return {...outcome.result, isError: outcome.isError};
      },
    };
  }
  async queue(spec: TaskSpec, signal: AbortSignal, bridge?: ConnectorBridge): Promise<AdmissionResult> {
    if (!spec.configProvenance) {
      const ctx = this.source.selection();
      if (!ctx) throw new Error('A selected parent model or explicit provider/model is required');
      spec = this.normalize(spec, ctx);
    }
    const scope = delegationScope(this.parent());
    const task = await validateTask(spec, scope.tools, scope.readTools);
    bridge = validateBridge(task, bridge);
    signal.throwIfAborted();
    const ctx = this.source.selection();
    await assertChildTask(task, {parent: this.parent(), approve: this.source.approve && ctx?.hasUI ? (request => this.source.approve!('Approve local child extensions', request, signal, ctx)) : undefined});
    const readTools = delegationScope(this.parent()).readTools;
    return {task, bridge, writer: task.extensions.length > 0 || task.tools.some(tool => !readTools.includes(tool))};
  }
  launch(task: ValidTask): void {
    const scope = delegationScope(this.parent());
    if (task.tools.some(tool => !scope.tools.includes(tool))) throw new Error(`Child tools exceed current parent permissions at launch: ${task.tools.filter(tool => !scope.tools.includes(tool)).join(', ')}`);
    const ctx = this.source.selection();
    if (!ctx || !task.configProvenance) throw new Error('Subagent configuration or trust changed while queued; resubmit task');
    if (task.configProvenance.config !== this.source.config(ctx).identity) throw new Error('Subagent configuration or trust changed while queued; resubmit task');
    availableModel(task.model!, ctx.modelRegistry, task.profile);
  }
  workflow(ctx?: ExtensionToolContext, replaySignal?: AbortSignal): WorkflowAdmission {
    ctx ??= this.source.selection() as ExtensionToolContext;
    if (!ctx) throw new Error('A selected parent model or explicit provider/model is required');
    const captured = ctx;
    const config = this.source.config(captured), cwd = captured.cwd;
    const selection = {model: ctx.model, thinkingLevel: ctx.thinkingLevel, modelRegistry: ctx.modelRegistry};
    return {
      request: task => ({task, bridge: this.bridge(task, captured)}),
      policyIdentity: delegationScope(this.parent()).replayIdentity,
      profileIdentity: config.identity,
      identityDefaults: {model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`, thinking: ctx.thinkingLevel},
      admit: async (input, root) => {
        assertTaskFields(input);
        if (input.cwd !== undefined && typeof input.cwd !== 'string') throw new Error('Invalid child cwd');
        let task = {...input, cwd: input.cwd ? resolve(root, input.cwd) : root};
        if (this.source.config(captured).identity !== config.identity || captured.cwd !== cwd) throw new Error('Workflow configuration or workspace changed; restart workflow');
        if (Array.isArray(task.tools) && task.tools.every(name => typeof name === 'string')) assertToolSelection(task.tools, this.parent());
        task = resolveProfile(task, config, selection);
        const scope = delegationScope(this.parent());
        const validated = await validateTask(task, scope.tools, scope.readTools);
        if (!insideRoot(root, validated.cwd)) throw new Error('Child cwd escapes workflow cwd');
        return validated;
      },
      replay: async (task, signal) => {
        signal = replaySignal ?? signal;
        await assertChildTask(task, {parent: this.parent(), approve: this.source.approve && captured.hasUI ? (request => this.source.approve!('Approve workflow child extensions', request, signal, captured)) : undefined});
      },
      read: path => assertWorkflowRead(this.parent(), path),
    };
  }
}
