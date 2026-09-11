import { clampThinkingLevel, type Api, type Model, type Provider } from '@earendil-works/pi-ai';
// This helper needs a filesystem runtime dependency; Pi's virtual root alias
// does not resolve import.meta.resolve or arbitrary package subpaths.
let buildBaseOptions: typeof import('@earendil-works/pi-ai/api/simple-options').buildBaseOptions | undefined;
try {
 buildBaseOptions = (await import(new URL('./api/simple-options.js', import.meta.resolve('@earendil-works/pi-ai')).href)).buildBaseOptions;
} catch { /* Leave base providers usable if the optional fast adapter is unavailable. */ }
const WRAPPED=Symbol.for('pi-interactive:fast-provider');
export const FAST_SUFFIX='~fast';
function supported(model:Model<Api>):boolean {
 try {
  const origin=new URL(model.baseUrl).origin;
  return (model.provider==='openai' && model.api==='openai-responses' && origin==='https://api.openai.com') ||
   (model.provider==='openai-codex' && model.api==='openai-codex-responses' && origin==='https://chatgpt.com');
 } catch {return false;}
}
export function withFastModels(original:Provider):Provider {
 if(!buildBaseOptions)return original;
 const baseOptions=buildBaseOptions;
 // Pi models.json overlays recompose provider objects and discard symbols,
 // but retain the fast aliases. Treat those as the installed adapter too.
 if((original as Provider & { [WRAPPED]?: boolean })[WRAPPED] || original.getModels().some(model=>model.id.endsWith(FAST_SUFFIX))) return original;
 const aliases=(models:readonly Model<Api>[])=>models.flatMap(model=>supported(model)&&!model.id.endsWith(FAST_SUFFIX)?[model,{...model,id:model.id+FAST_SUFFIX,name:model.name+' (fast)'}]:[model]);
 const resolve=(model:Model<Api>)=>{
  if(!model.id.endsWith(FAST_SUFFIX))return {model,fast:false};
  const base=original.getModels().find(m=>m.id===model.id.slice(0,-FAST_SUFFIX.length));
  if(!base || !supported(base))throw new Error('Fast model no longer available');
  // Preserve auth-resolved request headers/base URL while restoring base pricing and id.
  return {model:{...model,id:base.id,cost:base.cost},fast:true};
 };
 const wrapped:Provider={
  ...original,
  getModels:()=>aliases(original.getModels()),
  filterModels:original.filterModels ? (models,credential)=>{
   const bases=models.filter(m=>!m.id.endsWith(FAST_SUFFIX));
   return aliases(original.filterModels!(bases,credential));
  }:undefined,
  stream(model,context,options){const resolved=resolve(model);return original.stream(resolved.model,context,resolved.fast?{...options,serviceTier:'priority'}:options);},
  streamSimple(model,context,options){
   const resolved=resolve(model);
   if(!resolved.fast)return original.streamSimple(model,context,options);
   const level=options?.reasoning?clampThinkingLevel(resolved.model,options.reasoning):undefined;
   return original.stream(resolved.model,context,{
    ...baseOptions(resolved.model,context,options,options?.apiKey),
    toolChoice:options?.toolChoice,reasoningEffort:level==='off'?undefined:level,serviceTier:'priority',
   });
  },
 };
 Object.defineProperty(wrapped,WRAPPED,{value:true});
 return wrapped;
}
