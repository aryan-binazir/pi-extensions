import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContext, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { withPi } from '../../tests/pi-session.ts';
import fastMode from './index.ts';
import { withFastModels } from './provider.ts';

const original=anthropicProvider();
const opus=original.getModels().find(model=>model.id==='claude-opus-5-5')!;
const context=normalizeContext({messages:[{role:'user',content:'Hello',timestamp:0}]});
const usage={input_tokens:1000,output_tokens:100,cache_read_input_tokens:200,cache_creation_input_tokens:100};
function response(model:string,speed?:string) {
 const events=[
  {type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{...usage,...(speed?{speed}:{})}}},
  {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:100}},
  {type:'message_stop'},
 ];
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}

test('Anthropic aliases include future Claude models and preserve auth and endpoint isolation',()=>{
 const future={...opus,id:'claude-future-99'};
 const excluded=[
  {...opus,id:'proxy',baseUrl:'https://proxy.example'},
  {...opus,id:'claude-other-provider',provider:'other'},
  {...opus,id:'claude-bridge',api:'claude-bridge',baseUrl:'claude-bridge'},
  {...opus,id:'claude-invalid-url',baseUrl:'invalid'},
  {...opus,id:'not-claude'},
 ];
 const provider=withFastModels({...original,getModels:()=>[opus,future,...excluded]});
 assert.equal(provider.auth,original.auth);
 assert.deepEqual(provider.getModels().filter(model=>model.id.endsWith('~fast')).map(model=>model.id),[opus.id+'~fast',future.id+'~fast']);
 assert.deepEqual(provider.getModels()[1].cost,opus.cost);
 assert.equal(withFastModels(provider),provider);
});

for(const method of ['stream','streamSimple'] as const) {
 for(const id of [opus.id,'claude-future-99']) {
  test(`Anthropic ${method} sends fast speed for ${id} and retains caller hooks and normalization`,async()=>{
   const base={...opus,id};
   const provider=withFastModels({...original,getModels:()=>[base]});
   const alias=provider.getModels()[1];
   for(const speed of ['fast','standard',undefined]) {
    const payloads:Record<string,unknown>[]=[];
    let payloadHooks=0;let responseHooks=0;let eventHooks=0;
    const options:SimpleStreamOptions={
     apiKey:'fixture-key',reasoning:'high',maxTokens:4096,maxRetries:0,
     headers:{'x-fixture':'preserved'},
     onPayload:async(payload,current)=>{
      payloadHooks++;assert.equal(current.id,id);
      return {...payload as Record<string,unknown>,metadata:{user_id:'fixture-user'}};
     },
     onResponse:async()=>{responseHooks++;},
     onProviderStreamEvent:async()=>{eventHooks++;},
     fetch:async(_url,init)=>{
      const headers=new Headers(init?.headers);
      assert.equal(headers.get('x-api-key'),'fixture-key');
      assert.equal(headers.get('x-fixture'),'preserved');
      payloads.push(JSON.parse(String(init?.body)));
      return response(id,speed);
     },
    };
    const normal=await provider[method](base,context,options).result();
    const stream=provider[method](alias,context,options);
    let terminal;
    for await(const event of stream)if(event.type==='done')terminal=event.message;
    const result=await stream.result();
    assert.equal(result.stopReason,'stop',result.errorMessage);
    assert.equal(result,terminal);
    assert.equal(payloads[1].model,id);
    assert.equal(payloads[1].service_tier,undefined);
    assert.deepEqual(payloads[1],{...payloads[0],speed:'fast'});
    assert.deepEqual({payloadHooks,responseHooks,eventHooks},{payloadHooks:2,responseHooks:2,eventHooks:6});
    for(const key of ['input','output','cacheRead','cacheWrite','total'] as const) {
     assert.equal(result.usage.cost[key],normal.usage.cost[key]*(speed==='standard'?1:2));
    }
   }
  });
 }

 test(`Anthropic ${method} preserves payload replacements, errors and aborts`,async()=>{
  const provider=withFastModels(original);
  const alias=provider.getModels().find(model=>model.id===opus.id+'~fast')!;
  const replaced=await provider[method](alias,context,{
   apiKey:'fixture-key',maxRetries:0,
   onPayload:(payload)=>({...payload as Record<string,unknown>,speed:'standard'}),
   fetch:async(_url,init)=>{
    assert.equal(JSON.parse(String(init?.body)).speed,'standard');
    return response(opus.id);
   },
  }).result();
  assert.equal(replaced.stopReason,'stop',replaced.errorMessage);
  assert.equal(replaced.usage.cost.input,opus.cost.input*0.001);
  const rejected=await provider[method](alias,context,{
   apiKey:'fixture-key',maxRetries:0,
   fetch:async()=>new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Fast mode is not supported'}}),{status:400,headers:{'content-type':'application/json'}}),
  }).result();
  assert.equal(rejected.stopReason,'error');
  assert.match(rejected.errorMessage??'',/Fast mode is not supported/);
  const hookError=await provider[method](alias,context,{
   apiKey:'fixture-key',maxRetries:0,onPayload:()=>{throw new Error('caller failed');},
   fetch:async()=>{throw new Error('fetch must not run');},
  }).result();
  assert.equal(hookError.stopReason,'error');
  assert.match(hookError.errorMessage??'',/caller failed/);
  const aborted=await provider[method](alias,context,{
   apiKey:'fixture-key',maxRetries:0,signal:AbortSignal.abort(),
   fetch:async()=>{throw new Error('fetch must not run');},
  }).result();
  assert.equal(aborted.stopReason,'aborted');
 });
}

