import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SubagentRegistry } from './registry.ts';

test('isolated processes stream text and usage and push completion without polling', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagents-'));
  const updates: string[] = [];
  const notifications: string[] = [];
  const registry = new SubagentRegistry({
    invocation: () => ({command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'hello'}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',usage:{input:2,output:3},content:[{type:'text',text:'hello'}]}}))`]}),
    onUpdate: task => updates.push(task.output), onComplete: task => notifications.push(task.status),
  });
  try {
    const task = await registry.spawn({task:'Say hello', cwd, preset:'reader'});
    const result = await task.done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'hello');
    assert.deepEqual(result.usage, {input:2,output:3});
    assert.ok(updates.includes('hello'));
    assert.deepEqual(notifications, ['succeeded']);
  } finally {await registry.shutdown(); await rm(cwd,{recursive:true,force:true});}
});

test('failure, timeout, cancellation and session shutdown settle real subprocesses', async () => {
  const registry = new SubagentRegistry({invocation: spec => ({command: process.execPath,args:['-e',spec.task === 'fail' ? 'process.exit(7)' : 'setInterval(()=>{},1000)']})});
  try {
    assert.equal((await (await registry.spawn({task:'fail',cwd:tmpdir()})).done).status,'failed');
    assert.equal((await (await registry.spawn({task:'hang',cwd:tmpdir(),timeout:50})).done).status,'timed-out');
    const cancelled = await registry.spawn({task:'hang',cwd:tmpdir()});
    assert.equal(registry.cancel(cancelled.id),true);
    assert.equal((await cancelled.done).status,'cancelled');
    const shutdown = await registry.spawn({task:'hang',cwd:tmpdir()});
    await registry.shutdown();
    assert.equal((await shutdown.done).status,'cancelled');
    await assert.rejects(registry.spawn({task:'late',cwd:tmpdir()}),/shut down/);
  } finally {await registry.shutdown();}
});

test('writers using a directory symlink serialize while unrelated readers can run', async () => {
  const cwd = await mkdtemp(join(tmpdir(),'writers-'));
  await symlink(cwd,join(cwd,'alias'));
  const registry = new SubagentRegistry({concurrency:2,invocation:()=>({command:process.execPath,args:['-e',`setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}})),150)`]})});
  try {
    const first = await registry.spawn({task:'first',cwd});
    const second = await registry.spawn({task:'second',cwd:join(cwd,'alias')});
    const reader = await registry.spawn({task:'reader',cwd,preset:'reader'});
    assert.deepEqual(registry.list().map(t=>t.status),['running','queued','running']);
    await Promise.all([first.done,second.done,reader.done]);
    assert.ok(registry.list().every(t=>t.status === 'succeeded'));
  } finally {await registry.shutdown();await rm(cwd,{recursive:true,force:true});}
});

test('notification errors settle tasks and do not strand queued writers', async () => {
 const registry=new SubagentRegistry({concurrency:1,invocation:()=>({command:process.execPath,args:['-e',`console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}}))`]}),onComplete:()=>{throw new Error('UI gone');}});
 try {
  const first=await registry.spawn({task:'one',cwd:tmpdir()});
  const second=await registry.spawn({task:'two',cwd:tmpdir()});
  const results=await Promise.all([first.done,second.done]);
  assert.ok(results.every(r=>r.status==='succeeded' && r.notificationError?.includes('UI gone')));
 } finally {await registry.shutdown();}
});

