import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAST_SUFFIX, withFastModels } from './provider.ts';
export default function fastMode(pi:ExtensionAPI):void {
 const install=(ctx:ExtensionContext)=>{
  for(const id of ['openai','openai-codex']) {
   const provider=ctx.modelRegistry.getProvider(id);
   if(provider) {const wrapped=withFastModels(provider);if(wrapped!==provider)pi.registerProvider(wrapped);}
  }
 };
 pi.on('session_start',async(event,ctx)=>{
  install(ctx);
  if(!['resume','startup'].includes(event.reason))return;
  // Explicit CLI selection takes precedence over the stored alias on startup.
  if(event.reason==='startup'&&process.argv.some(arg=>/^--(?:model|provider)(?:=|$)/.test(arg)))return;
  const previous=[...ctx.sessionManager.getBranch()].reverse().find(entry=>entry.type==='model_change');
  if(previous?.type!=='model_change'||!previous.modelId.endsWith(FAST_SUFFIX))return;
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
   const id=current.id.replace(/~fast$/,'')+(enabled?FAST_SUFFIX:'');
   const next=ctx.modelRegistry.find(current.provider,id);
   if(!next || (!active && next===current && enabled)){ctx.ui.notify('Fast mode is unavailable for this provider path','error');return;}
   const effort=pi.getThinkingLevel();
   if(!(await pi.setModel(next))){ctx.ui.notify('Model authentication unavailable','error');return;}
   pi.setThinkingLevel(effort);
   ctx.ui.notify(enabled?'Fast requested. Provider tier pricing applies; entitlement is unverified.':'Fast disabled','info');
  },
 });
}
