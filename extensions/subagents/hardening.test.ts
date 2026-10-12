import { supervisorAdmission, admissionFixture } from './test-support.ts';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SubagentRegistry } from './registry.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

test('a long-running task remains retained when it finishes after many shorter tasks', async () => {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: spec => {
    if (spec.task === 'long') return {command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']};
    throw new Error('Synthetic short task');
  }});
  try {
    const first = await registry.spawn({task: 'long', cwd: tmpdir(), preset: 'reader'});
    for (let i = 0; i < 51; i++) await (await registry.spawn({task: `short ${i}`, cwd: tmpdir(), preset: 'reader'})).done;
    registry.cancel(first.id);
    await first.done;
    assert.equal(registry.get(first.id)?.status, 'cancelled');
    assert.equal(registry.list().at(-1)?.id, first.id);
  } finally { await registry.shutdown(); }
});

test('cancel-all winning an admission microtask race prevents the launch', async () => {
  for (let depth = 0; depth < 8; depth++) {
    let cancelled = false, lateLaunches = 0;
    let cancellation = Promise.resolve();
    const registry = new SubagentRegistry({admission: {launch: () => {}, queue: async (spec, signal, bridge) => {
      const admitted = await supervisorAdmission.queue(spec, signal, bridge);
      let chain = Promise.resolve();
      for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
      cancellation = chain.then(async () => { cancelled = true; await registry.cancelAll(); });
      return admitted;
    }}, invocation: () => { if (cancelled) lateLaunches++; throw new Error('Synthetic launch boundary'); }});
    try {
      await registry.spawn({task: 'admission race', cwd: tmpdir()}).then(handle => handle.done, () => undefined);
      await cancellation;
      assert.equal(lateLaunches, 0, `launch after cancellation at microtask depth ${depth}`);
    } finally { await registry.shutdown(); }
  }
});

test('queued work cannot launch with tools revoked by its owner while it waited', async () => {
  let allowed = ['read', 'write'];
  const launched: string[] = [];
  const admission = admissionFixture({cwd: () => tmpdir(), tools: () => allowed}).admission;
  const registry = new SubagentRegistry({concurrency: 1, admission, invocation: spec => {
    launched.push(spec.task);
    return {command: process.execPath, args: ['-e', `setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}})),100);`]};
  }});
  try {
    await registry.spawn({task: 'first', cwd: tmpdir(), tools: ['read']});
    const queued = await registry.spawn({task: 'revoked', cwd: tmpdir(), tools: ['write']});
    allowed = ['read'];
    const result = await queued.done;
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /permissions/);
    assert.deepEqual(launched, ['first']);
  } finally { await registry.shutdown(); }
});

test('a burst of streamed events does not repaint observers for every record', async () => {
  let updates = 0;
  const script = `for(let i=0;i<1000;i++)console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'x'}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`;
  const registry = new SubagentRegistry({admission: supervisorAdmission, onUpdate: () => { updates++; }, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'burst', cwd: tmpdir()})).done;
    assert.equal(result.output, 'done');
    assert.ok(updates > 0 && updates <= 10, `received ${updates} updates`);
  } finally { await registry.shutdown(); }
});

test('completed-result retention is bounded without imposing a lifetime launch quota', async () => {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => { throw new Error('Synthetic launch failure'); }});
  try {
    for (let i = 0; i < 1005; i++) await (await registry.spawn({task: `attempt ${i}`, cwd: tmpdir()})).done;
    assert.equal(registry.list().length, 50);
    assert.equal(registry.list().at(-1)?.task, 'attempt 1004');
  } finally { await registry.shutdown(); }
});

test('the task deadline covers unanswered admission approval before any process exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'admission-deadline-'));
  const extension = join(cwd, 'child.ts');
  await writeFile(extension, 'export default () => {};');
  let approvals = 0;
  const admission = admissionFixture({cwd: () => cwd, tools: () => ['read'], approve: () => {approvals++; return new Promise(() => {});}}).admission;
  const registry = new SubagentRegistry({admission});
  try {
    const admission = registry.spawn({task: 'approval', cwd, extensions: [extension], timeout: 200}).then(() => 'started', () => 'rejected');
    const outcome = await Promise.race([admission, new Promise<string>(resolve => setTimeout(() => resolve('hung'), 600))]);
    assert.equal(outcome, 'rejected');
    assert.equal(approvals, 1);
    assert.deepEqual(registry.list(), []);
  } finally { await registry.shutdown(); await rm(cwd, {recursive: true, force: true}); }
});