test('older fast-capable Opus models retain existing beta headers',async()=>{
 const provider=withFastModels(original);
 for(const id of ['claude-opus-4-8','claude-opus-5',opus.id]) {
  const alias=provider.getModels().find(model=>model.id===id+'~fast')!;
  const result=await provider.streamSimple(alias,context,{
   apiKey:'fixture-key',reasoning:'high',maxRetries:0,
   onPayload:payload=>{
    const request=payload as {betas?:string[]};
    assert.equal(request.betas?.includes('fast-mode-2026-02-01')??false,id!==opus.id);
    return {...request,betas:[...(request.betas??[]),'fixture-beta']};
   },
   fetch:async(_url,init)=>{
    const betas=new Headers(init?.headers).get('anthropic-beta')??'';
    assert.ok(betas.includes('fixture-beta'));
    assert.equal(betas.includes('fast-mode-2026-02-01'),id!==opus.id);
    return response(id,'fast');
   },
  }).result();
  assert.equal(result.stopReason,'stop',result.errorMessage);
 }
});

test('/fast toggles Anthropic aliases and restores saved sessions without changing reasoning',async()=>withPi({
 extensions:[fastMode],configure:async({modelRuntime})=>{
  await modelRuntime.setRuntimeApiKey('anthropic','fixture-key');
  return {model:modelRuntime.getModel('anthropic',opus.id),thinkingLevel:'high'};
 },
},async({session,runner})=>{
 const command=runner.getCommand('fast')!;
 await command.handler('on',runner.createCommandContext());
 assert.equal(session.model?.id,opus.id+'~fast');assert.equal(session.thinkingLevel,'high');
 session.sessionManager.appendMessage({role:'user',content:'Saved Claude fast session',timestamp:0});
 session.sessionManager.appendModelChange('anthropic',opus.id+'~fast');
 session.sessionManager.appendThinkingLevelChange('high');
 await runner.emit({type:'session_start',reason:'resume'});
 assert.equal(session.model?.id,opus.id+'~fast');assert.equal(session.thinkingLevel,'high');
 await command.handler('off',runner.createCommandContext());
 assert.equal(session.model?.id,opus.id);assert.equal(session.thinkingLevel,'high');
}));
