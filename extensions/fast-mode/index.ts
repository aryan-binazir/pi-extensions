import { parseArgs, resolveModelScopeWithDiagnostics, type ExtensionAPI, type ExtensionContext, type ModelRuntime, type ScopedModel } from '@earendil-works/pi-coding-agent';
import type { Provider as ModelProvider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { FAST_SUFFIX, withFastModels } from './provider.ts';
type BranchEntry=ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];
type ModelChange=Extract<BranchEntry,{type:'model_change'}>;
// Importing pi-ai's modelsAreEqual at runtime here added about 0.3 ms to each jiti load in A/B runs.
const same=(a:{provider:string;id:string},b?:{provider:string;id:string})=>a.provider===b?.provider&&a.id===b.id;
export default function fastMode(pi:ExtensionAPI):void {
 const install=(ctx:ExtensionContext)=>{
  for(const id of ['openai','openai-codex']) {
   // Native registration replaces legacy config, including another extension's endpoint and auth.
   if(ctx.modelRegistry.getRegisteredProviderConfig(id))continue;
   const view=ctx.modelRegistry.getProvider(id);
   // Pi 0.85.1 private runtime.builtins preserves the pi.dev catalog; public factories are the fallback.
   const provider=ctx.modelRegistry.getRegisteredNativeProvider(id)
    ?? (ctx.modelRegistry as unknown as {runtime?:{builtins?:Map<string,ModelProvider>}}).runtime?.builtins?.get(id)
    ?? builtinProviders().find(provider=>provider.id===id);
   if(provider && view) {const wrapped=withFastModels(provider,view);if(wrapped!==provider)pi.registerProvider(wrapped);}
  }
 };
 // Pi picks a new session's model before session_start registers aliases; redo its saved-default and scope choice.
 const restoreDefault=async(ctx:ExtensionContext)=>{
  const args=parseArgs(process.argv.slice(2));const settings=pi.getSettings();
  const patterns=args.models??settings.enabledModels;
  // Pi resolves --model first; --provider alone selects nothing.
  if(args.model!==undefined||(!patterns?.length&&!settings.defaultModel?.endsWith(FAST_SUFFIX)))return;
  const available={getAvailable:async()=>ctx.modelRegistry.getAvailable()} as unknown as ModelRuntime;
  const scoped=patterns?.length?(await resolveModelScopeWithDiagnostics(patterns,available)).scopedModels:[];
  const saved=settings.defaultProvider&&settings.defaultModel?ctx.modelRegistry.find(settings.defaultProvider,settings.defaultModel):undefined;
  const choice:ScopedModel|undefined=scoped.find(entry=>same(entry.model,saved))??scoped[0]??(saved&&{model:saved});
  if(!choice?.model.id.endsWith(FAST_SUFFIX)||same(choice.model,ctx.model))return;
  // 'medium' is Pi's DEFAULT_THINKING_LEVEL.
  const effort=args.thinking??choice.thinkingLevel??settings.modelThinkingLevels?.[`${choice.model.provider}/${choice.model.id}`]??settings.defaultThinkingLevel??'medium';
  if(await pi.setModel(choice.model))pi.setThinkingLevel(effort);
 };
 pi.on('session_start',async(event,ctx)=>{
  install(ctx);
  if(event.reason==='reload')return;
  const branch=event.reason==='new'?[]:[...ctx.sessionManager.getBranch()].reverse();
  // Like Pi, treat /new and branches without context messages as new sessions.
  if(!branch.some(entry=>['message','custom_message','branch_summary','compaction'].includes(entry.type))){await restoreDefault(ctx);return;}
  if(event.reason==='startup'&&process.argv.some(arg=>/^--(?:model|provider)(?:=|$)/.test(arg)))return;
  const previous=branch.find((entry):entry is ModelChange=>entry.type==='model_change');
  if(!previous||!previous.modelId.endsWith(FAST_SUFFIX))return;
  const restored=ctx.modelRegistry.find(previous.provider,previous.modelId);
  if(!restored)return;
  const startupEffort=event.reason==='startup'?parseArgs(process.argv.slice(2)).thinking:undefined;
  const savedEffort=branch.find(entry=>entry.type==='thinking_level_change')?.thinkingLevel;
  const effort=startupEffort??parseArgs(savedEffort?['--thinking',savedEffort]:[]).thinking??pi.getThinkingLevel();
  if(await pi.setModel(restored))pi.setThinkingLevel(effort);
 });
 pi.registerCommand('fast',{
  description:'Toggle priority processing on supported OpenAI models; entitlement and speed are not guaranteed',
  async handler(args,ctx){
   if(args.trim() && !['on','off'].includes(args.trim())){ctx.ui.notify('Usage: /fast [on|off]','error');return;}
   install(ctx);
   const current=ctx.model;
   if(!current){ctx.ui.notify('No selected model','error');return;}
   const active=current.id.endsWith(FAST_SUFFIX);
   const enabled=args.trim()?args.trim()==='on':!active;
   const id=(active?current.id.slice(0,-FAST_SUFFIX.length):current.id)+(enabled?FAST_SUFFIX:'');
   const next=ctx.modelRegistry.find(current.provider,id);
   if(!next){ctx.ui.notify('Fast mode is unavailable for this provider path','error');return;}
   const effort=pi.getThinkingLevel();
   if(!(await pi.setModel(next))){ctx.ui.notify('Model authentication unavailable','error');return;}
   pi.setThinkingLevel(effort);
   ctx.ui.notify(enabled?'Fast requested. Provider tier pricing applies; entitlement is unverified.':'Fast disabled','info');
  },
 });
}