test('queued work expires without launching after its deadline', async () => {
  const launches: string[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission, concurrency: 1, invocation: spec => {
    launches.push(spec.task);
    return {command: process.execPath, args: ['-e', `setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[]}})),300);`]};
  }});
  try {
    await registry.spawn({task: 'first', cwd: tmpdir(), timeout: 1000});
    const second = await registry.spawn({task: 'expired', cwd: tmpdir(), timeout: 50});
    assert.equal((await second.done).status, 'expired-in-queue');
    assert.deepEqual(launches, ['first']);
  } finally { await registry.shutdown(); }
});

test('cancellation gives the child time to finish graceful cleanup before escalation', async () => {
  const script = `process.on('SIGTERM',()=>setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'cleaned'}]}}));process.exit(0);},500));console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'armed'}}));setInterval(()=>{},1000);`;
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const handle = await registry.spawn({task: 'graceful cleanup', cwd: tmpdir()});
    const end = Date.now() + 2000;
    while (registry.get(handle.id)?.output !== 'armed' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(registry.get(handle.id)?.output, 'armed');
    assert.equal(registry.cancel(handle.id), true);
    assert.equal(registry.cancel(handle.id), false, 'cancellation must not signal twice');
    const result = await handle.done;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.output, 'cleaned');
  } finally { await registry.shutdown(); }
});

test('usage preserves provider-reported cached tokens, totals, reasoning and cost', async () => {
  const usage = {input: 1, output: 2, cacheRead: 100, cacheWrite: 10, cacheWrite1h: 4, reasoning: 1, totalTokens: 113, cost: {input: 0.01, output: 0.02, cacheRead: 0.1, cacheWrite: 0.2, total: 0.33}};
  const event = {type: 'message_end', message: {role: 'assistant', stopReason: 'stop', usage, content: []}};
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))});`]})});
  try {
    const result = await (await registry.spawn({task: 'report usage', cwd: tmpdir()})).done;
    assert.deepEqual(result.usage, usage);
  } finally { await registry.shutdown(); }
});

test('dropping an oversized final assistant record cannot reuse an earlier success', async () => {
  const script = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Earlier'}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',content:[{type:'text',text:'X'.repeat(400000)}]}}));`;
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'oversized terminal record', cwd: tmpdir()})).done;
    assert.equal(result.status, 'incomplete');
    assert.equal(result.usageIncomplete, true);
  } finally { await registry.shutdown(); }
});

test('exit zero is not success when the final assistant outcome is absent or incomplete', async () => {
  for (const stopReason of [undefined, 'length', 'toolUse', 'pending', 'deferred']) {
    const event = stopReason ? {type: 'message_end', message: {role: 'assistant', stopReason, content: [{type: 'text', text: 'Partial'}]}} : {type: 'session'};
    const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))});`]})});
    try {
      const result = await (await registry.spawn({task: 'incomplete outcome', cwd: tmpdir()})).done;
      assert.equal(result.status, 'incomplete', `stopReason=${stopReason}`);
    } finally { await registry.shutdown(); }
  }
});

test('an oversized image record does not kill a child that subsequently completes', async () => {
  const script = `const line=JSON.stringify({type:'tool_execution_end',toolCallId:'image',toolName:'read',isError:false,result:{content:[{type:'image',data:'A'.repeat(400000)}]}})+'\\n';let offset=0;const timer=setInterval(()=>{process.stdout.write(line.slice(offset,offset+32768));offset+=32768;if(offset>=line.length){clearInterval(timer);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Image inspected'}]}}));}},2);`;
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'inspect image', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Image inspected');
    assert.equal(result.droppedRecords, 1);
  } finally { await registry.shutdown(); }
});

test('four consecutive identical failing calls return control instead of retrying forever', async () => {
  const events = toolCall('loop', 'bash', {command: 'missing-command'}, true);
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', `for(let i=0;i<4;i++)for(const event of ${JSON.stringify(events)})console.log(JSON.stringify({...event,toolCallId:String(i)}));setInterval(()=>{},1000);`]})});
  try {
    const result = await (await registry.spawn({task: 'repetitive failure', cwd: tmpdir(), timeout: 500})).done;
    assert.equal(result.status, 'stalled');
    assert.match(result.error ?? '', /identical.*failed tool calls/);
  } finally { await registry.shutdown(); }
});

