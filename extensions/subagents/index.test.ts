import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import subagents from './index.ts';
import { AutoPolicy, setActivePolicy } from '../auto-mode/policy.ts';

test('workflow registration blocks missing UI and protects sensitive reads through inherited policy',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'workflow-extension-'));
 const previousAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(cwd,'agent-home');
 const tools=new Map<string,any>();const events=new Map<string,any>();
 subagents({registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},on:(name:string,handler:any)=>events.set(name,handler)} as unknown as ExtensionAPI);
 const ctx={cwd,hasUI:false,mode:'tui',sessionManager:{getSessionId:()=> 'workflow-extension-test'},ui:{editor:async(_title:string,source:string)=>source,confirm:async()=>true}};
 try {
  await assert.rejects(tools.get('workflow').execute('id',{source:'return 1;'},undefined,undefined,ctx),/approval/);
  ctx.hasUI=true;
  await writeFile(join(cwd,'.env'),'SYNTHETIC_SECRET');
  setActivePolicy(new AutoPolicy(cwd),'workflow-extension-test');
  await assert.rejects(tools.get('workflow').execute('id',{source:'return await api.readFile(".env");'},undefined,undefined,ctx),/Approval required/);
 } finally {
  if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;
  await events.get('session_shutdown')();setActivePolicy(undefined,'workflow-extension-test');await rm(cwd,{recursive:true,force:true});
 }
});

test('registered background tool launches guarded Pi and pushes completion to its parent',async()=>{
 const {chmod}=await import('node:fs/promises');
 const cwd=await mkdtemp(join(tmpdir(),'subagent-extension-'));
 const previousPath=process.env.PATH,previousAgentDir=process.env.PI_CODING_AGENT_DIR;
 const sessionId='subagent-notification-test';
 const tools=new Map<string,any>();const events=new Map<string,any>();
 let notify!:(value:{message:any;options:any})=>void;
 const notification=new Promise<{message:any;options:any}>(resolve=>{notify=resolve;});
 const ctx={cwd,hasUI:false,mode:'print',sessionManager:{getSessionId:()=>sessionId}};
 try {
  await writeFile(join(cwd,'pi'),`#!${process.execPath}\nconst policy=JSON.parse(process.env.PI_AGENT_POLICY);const output=JSON.stringify({args:process.argv.slice(2),policy});process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:output}],usage:{input:3,output:4}}})+'\\n');`);
  await chmod(join(cwd,'pi'),0o700);
  process.env.PATH=`${cwd}:${previousPath??''}`;process.env.PI_CODING_AGENT_DIR=join(cwd,'agent-home');
  setActivePolicy(new AutoPolicy(cwd),sessionId);
  subagents({registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},on:(name:string,handler:any)=>events.set(name,handler),sendMessage:(message:any,options:any)=>notify({message,options})} as unknown as ExtensionAPI);
  await events.get('session_start')({},ctx);
  const response=await tools.get('subagent').execute('call',{task:'Read synthetic checkout',preset:'reader'},undefined,undefined,ctx);
  const deadline=setTimeout(()=>notify({message:{content:'{}'},options:{timeout:true}}),5000);
  let completion;
  try {completion=await notification;}finally{clearTimeout(deadline);}
  assert.deepEqual(completion.options,{triggerTurn:true,deliverAs:'followUp'});
  assert.equal(completion.message.customType,'subagent-complete');
  const task=JSON.parse(completion.message.content);
  assert.equal(task.status,'succeeded');assert.equal(task.id,response.details.id);
  assert.deepEqual(task.usage,{input:3,output:4});
  const child=JSON.parse(task.output);
  assert.equal(child.policy.inherited,true);assert.equal(child.policy.root,cwd);
  assert.deepEqual(child.policy.tools,['read','grep','find','ls']);
  assert.ok(child.args.includes('--no-session'));assert.ok(child.args.includes('--no-extensions'));
  const extension=child.args[child.args.indexOf('-e')+1];
  assert.match(extension,/auto-mode\/index\.ts$/);
  assert.equal(child.args.at(-1),'Read synthetic checkout');
 } finally {
  await events.get('session_shutdown')?.();setActivePolicy(undefined,sessionId);
  if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
  if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;
  await rm(cwd,{recursive:true,force:true});
 }
});
