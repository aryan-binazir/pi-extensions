import { supervisorAdmission, admissionFixture } from './test-support.ts';
import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { piInvocation, SubagentRegistry } from './registry.ts';
import { assertChildTask, validateTask } from './scope.ts';

test('compiled Pi launches the parent executable while Node and generic Bun keep PATH lookup', async () => {
  const spec = await validateTask({task: 'literal', cwd: tmpdir(), tools: []}, []);
  const execPath = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  const entrypoint = process.argv[1];
  try {
    for (const [runtime, executable, main, expected] of [
      [undefined, '/usr/bin/node', '/scripts/run.ts', 'pi'],
      ['1.3.14', '/usr/bin/bun', '/scripts/run.ts', 'pi'],
      [undefined, '/tools/pi', '/$bunfs/root/pi', 'pi'],
      ['1.3.14', '/tools/pi', '/$bunfs/root/pi', '/tools/pi'],
      ['1.3.14', '/tools/pi.exe', 'B:/~BUN/root/pi.exe', '/tools/pi.exe'],
      ['1.3.14', '/tools/pi', '/scripts/run.ts', 'pi'],
    ] as const) {
      process.argv[1] = main;
      Object.defineProperty(process.versions, 'bun', {configurable: true, value: runtime});
      Object.defineProperty(process, 'execPath', {configurable: true, value: executable});
      const invocation = piInvocation(spec);
      assert.equal(invocation.command, 'node');
      assert.equal(invocation.supervised, true);
      assert.equal(invocation.args[1], expected);
    }
  } finally {
    Object.defineProperty(process, 'execPath', execPath);
    process.argv[1] = entrypoint;
    if (bun) Object.defineProperty(process.versions, 'bun', bun); else delete (process.versions as {bun?: string}).bun;
  }
});

test('an explicit child model also scopes Pi model cycling', async () => {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const {parseArgs} = await import(new URL('./cli/args.js', entry).href);
  const spec = await validateTask({task: 'read', cwd: tmpdir(), model: 'openai-codex/gpt-6-astra'}, []);
  const selected = parseArgs(piInvocation(spec).args.slice(2));
  assert.equal(selected.model, 'openai-codex/gpt-6-astra');
  assert.deepEqual(selected.models, ['openai-codex/gpt-6-astra']);
  const inherited = parseArgs(piInvocation({...spec, model: undefined}).args.slice(2));
  assert.equal(inherited.models, undefined);
});

test('explicit task briefs remain literal messages through Pi attachment parsing with no tools', async () => {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const {parseArgs} = await import(new URL('./cli/args.js', entry).href);
  const {processFileArguments} = await import(new URL('./cli/file-processor.js', entry).href);
  const root = await mkdtemp(join(tmpdir(), 'literal-brief-'));
  const cwd = join(root, 'workspace'), outside = join(root, 'outside.txt');
  try {
    await mkdir(cwd);
    await writeFile(outside, 'SYNTHETIC OUTSIDE DATA');
    const cases = [
      {brief: `@${outside}`, message: `\n@${outside}`},
      {brief: 'normal brief', message: 'normal brief'},
      {brief: '--model literal/provider', message: '--model literal/provider'},
      {brief: '@', message: '\n@'},
      {brief: '@person\n--model literal/provider\n@other  ', message: '\n@person\n--model literal/provider\n@other  '},
      {brief: `@${join(root, 'missing.txt')}`, message: `\n@${join(root, 'missing.txt')}`},
      {brief: '\\@literal', message: '\\@literal'},
      {brief: '\n@already literal', message: '\n@already literal'},
    ];
    for (const {brief, message} of cases) {
      const spec = await validateTask({task: brief, cwd, tools: []}, []);
      await assertChildTask(spec, {parent: {cwd, tools: []}});
      assert.equal(spec.task, brief);
      const parsed = parseArgs(piInvocation(spec).args.slice(2));
      assert.deepEqual(parsed.fileArgs, [], brief);
      assert.deepEqual(parsed.messages, [message], brief);
      assert.deepEqual(parsed.tools, [], brief);
      assert.deepEqual(await processFileArguments(parsed.fileArgs), {text: '', images: []}, brief);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('unused stream records avoid JSON decoding without changing accounting, updates or oversized drops', async t => {
  const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), stdio: []}) as unknown as ChildProcess;
  const ignored = ['message_start', 'tool_execution_update', 'turn_end', 'agent_end', 'entry_appended', 'compaction_end'].map(type => JSON.stringify({type, payload: 'unused'.repeat(1000)}));
  let decoded = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (ignored.includes(text)) decoded++;
    return parse(text, reviver);
  });
  const updates: string[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => child, onUpdate: task => updates.push(task.output)});
  try {
    const handle = await registry.spawn({task: 'stream', cwd: tmpdir()});
    const terminal = {type: 'message_end', message: {role: 'assistant', stopReason: 'stop', usage: {input: 3, output: 2}, content: [{type: 'text', text: 'Complete'}]}};
    for (const line of ignored) child.stdout!.emit('data', line + '\n');
    child.stdout!.emit('data', '{"assistantMessageEvent":{"type":"text_delta","delta":"partial"},"type":"message_update"}\n');
    child.stdout!.emit('data', JSON.stringify(terminal) + '\n');
    child.stdout!.emit('data', JSON.stringify({type: 'turn_end', payload: 'x'.repeat(300000)}) + '\n');
    child.emit('exit', 0, null); child.emit('close', 0, null);
    const result = await handle.done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Complete');
    assert.deepEqual(result.usage, {input: 3, output: 2});
    assert.equal(result.usageIncomplete, undefined);
    assert.equal(result.droppedRecords, 1);
    assert.deepEqual(updates, ['partial']);
    assert.equal(decoded, 0);
  } finally { await registry.shutdown(); }
});