test('productive edit/test cycles and repeated successful polling are not turn-limited', async () => {
  const events: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    events.push(...toolCall(`test-${i}`, 'bash', {command: 'npm test'}, true));
    events.push(...toolCall(`edit-${i}`, 'edit', {path: 'code.ts', oldText: 'old', newText: 'new'}, false));
  }
  for (let i = 0; i < 30; i++) events.push(...toolCall(`poll-${i}`, 'bash', {command: 'git status'}, false));
  events.push({type: 'message_end', message: {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Productive work finished'}]}});
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', `for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`]})});
  try {
    const result = await (await registry.spawn({task: 'productive iterations', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Productive work finished');
  } finally { await registry.shutdown(); }
});

test('a task uses a one-hour default backstop without a turn quota', async () => {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: spec => ({command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:${JSON.stringify(String(spec.timeout))}}]}}));`]})});
  try {
    const result = await (await registry.spawn({task: 'default timeout', cwd: tmpdir()})).done;
    assert.equal(result.output, '3600000');
  } finally { await registry.shutdown(); }
});

test('shutdown settles an admission whose approval callback never resolves', async () => {
  let entered!: () => void;
  const approving = new Promise<void>(resolve => { entered = resolve; });
  let launched = false;
  const cwd = await mkdtemp(join(tmpdir(), 'admission-shutdown-'));
  const extension = join(cwd, 'child.ts');
  await writeFile(extension, 'export default () => {};');
  const admissionPort = admissionFixture({cwd: () => cwd, tools: () => ['read'], approve: () => {entered(); return new Promise(() => {});}}).admission;
  const registry = new SubagentRegistry({
    admission: admissionPort,
    invocation: () => { launched = true; return {command: process.execPath, args: ['-e', 'process.exit(0)']}; },
  });
  const admission = registry.spawn({task: 'approval', cwd, extensions: [extension]}).then(() => 'launched', () => 'rejected');
  try {
    await approving;
    await registry.shutdown();
    const result = await Promise.race([admission, new Promise<string>(resolve => setTimeout(() => resolve('hung'), 100))]);
    assert.equal(result, 'rejected');
    assert.equal(launched, false);
  } finally { await registry.shutdown(); await rm(cwd, {recursive: true, force: true}); }
});

test('aborting an owning signal after admission stops its running child', async () => {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']})});
  const controller = new AbortController();
  try {
    const handle = await registry.spawn({task: 'wait', cwd: tmpdir()}, controller.signal);
    controller.abort();
    const value = await Promise.race([handle.done, new Promise<undefined>(resolve => setTimeout(resolve, 500))]);
    assert.equal(value?.status, 'cancelled');
  } finally { await registry.shutdown(); }
});

test('a recovered provider failure does not turn completed work into a failed task', async () => {
  const events = [
    {type: 'message_end', message: {role: 'assistant', stopReason: 'error', errorMessage: 'overloaded'}},
    {type: 'auto_retry_start'},
    {type: 'message_end', message: {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Completed'}]}},
  ];
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`]})});
  try {
    const result = await (await registry.spawn({task: 'recover', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Completed');
  } finally { await registry.shutdown(); }
});

function toolCall(toolCallId: string, toolName: string, args: object, isError: boolean) {
  return [
    {type: 'tool_execution_start', toolCallId, toolName, args},
    {type: 'tool_execution_end', toolCallId, toolName, result: {content: [{type: 'text', text: 'result'}], details: {}}, isError},
  ];
}

async function eventResult(script: string) {
  const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try { return await (await registry.spawn({task: 'event regression', cwd: tmpdir(), timeout: 3000})).done; }
  finally { await registry.shutdown(); }
}
const terminal = {type: 'message_end', message: {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: 'Complete'}], usage: {input: 3, output: 2}}};

