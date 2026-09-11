import { createHash, randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { resolveToolPath } from '../worktree/routing.ts';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Action { tool: string; input: Record<string, unknown>; cwd: string; provenance?: string }
export interface Decision { allow: boolean; reason: string; classification: 'safe'|'ask'|'unsafe' }
export interface PolicyIO {
  classify?: (request: string, signal: AbortSignal) => Promise<'safe'|'ask'|'unsafe'>;
  approve?: (request: string) => Promise<boolean>;
  context?: string;
}
export type Declaration = { version: 1; source: 'local'; extension: string; tool: string } & (
  { effect: 'read'|'write'; pathArgument: string } | { effect: 'managed'; pathArgument?: never }
);
interface Envelope { version: 1; root: string; tools: string[]; inherited: true; directives: string[]; provenance: string; policyFingerprint: string }
const builtinTools = ['read','write','edit','bash','grep','find','ls'];
export async function canonical(path: string): Promise<string> {
  let candidate = resolve(path);
  const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(candidate), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      tail.push(relative(parent,candidate)); candidate = parent;
    }
  }
}
// Match Pi 0.85.1 tools/path-utils and utils/paths before checking permissions.
async function piFilePath(raw:string, cwd:string, read:boolean):Promise<string> {
  const resolved=resolveToolPath(raw,cwd);
  if(!read) return resolved;
  // Pi read retries macOS screenshot and Unicode filename variants. Check the
  // actual existing candidate, including symlinks, rather than the missing name.
  const candidates=[resolved,resolved.replace(/ (AM|PM)\./gi,'\u202F$1.'),resolved.normalize('NFD'),resolved.replace(/'/g,'\u2019'),resolved.normalize('NFD').replace(/'/g,'\u2019')];
  for(const candidate of candidates) {
    try {await access(candidate);return candidate;} catch {/* Try the next SDK variant. */}
  }
  return resolved;
}
function sensitiveComponent(p:string):boolean { return ['.git','.pi','.agents','.codex','AGENTS.md','CLAUDE.md','id_rsa','id_ed25519','auth.json','credentials','credentials.json'].includes(p) || /^\.env(?:\.|$)|^credentials(?:\.|$)/i.test(p); }
function within(root: string, path: string) { const r = relative(root,path); return r === '' || (!r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && r !== '..' && !isAbsolute(r)); }
export class AutoPolicy {
  mode: 'on'|'off' = 'on';
  readonly approvals = new Set<string>();
  readonly audit: {kind:string; detail:string; timestamp:number}[] = [];
  readonly directives: string[] = [];
  private readonly scope=randomUUID();
  private declarations = new Map<string,Declaration>();
  constructor(public root: string, readonly tools: string[] = [...builtinTools], readonly inherited = false) {}
  fingerprint() { return createHash('sha256').update(JSON.stringify({version:1,mode:this.mode,tools:this.tools,declarations:[...this.declarations],directives:this.directives})).digest('hex'); }
  record(kind:string, detail:string) { this.audit.push({kind,detail:detail.slice(0,4000),timestamp:Date.now()}); if(this.audit.length>500) this.audit.shift(); }
  directive(value:string) { this.directives.push(value.slice(0,4000)); if(this.directives.length>12) this.directives.shift(); this.approvals.clear(); this.record('directive',value); }
  declare(value:Declaration) {
    if(value.version!==1 || value.source!=='local' || !isAbsolute(value.extension) || !value.tool || !['read','write','managed'].includes(value.effect) || (value.effect !== 'managed' && !value.pathArgument) || (value.effect === 'managed' && value.pathArgument !== undefined)) throw new Error('Only versioned trusted local declarations are accepted');
    if (builtinTools.includes(value.tool)) throw new Error('Cannot replace a builtin declaration');
    if(this.inherited && !this.tools.includes(value.tool)) throw new Error('Declaration exceeds inherited tools');
    if(!this.tools.includes(value.tool)) this.tools.push(value.tool);
    this.declarations.set(value.tool,{...value}); this.approvals.clear(); this.record('declaration',JSON.stringify(value));
  }
  async check(action:Action, io:PolicyIO = {}):Promise<Decision> {
    const finish = (allow:boolean, classification:Decision['classification'],reason:string):Decision => { this.record('action',JSON.stringify({tool:action.tool,cwd:action.cwd,provenance:action.provenance,allow,classification,reason})); return {allow,classification,reason}; };
    if(this.mode==='off' && !this.inherited) return finish(true,'safe','Auto mode disabled');
    try {
      const root=await canonical(this.root), cwd=await canonical(action.cwd);
      const declaration=this.declarations.get(action.tool);
      if(this.inherited && !this.tools.includes(action.tool)) return finish(false,'unsafe','Tool is outside inherited permissions');
      const argument = declaration?.pathArgument ?? (['read','write','edit','grep','find','ls'].includes(action.tool)?'path':undefined);
      const raw=argument ? action.input[argument] : undefined;
      if(argument && typeof raw!=='string' && !(raw===undefined && ['grep','find','ls'].includes(action.tool))) return finish(false,'unsafe','Invalid file path argument');
      const path=argument && (raw===undefined && ['grep','find','ls'].includes(action.tool) || typeof raw==='string') ? await canonical(declaration ? resolve(cwd,typeof raw==='string'?raw:'.') : await piFilePath(typeof raw==='string'?raw:'.',cwd,action.tool==='read')) : undefined;
      const bounded=within(root,cwd) && (!path || within(root,path));
      if(this.inherited && !bounded) return finish(false,'unsafe','Path is outside inherited workspace');
      if(bounded && declaration?.effect==='managed') return finish(true,'safe',`Trusted local managed operation ${declaration.extension} v1`);
      // Protect repository metadata and instructions from model-free modification.
      const sensitive=path && relative(root,path).split(/[\\/]/).some(sensitiveComponent);
      // Pi grep includes hidden files. Only a specific regular file can use
      // the file-level sensitivity check; a directory may contain credentials.
      const directorySearch=action.tool==='grep' && (!path || !(await stat(path).catch(()=>undefined))?.isFile());
      if(bounded && path && !sensitive && !directorySearch) return finish(true,'safe',declaration ? `Local declaration ${declaration.extension} v1` : 'Canonical workspace file operation');
      if(bounded && action.tool==='bash' && action.input.command==='pwd') return finish(true,'safe','Literal pwd');
      const request=JSON.stringify({action:{...action,cwd},resolvedPath:path,root,directives:this.directives,context:(io.context??'').slice(-12000)});
      const key=createHash('sha256').update(JSON.stringify({version:1,scope:this.scope,action:{...action,cwd},resolvedPath:path,root,policy:this.fingerprint()})).digest('hex');
      if(this.approvals.has(key)) return finish(true,'safe','Existing exact approval');
      let classification:Decision['classification']='ask';
      if(io.classify) {
        const controller=new AbortController();
        let timer:ReturnType<typeof setTimeout>|undefined;
        try { classification=await Promise.race([io.classify(request.slice(0,24000),controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Classifier timed out'));},10000);})]); }
        catch { return finish(false,'unsafe','Classifier failed; blocked'); }
        finally { clearTimeout(timer); }
        if(!['safe','ask','unsafe'].includes(classification)) return finish(false,'unsafe','Invalid classifier result; blocked');
      }
      if(classification==='unsafe') return finish(false,'unsafe','Classifier rejected action');
      // The model cannot expand deterministic filesystem or extension trust boundaries.
      if(classification==='safe' && bounded && !sensitive && !directorySearch && this.tools.includes(action.tool)) return finish(true,'safe','Classifier accepted permitted bounded action');
      if(!io.approve) return finish(false,'ask','Approval required but interactive UI unavailable');
      try {
        if(await io.approve(JSON.stringify({tool:action.tool,input:action.input,cwd,resolvedPath:path,provenance:action.provenance},null,2))) { this.approvals.add(key);this.record('approval',JSON.stringify({key,tool:action.tool,cwd,provenance:action.provenance}));return finish(true,'ask','User approved exact action'); }
      } catch { return finish(false,'ask','Approval failed; blocked'); }
      return finish(false,'ask','User declined action');
    } catch { return finish(false,'unsafe','Policy validation failed; blocked'); }
  }
}
const activeKey=Symbol.for('pi-agent-workflows.auto-policy');
const shared=globalThis as typeof globalThis & {[activeKey]?:Map<string,AutoPolicy>};
const policies=shared[activeKey]??=new Map<string,AutoPolicy>();
export function setActivePolicy(policy:AutoPolicy|undefined, sessionId='default') { if(policy) policies.set(sessionId,policy);else policies.delete(sessionId); }
export function inheritedPolicy():AutoPolicy|undefined {
  const raw=process.env.PI_AGENT_POLICY;
  if(!raw) return undefined;
  const data=JSON.parse(raw) as Envelope;
  if(data.version!==1 || data.inherited!==true || !isAbsolute(data.root) || !Array.isArray(data.tools) || data.tools.some(t=>typeof t!=='string')) throw new Error('Invalid inherited policy');
  if(!Array.isArray(data.directives) || data.directives.some(d=>typeof d!=='string') || typeof data.provenance!=='string' || typeof data.policyFingerprint!=='string') throw new Error('Invalid inherited provenance');
  const policy=new AutoPolicy(data.root,data.tools,true);
  for(const directive of data.directives) policy.directive(directive);
  policy.record('inherited',data.provenance);
  return policy;
}
export function childPolicy(cwd:string, tools?:string[], sessionId='default'):{env:Record<string,string>;extensions:string[]} {
  const policy=policies.get(sessionId)??inheritedPolicy()??new AutoPolicy(cwd);
  return {env:{PI_AGENT_POLICY:JSON.stringify({version:1,root:cwd,tools:tools?tools.filter(t=>policy.tools.includes(t)):policy.tools,inherited:true,directives:[...policy.directives],provenance:'Parent subagent/workflow task',policyFingerprint:policy.fingerprint()} satisfies Envelope)},extensions:[fileURLToPath(new URL('./index.ts',import.meta.url))]};
}
export async function assertChildTask(task:{cwd:string;tools:string[];extensions?:string[]}, options:{approve?:(request:string)=>Promise<boolean>} = {}, sessionId='default'):Promise<void> {
  const policy=policies.get(sessionId)??inheritedPolicy()??new AutoPolicy(task.cwd);
  const root=await canonical(policy.root), cwd=await canonical(task.cwd);
  if(!within(root,cwd)) throw new Error('Child cwd is outside parent workspace');
  if(relative(root,cwd).split(/[\\/]/).some(sensitiveComponent)) throw new Error('Child cwd is sensitive or repository control data');
  if(task.tools.some(t=>!policy.tools.includes(t))) throw new Error('Child tools exceed parent permissions');
  if(task.extensions?.length) {
    for(const extension of task.extensions) {
      if(!isAbsolute(extension)) throw new Error('Child extensions must be absolute local paths');
      await realpath(extension);
    }
    if(!options.approve || !await options.approve(`Load trusted local child extensions with host privileges? ${JSON.stringify(task.extensions)}`)) throw new Error('Child extension loading was not approved');
  }
}
/** Apply the same active or inherited policy to host-mediated workflow operations. */
export async function checkAction(action:Action, io:PolicyIO = {}, sessionId='default'):Promise<Decision> {
  return (policies.get(sessionId)??inheritedPolicy()??new AutoPolicy(action.cwd)).check(action,io);
}