test('isolated processes stream text and usage and push completion without polling', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagents-'));
  const updates: string[] = [];
  const notifications: string[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission,
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
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: spec => ({command: process.execPath,args:['-e',spec.task === 'fail' ? 'process.exit(7)' : 'setInterval(()=>{},1000)']})});
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

test('default concurrency runs eight readers and queues the ninth until a slot opens', async () => {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']})});
  try {
    const tasks = [];
    for (let i = 0; i < 9; i++) tasks.push(await registry.spawn({task: `reader ${i}`, cwd: tmpdir(), preset: 'reader'}));
    assert.equal(registry.list().filter(task => task.status === 'running').length, 8);
    assert.equal(registry.get(tasks[8].id)?.status, 'queued');
    registry.cancel(tasks[0].id);
    await tasks[0].done;
    assert.equal(registry.get(tasks[8].id)?.status, 'running');
    assert.equal(registry.list().filter(task => task.status === 'running').length, 8);
  } finally { await registry.shutdown(); }
});

test('writers using a directory symlink serialize while unrelated readers can run', async () => {
  const cwd = await mkdtemp(join(tmpdir(),'writers-'));
  await symlink(cwd,join(cwd,'alias'));
  const registry = new SubagentRegistry({admission: supervisorAdmission, concurrency:2,invocation:()=>({command:process.execPath,args:['-e',`setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}})),150)`]})});
  try {
    const first = await registry.spawn({task:'first',cwd});
    const second = await registry.spawn({task:'second',cwd:join(cwd,'alias')});
    const reader = await registry.spawn({task:'reader',cwd,preset:'reader'});
    assert.deepEqual(registry.list().map(t=>t.status),['running','queued','running']);
    await Promise.all([first.done,second.done,reader.done]);
    assert.ok(registry.list().every(t=>t.status === 'succeeded'));
  } finally {await registry.shutdown();await rm(cwd,{recursive:true,force:true});}
});

test('notification failures settle tasks, keep the child error and do not strand queued writers', async () => {
 const registry=new SubagentRegistry({admission: supervisorAdmission, concurrency:1,onComplete:()=>{throw new Error('UI gone');},invocation:spec=>({command:process.execPath,args:['-e',spec.task==='fail'
  ? `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'provider refused request'}}))`
  : `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}}))`]})});
 try {
  const first=await registry.spawn({task:'one',cwd:tmpdir()});
  const second=await registry.spawn({task:'two',cwd:tmpdir()});
  const results=await Promise.all([first.done,second.done]);
  assert.ok(results.every(r=>r.status==='succeeded' && r.notificationError?.includes('UI gone')));
  const failed=await (await registry.spawn({task:'fail',cwd:tmpdir()})).done;
  assert.equal(failed.status,'failed');
  assert.equal(failed.error,'provider refused request');
  assert.match(failed.notificationError!,/UI gone/);
 } finally {await registry.shutdown();}
});

