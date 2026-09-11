import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import autoMode from './index.ts';
import { childPolicy, inheritedPolicy, setActivePolicy, AutoPolicy, assertChildTask } from './policy.ts';

function fixture() {
  const handlers:Record<string,any>={},commands:Record<string,any>={};
  const entries:unknown[]=[];
  autoMode({on:(name:string,handler:any)=>{handlers[name]=handler;},events:{on:()=>{},emit:()=>{}},getAllTools:()=>['read','write','edit','bash','grep','find','ls'].map(name=>({name})),getActiveTools:()=>['read','write','edit','bash','grep','find','ls'],registerCommand:(name:string,command:any)=>{commands[name]=command;},appendEntry:(_name:string,entry:unknown)=>{entries.push(entry);}} as any);
  const ctx:any={cwd:tmpdir(),hasUI:false,mode:'print',ui:{setStatus:()=>{},notify:()=>{}},sessionManager:{getBranch:()=>[],getSessionId:()=>'default'}};
  return {handlers,commands,ctx,entries};
}

test('registered pre-execution handler blocks unapproved calls without UI and records decisions', async()=>{
  const {handlers,ctx,entries,commands}=fixture();
  await handlers.session_start({},ctx);
  assert.equal((await handlers.tool_call({toolName:'bash',input:{command:'touch /tmp/denied'},toolCallId:'one'},ctx)).block,true);
  assert.equal(await handlers.tool_call({toolName:'read',input:{path:'example'},toolCallId:'two'},ctx),undefined);
  assert.equal(entries.length,2);
  await commands.auto.handler('off',ctx);
  assert.equal(await handlers.tool_call({toolName:'bash',input:{command:'touch /tmp/allowed'},toolCallId:'three'},ctx),undefined);
  await handlers.session_shutdown();
});

test('children inherit a mandatory guard, restricted tools and workspace without approval cache',async()=>{
  const previous=process.env.PI_AGENT_POLICY;
  try {
    setActivePolicy(new AutoPolicy(tmpdir(),['read']));
    const child=childPolicy(tmpdir());
    assert.match(child.extensions[0],/auto-mode\/index.ts$/);
    process.env.PI_AGENT_POLICY=child.env.PI_AGENT_POLICY;
    const policy=inheritedPolicy()!;
    assert.equal(policy.inherited,true);
    assert.equal((await policy.check({tool:'write',input:{path:'x',content:'bad'},cwd:tmpdir()})).allow,false);
    await assert.rejects(assertChildTask({cwd:'/etc',tools:['read']}),/outside/);
    await assert.rejects(assertChildTask({cwd:tmpdir(),tools:['bash']}),/permissions/);
    setActivePolicy(undefined);
    const {handlers,ctx,commands}=fixture();
    await handlers.session_start({},ctx);
    await commands.auto.handler('off',ctx);
    assert.equal((await handlers.tool_call({toolName:'write',input:{path:'x',content:'bad'},toolCallId:'child'},ctx)).block,true);
    await handlers.session_shutdown();
  } finally {setActivePolicy(undefined);if(previous===undefined)delete process.env.PI_AGENT_POLICY;else process.env.PI_AGENT_POLICY=previous;}
});

test('malformed inherited policy blocks all tool calls',async()=>{
  const previous=process.env.PI_AGENT_POLICY;
  try {
    process.env.PI_AGENT_POLICY='invalid';
    const {handlers,ctx}=fixture();
    assert.equal((await handlers.tool_call({toolName:'read',input:{path:'x'},toolCallId:'bad'},ctx)).block,true);
  } finally {if(previous===undefined)delete process.env.PI_AGENT_POLICY;else process.env.PI_AGENT_POLICY=previous;}
});

test('real subprocess enforces inherited guard before a child filesystem write',async()=>{
  const {spawn}=await import('node:child_process');
  const {mkdtemp,rm,access}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'auto-child-'));
  const target=join(dir,'forbidden');
  try {
    setActivePolicy(new AutoPolicy(dir,['read']));
    const child=childPolicy(dir,['read']);
    const source=`
      import autoMode from ${JSON.stringify(new URL('./index.ts',import.meta.url).href)};
      import {writeFile} from 'node:fs/promises';
      const hooks={};
      autoMode({on:(n,h)=>hooks[n]=h,events:{on(){},emit(){}},getAllTools:()=>['read','write'].map(name=>({name})),getActiveTools:()=>['read','write'],registerCommand(){},appendEntry(){}});
      const ctx={cwd:${JSON.stringify(dir)},hasUI:false,mode:'print',ui:{setStatus(){}},sessionManager:{getBranch:()=>[],getSessionId:()=>'default'}};
      await hooks.session_start({},ctx);
      const decision=await hooks.tool_call({toolName:'write',toolCallId:'real-child',input:{path:${JSON.stringify(target)},content:'bad'}},ctx);
      if(!decision?.block) await writeFile(${JSON.stringify(target)},'bad');
      if(!decision?.block || !decision.reason.includes('inherited permissions')) process.exitCode=2;
    `;
    const code=await new Promise<number|null>((resolve,reject)=>{
      const processChild=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),env:{...process.env,...child.env},stdio:['ignore','ignore','pipe']});
      let stderr='';processChild.stderr.on('data',chunk=>{stderr+=chunk;});
      processChild.on('error',reject);processChild.on('close',code=>code===0?resolve(code):reject(new Error(`Child failed ${code}: ${stderr}`)));
    });
    assert.equal(code,0);
    await assert.rejects(access(target));
  } finally {setActivePolicy(undefined);await rm(dir,{recursive:true,force:true});}
});

test('coexisting sessions do not share mode, permissions or workflow replay identity',async()=>{
  const {checkAction}=await import('./policy.ts');
  const first=new AutoPolicy(tmpdir(),['read']);
  const second=new AutoPolicy(tmpdir());second.mode='off';
  setActivePolicy(first,'first');setActivePolicy(second,'second');
  try {
    const action={tool:'bash',input:{command:'echo denied'},cwd:tmpdir()};
    assert.equal((await checkAction(action,{},'first')).allow,false);
    assert.equal((await checkAction(action,{},'second')).allow,true);
    assert.deepEqual(JSON.parse(childPolicy(tmpdir(),undefined,'first').env.PI_AGENT_POLICY).tools,['read']);
    const identity=childPolicy(tmpdir(),undefined,'second').env.PI_AGENT_POLICY;
    second.mode='on';
    assert.notEqual(childPolicy(tmpdir(),undefined,'second').env.PI_AGENT_POLICY,identity);
  } finally {setActivePolicy(undefined,'first');setActivePolicy(undefined,'second');}
});

test('package runs auto policy after owned routing and delegation extensions',async()=>{
  const {readFile}=await import('node:fs/promises');
  const manifest=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.pi.extensions.at(-1),'./extensions/auto-mode/index.ts');
});

test('session switches remove the previous active policy registration',async()=>{
  const {handlers,commands,ctx}=fixture();
  let id='switch-old';
  ctx.sessionManager.getSessionId=()=>id;
  try {
    await handlers.session_start({},ctx);
    await commands.auto.handler('off',ctx);
    const {checkAction}=await import('./policy.ts');
    const action={tool:'bash',input:{command:'echo needs approval'},cwd:tmpdir()};
    assert.equal((await checkAction(action,{},id)).allow,true);
    id='switch-new';
    await handlers.session_start({},ctx);
    assert.equal((await checkAction(action,{},'switch-old')).allow,false);
    assert.equal((await checkAction(action,{},id)).allow,false);
  } finally {await handlers.session_shutdown();setActivePolicy(undefined,'switch-old');}
});