test('timeout reaps a child and its ordinary process-group descendants', async()=>{
 const {readFile}=await import('node:fs/promises');
 const {execFileSync}=await import('node:child_process');
 const cwd=await mkdtemp(join(tmpdir(),'process-tree-'));const marker=join(cwd,'pid');
 const script=`const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
 const registry=new SubagentRegistry({invocation:()=>({command:process.execPath,args:['-e',script]})});
 try {
  const task=await registry.spawn({task:'spawn descendant',cwd,timeout:200});
  assert.equal((await task.done).status,'timed-out');
  const pid=Number(await readFile(marker,'utf8'));
  let alive=true;
  for(let attempt=0;attempt<20;attempt++){
   try {process.kill(pid,0);const status=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();alive=!status.startsWith('Z');}catch{alive=false;}
   if(!alive)break;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(alive,false,'grandchild must be dead or awaiting OS zombie reaping');
 } finally {await registry.shutdown();await rm(cwd,{recursive:true,force:true});}
});

test('invalid task model, tools, preset, cwd, extensions and timeout never launch a process',async()=>{
 let launched=0;
 const registry=new SubagentRegistry({invocation:()=>{launched++;return {command:process.execPath,args:['-e','process.exit(0)']};}});
 const base={task:'read',cwd:tmpdir()};
 try {
  for(const bad of [{task:''},{cwd:'relative'},{model:'--unsafe'},{preset:'unknown'},{preset:'reader',tools:['bash']},{tools:['unknown']},{extensions:['relative.ts']},{timeout:0}]) {
   await assert.rejects(registry.spawn({...base,...bad} as any));
  }
  assert.equal(launched,0);
 } finally {await registry.shutdown();}
});

test('split UTF-8 stdout and stderr retain non-ASCII text', async () => {
  const script = `
    const record=Buffer.from(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'café 🚀'}})+'\\n');
    const split=record.indexOf(Buffer.from('é'))+1;
    process.stdout.write(record.subarray(0,split));
    process.stderr.write(Buffer.from([0xf0,0x9f]));
    setTimeout(()=>{process.stdout.write(record.subarray(split));process.stderr.write(Buffer.from([0x9a,0x80]));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'café 🚀'}]}}));},50);
  `;
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'unicode', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'café 🚀');
    assert.equal(result.stderr, '🚀');
  } finally { await registry.shutdown(); }
});

test('notification failures preserve the original child error', async () => {
  const registry = new SubagentRegistry({
    invocation: () => ({command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider refused request'}}))`]}),
    onComplete: () => { throw new Error('UI gone'); },
  });
  try {
    const result = await (await registry.spawn({task: 'fail', cwd: tmpdir()})).done;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'provider refused request');
    assert.match(result.notificationError!, /UI gone/);
  } finally { await registry.shutdown(); }
});

test('explicit tools must respect parent permissions without an authorize callback', async () => {
  const launched: string[][] = [];
  let allowed = ['read'];
  const registry = new SubagentRegistry({
    allowedTools: () => allowed,
    invocation: spec => {
      launched.push(spec.tools);
      return {command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}}));`]};
    },
  });
  try {
    await assert.rejects(registry.spawn({task: 'escalate', cwd: tmpdir(), tools: ['bash']}), /exceed parent permissions/);
    assert.deepEqual(launched, []);
    for (const selection of [{tools: ['read']}, {}, {preset: 'reader' as const}, {preset: 'writer' as const}]) {
      assert.equal((await (await registry.spawn({task: 'read', cwd: tmpdir(), ...selection})).done).status, 'succeeded');
    }
    assert.deepEqual(launched, [['read'], ['read'], ['read'], ['read']]);
    allowed = [];
    await assert.rejects(registry.spawn({task: 'escalate', cwd: tmpdir(), tools: ['read']}), /exceed parent permissions/);
    assert.equal(launched.length, 4);
    assert.equal((await (await registry.spawn({task: 'reason', cwd: tmpdir()})).done).status, 'succeeded');
    assert.deepEqual(launched.at(-1), []);
  } finally { await registry.shutdown(); }
});

for (const missingGroup of [false, true]) {
  test(`child exit attempts group cleanup only once, including close (ESRCH: ${missingGroup})`, async t => {
    const kill = t.mock.method(process, 'kill', () => {
      if (missingGroup) throw Object.assign(new Error('No such process'), {code: 'ESRCH'});
      return true;
    });
    const registry = new SubagentRegistry({invocation: () => ({
      command: process.execPath,
      args: ['-e', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:String(process.pid)}]}}));`],
    })});
    try {
      const result = await (await registry.spawn({task: 'exit normally', cwd: tmpdir()})).done;
      assert.equal(result.status, 'succeeded');
      const pid = Number(result.output);
      assert.ok(pid > 0);
      assert.deepEqual(kill.mock.calls.map(call => call.arguments), [[-pid, 'SIGKILL']]);
    } finally { await registry.shutdown(); }
  });
}

test('cancellation escalation does not signal the process group again at exit or close', async t => {
  const kill = t.mock.method(process, 'kill');
  let ready!: (pid: number) => void;
  const started = new Promise<number>(resolve => { ready = resolve; });
  const registry = new SubagentRegistry({
    invocation: () => ({command: process.execPath, args: ['-e', `
      process.on('SIGTERM',()=>{});
      console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:String(process.pid)}}));
      setInterval(()=>{},1000);
    `]}),
    onUpdate: task => { if (task.output) ready(Number(task.output)); },
  });
  try {
    const task = await registry.spawn({task: 'ignore graceful cancellation', cwd: tmpdir(), timeout: 5000});
    const pid = await Promise.race([started, task.done.then(() => { throw new Error('Child exited before readiness'); })]);
    assert.ok(pid > 0);
    assert.equal(registry.cancel(task.id), true);
    assert.equal((await task.done).status, 'cancelled');
    assert.deepEqual(kill.mock.calls.map(call => call.arguments), [[-pid, 'SIGTERM'], [-pid, 'SIGKILL']]);
  } finally { await registry.shutdown(); }
});
