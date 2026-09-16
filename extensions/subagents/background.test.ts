import { fixtureModelRegistry } from './test-support.ts';
import assert from 'node:assert/strict';
import { chmod,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import subagents from './index.ts';

async function fixture(run:(host:any)=>Promise<void>){
 const cwd=await mkdtemp(join(tmpdir(),'pi-background-preflight-'));
 const priorPath=process.env.PATH,priorAgent=process.env.PI_CODING_AGENT_DIR;
 const tools=new Map<string,any>(),hooks=new Map<string,any>();
 const activity:{id:string;active:boolean}[]=[];
 const sessionId='background-'+cwd;
 try{
  await writeFile(join(cwd,'pi'),`#!${process.execPath}\nconst task=process.argv.at(-1);if(task==='hold'){setInterval(()=>{},1000);}else if(task==='fail'){process.exit(2);}else{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'fixture result'}]}}));}`);
  await chmod(join(cwd,'pi'),0o700);process.env.PATH=cwd+':'+priorPath;process.env.PI_CODING_AGENT_DIR=join(cwd,'agent');
  const ctx={modelRegistry: fixtureModelRegistry(),cwd,model:{provider:'test',id:'fixture'},thinkingLevel:'off',hasUI:true,mode:'tui',sessionManager:{getSessionId:()=>sessionId},ui:{setStatus(){},setWidget(){},editor:async(_title:string,source:string)=>source,confirm:async()=>true}};
  subagents({getActiveTools:()=>['read','write','edit','bash','grep','find','ls'],registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand(){},on:(name:string,fn:any)=>hooks.set(name,fn),sendMessage(){},events:{emit:(name:string,value:any)=>{if(name==='pi-interactive:background-activity')activity.push(value);}}} as any);
  await hooks.get('session_start')({},ctx);
  const execute=(name:string,args:any)=>tools.get(name).execute('fixture',args,undefined,undefined,ctx);
  const finish=async()=>{const end=Date.now()+5000;while(!activity.some(a=>!a.active)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(activity.length,2);assert.deepEqual(activity,[{id:activity[0].id,active:true},{id:activity[0].id,active:false}]);};
  await run({execute,activity,finish,cwd});
 }finally{
  await hooks.get('session_shutdown')?.();
  if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;
  if(priorAgent===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=priorAgent;
  await rm(cwd,{recursive:true,force:true});
 }
}
test('subagent completion emits one active interval',async()=>fixture(async({execute,activity,finish}:any)=>{
 const value=await execute('subagent',{task:'complete',preset:'reader'});await finish();assert.equal(activity[0].id,value.details.id);
}));
test('subagent cancellation closes its active interval',async()=>fixture(async({execute,finish}:any)=>{
 const value=await execute('subagent',{task:'hold',preset:'reader'});await execute('subagent_cancel',{id:value.details.id});await finish();
}));
test('child failure closes its active interval',async()=>fixture(async({execute,finish}:any)=>{
 await execute('subagent',{task:'fail',preset:'reader'});await finish();
}));
test('workflow spawn emits and closes an active interval',async()=>fixture(async({execute,finish,cwd}:any)=>{
 await execute('workflow',{source:`return await api.spawn({task:'complete',cwd:${JSON.stringify(cwd)},preset:'reader'},'child');`});await finish();
}));
test('failed workflow child closes its active interval',async()=>fixture(async({execute,finish,cwd}:any)=>{
 await assert.rejects(execute('workflow',{source:`return await api.spawn({task:'fail',cwd:${JSON.stringify(cwd)},preset:'reader'},'child');`}),/failed/);await finish();
}));