for (const mode of ['different', 'missing', 'interleaved', 'consumed', 'evicted', 'dropped-start']) {
  test(`failing read probes with ${mode} arguments cannot falsely stall`, async () => {
    const calls = Array.from({length: 4}, (_, i) => toolCall(String(i), 'read', {path: `missing-${i}`}, true));
    let events = calls.flat();
    if (mode === 'missing') events = calls.map(call => call[1]);
    if (mode === 'interleaved') events = [...calls.map(call => call[0]), ...calls.map(call => call[1]).reverse()];
    if (mode === 'consumed') events = [calls[0][0], ...Array(4).fill(calls[0][1])];
    if (mode === 'evicted') events = [...Array.from({length: 1100}, (_, i) => toolCall(String(i), 'read', {path: 'same'}, true)[0]), ...calls.map(call => call[1])];
    const prefix = mode === 'dropped-start' ? `console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'0',toolName:'read',args:{path:'x'.repeat(400000)}}));` : '';
    if (mode === 'dropped-start') events = Array(4).fill(calls[0][1]);
    const result = await eventResult(`${prefix}for(const event of ${JSON.stringify([...events, terminal])})console.log(JSON.stringify(event));`);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Complete');
  });
}

for (const kind of ['turn_end', 'entry_appended', 'message_start', 'compaction_end']) {
  test(`oversized redundant ${kind} preserves terminal outcome and complete usage`, async () => {
    const result = await eventResult(`
      const terminal=${JSON.stringify(terminal)};
      console.log(JSON.stringify(terminal));
      const message={...terminal.message,content:[{type:'text',text:'x'.repeat(400000)}]};
      const events={
        turn_end:{type:'turn_end',message,toolResults:[]},
        entry_appended:{type:'entry_appended',entry:{type:'message',id:'one',parentId:null,timestamp:new Date().toISOString(),message}},
        message_start:{type:'message_start',message},
        compaction_end:{type:'compaction_end',reason:'manual',result:{summary:'x'.repeat(400000),firstKeptEntryId:'one',tokensBefore:10},aborted:false,willRetry:false}
      };
      console.log(JSON.stringify(events[${JSON.stringify(kind)}]));
    `);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.usageIncomplete, undefined);
    assert.deepEqual(result.usage, terminal.message.usage);
    assert.equal(result.droppedRecords, 1);
  });
}

for (const content of [[], [{type: 'thinking', thinking: 'thought'}], [{type: 'text', text: ''}], [{type: 'text', text: ''}, {type: 'text', text: ''}], [{type: 'text', text: 'Final answer'}]]) {
  test(`final assistant content ${JSON.stringify(content)} preserves or replaces streamed text`, async () => {
    const result = await eventResult(`
      const message=${JSON.stringify({...terminal.message, content})};
      console.log(JSON.stringify({type:'message_update',message,assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'The answer is 42.',partial:message}}));
      console.log(JSON.stringify({type:'message_end',message}));
    `);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, content.some(c => c.type === 'text' && 'text' in c && c.text) ? 'Final answer' : 'The answer is 42.');
  });
}

for (const role of ['user', 'toolResult']) {
  test(`oversized ${role} message_end does not invalidate assistant usage`, async () => {
    const result = await eventResult(`
      console.log(JSON.stringify(${JSON.stringify(terminal)}));
      console.log(JSON.stringify({type:'message_end',message:{role:${JSON.stringify(role)},toolCallId:'read',toolName:'read',isError:false,timestamp:0,content:[{type:'text',text:'x'.repeat(400000)}]}}));
    `);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.usageIncomplete, undefined);
    assert.deepEqual(result.usage, terminal.message.usage);
  });
}

test('a dropped assistant outcome leaves usage incomplete even after a later success', async () => {
  const result = await eventResult(`
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'x'.repeat(400000)}],usage:{input:100,output:100}}}));
    console.log(JSON.stringify(${JSON.stringify(terminal)}));
  `);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.usageIncomplete, true);
  assert.deepEqual(result.usage, terminal.message.usage);
});

for (const interruption of ['success', 'unknown']) {
  test(`${interruption} tool end breaks a consecutive failed-call streak`, async () => {
    const events = [
      ...Array.from({length: 3}, (_, i) => toolCall(String(i), 'read', {path: 'missing'}, true)).flat(),
      ...(interruption === 'success' ? toolCall('break', 'read', {path: 'missing'}, false) : [toolCall('break', 'read', {path: 'missing'}, true)[1]]),
      ...toolCall('last', 'read', {path: 'missing'}, true), terminal,
    ];
    const result = await eventResult(`for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`);
    assert.equal(result.status, 'succeeded');
  });
}

