/* eslint-disable @typescript-eslint/no-explicit-any -- Registered extension test double. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm, writeFile, symlink, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import subagents from '../extensions/subagents/index.ts';
import {runWorkflow} from '../extensions/subagents/workflow.ts';
const cwd = await mkdtemp(join(tmpdir(), 'fifo-regression-'));
process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
const tools = new Map<string, any>(), events = new Map<string, any>();
const ctx = {cwd, hasUI: true, sessionManager:{getSessionId:()=> 'fifo-only'}, ui:{setWidget(){},setStatus(){},editor:async (_:string,s:string)=>s,confirm:async()=>true}};
subagents({getActiveTools:()=>['read','workflow'],registerTool:(t:any)=>tools.set(t.name,t),registerCommand:()=>{},on:(n:string,h:any)=>events.set(n,h)} as any);
const execute = (source:string, timeout=1000) => tools.get('workflow').execute('fifo',{source,timeout},undefined,undefined,ctx);
try {
  execFileSync('mkfifo',[join(cwd,'pipe')]);
  await assert.rejects(execute('return await api.readFile("pipe");'), /regular file/);
  await assert.rejects(execute('try { await api.readFile("pipe"); } catch {} await new Promise(() => {});'), /timed out/);
  let ready!:()=>void;
  const started = new Promise<void>(resolve=>{ready=resolve;});
  ctx.ui.editor = async (_,s) => {ready();return s;};
  const running = execute('try { await api.readFile("pipe"); } catch {} await new Promise(() => {});', 10000);
  const rejected = assert.rejects(running, /aborted/);
  await started;
  await new Promise(resolve=>setTimeout(resolve,500));
  await events.get('session_shutdown')();
  await rejected;
  // A final-component substitution between authorization and open must not follow a symlink.
  await writeFile(join(cwd,'file'),'inside');
  await assert.rejects(runWorkflow({cwd,journalDirectory:join(cwd,'journals'),policyIdentity:'race',source:'return await api.readFile("file");',approve:async()=>true,spawn:async()=>{},authorizeRead:async path=>{await rename(path,path+'.old');await symlink('/etc/passwd',path);}}), /ELOOP|symbolic link/);
  console.log('FIFO_REGRESSION_PASS: regular-file rejection, timeout, registered session shutdown, symlink substitution');
} finally {await rm(cwd,{recursive:true,force:true});}
