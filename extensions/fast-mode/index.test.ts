import assert from 'node:assert/strict';
import test from 'node:test';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createModels, getSupportedThinkingLevels, type ThinkingLevel, type Provider } from '@earendil-works/pi-ai';
import { withFastModels } from './provider.ts';

const priorityRate=(model:{id:string})=>model.id==='gpt-5.5'?2.5:2;

test('both model views expose unique chat aliases and preserve the complete mixed catalog',()=>{
 const original=openaiProvider();
 const base={...original.getModels().find(model=>model.id==='gpt-5.5')!,type:undefined};
 const other={...base,id:'gpt-direct',type:'chat' as const};
 const image={...base,id:'gpt-5.5~fast',type:'image' as const,api:'fixture-images',output:['image'] as ['image']};
 const classifier={...base,type:'classifier' as const,api:'fixture-classifier'};
 const existing={...other,id:'gpt-direct~fast',name:'Existing alias'};
 let chats=[base,other];
 let catalog=[image,existing,{...base},classifier,{...other}];
 const mixed={...original,getModels:()=>chats,getAllModels(){assert.equal(this,mixed);return catalog;},filterModels:(models:ReturnType<Provider['getModels']>)=>models.filter(model=>model.id===base.id)};
 const provider=withFastModels(mixed);
 const expected=['gpt-5.5','gpt-5.5~fast','gpt-direct','gpt-direct~fast'];
 assert.deepEqual(provider.getModels().map(model=>model.id),expected);
 assert.ok('getAllModels' in provider && typeof provider.getAllModels==='function');
 const all=provider.getAllModels();
 assert.deepEqual(all.filter(model=>model.type===undefined||model.type==='chat').map(model=>model.id).sort(),[...expected].sort());
 assert.equal(all.find(model=>model.type==='image'),image);
 assert.equal(all.find(model=>model.type==='classifier'),classifier);
 assert.equal(all.find(model=>model.id==='gpt-direct~fast'),existing);
 assert.deepEqual(provider.filterModels!(provider.getModels(),undefined).map(model=>model.id),['gpt-5.5','gpt-5.5~fast']);
 assert.equal(withFastModels(provider),provider);
 chats=[{...base,name:'Updated catalog model'}];
 catalog=[image,...chats,classifier];
 const refreshed=provider.getAllModels();
 assert.equal(refreshed.find(model=>model.type==='image'),image);
 assert.equal(refreshed.find(model=>model.type==='classifier'),classifier);
 assert.deepEqual(refreshed.find(model=>model.id==='gpt-5.5'&&model.type===undefined),{...base,name:'Updated catalog model'});
 assert.deepEqual(provider.getModels().map(model=>model.id),['gpt-5.5','gpt-5.5~fast']);
 assert.equal(provider.getModels()[1].name,'Updated catalog model (fast)');
});

test('provider-owned fast IDs retain their original routing and filtering',async()=>{
 const original=openaiProvider();
 const base=original.getModels().find(model=>model.id==='gpt-5.5')!;
 const nativeAlias={...base,id:'gpt-5.5~fast',name:'Provider-owned model'};
 for(const models of [[base,nativeAlias],[nativeAlias]]) {
  const native={...original,getModels:()=>models,filterModels:(models:ReturnType<Provider['getModels']>)=>models};
  const provider=withFastModels(native);
  assert.equal(provider,native);
  assert.deepEqual(provider.filterModels(provider.getModels()),models);
  const collection=createModels({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore()});
  collection.setProvider(provider);
  let payload:Record<string,unknown>|undefined;
  const fetch:typeof globalThis.fetch=async(_url,init)=>{
   payload=JSON.parse(String(init?.body));
   return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:0,output_tokens:0}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const output=await collection.streamSimple(nativeAlias,{messages:[]},{apiKey:'fixture-key',fetch,maxRetries:0}).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);
  assert.equal(payload!.model,'gpt-5.5~fast');
  assert.equal(payload!.service_tier,undefined);
 }
});