test('registry delivers a parent completion after the 250 ms window', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const notices: {content: string; options: {triggerTurn: boolean; deliverAs: string}}[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission,
    invocation: () => { throw new Error('Synthetic launch failure'); },
    notify: (content, options) => { notices.push({content, options}); },
  });
  t.after(() => registry.shutdown());
  const child = await registry.spawn({task: 'completion', cwd: tmpdir()});
  await child.done;
  t.mock.timers.tick(249);
  assert.equal(notices.length, 0);
  t.mock.timers.tick(1);
  assert.equal(JSON.parse(notices[0].content).id, child.id);
  assert.deepEqual(notices[0].options, {triggerTurn: true, deliverAs: 'followUp'});
});

function lifecycleFixture(t: TestContext, concurrency = 8, observe: () => void = () => {}) {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const children = new Map<string, {complete: (output?: string) => void; close: () => void}>();
  const notices: {value: any; options: {triggerTurn: boolean; deliverAs: string}}[] = [];
  const activity: {tracker?: string; background?: {id: string; active: boolean}}[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission, concurrency,
    activity: event => { activity.push(event); observe(); },
    invocation: spec => {
      const stdout = new PassThrough(), stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {stdout, stderr, stdio: []}) as unknown as ChildProcess;
      let closed = false;
      const close = () => { if (!closed) { closed = true; child.emit('close', 0, null); } };
      children.set(spec.task, {close, complete: (output = 'done') => {
        stdout.write(JSON.stringify({type: 'message_end', message: {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: output}]}}) + '\n');
        close();
      }});
      return child;
    },
    notify: (content, options) => { notices.push({value: JSON.parse(content), options}); },
  });
  t.after(async () => {
    const stopped = registry.shutdown();
    for (const child of children.values()) child.close();
    await stopped;
  });
  const spawn = (task: string, owner: 'parent' | 'workflow' = 'parent', timeout?: number) => registry.spawn({task, cwd: tmpdir(), preset: 'reader', timeout}, undefined, owner);
  return {registry, children, notices, activity, spawn};
}

test('cancel-all records its cause and suppresses only the children it cancels', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t);
  const done = await spawn('done');
  children.get('done')!.complete();
  await done.done;
  const held = await spawn('held');
  const stopped = registry.cancelAll();
  children.get('held')!.close();
  assert.deepEqual(await stopped, {cancelled: true, count: 1});
  assert.equal((await held.done).cancellationCause, 'cancel-all');
  t.mock.timers.tick(250);
  assert.deepEqual(notices.map(notice => [notice.value.id, notice.value.status, notice.options.triggerTurn]), [[done.id, 'succeeded', true]]);
});

test('cancel-all counts mixed children once and awaits workflow cleanup', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t);
  const direct = await spawn('direct');
  const stage = await spawn('stage', 'workflow');
  let workflowAborted = false, finishWorkflow!: () => void;
  const workflow = registry.track(signal => new Promise<void>(resolve => {
    finishWorkflow = resolve;
    signal.addEventListener('abort', () => { workflowAborted = true; }, {once: true});
  }));
  let settled = false;
  const stopping = registry.cancelAll().then(value => { settled = true; return value; });
  assert.equal(workflowAborted, true);
  children.get('direct')!.close(); children.get('stage')!.close();
  await Promise.all([direct.done, stage.done]);
  assert.equal(settled, false);
  finishWorkflow(); await workflow;
  assert.deepEqual(await stopping, {cancelled: true, count: 2});
  t.mock.timers.tick(250);
  assert.deepEqual(notices, []);
  assert.deepEqual(await registry.cancelAll(), {cancelled: false, count: 0});
});


test('cancel-all delivers an individual cancellation of a child admitted during its wait', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t, 1);
  await spawn('held');
  let settled = false;
  const stopping = registry.cancelAll().then(value => { settled = true; return value; });
  const late = await spawn('late');
  assert.equal(registry.get(late.id)?.status, 'queued');
  assert.equal(registry.cancel(late.id), true);
  assert.equal((await late.done).cancellationCause, 'user');
  t.mock.timers.tick(250);
  assert.equal(settled, false);
  assert.deepEqual(notices.map(notice => [notice.value.id, notice.value.status, notice.options.triggerTurn]), [[late.id, 'cancelled', false]]);
  children.get('held')!.close();
  assert.deepEqual(await stopping, {cancelled: true, count: 1});
  const next = await spawn('next'); children.get('next')!.complete(); await next.done;
  t.mock.timers.tick(250);
  assert.equal(notices[1].value.id, next.id);
});

