import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
 subagents({getActiveTools: () => ['read','write','edit','bash','grep','find','ls'], registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},on:(name:string,handler:any)=>events.set(name,handler)} as unknown as ExtensionAPI);
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
  subagents({getActiveTools: () => ['read','write','edit','bash','grep','find','ls'], registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},on:(name:string,handler:any)=>events.set(name,handler),sendMessage:(message:any,options:any)=>notify({message,options})} as unknown as ExtensionAPI);
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
  assert.equal(child.policy.inherited,true);assert.equal(child.policy.root,await realpath(cwd));
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

test('RPC UI approves extensions once per real spawn and reauthorizes cached workflow stages', async () => {
  const {chmod} = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-rpc-'));
  const previousPath = process.env.PATH, previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessionId = 'workflow-rpc-test';
  const tools = new Map<string, any>(), events = new Map<string, any>();
  const approvals: string[] = [];
  let allowExtensions = true;
  let completions = 0;
  const ctx = {
    cwd, hasUI: true, mode: 'rpc', sessionManager: {getSessionId: () => sessionId},
    ui: {
      editor: async (_title: string, source: string) => source,
      confirm: async (title: string) => { approvals.push(title); return title.includes('child extensions') ? allowExtensions : true; },
      setWidget: () => {},
    },
  };
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    await writeFile(join(cwd, 'trusted.ts'), 'export default () => {};');
    process.env.PATH = `${cwd}:${previousPath ?? ''}`;
    process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent-home');
    const policy = new AutoPolicy(cwd);
    setActivePolicy(policy, sessionId);
    subagents({getActiveTools: () => ['read','write','edit','bash','grep','find','ls'], registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler), sendMessage: () => { completions++; }} as unknown as ExtensionAPI);
    await events.get('session_start')({}, ctx);
    const source = `return await api.spawn({task:'read',preset:'reader',extensions:[${JSON.stringify(join(cwd, 'trusted.ts'))}]},'read');`;
    const execute = () => tools.get('workflow').execute('call', {source}, undefined, undefined, ctx);
    await execute();
    assert.equal(completions, 1);
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 1);
    policy.directive('Retry the exact same approved workflow after the failed turn');
    allowExtensions = false;
    await assert.rejects(execute(), /Child extension loading was not approved/);
    assert.equal(completions, 1, 'rejected replay must not launch a child');
    allowExtensions = true;
    await execute();
    assert.equal(completions, 1, 'approved replay must reuse the cached child');
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 3);
  } finally {
    await events.get('session_shutdown')?.();
    setActivePolicy(undefined, sessionId);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
});

test('cancelled switches keep the registry usable; committed shutdown reaps children', async () => {
  const {chmod} = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-switch-'));
  const previousPath = process.env.PATH;
  const sessionId = 'subagent-switch-test';
  const tools = new Map<string, any>(), events = new Map<string, any>();
  const ctx = {cwd, hasUI: false, mode: 'print', sessionManager: {getSessionId: () => sessionId}};
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:String(process.pid)}}));setInterval(()=>{},1000);`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${previousPath ?? ''}`;
    setActivePolicy(new AutoPolicy(cwd), sessionId);
    subagents({getActiveTools: () => ['read','write','edit','bash','grep','find','ls'], registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler), sendMessage: () => {}} as unknown as ExtensionAPI);
    await events.get('session_start')({}, ctx);
    const launch = () => tools.get('subagent').execute('call', {task: 'wait', preset: 'reader'}, undefined, undefined, ctx);
    await launch();
    // Another extension cancels the request after all before-switch handlers run.
    await events.get('session_before_switch')?.({reason: 'resume'}, ctx);
    await launch();
    const status = async () => (await tools.get('subagent_status').execute()).details;
    let running = await status();
    const deadline = Date.now() + 5000;
    while (running.some((task: any) => !task.output) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      running = await status();
    }
    assert.equal(running.length, 2);
    assert.ok(running.every((task: any) => task.status === 'running' && Number(task.output) > 0));
    const pids = running.map((task: any) => Number(task.output));
    await events.get('session_shutdown')({reason: 'resume'}, ctx);
    assert.ok((await status()).every((task: any) => task.status === 'cancelled'));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  } finally {
    await events.get('session_shutdown')?.();
    setActivePolicy(undefined, sessionId);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(cwd, {recursive: true, force: true});
  }
});

test('standalone registered subagents and workflows inherit active builtins and workspace without auto mode', async () => {
  const {chmod} = await import('node:fs/promises');
  const cwd = await mkdtemp(join(tmpdir(), 'standalone-subagents-'));
  const previousPath = process.env.PATH, previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tools = new Map<string, any>(), events = new Map<string, any>();
  let active = ['read', 'subagent', 'workflow'];
  const ctx = {cwd, hasUI: true, sessionManager: {getSessionId: () => 'standalone-only'}, ui: {
    editor: async (_title: string, source: string) => source, confirm: async () => true, setWidget: () => {},
  }};
  subagents({getActiveTools: () => active, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: () => {}, on: (name: string, handler: any) => events.set(name, handler), sendMessage: () => {}} as unknown as ExtensionAPI);
  const direct = (params: any) => tools.get('subagent').execute('call', params, undefined, undefined, ctx);
  const workflow = (source: string) => tools.get('workflow').execute('call', {source}, undefined, undefined, ctx);
  const directPolicy = async (preset?: string) => {
    const response = await direct({task: 'valid direct child', preset});
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const task = (await tools.get('subagent_status').execute()).details.find((task: any) => task.id === response.details.id);
      if (task.status === 'succeeded') return JSON.parse(task.output);
      assert.ok(['queued', 'running'].includes(task.status), JSON.stringify(task));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Direct child did not complete');
  };
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.PI_AGENT_POLICY}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    await writeFile(join(cwd, 'input'), 'safe');
    process.env.PATH = `${cwd}:${previousPath ?? ''}`;
    process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent-home');
    await events.get('session_start')({}, ctx);
    for (const tool of ['write', 'bash']) {
      await assert.rejects(direct({task: 'escalate', tools: [tool]}), /exceed parent permissions/);
      await assert.rejects(workflow(`return await api.spawn({task:'escalate',tools:['${tool}']},'${tool}');`), /exceed parent permissions/);
    }
    await assert.rejects(direct({task: 'escape', cwd: tmpdir()}), /outside parent workspace/);
    await assert.rejects(workflow(`return await api.spawn({task:'escape',cwd:${JSON.stringify(tmpdir())}},'escape');`), /escapes workflow cwd/);
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'valid', preset})},'valid');`);
      const policy = JSON.parse(response.details.output);
      assert.deepEqual(policy.tools, ['read']);
      assert.deepEqual((await directPolicy(preset)).tools, ['read']);
      assert.equal(policy.root, await realpath(cwd));
    }
    active = ['subagent', 'workflow'];
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'reason only', preset})},'reason');`);
      assert.deepEqual(JSON.parse(response.details.output).tools, []);
      assert.deepEqual((await directPolicy(preset)).tools, []);
    }
    await assert.rejects(workflow('return await api.readFile("input");'), /outside parent permissions/);
  } finally {
    await events.get('session_shutdown')();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
});