test('fast aliases preserve auth and pricing metadata and send priority through real provider',async()=>{
 const original=openaiProvider(); const provider=withFastModels(original);
 assert.equal(provider.auth,original.auth);
 const base=original.getModels().find(m=>m.id==='gpt-5.5')!;
 const alias=provider.getModels().find(m=>m.id===base.id+'~fast')!;
 assert.deepEqual(alias.cost,base.cost);
 for(const reasoning of getSupportedThinkingLevels(base)) {
  let payload:any;let headers:Headers|undefined;
  const fetch:typeof globalThis.fetch=async(_url,init)=>{
   payload=JSON.parse(String(init?.body));headers=new Headers(init?.headers);
   return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',service_tier:'priority',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  // Pi's runtime handles 'off', but its simple-options type excludes it.
  const output=await provider.streamSimple(alias,{messages:[]},{apiKey:'fixture-key',reasoning:reasoning as ThinkingLevel,fetch,maxRetries:0}).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);
  assert.equal(payload.model,base.id);assert.equal(payload.service_tier,'priority');
  assert.equal(headers!.get('authorization'),'Bearer fixture-key');
  assert.equal(payload.reasoning.effort,reasoning==='off'?'none':base.thinkingLevelMap?.[reasoning]??reasoning);
  assert.equal(output.usage.cost.input,base.cost.input*0.001*priorityRate(base));
 }
 assert.equal(withFastModels(provider),provider,'reload must not wrap twice');
});

import fastMode from './index.ts';
test('toggle and resume keep reasoning; other provider paths remain untouched',async()=>{
 const original=openaiProvider();const models=original.getModels();const base=models.find(m=>m.id==='gpt-5.5')!;
 let provider:any=original;let selected:any=base;let effort='high';let command:any;let resume:any;let registrations=0;
 const ctx:any={model:base,modelRegistry:{getRegisteredProviderConfig:()=>undefined,getRegisteredNativeProvider:(id:string)=>id==='openai'&&registrations?provider:undefined,getProvider:(id:string)=>id==='openai'?provider:undefined,find:(id:string,name:string)=>id==='openai'?provider.getModels().find((m:any)=>m.id===name):undefined},sessionManager:{getBranch:()=>[{type:'model_change',provider:'openai',modelId:'gpt-5.5~fast'}]},ui:{notify(){}}};
 fastMode({registerProvider:(p:any)=>{registrations++;provider=p;},on:(name:string,fn:any)=>{if(name==='session_start')resume=fn;},registerCommand:(_name:string,entry:any)=>{command=entry;},getThinkingLevel:()=>effort,setThinkingLevel:(value:string)=>{effort=value;},setModel:async(value:any)=>{selected=value;ctx.model=value;effort='low';return true;}} as any);
 await command.handler('',ctx);assert.equal(selected.id,'gpt-5.5~fast');assert.equal(effort,'high');
 await command.handler('',ctx);assert.equal(selected.id,'gpt-5.5');assert.equal(effort,'high');
 await resume({reason:'resume'},ctx);assert.equal(selected.id,'gpt-5.5~fast');assert.equal(effort,'high');assert.equal(registrations,1);
 const proxy={...original,getModels:()=>[{...base,baseUrl:'https://proxy.example/v1'}]};
 assert.equal(withFastModels(proxy).getModels().length,1);
});
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
test('Codex fast sends priority using existing subscription auth and reasoning',async()=>{
 const original=openaiCodexProvider();const provider=withFastModels(original);
 const base=original.getModels().find(m=>m.id==='gpt-5.5')??original.getModels()[0];
 const alias=provider.getModels().find(m=>m.id===base.id+'~fast')!;
 const token='fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.fixture';
 let payload:any;let headers:Headers|undefined;
 const fetch:typeof globalThis.fetch=async(_url,init)=>{headers=new Headers(init?.headers);const body=headers.get('content-encoding')==='zstd'?(await import('node:zlib') as any).zstdDecompressSync(init?.body).toString():String(init?.body);payload=JSON.parse(body);return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',service_tier:'priority',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
 const output=await provider.streamSimple(alias,{messages:[]},{apiKey:token,reasoning:'low',fetch,transport:'sse',maxRetries:0}).result();
 assert.equal(output.stopReason,'stop',output.errorMessage);assert.equal(payload.model,base.id);assert.equal(payload.service_tier,'priority');
 assert.equal(payload.reasoning.effort,'low');assert.equal(headers!.get('chatgpt-account-id'),'fixture-account');assert.equal(headers!.get('authorization'),'Bearer '+token);
 assert.equal(output.usage.cost.input,base.cost.input*0.001*priorityRate(base));assert.equal(provider.auth,original.auth);
});

import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore,InMemoryModelsStore } from '@earendil-works/pi-ai';