test('shutdown discards a batch preserved by cancel-all and awaits mixed run cleanup', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t);
  const done = await spawn('done'); children.get('done')!.complete(); await done.done;
  await registry.cancelAll();
  const held = await spawn('held');
  let finish!: () => void, aborted = false;
  const run = registry.track(signal => new Promise<void>(resolve => {
    finish = resolve; signal.addEventListener('abort', () => { aborted = true; }, {once: true});
  }));
  let settled = false;
  const stopping = registry.shutdown().then(() => { settled = true; });
  assert.equal(aborted, true);
  children.get('held')!.close();
  assert.equal((await held.done).cancellationCause, 'shutdown');
  assert.equal(settled, false);
  finish(); await run; await stopping;
  t.mock.timers.tick(1000);
  assert.deepEqual(notices, []);
  assert.equal(registry.isShutdown, true);
  await assert.rejects(spawn('late'), /shut down/);
});

test('workflows submitted during or after shutdown never run', async t => {
  const {registry, children, spawn} = lifecycleFixture(t);
  const held = await spawn('held');
  const stopping = registry.shutdown();
  let ran = false;
  await assert.rejects(registry.track(async () => { ran = true; }), /shut down/);
  children.get('held')!.close(); await held.done; await stopping;
  await assert.rejects(registry.track(async () => { ran = true; }), /shut down/);
  assert.equal(ran, false);
});

test('a throwing activity observer cannot block cancel-all or shutdown cleanup', async t => {
  const {registry, children, spawn} = lifecycleFixture(t, 8, () => { throw new Error('observer failed'); });
  const first = await spawn('first');
  const cancelling = registry.cancelAll();
  children.get('first')!.close();
  assert.deepEqual(await cancelling, {cancelled: true, count: 1});
  assert.equal((await first.done).cancellationCause, 'cancel-all');
  const second = await spawn('second');
  let aborted = false;
  const run = registry.track(signal => new Promise<void>(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve(); }, {once: true}); }));
  const stopping = registry.shutdown();
  children.get('second')!.close();
  await stopping; await run;
  assert.equal(aborted, true);
  assert.equal((await second.done).cancellationCause, 'shutdown');
});

test('ordinary cancellation overflow survives cancel-all without waking the parent', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t, 1);
  await spawn('held');
  for (let i = 0; i < 40; i++) {
    const child = await spawn(`queued ${i}`); registry.cancel(child.id); await child.done;
  }
  const stopping = registry.cancelAll(); children.get('held')!.close(); await stopping;
  t.mock.timers.tick(250);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].value.tasks.length, 16);
  assert.equal(notices[0].value.additionalCompletions, 24);
  assert.deepEqual(notices[0].options, {triggerTurn: false, deliverAs: 'nextTurn'});
});

test('a non-cancelled completion beyond the notice limit still triggers a turn', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t, 1);
  const held = await spawn('held');
  for (let i = 0; i < 19; i++) {
    const child = await spawn(`queued ${i}`); registry.cancel(child.id); await child.done;
  }
  children.get('held')!.complete(); await held.done;
  t.mock.timers.tick(250);
  assert.equal(notices[0].value.tasks.length + notices[0].value.additionalCompletions, 20);
  assert.deepEqual(notices[0].options, {triggerTurn: true, deliverAs: 'followUp'});
});

test('batched completions re-clip output and bound the compact array to 12000 bytes', async t => {
  const {children, notices, spawn} = lifecycleFixture(t);
  for (let i = 0; i < 20; i++) {
    const name = String(i) + '界'.repeat(200);
    const child = await spawn(name); children.get(name)!.complete('界'.repeat(5000)); await child.done;
  }
  t.mock.timers.tick(250);
  const batch = notices[0].value;
  assert.ok(batch.tasks.length > 0 && batch.tasks.length < 16);
  assert.equal(batch.tasks.length + batch.additionalCompletions, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(batch.tasks), 'utf8') <= 12000);
  assert.ok(batch.tasks.every((task: any) => task.outputTruncated && task.output.length < task.outputLength));
  assert.deepEqual(notices[0].options, {triggerTurn: true, deliverAs: 'followUp'});
});

