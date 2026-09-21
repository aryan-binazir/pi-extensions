import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runWorkflow } from './workflow.ts';

test('workflow rejects unapproved source, executes approved TS, and replays successful stages', async () => {
 const cwd = await mkdtemp(join(tmpdir(),'workflow-'));
 let calls = 0;
 const options = {source:'const n: number = 2; return await api.spawn({ task: `Read ${n}`, preset: "reader" }, "read");',cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'reader-only',approveReplay:async()=>true,spawn:async()=>{calls++;return {output:'done'};},approve:async()=>false};
 try {
  await assert.rejects(runWorkflow(options),/approval/);
  assert.equal(calls,0);
  assert.deepEqual(await runWorkflow({...options,approve:async source=>source===options.source}),{output:'done'});
  assert.equal(calls,1);
  assert.deepEqual(await runWorkflow({...options,approve:async()=>true}),{output:'done'});
  assert.equal(calls,1);
  await runWorkflow({...options,policyIdentity:'changed',approve:async()=>true});
  assert.equal(calls,2);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('capabilities enforce read bounds, retries, checkpoints, and restricted globals', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-caps-'));
 await writeFile(join(cwd,'input'),'hello');
 let attempts=0;
 const base={cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'same',approve:async()=>true,approveReplay:async()=>true,spawn:async()=>{if(++attempts===1)throw new Error('temporary');return 'passed';}};
 try {
  const source='return await api.parallel([async()=>api.checkpoint("fetch",async()=>api.retry(2,async()=>api.spawn({task:"read"},"read"))),async()=>api.readFile("input",5),async()=>typeof process]);';
  assert.deepEqual(await runWorkflow({...base,source}),['passed','hello','undefined']);
  assert.equal(attempts,2);
  assert.deepEqual(await runWorkflow({...base,source}),['passed','hello','undefined']);
  assert.equal(attempts,2);
  await assert.rejects(runWorkflow({...base,source:'return await api.readFile("input",4);'}),/byte limit/);
  const outside=join(cwd,'..',`${cwd.split('/').at(-1)}-outside`);
  await writeFile(outside,'outside');
  try {await assert.rejects(runWorkflow({...base,source:`return await api.readFile(${JSON.stringify(outside)});`}),/escapes workflow cwd/);}
  finally {await rm(outside,{force:true});}
  await assert.rejects(runWorkflow({...base,source:'return Function("return process")();'}),/Code generation/);
  await assert.rejects(runWorkflow({...base,source:'while (true) {}',timeout:20000}),/Script execution timed out after 100ms/);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('abort cancels outstanding children and unfinished workflow calls cannot report success', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-abort-'));
 let cancelled=0;
 // Aborting once the child is actually running is deterministic; a wall-clock
 // deadline here would have to cover the Node probe and worker spawn as well.
 let onSpawn:(()=>void)|undefined;
 const base={cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'same',approve:async()=>true,approveReplay:async()=>true,spawn:async(_task:unknown,signal:AbortSignal)=>await new Promise((_,reject)=>{const abort=()=>{cancelled++;reject(new Error('cancelled'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();onSpawn?.();})};
 try {
  await assert.rejects(runWorkflow({...base,source:'void api.spawn({task:"hang"},"hang");return "incorrect success";'}),/unfinished/);
  assert.equal(cancelled,1);
  const running=new AbortController();
  onSpawn=()=>running.abort();
  await assert.rejects(runWorkflow({...base,source:'return await api.spawn({task:"hang"},"hang");',signal:running.signal}),/aborted/);
  onSpawn=undefined;
  assert.equal(cancelled,2);
  await assert.rejects(runWorkflow({...base,source:'return 1;',approve:async()=>{throw new Error('UI failed');}}),/approval failed/);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('replay requires explicit confirmation and validates cached child permissions', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-replay-'));
 let calls=0;let checks=0;
 const base={cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'same',source:'return await api.spawn({task:"read"},"stable");',approve:async()=>true,spawn:async()=>{calls++;return 'done';},validateTask:async()=>{checks++;}};
 try {
  await runWorkflow(base);
  await assert.rejects(runWorkflow(base),/replay approval/);
  await assert.rejects(runWorkflow({...base,approveReplay:async()=>false}),/replay approval/);
  assert.equal(calls,1);
  await assert.rejects(runWorkflow({...base,approveReplay:async()=>true,validateTask:async()=>{throw new Error('permissions changed');}}),/permissions changed/);
  await runWorkflow({...base,approveReplay:async()=>true});
  assert.equal(calls,1);assert.equal(checks,1);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('oversize workflow results and capability messages fail before reaching the parent tool',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'workflow-size-'));
 const base={cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'same',approve:async()=>true,spawn:async()=>{throw new Error('Oversize capability must never execute');}};
 try {
  await assert.rejects(runWorkflow({...base,source:'return "x".repeat(300000);'}),/result exceeds/);
  await assert.rejects(runWorkflow({...base,source:'return await api.spawn({task:"x".repeat(1100000)},"oversize");'}),/message exceeds/);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('workflow fails closed when a real supported Node is unavailable on PATH', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-node-'));
 const previousPath=process.env.PATH;
 let children=0;
 const base={source:'return await api.spawn({task:"read"},"read");',cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'node-test',approve:async()=>true,spawn:async()=>{children++;return 'unexpected';}};
 try {
  process.env.PATH=cwd;
  await assert.rejects(runWorkflow(base),/Workflow requires.*Node/);
  await writeFile(join(cwd,'node'),'#!/bin/sh\nprintf \'{"execPath":"/invalid/node","version":"20.0.0"}\\n\'\n',{mode:0o700});
  await assert.rejects(runWorkflow(base),/Unsupported workflow Node version/);
  assert.equal(children,0);
 } finally {process.env.PATH=previousPath;await rm(cwd,{recursive:true,force:true});}
});

test('workflow rejects a Node candidate that cannot enforce permissions', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-permission-probe-'));
 const previousPath=process.env.PATH;
 try {
  const candidate=join(cwd,'node');
  await writeFile(candidate,`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({execPath:candidate,version:'24.18.0'})}'\n`,{mode:0o700});
  process.env.PATH=cwd;
  await assert.rejects(runWorkflow({source:'return 1;',cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'permission-probe',approve:async()=>true,spawn:async()=>{throw new Error('must not spawn');}}),/permission capability probe failed/);
 } finally {process.env.PATH=previousPath;await rm(cwd,{recursive:true,force:true});}
});

test('parallel duplicate stages are reserved before asynchronous task validation', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'workflow-stage-race-'));
 let calls=0;
 try {
  await assert.rejects(runWorkflow({cwd,journalDirectory:join(cwd,'journal'),policyIdentity:'race',approve:async()=>true,
   source:'return await api.parallel([()=>api.spawn({task:"read"},"same"),()=>api.spawn({task:"read"},"same")]);',
   spawn:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return 'done';},
  }),/Concurrent duplicate spawn stage/);
  assert.ok(calls<=1,`duplicate stage launched ${calls} children`);
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('FIFO capability, timeout and registered shutdown settle in a bounded subprocess', async () => {
  const fixture = fileURLToPath(new URL('../../tests/fifo-regression.fixture.ts', import.meta.url));
  const {stdout} = await promisify(execFile)(process.execPath, ['--import', 'tsx', fixture], {timeout: 15000, killSignal: 'SIGKILL'});
  assert.match(stdout, /FIFO_REGRESSION_PASS/);
});


const bounded = async (run: (options: any) => Promise<unknown>): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-bounds-'));
  try { await run({cwd, journalDirectory: join(cwd, 'journal'), policyIdentity: 'bounds', approve: async () => true, approveReplay: async () => true}); }
  finally { await rm(cwd, {recursive: true, force: true}); }
};

for (const [label, source, error] of [
  ['a spawn without an explicit stage label', "return await api.spawn({task:'x'});", /explicit stable stage label/],
  ['parallel with more than 16 functions', "return await api.parallel(Array.from({length:17},(_,i)=>()=>api.spawn({task:'x'},'s'+i)));", /at most 16 functions/],
  ['retry with more than 5 attempts', "return await api.retry(6,()=>api.spawn({task:'x'},'r'));", /attempts must be 1–5/],
] as const) test(`${label} is rejected before any child launches`, async () => bounded(async base => {
  let launches = 0;
  await assert.rejects(runWorkflow({...base, source, spawn: async () => { launches++; return 'x'; }}), error);
  assert.equal(launches, 0);
}));

test('a stage label cannot replay the cached result of a different task', async () => bounded(async base => {
  await writeFile(join(base.cwd, 'input'), 'hello');
  const options = {...base, source: "const n = await api.readFile('input', 5); return await api.spawn({task: n}, 'stage');", spawn: async (task: any) => 'ran:' + task.task};
  assert.equal(await runWorkflow(options), 'ran:hello');
  await writeFile(join(base.cwd, 'input'), 'world');
  await assert.rejects(runWorkflow(options), /reused for a different task/);
}));