test('ModelRuntime overlays and refreshes preserve fast aliases and non-chat models',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-catalog-'));
 try {
  const modelsPath=join(dir,'models.json');
  const original=openaiProvider();
  const base=original.getModels().find(model=>model.id==='gpt-5.5')!;
  const image={...base,id:'gpt-5.5~fast',type:'image' as const,api:'fixture-images',output:['image'] as ['image']};
  const classifier={...base,type:'classifier' as const,api:'fixture-classifier'};
  const native={...original,getModels:()=>[base],getAllModels:()=>[image,{...base},classifier]};
  await writeFile(modelsPath,JSON.stringify({providers:{openai:{modelOverrides:{'gpt-5.5':{name:'Customized chat'}}}}}));
  const runtime=await ModelRuntime.create({modelsPath,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
  runtime.registerNativeProvider(native);
  runtime.registerNativeProvider(withFastModels(native,runtime.getProvider('openai')!));
  const catalogRuntime:ModelRuntime & {getAllModels?:(id:string)=>readonly {id:string;type?:string}[]}=runtime;
  for(const name of ['Customized chat','Refreshed chat']) {
   await writeFile(modelsPath,JSON.stringify({providers:{openai:{modelOverrides:{'gpt-5.5':{name}}}}}));
   await runtime.refresh({allowNetwork:false});
   assert.equal(runtime.getModel('openai','gpt-5.5')!.name,name);
   assert.deepEqual(runtime.getModels('openai').map(model=>model.id),['gpt-5.5','gpt-5.5~fast']);
   if(catalogRuntime.getAllModels) {
    const all=catalogRuntime.getAllModels('openai');
    assert.deepEqual(all.map(model=>`${model.type??'chat'}:${model.id}`).sort(),['chat:gpt-5.5','chat:gpt-5.5~fast','classifier:gpt-5.5','image:gpt-5.5~fast']);
    assert.deepEqual(all.find(model=>model.type==='image'),image);
    assert.deepEqual(all.find(model=>model.type==='classifier'),classifier);
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('fast installation preserves unique models and reflects models.json refreshes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-overlay-'));
 try {
  const modelsPath=join(dir,'models.json');
  await writeFile(modelsPath,JSON.stringify({providers:{openai:{modelOverrides:{'gpt-5.5':{name:'Custom model name'}}}}}));
  const runtime=await ModelRuntime.create({modelsPath,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
  let command:any;let startup:any;let registrations=0;
  const base=runtime.getModel('openai','gpt-5.5')!;assert.equal(base.name,'Custom model name');
  const ctx:any={model:base,modelRegistry:new ModelRegistry(runtime),ui:{notify(){}}};
  fastMode({registerProvider:(provider:any)=>{registrations++;runtime.registerNativeProvider(provider);},on:(_name:string,handler:any)=>{startup=handler;},registerCommand:(_name:string,entry:any)=>{command=entry;},getThinkingLevel:()=> 'low',setThinkingLevel:()=>{},setModel:async(model:any)=>{ctx.model=model;return true;}} as any);
  await startup({reason:'new'},ctx);
  assert.equal(typeof ctx.modelRegistry.getRegisteredNativeProvider('openai')!.refreshModels,'function','Native wrapper must retain catalog refreshModels rather than use a bare factory');
  const installed=registrations;
  const count=runtime.getModels('openai').length;
  for(let i=0;i<5;i++){
   await command.handler('',ctx);
   const models=runtime.getModels('openai');
   assert.equal(models.length,count,'Repeated /fast must not grow the model list');
   assert.equal(new Set(models.map(m=>m.id)).size,models.length);
   assert.equal(ctx.model.id,i%2===0?'gpt-5.5~fast':'gpt-5.5');
  }
  assert.equal(registrations,installed,'Composed providers must not accumulate wrapper layers');
  await ctx.modelRegistry.refresh({allowNetwork:false});
  await writeFile(modelsPath,JSON.stringify({providers:{}}));
  await ctx.modelRegistry.refresh({allowNetwork:false});
  assert.equal(ctx.modelRegistry.find('openai','gpt-5.5')!.name,'GPT-5.5','Removing an override must restore the builtin value');
  await writeFile(modelsPath,JSON.stringify({providers:{openai:{modelOverrides:{'gpt-5.5':{name:'Updated model name'}}}}}));
  await ctx.modelRegistry.refresh({allowNetwork:false});
  assert.equal(ctx.modelRegistry.find('openai','gpt-5.5')!.name,'Updated model name');
  await command.handler('on',ctx);
  const refreshed=runtime.getModels('openai');
  assert.equal(ctx.model.id,'gpt-5.5~fast');
  assert.equal(refreshed.length,count);
  assert.equal(new Set(refreshed.map(m=>m.id)).size,refreshed.length);
  assert.equal(registrations,installed,'Refresh must not cause duplicate installation');
 }finally{await rm(dir,{recursive:true,force:true});}
});

const aliasesUnderConfig=async(config:unknown)=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-proxy-'));
 try {
  const modelsPath=join(dir,'models.json');
  await writeFile(modelsPath,JSON.stringify({providers:{openai:config}}));
  const runtime=await ModelRuntime.create({modelsPath,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
  let startup:any;
  fastMode({registerProvider:(provider:any)=>runtime.registerNativeProvider(provider),on:(_name:string,handler:any)=>{startup=handler;},registerCommand:()=>{}} as any);
  const registry=new ModelRegistry(runtime);
  await startup({reason:'new'},{modelRegistry:registry});
  await registry.refresh({allowNetwork:false});
  return runtime.getModels('openai').filter(model=>model.id.endsWith('~fast'));
 }finally{await rm(dir,{recursive:true,force:true});}
};

test('a provider-wide proxy leaves no model eligible for fast',async()=>{
 assert.deepEqual(await aliasesUnderConfig({baseUrl:'https://proxy.example/v1'}),[]);
});

test('a per-model proxy withdraws only that model from fast',async()=>{
 const aliases=await aliasesUnderConfig({models:[{id:'gpt-5.5',baseUrl:'https://proxy.example/v1'}]});
 assert.ok(aliases.length>0,'Other direct models remain eligible');
 assert.ok(!aliases.some(model=>model.id==='gpt-5.5~fast'));
});

test('config-declared direct models retain usable fast aliases',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-custom-'));
 try {
  const modelsPath=join(dir,'models.json');
  const definition={...openaiProvider().getModels().find(model=>model.id==='gpt-5.5')!,id:'gpt-custom',name:'Custom direct model'};
  await writeFile(modelsPath,JSON.stringify({providers:{openai:{models:[definition]}}}));
  const runtime=await ModelRuntime.create({modelsPath,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
  const registry=new ModelRegistry(runtime);
  let command:any;
  const ctx:any={model:registry.find('openai','gpt-custom'),modelRegistry:registry,ui:{notify(){}}};
  fastMode({registerProvider:(provider:any)=>runtime.registerNativeProvider(provider),on:()=>{},registerCommand:(_name:string,entry:any)=>{command=entry;},getThinkingLevel:()=> 'low',setThinkingLevel:()=>{},setModel:async(model:any)=>{ctx.model=model;return true;}} as any);
  await command.handler('on',ctx);
  assert.equal(ctx.model.id,'gpt-custom~fast');
  await registry.refresh({allowNetwork:false});
  let payload:any;
  const fetch:typeof globalThis.fetch=async(_url,init)=>{
   payload=JSON.parse(String(init?.body));
   return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:0,output_tokens:0}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  };
  const alias=registry.find('openai','gpt-custom~fast');
  assert.ok(alias,'Custom alias survives refresh');
  assert.ok(registry.find('openai','gpt-custom'),'Configured base remains available');
  const output=await registry.getProvider('openai')!.streamSimple(alias,{messages:[]},{apiKey:'fixture-key',reasoning:'low',fetch,maxRetries:0}).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);
  assert.equal(payload.model,'gpt-custom');
  assert.equal(payload.service_tier,'priority');
  const models=runtime.getModels('openai');
  assert.equal(new Set(models.map(model=>model.id)).size,models.length);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('fast installation preserves another extension legacy provider registration',async()=>{
 const runtime=await ModelRuntime.create({modelsPath:null,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
 const registry=new ModelRegistry(runtime);
 const config={baseUrl:'https://proxy.example/v1',apiKey:'fixture-proxy-key'};
 registry.registerProvider('openai',config);
 await registry.refresh({allowNetwork:false});
 let startup:any;
 fastMode({registerProvider:(provider:any)=>registry.registerProvider(provider),on:(_name:string,handler:any)=>{startup=handler;},registerCommand:()=>{}} as any);
 await startup({reason:'new'},{modelRegistry:registry});
 await registry.refresh({allowNetwork:false});
 assert.deepEqual(registry.getRegisteredProviderConfig('openai'),config);
 assert.equal(registry.getRegisteredNativeProvider('openai'),undefined);
 assert.equal(registry.find('openai','gpt-5.5')!.baseUrl,config.baseUrl);
 assert.ok(!runtime.getModels('openai').some(model=>model.id.endsWith('~fast')));
});

test('alias derivation tracks the live base model list rather than a stale snapshot',async()=>{
 const original=openaiProvider();
 const base=original.getModels().find(model=>model.id==='gpt-5.5')!;
 const other=original.getModels().find(model=>model.id!=='gpt-5.5'&&model.baseUrl===base.baseUrl&&model.api===base.api)!;
 let current:any[]=[base,other];
 const mutable:any={...original,getModels:()=>current};
 const provider=withFastModels(mutable);
  assert.deepEqual(provider.getModels().map(model=>model.id),[base.id,base.id+'~fast',other.id,other.id+'~fast']);
 current=[{...base,name:'Renamed'},{...other,baseUrl:'https://proxy.example/v1'}];
 const refreshed=provider.getModels();
 assert.deepEqual(refreshed.map(model=>model.id),[base.id,base.id+'~fast',other.id]);
 assert.equal(refreshed.find(model=>model.id===base.id+'~fast')!.name,'Renamed (fast)');
 current=[base,other];
 assert.deepEqual(provider.getModels().map(model=>model.id),[base.id,base.id+'~fast',other.id,other.id+'~fast']);
 assert.equal(provider.getModels().find(model=>model.id===base.id+'~fast')!.name,base.name+' (fast)');
});

const savedAlias=(onSelect:(model:any)=>void)=>{
 const original=openaiProvider();const base=original.getModels().find(m=>m.id==='gpt-5.5')!;
 let provider:any=original;let registrations=0;let startup:any;
 const ctx:any={model:base,modelRegistry:{getRegisteredProviderConfig:()=>undefined,getRegisteredNativeProvider:(id:string)=>id==='openai'&&registrations?provider:undefined,getProvider:(id:string)=>id==='openai'?provider:undefined,find:(id:string,name:string)=>id==='openai'?provider.getModels().find((m:any)=>m.id===name):undefined},sessionManager:{getBranch:()=>[{type:'model_change',provider:'openai',modelId:'gpt-5.5~fast'}]},ui:{notify(){}}};
 fastMode({registerProvider:(p:any)=>{registrations++;provider=p;},on:(name:string,fn:any)=>{if(name==='session_start')startup=fn;},registerCommand:()=>{},getThinkingLevel:()=>'high',setThinkingLevel:()=>{},setModel:async(value:any)=>{onSelect(value);ctx.model=value;return true;}} as any);
 return {ctx,startup};
};

test('an explicit --model on the command line overrides the saved fast alias at startup',async()=>{
 let selected='gpt-5.5';
 const h=savedAlias(model=>{selected=model.id;});
 const argv=process.argv;process.argv=[...argv,'--model','openai/gpt-5.5'];
 try{await h.startup({reason:'startup'},h.ctx);}finally{process.argv=argv;}
 assert.equal(selected,'gpt-5.5');
});

test('a resumed session restores the saved fast alias even when the command line named a model',async()=>{
 let selected='gpt-5.5';
 const h=savedAlias(model=>{selected=model.id;});
 const argv=process.argv;process.argv=[...argv,'--model','openai/gpt-5.5'];
 try{await h.startup({reason:'resume'},h.ctx);}finally{process.argv=argv;}
 assert.equal(selected,'gpt-5.5~fast');
});

test('/fast on a model outside the OpenAI Responses paths reports unavailable and changes nothing',async()=>{
 const runtime=await ModelRuntime.create({modelsPath:null,credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
 const registry=new ModelRegistry(runtime);
 const base=registry.getAll().find(model=>model.provider==='anthropic')!;
 let selections=0;const notices:[string,string][]=[];let command:any;
 const ctx:any={model:base,modelRegistry:registry,ui:{notify:(message:string,level:string)=>notices.push([message,level])}};
 fastMode({registerProvider:(provider:any)=>runtime.registerNativeProvider(provider),on(){},registerCommand:(_name:string,entry:any)=>{command=entry;},getThinkingLevel:()=>'low',setThinkingLevel(){},setModel:async()=>{selections++;return true;}} as any);
 await command.handler('on',ctx);
 assert.deepEqual({selections,notices},{selections:0,notices:[['Fast mode is unavailable for this provider path','error']]});
});

import { createAgentSession, DefaultResourceLoader, parseArgs, SessionManager, SettingsManager, type SessionStartEvent } from '@earendil-works/pi-coding-agent';

type SavedThinking=Parameters<SessionManager['appendThinkingLevelChange']>[0];
const savedFastSession=(dir:string,thinking:SavedThinking|null='high')=>{
 const manager=SessionManager.create(dir,dir);
 manager.appendMessage({role:'user',content:'Synthetic saved conversation',timestamp:0});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Synthetic response'}],api:'openai-responses',provider:'openai',model:'gpt-5.5',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0});
 manager.appendModelChange('openai','gpt-5.5~fast');
 if(thinking!==null){manager.appendThinkingLevelChange('low');manager.appendThinkingLevelChange(thinking);}
 return manager.getSessionFile()!;
};
const openFastSession=async(dir:string,file:string,reason:SessionStartEvent['reason'])=>{
 const credentials=new InMemoryCredentialStore();
 await credentials.modify('openai',async()=>({type:'api_key',key:'synthetic-fast-session-key'}));
 const modelRuntime=await ModelRuntime.create({modelsPath:null,credentials,modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
 await modelRuntime.refresh({allowNetwork:false,providers:['openai']});
 const settingsManager=SettingsManager.inMemory({defaultProvider:'openai',defaultModel:'gpt-4.1',defaultThinkingLevel:'medium'});
 const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,extensionFactories:[fastMode],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:''});
 await resourceLoader.reload();
 const sessionManager=SessionManager.open(file);
 const thinkingLevel=reason==='startup'?parseArgs(process.argv.slice(2)).thinking:undefined;
 const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime,settingsManager,sessionManager,resourceLoader,tools:[],thinkingLevel,sessionStartEvent:{type:'session_start',reason}});
 try {
  assert.equal(session.model?.id,'gpt-4.1');
  assert.equal(session.thinkingLevel,'off');
  if(thinkingLevel!==undefined)session.setThinkingLevel(session.thinkingLevel);
  const errors:unknown[]=[];
  await session.bindExtensions({onError:error=>errors.push(error)});
  assert.deepEqual(errors,[]);
  return session;
 }catch(error){session.dispose();throw error;}
};

for(const reason of ['startup','resume'] as const) {
 test(`${reason} restores fast reasoning and preserves it across a fresh disk resume`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-fast-saved-thinking-'));
  try {
   const file=savedFastSession(dir);
   for(const startReason of [reason,'resume'] as const) {
    const session=await openFastSession(dir,file,startReason);
    try {
     assert.equal(session.model?.id,'gpt-5.5~fast');
     assert.equal(session.thinkingLevel,'high');
     assert.equal(SessionManager.open(file).buildSessionContext().thinkingLevel,'high');
    }finally{session.dispose();}
   }
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}


test('startup thinking flags override saved reasoning and the override survives a fresh resume',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-startup-thinking-'));
 const argv=process.argv;
 try {
  const cases:[string[],SavedThinking][]=[
   [['--thinking','low'],'low'],
   [['--thinking','off'],'off'],
   [['--thinking','low','--thinking','medium'],'medium'],
   [['--thinking','low','--thinking','invalid'],'low'],
   [['--','--thinking','low'],'high'],
  ];
  for(const [args,expected] of cases) {
   const file=savedFastSession(dir);
   process.argv=[...argv.slice(0,2),...args];
   const session=await openFastSession(dir,file,'startup');
   try {
    assert.equal(session.model?.id,'gpt-5.5~fast');
    assert.equal(session.thinkingLevel,expected);
    assert.equal(SessionManager.open(file).buildSessionContext().thinkingLevel,expected);
   }finally{session.dispose();}
   process.argv=[...argv.slice(0,2),'--thinking','xhigh'];
   const resumed=await openFastSession(dir,file,'resume');
   try {assert.equal(resumed.thinkingLevel,expected);}finally{resumed.dispose();}
  }
 }finally{process.argv=argv;await rm(dir,{recursive:true,force:true});}
});

test('saved off and sessions without reasoning metadata retain off after fast restoration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-default-thinking-'));
 try {
  for(const saved of ['off',null] as const) {
   const file=savedFastSession(dir,saved);
   const session=await openFastSession(dir,file,'resume');
   try {
    assert.equal(session.model?.id,'gpt-5.5~fast');
    assert.equal(session.thinkingLevel,'off');
    assert.equal(SessionManager.open(file).buildSessionContext().thinkingLevel,'off');
   }finally{session.dispose();}
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('reasoning on a sibling branch does not override the resumed fast branch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-fast-branch-thinking-'));
 try {
  const file=savedFastSession(dir);
  const manager=SessionManager.open(file);
  const active=manager.getLeafId()!;
  manager.appendThinkingLevelChange('off');
  manager.branch(active);
  manager.appendCustomEntry('synthetic-active-branch',{});
  const session=await openFastSession(dir,file,'resume');
  try {
   assert.equal(session.thinkingLevel,'high');
   assert.equal(SessionManager.open(file).buildSessionContext().thinkingLevel,'high');
  }finally{session.dispose();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

import { AgentSessionRuntime, createAgentSessionServices, type CreateAgentSessionRuntimeFactory } from '@earendil-works/pi-coding-agent';

test('forking a saved fast branch restores its alias in a fresh runtime',async(t)=>{
 for(const position of ['at','before'] as const)await t.test(position,async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'pi-fast-fork-'));
  let runtime:AgentSessionRuntime|undefined;
  try {
   const create:CreateAgentSessionRuntimeFactory=async(options)=>{
    const credentials=new InMemoryCredentialStore();
    await credentials.modify('openai',async()=>({type:'api_key',key:'fixture-key'}));
    const modelRuntime=await ModelRuntime.create({modelsPath:null,credentials,modelsStore:new InMemoryModelsStore(),refreshOnCreate:false,allowModelNetwork:false});
    await modelRuntime.refresh({allowNetwork:false,providers:['openai']});
    const settingsManager=SettingsManager.inMemory({defaultProvider:'openai',defaultModel:'gpt-5.5'});
    const services=await createAgentSessionServices({cwd,agentDir:cwd,modelRuntime,settingsManager,resourceLoaderOptions:{extensionFactories:[fastMode],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true}});
    const result=await createAgentSession({...services,sessionManager:options.sessionManager,sessionStartEvent:options.sessionStartEvent,tools:[]});
    const errors:string[]=[];
    await result.session.bindExtensions({onError:error=>errors.push(error.error)});
    assert.deepEqual(errors,[]);
    return {...result,services,diagnostics:[]};
   };
   const sessionManager=SessionManager.inMemory(cwd);
   sessionManager.appendModelChange('openai','gpt-5.5~fast');
   const firstUserId=sessionManager.appendMessage({role:'user',content:'Saved fast branch',timestamp:Date.now()});
   const laterUserId=sessionManager.appendMessage({role:'user',content:'Later message',timestamp:Date.now()});
   const initial=await create({cwd,agentDir:cwd,sessionManager,sessionStartEvent:{type:'session_start',reason:'startup'}});
   runtime=new AgentSessionRuntime(initial.session,initial.services,create);
   assert.equal(runtime.session.model?.id,'gpt-5.5~fast');
   await runtime.session.setModel(runtime.services.modelRuntime.getModel('openai','gpt-5.5')!);
   assert.equal(runtime.session.model?.id,'gpt-5.5');
   const argv=process.argv;process.argv=[...argv,'--model','openai/gpt-5.5'];
   try{assert.equal((await runtime.fork(position==='at'?firstUserId:laterUserId,{position})).cancelled,false);}finally{process.argv=argv;}
   assert.notEqual(runtime.services.modelRuntime,initial.services.modelRuntime);
   assert.ok(runtime.services.modelRuntime.getModel('openai','gpt-5.5~fast'));
   assert.equal(runtime.session.sessionManager.buildSessionContext().model?.modelId,'gpt-5.5~fast');
   assert.equal(runtime.session.model?.id,'gpt-5.5~fast');
   await runtime.session.setModel(runtime.services.modelRuntime.getModel('openai','gpt-5.5')!);
   assert.equal(runtime.session.model?.id,'gpt-5.5');
   const ordinaryUserId=runtime.session.sessionManager.appendMessage({role:'user',content:'Ordinary model branch',timestamp:Date.now()});
   assert.equal((await runtime.fork(ordinaryUserId,{position:'at'})).cancelled,false);
   assert.equal(runtime.session.model?.id,'gpt-5.5');
   assert.equal((await runtime.newSession()).cancelled,false);
   assert.equal(runtime.session.model?.id,'gpt-5.5');
  }finally{await runtime?.dispose();await rm(cwd,{recursive:true,force:true});}
 });
});