test('the batching window starts with the first notice rather than restarting on later notices', async t => {
  const {children, notices, spawn} = lifecycleFixture(t);
  const first = await spawn('first'); children.get('first')!.complete(); await first.done;
  t.mock.timers.tick(200);
  const second = await spawn('second'); children.get('second')!.complete(); await second.done;
  t.mock.timers.tick(49); assert.equal(notices.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(notices[0].value.tasks.map((task: any) => task.id), [first.id, second.id]);
});

test('notification sink failures are recorded on retained completed tasks', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const registry = new SubagentRegistry({admission: supervisorAdmission,
    invocation: () => { throw new Error('Synthetic launch failure'); },
    notify: () => { throw new Error('UI gone'); },
  });
  t.after(() => registry.shutdown());
  const child = await registry.spawn({task: 'failed notice', cwd: tmpdir()}); await child.done;
  t.mock.timers.tick(250);
  assert.equal(registry.get(child.id)?.notificationError, 'Completion notification failed: Error: UI gone');
});

test('running and queued timeouts record their cause and trigger a turn', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t, 1);
  const held = await spawn('held', 'parent', 100);
  const queued = await spawn('queued', 'parent', 10);
  t.mock.timers.tick(10);
  assert.equal((await queued.done).status, 'expired-in-queue');
  assert.equal(registry.get(queued.id)?.cancellationCause, 'timeout');
  t.mock.timers.tick(90); children.get('held')!.close();
  assert.equal((await held.done).status, 'timed-out');
  assert.equal(registry.get(held.id)?.cancellationCause, 'timeout');
  t.mock.timers.tick(250);
  assert.equal(notices[0].value.tasks.length, 2);
  assert.deepEqual(notices[0].options, {triggerTurn: true, deliverAs: 'followUp'});
});


test('a synchronous invocation failure closes its background activity interval', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const activity: {id: string; active: boolean}[] = [];
  const registry = new SubagentRegistry({admission: supervisorAdmission,
    invocation: () => { throw new Error('Synthetic launch failure'); },
    activity: event => { if (event.background) activity.push(event.background); },
  });
  t.after(() => registry.shutdown());
  const child = await registry.spawn({task: 'failed start', cwd: tmpdir()});
  await child.done;
  assert.deepEqual(activity, [{id: child.id, active: true}, {id: child.id, active: false}]);
});

test('cancel-all gates tracker activity during cleanup and resumes it afterward', async t => {
  const {registry, children, activity, spawn} = lifecycleFixture(t, 1);
  await spawn('held');
  activity.length = 0;
  const stopping = registry.cancelAll();
  const late = await spawn('late');
  assert.deepEqual(activity.filter(event => event.tracker).map(event => event.tracker), ['stop']);
  assert.deepEqual(activity.filter(event => event.background).map(event => event.background), [{id: late.id, active: true}]);
  children.get('held')!.close(); await stopping;
  assert.equal(activity.at(-1)?.tracker, 'update');
  assert.equal(registry.cancel(late.id), true);
  assert.equal(activity.at(-1)?.tracker, 'invalidate');
  children.get('late')!.close(); await late.done;
  assert.equal(activity.filter(event => event.tracker).at(-1)?.tracker, 'invalidate');
});

test('workflow-only cancellation reports work and propagates the owning signal without changing its abort reason', async t => {
  const {registry} = lifecycleFixture(t);
  const parent = new AbortController();
  let runSignal!: AbortSignal, finish!: () => void;
  const run = registry.track(signal => { runSignal = signal; return new Promise<void>(resolve => { finish = resolve; }); }, parent.signal);
  parent.abort();
  assert.equal(runSignal.aborted, true);
  assert.equal((runSignal.reason as Error).name, 'AbortError');
  const stopping = registry.cancelAll();
  finish(); await run;
  assert.deepEqual(await stopping, {cancelled: false, count: 0});
  const active = registry.track(signal => new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), {once: true}); }));
  assert.deepEqual(await registry.cancelAll(), {cancelled: true, count: 0});
  await active;
});

