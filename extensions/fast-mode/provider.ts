import { lazyStream, type Api, type Model, type Provider, type StreamOptions } from '@earendil-works/pi-ai';
type SimpleOptions=Parameters<Provider['streamSimple']>[2];
function anthropicFast(original:Provider,model:Model<Api>,context:Parameters<Provider['stream']>[1],options:StreamOptions|undefined,simple:boolean) {
 let fast=true;
 return lazyStream(model,async()=>{
  const source=original[simple?'streamSimple':'stream'](model,context,{
   ...options,
   async onPayload(payload,current) {
    const request:Record<string,unknown>={...payload as Record<string,unknown>,speed:'fast'};
    if(/^claude-opus-(?:4-8|5)(?:-\d{8})?$/.test(model.id)) {
     const betas=Array.isArray(request.betas)?request.betas:[];
     request.betas=[...new Set([...betas,'fast-mode-2026-02-01'])];
    }
    const replacement=await options?.onPayload?.(request,current);
    const effective=replacement===undefined?request:replacement;
    fast=!!effective && typeof effective==='object' && 'speed' in effective && effective.speed==='fast';
    return effective;
   },
   async onProviderStreamEvent(data,current) {
    if(data && typeof data==='object') {
     const message='message' in data?data.message:data;
     const usage=message && typeof message==='object' && 'usage' in message?message.usage:undefined;
     if(usage && typeof usage==='object' && 'speed' in usage) {
      if(usage.speed==='fast'||usage.speed==='standard')fast=usage.speed==='fast';
     }
    }
    await options?.onProviderStreamEvent?.(data,current);
   },
  });
  return {
   async *[Symbol.asyncIterator]() {
    for await(const event of source) {
     if(fast && (event.type==='done'||event.type==='error')) {
      const cost=(event.type==='done'?event.message:event.error).usage.cost;
      for(const key of ['input','output','cacheRead','cacheWrite','total'] as const)cost[key]*=2;
     }
     yield event;
    }
   },
  };
 });
}
function prioritySimple(original:Provider,model:Model<Api>,context:Parameters<Provider['streamSimple']>[1],options:SimpleOptions) {
 let reportedTier=false;
 return lazyStream(model,async()=>{
  const source=original.streamSimple(model,context,{
   ...options,
   async onPayload(payload,current) {
    const priority={...payload as Record<string,unknown>,service_tier:'priority'};
    const replacement=await options?.onPayload?.(priority,current);
    return replacement===undefined?priority:replacement;
   },
   async onProviderStreamEvent(data,current) {
    if(data && typeof data==='object' && 'type' in data && ['response.completed','response.done','response.incomplete'].includes(String(data.type))) {
     const response='response' in data?data.response:undefined;
     reportedTier=!!response && typeof response==='object' && 'service_tier' in response && response.service_tier!=null;
    }
    await options?.onProviderStreamEvent?.(data,current);
   },
  });
  return {
   async *[Symbol.asyncIterator]() {
    for await(const event of source) {
     if(!reportedTier && (event.type==='done'||event.type==='error')) {
      const message=event.type==='done'?event.message:event.error;
      const multiplier=model.id==='gpt-5.5'?2.5:2;
      const cost=message.usage.cost;
      for(const key of ['input','output','cacheRead','cacheWrite','total'] as const)cost[key]*=multiplier;
     }
     yield event;
    }
   },
  };
 });
}
const WRAPPED=Symbol.for('pi-interactive:fast-provider');
export const FAST_SUFFIX='~fast';
type CatalogEntry=Provider extends {getAllModels?:()=>readonly (infer Entry)[]} ? Entry : {id:string;type?:string};
type CatalogProvider=Provider & {getAllModels?:()=>readonly CatalogEntry[]};
function eligibility(model:Model<Api>):boolean {
 try {
  const origin=new URL(model.baseUrl).origin;
  return (model.provider==='openai' && model.api==='openai-responses' && origin==='https://api.openai.com') ||
   (model.provider==='openai-codex' && model.api==='openai-codex-responses' && origin==='https://chatgpt.com') ||
   (model.provider==='anthropic' && model.api==='anthropic-messages' && origin==='https://api.anthropic.com' && model.id.startsWith('claude-'));
 } catch {return false;}
}
const supportedCache=new WeakMap<Model<Api>,boolean>();
function supported(model:Model<Api>):boolean {
 let result=supportedCache.get(model);
 if(result===undefined)supportedCache.set(model,result=eligibility(model));
 return result;
}
export function withFastModels(original:Provider,view:Provider=original):CatalogProvider {
 if((original as Provider & { [WRAPPED]?: boolean })[WRAPPED] || original.getModels().some(model=>model.id.endsWith(FAST_SUFFIX))) return original;
 const eligible=new Map(view.getModels().filter(supported).map(model=>[model.id,model]));
 const bases=original.getModels();
 const custom=[...eligible.values()].filter(model=>!bases.some(base=>base.id===model.id)&&!model.id.endsWith(FAST_SUFFIX));
 const aliasCache=new WeakMap<Model<Api>,Model<Api>|null>();
 const aliasOf=(model:Model<Api>):Model<Api>|null=>{
  let alias=aliasCache.get(model);
  if(alias===undefined)aliasCache.set(model,alias=eligible.has(model.id)&&!model.id.endsWith(FAST_SUFFIX)&&supported(model)?{...model,id:model.id+FAST_SUFFIX,name:model.name+' (fast)'}:null);
  return alias;
 };
 const aliases=(models:readonly Model<Api>[],extras:readonly Model<Api>[]=[])=>{
  const out:Model<Api>[]=[];
  for(const model of models){out.push(model);const alias=aliasOf(model);if(alias)out.push(alias);}
  for(const extra of extras)if(!models.some(base=>base.id===extra.id)){const alias=aliasOf(extra);if(alias)out.push(alias);}
  return out;
 };
 const resolve=(model:Model<Api>)=>{
  if(!model.id.endsWith(FAST_SUFFIX))return {model,fast:false};
  const baseId=model.id.slice(0,-FAST_SUFFIX.length);
  const base=original.getModels().find(candidate=>candidate.id===baseId)??custom.find(candidate=>candidate.id===baseId);
  if(!base || !supported(base))throw new Error('Fast model no longer available');
  return {model:{...model,id:base.id,cost:base.cost},fast:true};
 };
 const catalog:CatalogProvider=original;
 const getAllModels=catalog.getAllModels;
 const wrapped:CatalogProvider={
  ...original,
  ...(getAllModels?{getAllModels:()=>{
   const models=getAllModels.call(original);
   const chatIds=new Set(models.filter(model=>model.type===undefined||model.type==='chat').map(model=>model.id));
   const fast=aliases(original.getModels(),custom).filter(model=>model.id.endsWith(FAST_SUFFIX)&&!chatIds.has(model.id));
   return [...models,...fast];
  }}:{}),
  getModels:()=>aliases(original.getModels(),custom),
  filterModels:original.filterModels ? (models,credential)=>{
   const withoutAliases=models.filter(model=>!model.id.endsWith(FAST_SUFFIX));
   return aliases(original.filterModels!(withoutAliases,credential));
  }:undefined,
  stream(model,context,options){
   const resolved=resolve(model);
   if(resolved.fast && resolved.model.api==='anthropic-messages')return anthropicFast(original,resolved.model,context,options,false);
   return original.stream(resolved.model,context,resolved.fast?{...options,serviceTier:'priority'}:options);
  },
  streamSimple(model,context,options){
   const resolved=resolve(model);
   if(!resolved.fast)return original.streamSimple(model,context,options);
   if(resolved.model.api==='anthropic-messages')return anthropicFast(original,resolved.model,context,options,true);
   return prioritySimple(original,resolved.model,context,options);
  },
 };
 Object.defineProperty(wrapped,WRAPPED,{value:true});
 return wrapped;
}
