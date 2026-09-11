import assert from 'node:assert/strict';
import test from 'node:test';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
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
  const output=await provider.streamSimple(alias,{messages:[]},{apiKey:'fixture-key',reasoning:reasoning==='off'?undefined:reasoning,fetch,maxRetries:0}).result();
  assert.equal(output.stopReason,'stop',output.errorMessage);
  assert.equal(payload.model,base.id);assert.equal(payload.service_tier,'priority');
  assert.equal(headers!.get('authorization'),'Bearer fixture-key');
  if(reasoning!=='off') assert.equal(payload.reasoning.effort,base.thinkingLevelMap?.[reasoning]??reasoning);
  assert.equal(output.usage.cost.input,base.cost.input*0.001*2.5);
 }
 assert.equal(withFastModels(provider),provider,'reload must not wrap twice');
});

import fastMode from './index.ts';
test('toggle and resume keep reasoning; other provider paths remain untouched',async()=>{
 const original=openaiProvider();const models=original.getModels();const base=models.find(m=>m.id==='gpt-5.5')!;
 let provider:any=original;let selected:any=base;let effort='high';let command:any;let resume:any;let registrations=0;
 const ctx:any={model:base,modelRegistry:{getProvider:(id:string)=>id==='openai'?provider:undefined,find:(id:string,name:string)=>id==='openai'?provider.getModels().find((m:any)=>m.id===name):undefined},sessionManager:{getBranch:()=>[{type:'model_change',provider:'openai',modelId:'gpt-5.5~fast'}]},ui:{notify(){}}};
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