test('batch re-clipping marks output that fit the original single-notice view', async t => {
  const {children, notices, spawn} = lifecycleFixture(t);
  for (const name of ['first', 'second']) {
    const child = await spawn(name); children.get(name)!.complete('x'.repeat(1700)); await child.done;
  }
  t.mock.timers.tick(250);
  assert.equal(notices[0].value.tasks.length, 2);
  for (const task of notices[0].value.tasks) {
    assert.equal(task.outputLength, 1700);
    assert.equal(task.output.length, 1022);
    assert.equal(task.outputTruncated, true);
  }
});


test('a throwing tracker adapter does not prevent closing background activity', async () => {
  const script = `
    import {SubagentRegistry} from ${JSON.stringify(new URL('./registry.ts', import.meta.url).href)};
    import {supervisorAdmission} from ${JSON.stringify(new URL('./test-support.ts', import.meta.url).href)};
    import {tmpdir} from 'node:os';
    import {EventEmitter} from 'node:events';
    import {PassThrough} from 'node:stream';
    process.on('unhandledRejection', () => {});
    const activity = [];
    let fail = false;
    const child = Object.assign(new EventEmitter(), {stdout: new PassThrough(), stderr: new PassThrough(), stdio: []});
    const registry = new SubagentRegistry({admission: supervisorAdmission, invocation: () => child,
      activity: event => {
        if (fail && event.tracker === 'update') throw new Error('UI gone');
        if (event.background) activity.push(event.background.active);
      },
    });
    const handle = await registry.spawn({task: 'adapter failure', cwd: tmpdir()});
    fail = true; child.emit('close', 0, null); await handle.done;
    await new Promise(resolve => setImmediate(resolve));
    console.log(JSON.stringify(activity));
    await registry.shutdown();
  `;
  const {stdout} = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script]);
  assert.deepEqual(JSON.parse(stdout), [true, false]);
});


test('shutdown during cancel-all prevents its final tracker update', async t => {
  const {registry, children, activity, notices, spawn} = lifecycleFixture(t);
  await spawn('held');
  const cancelled = registry.cancelAll();
  const stopped = registry.shutdown();
  activity.length = 0;
  children.get('held')!.close(); await cancelled; await stopped;
  t.mock.timers.tick(250);
  assert.deepEqual(activity.filter(event => event.tracker), []);
  assert.deepEqual(notices, []);
  assert.deepEqual(await registry.cancelAll(), {cancelled: false, count: 0});
  assert.deepEqual(activity.filter(event => event.tracker).map(event => event.tracker), ['stop']);
});

test('a workflow tracked during cancel-all remains usable and belongs to the next cancellation', async t => {
  const {registry, children, spawn} = lifecycleFixture(t);
  await spawn('held');
  const first = registry.cancelAll();
  let aborted = false;
  const late = registry.track(signal => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve(); }, {once: true});
  }));
  children.get('held')!.close(); await first;
  assert.equal(aborted, false);
  assert.deepEqual(await registry.cancelAll(), {cancelled: true, count: 0});
  await late;
  assert.equal(aborted, true);
});

test('an already-aborted signal does not register or start a workflow', async t => {
  const {registry} = lifecycleFixture(t);
  const controller = new AbortController(); controller.abort();
  let entered = false;
  await assert.rejects(registry.track(async () => { entered = true; }, controller.signal), {name: 'AbortError'});
  assert.equal(entered, false);
  assert.deepEqual(await registry.cancelAll(), {cancelled: false, count: 0});
});

test('cancel-all suppresses a burst larger than the retained notice limit', async t => {
  const {registry, children, notices, spawn} = lifecycleFixture(t);
  for (let i = 0; i < 20; i++) await spawn(`child ${i}`);
  const stopping = registry.cancelAll();
  for (const child of children.values()) child.close();
  assert.deepEqual(await stopping, {cancelled: true, count: 20});
  t.mock.timers.tick(250);
  assert.deepEqual(notices, []);
});

test('workflow-runner aborts retain their source without claiming a user cancellation', async t => {
  const {registry, children, notices} = lifecycleFixture(t);
  const controller = new AbortController();
  const child = await registry.spawn({task: 'workflow abort', cwd: tmpdir()}, controller.signal, 'workflow');
  controller.abort(); children.get('workflow abort')!.close();
  assert.equal((await child.done).cancellationCause, 'workflow');
  t.mock.timers.tick(250);
  assert.deepEqual(notices, []);
});
