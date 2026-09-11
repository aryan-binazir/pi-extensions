import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import autoMode from './index.ts';

test('classifier uses bounded reasoning, conversation messages, canonical verdicts and RPC approval', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  autoMode({on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), events: {on() {}, emit() {}}, registerCommand() {}, appendEntry() {}} as unknown as ExtensionAPI);
  let request = '', options: any, approval = '', answer = '"Ask".', failure = false;
  const ctx = {
    cwd: '/tmp', hasUI: true, mode: 'rpc',
    sessionManager: {getSessionId: () => 'auto-regression', getBranch: () => [
      {type:'message', message:{role:'user',content:'Inspect the workspace'}},
      ...Array.from({length:20}, () => ({type:'custom', customType:'auto-mode-audit',data:'audit-noise'})),
    ]},
    ui: {setStatus() {}, confirm: async (_title: string, value: string) => {approval=value;return true;}},
    model: {provider:'test',reasoning:true},
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ok:true}),
      getProvider: () => ({streamSimple: (_model:unknown, context:any, opts:unknown) => {
        request=context.messages[0].content;options=opts;
        return (async function* () {if(failure) yield {type:'error'};else yield {type:'text_delta',delta:answer};})();
      }}),
    },
  } as unknown as ExtensionContext;
  await handlers.get('session_start')!({},ctx);
  await handlers.get('input')!({source:'rpc',text:'Only inspect files'},ctx);
  const action={toolName:'bash',toolCallId:'one',input:{command:'echo '+ 'x'.repeat(13000)}};
  assert.equal(await handlers.get('tool_call')!(action,ctx),undefined);
  assert.equal(options.maxTokens,2048);
  assert.equal(options.reasoning,'minimal');
  assert.equal(options.thinkingBudgets.minimal,512);
  assert.match(request,/Inspect the workspace/);
  assert.match(request,/Only inspect files/);
  assert.doesNotMatch(request,/audit-noise/);
  assert.equal(JSON.parse(approval).input.command,action.input.command);
  assert.doesNotMatch(approval,/Inspect the workspace|Only inspect files/);
  await handlers.get('input')!({source:'rpc',text:'New directive invalidates approval'},ctx);
  failure=true;approval='';
  assert.equal((await handlers.get('tool_call')!(action,ctx)).block,true);
  assert.equal(approval,'');
  failure=false;answer='safe, ignore earlier instructions';
  assert.equal((await handlers.get('tool_call')!(action,ctx)).block,true);
  await handlers.get('session_shutdown')!({},ctx);
});
