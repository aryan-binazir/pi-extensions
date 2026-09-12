import assert from 'node:assert/strict';
import test from 'node:test';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getSupportedThinkingLevels, type ThinkingLevel } from '@earendil-works/pi-ai';
import { withFastModels } from './provider.ts';

test('fast aliases preserve auth and pricing metadata and send priority through real provider',async()=>{
 const original=openaiProvider(); const provider=withFastModels(original);
 assert.equal(provider.auth,original.auth);
 const base=original.getModels().find(m=>m.id==='gpt-5.5')!;
 assert.ok(base);
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
  assert.equal(output.usage.cost.input,base.cost.input*0.001*2.5);
 }
 assert.equal(withFastModels(provider),provider,'reload must not wrap twice');
});

import fastMode from './index.ts';
test('toggle and resume keep reasoning; other provider paths remain untouched',async()=>{
 const original=openaiProvider();const models=original.getModels();const base=models.find(m=>m.id==='gpt-5.5')!;
 let provider:any=original;let selected:any=base;let effort='high';let command:any;let resume:any;let registrations=0;
 const ctx:any={model:base,modelRegistry:{getRegisteredNativeProvider:(id:string)=>id==='openai'&&registrations?provider:undefined,getProvider:(id:string)=>id==='openai'?provider:undefined,find:(id:string,name:string)=>id==='openai'?provider.getModels().find((m:any)=>m.id===name):undefined},sessionManager:{getBranch:()=>[{type:'model_change',provider:'openai',modelId:'gpt-5.5~fast'}]},ui:{notify(){}}};
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
 assert.equal(output.usage.cost.input,base.cost.input*0.001*(base.id==='gpt-5.5'?2.5:2));assert.equal(provider.auth,original.auth);
});

import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore,InMemoryModelsStore } from '@earendil-works/pi-ai';

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
  // Refresh the initial configuration before changing the config file.
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

for(const [name,config] of [
 ['provider proxy',{baseUrl:'https://proxy.example/v1'}],
 ['per-model proxy',{models:[{id:'gpt-5.5',baseUrl:'https://proxy.example/v1'}]}],
] as const) {
 test(`fast installation respects ${name} eligibility`,async()=>{
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
   const aliases=runtime.getModels('openai').filter(model=>model.id.endsWith('~fast'));
   if(name==='provider proxy')assert.equal(aliases.length,0);
   else {
    assert.ok(aliases.length>0,'Other direct models remain eligible');
    assert.ok(!aliases.some(model=>model.id==='gpt-5.5~fast'));
   }
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}

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
