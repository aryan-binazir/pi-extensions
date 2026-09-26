import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Provider as ModelProvider } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { FAST_SUFFIX, withFastModels } from './provider.ts';
type BranchEntry=ReturnType<ExtensionContext['sessionManager']['getBranch']>[number];
type ModelChange=Extract<BranchEntry,{type:'model_change'}>;
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
 pi.on('session_start',async(event,ctx)=>{
  install(ctx);
  if(!['resume','startup'].includes(event.reason))return;
  if(event.reason==='startup'&&process.argv.some(arg=>/^--(?:model|provider)(?:=|$)/.test(arg)))return;
  const previous=[...ctx.sessionManager.getBranch()].reverse().find((entry):entry is ModelChange=>entry.type==='model_change');
  if(!previous||!previous.modelId.endsWith(FAST_SUFFIX))return;
  const restored=ctx.modelRegistry.find(previous.provider,previous.modelId);
  if(!restored)return;
  const effort=pi.getThinkingLevel();
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