test('timeout reaps a child and its ordinary process-group descendants', async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'process-tree-'));const marker=join(cwd,'pid');
 const script=`const {spawn}=require('child_process');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
 const registry=new SubagentRegistry({admission: supervisorAdmission, invocation:()=>({command:process.execPath,args:['-e',script]})});
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
 const registry=new SubagentRegistry({admission: supervisorAdmission, invocation:()=>{launched++;return {command:process.execPath,args:['-e','process.exit(0)']};}});
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
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'unicode', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'café 🚀');
    assert.equal(result.stderr, '🚀');
  } finally { await registry.shutdown(); }
});

test('finished entries keep 64 KiB of output and an 8 KiB diagnostic tail', async () => {
  const script = `
    const line = text => JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
    for (let i = 0; i < 4000; i++) { console.log(line(String(i % 10).repeat(40))); process.stderr.write(String(i % 10).repeat(40)); }
    setTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}})), 50);
  `;
  const expected = Array.from({length: 4000}, (_, i) => String(i % 10).repeat(40)).join('');
  const updates: string[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]}), onUpdate: task => updates.push(task.output)});
  try {
    const result = await (await registry.spawn({task: 'stream', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output.length, 64 * 1024);
    assert.equal(result.output, expected.slice(-64 * 1024));
    assert.equal(result.stderr, expected.slice(-8 * 1024));
    assert.ok(updates.length >= 1);
    for (const update of updates) {
      assert.ok(update.length <= 64 * 1024);
      assert.ok(expected.includes(update));
    }
  } finally { await registry.shutdown(); }
});

test('explicit tools must respect parent permissions without an authorize callback', async () => {
  const launched: string[][] = [];
  let allowed = ['read'];
  const admission = admissionFixture({cwd: () => tmpdir(), tools: () => allowed}).admission;
  const registry = new SubagentRegistry({
    admission,
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
    const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({
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
  const registry = new SubagentRegistry({admission: supervisorAdmission,
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

test('every child loads the hooks and Guardian extensions before any other and refuses to start without them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-hooks-'));
  try {
    const hooks = fileURLToPath(new URL('../hooks/index.ts', import.meta.url));
    const guardian = fileURLToPath(new URL('../guardian/index.ts', import.meta.url));
    const extra = join(cwd, 'extra.ts');
    await writeFile(extra, 'export default () => {};');
    const spec = await validateTask({task: 'Check', cwd, tools: [], extensions: [extra, hooks, guardian]}, []);
    const args = piInvocation(spec).args;
    assert.deepEqual(args.flatMap((arg, i) => arg === '-e' ? [args[i + 1]] : []), [await realpath(hooks), await realpath(guardian), await realpath(extra)]);
    await symlink(join(cwd, 'gone.ts'), join(cwd, 'dangling.ts'));
    for (const missing of [join(cwd, 'missing.ts'), join(cwd, 'dangling.ts')]) {
      await assert.rejects(validateTask({task: 'Check', cwd, tools: []}, [], undefined, missing), /Subagents do not start without the hooks extension/);
      await assert.rejects(validateTask({task: 'Check', cwd, tools: []}, [], undefined, undefined, missing), /Subagents do not start without the guardian extension/);
    }
  } finally { await rm(cwd, {recursive: true, force: true}); }
});


test('the supervisor rejects malformed tasks returned by an admission port', async () => {
  const signal = new AbortController().signal;
  const admitted = await supervisorAdmission.queue({task: 'inspect', cwd: tmpdir(), tools: []}, signal);
  let launches = 0;
  for (const bad of [{task: ''}, {cwd: 'relative'}, {timeout: 0}, {extensions: {}}, {extensions: ['relative.ts']}]) {
    const registry = new SubagentRegistry({admission: {queue: async () => ({...admitted, task: {...admitted.task, ...bad} as any}), launch: () => {}},
      invocation: () => {launches++; throw new Error('Must not launch');}});
    try { await assert.rejects(registry.spawn({task: 'inspect', cwd: tmpdir()})); }
    finally { await registry.shutdown(); }
  }
  assert.equal(launches, 0);
});
