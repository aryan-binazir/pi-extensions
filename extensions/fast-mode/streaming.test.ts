import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { withFastModels } from './provider.ts';

for(const original of [openaiProvider(),openaiCodexProvider()]) {
 test(`${original.id} fast simple streams retain provider normalization and caller hooks`,async()=>{
  const native=original.getModels().find(model=>model.id==='gpt-5.5')??original.getModels()[0];
  const base={...native,contextWindow:4200,maxTokens:10000,samplingParams:{temperature:0.3},samplingParamsByThinkingLevel:{low:{temperature:0.4}}};
  const provider=withFastModels({...original,getModels:()=>[base]});
  const alias=provider.getModels().find(model=>model.id===base.id+'~fast')!;
  const context=normalizeContext({messages:[{role:'user',content:'hello '.repeat(100),timestamp:0}]});
  const apiKey=original.id==='openai-codex'
   ? 'fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.fixture'
   : 'fixture-key';
  for(const reasoning of ['off','low'] as const) {
   const payloads:Record<string,unknown>[]=[];
   let payloadHooks=0;let responseHooks=0;let eventHooks=0;
   const options:SimpleStreamOptions={apiKey,reasoning:reasoning as SimpleStreamOptions['reasoning'],maxTokens:9000,samplingParams:{temperature:0.5},transport:'sse',maxRetries:0,
    onPayload:async(payload,current)=>{payloadHooks++;assert.equal(current.id,base.id);return {...payload as Record<string,unknown>,metadata:{caller:'preserved'}};},
    onResponse:async()=>{responseHooks++;},
    onProviderStreamEvent:async()=>{eventHooks++;},
    fetch:async(_url,init)=>{
     const headers=new Headers(init?.headers);
     const body=headers.get('content-encoding')==='zstd'?(await import('node:zlib') as typeof import('node:zlib') & {zstdDecompressSync:(body:unknown)=>Buffer}).zstdDecompressSync(init?.body).toString():String(init?.body);
     payloads.push(JSON.parse(body));
     return new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:100,cache_write_tokens:20}}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
    },
   };
   const normal=await provider.streamSimple(base,context,options).result();
   const fast=provider.streamSimple(alias,context,options);
   let completed;
   for await(const event of fast)if(event.type==='done')completed=event.message;
   const result=await fast.result();
   assert.equal(result.stopReason,'stop',result.errorMessage);
   assert.equal(result,completed);
   assert.deepEqual(payloads[1],{...payloads[0],service_tier:'priority'});
   assert.deepEqual({payloadHooks,responseHooks,eventHooks},{payloadHooks:2,responseHooks:2,eventHooks:2});
   const multiplier=base.id==='gpt-5.5'?2.5:2;
   for(const key of ['input','output','cacheRead','cacheWrite','total'] as const)assert.equal(result.usage.cost[key],normal.usage.cost[key]*multiplier);
  }
 });
}

test('fast streams terminate with an error when a caller payload hook throws',async()=>{
 const original=openaiProvider();const provider=withFastModels(original);
 const base=original.getModels().find(model=>model.id==='gpt-5.5')!;
 const alias=provider.getModels().find(model=>model.id===base.id+'~fast')!;
 const stream=provider.streamSimple(alias,normalizeContext({messages:[]}),{
  apiKey:'fixture-key',onPayload(){throw new Error('caller hook failed');},
  fetch:async()=>{throw new Error('fetch must not run');},maxRetries:0,
 });
 let terminal;
 for await(const event of stream)if(event.type==='error')terminal=event.error;
 const result=await stream.result();
 assert.equal(result,terminal);
 assert.equal(result.stopReason,'error');
 assert.match(result.errorMessage??'',/caller hook failed/);
});
