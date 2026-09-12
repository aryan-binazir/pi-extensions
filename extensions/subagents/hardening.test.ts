import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SubagentRegistry } from './registry.ts';

test('a long-running task remains retained when it finishes after many shorter tasks', async () => {
  const registry = new SubagentRegistry({invocation: spec => {
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
    const registry = new SubagentRegistry({authorize: async () => {
      let chain = Promise.resolve();
      for (let i = 0; i < depth; i++) chain = chain.then(() => undefined);
      cancellation = chain.then(async () => { cancelled = true; await registry.cancelAll(); });
    }, invocation: () => { if (cancelled) lateLaunches++; throw new Error('Synthetic launch boundary'); }});
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
  const registry = new SubagentRegistry({concurrency: 1, allowedTools: () => allowed, invocation: spec => {
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
  const registry = new SubagentRegistry({onUpdate: () => { updates++; }, invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'burst', cwd: tmpdir()})).done;
    assert.equal(result.output, 'done');
    assert.ok(updates > 0 && updates <= 10, `received ${updates} updates`);
  } finally { await registry.shutdown(); }
});

test('completed-result retention is bounded without imposing a lifetime launch quota', async () => {
  const registry = new SubagentRegistry({invocation: () => { throw new Error('Synthetic launch failure'); }});
  try {
    for (let i = 0; i < 1005; i++) await (await registry.spawn({task: `attempt ${i}`, cwd: tmpdir()})).done;
    assert.equal(registry.list().length, 50);
    assert.equal(registry.list().at(-1)?.task, 'attempt 1004');
  } finally { await registry.shutdown(); }
});

test('the task deadline covers unanswered admission approval before any process exists', async () => {
  const registry = new SubagentRegistry({authorize: () => new Promise<void>(() => {})});
  try {
    const admission = registry.spawn({task: 'approval', cwd: tmpdir(), timeout: 50}).then(() => 'started', () => 'rejected');
    const outcome = await Promise.race([admission, new Promise<string>(resolve => setTimeout(() => resolve('hung'), 200))]);
    assert.equal(outcome, 'rejected');
    assert.deepEqual(registry.list(), []);
  } finally { await registry.shutdown(); }
});

test('queued work expires without launching after its deadline', async () => {
  const launches: string[] = [];
  const registry = new SubagentRegistry({concurrency: 1, invocation: spec => {
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
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', script]})});
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
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))});`]})});
  try {
    const result = await (await registry.spawn({task: 'report usage', cwd: tmpdir()})).done;
    assert.deepEqual(result.usage, usage);
  } finally { await registry.shutdown(); }
});

test('dropping an oversized final assistant record cannot reuse an earlier success', async () => {
  const script = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Earlier'}]}}));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',content:[{type:'text',text:'X'.repeat(400000)}]}}));`;
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'oversized terminal record', cwd: tmpdir()})).done;
    assert.equal(result.status, 'incomplete');
    assert.equal(result.usageIncomplete, true);
  } finally { await registry.shutdown(); }
});

test('exit zero is not success when the final assistant outcome is absent or incomplete', async () => {
  for (const stopReason of [undefined, 'length', 'toolUse', 'pending', 'deferred']) {
    const event = stopReason ? {type: 'message_end', message: {role: 'assistant', stopReason, content: [{type: 'text', text: 'Partial'}]}} : {type: 'session'};
    const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(event))});`]})});
    try {
      const result = await (await registry.spawn({task: 'incomplete outcome', cwd: tmpdir()})).done;
      assert.equal(result.status, 'incomplete', `stopReason=${stopReason}`);
    } finally { await registry.shutdown(); }
  }
});

test('an oversized image record does not kill a child that subsequently completes', async () => {
  const script = `const line=JSON.stringify({type:'tool_execution_end',toolCallId:'image',toolName:'read',isError:false,result:{content:[{type:'image',data:'A'.repeat(400000)}]}})+'\\n';let offset=0;const timer=setInterval(()=>{process.stdout.write(line.slice(offset,offset+32768));offset+=32768;if(offset>=line.length){clearInterval(timer);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Image inspected'}]}}));}},2);`;
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', script]})});
  try {
    const result = await (await registry.spawn({task: 'inspect image', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Image inspected');
    assert.equal(result.droppedRecords, 1);
  } finally { await registry.shutdown(); }
});

test('four consecutive identical failing calls return control instead of retrying forever', async () => {
  const events = toolCall('loop', 'bash', {command: 'missing-command'}, true);
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', `for(let i=0;i<4;i++)for(const event of ${JSON.stringify(events)})console.log(JSON.stringify({...event,toolCallId:String(i)}));setInterval(()=>{},1000);`]})});
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
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', `for(const event of ${JSON.stringify(events)})console.log(JSON.stringify(event));`]})});
  try {
    const result = await (await registry.spawn({task: 'productive iterations', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.output, 'Productive work finished');
  } finally { await registry.shutdown(); }
});

test('a task uses a one-hour default backstop without a turn quota', async () => {
  const registry = new SubagentRegistry({invocation: spec => ({command: process.execPath, args: ['-e', `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:${JSON.stringify(String(spec.timeout))}}]}}));`]})});
  try {
    const result = await (await registry.spawn({task: 'default timeout', cwd: tmpdir()})).done;
    assert.equal(result.output, '3600000');
  } finally { await registry.shutdown(); }
});

test('shutdown settles an admission whose approval callback never resolves', async () => {
  let entered!: () => void;
  const approving = new Promise<void>(resolve => { entered = resolve; });
  let launched = false;
  const registry = new SubagentRegistry({
    authorize: () => { entered(); return new Promise<void>(() => {}); },
    invocation: () => { launched = true; return {command: process.execPath, args: ['-e', 'process.exit(0)']}; },
  });
  const admission = registry.spawn({task: 'approval', cwd: tmpdir()}).then(() => 'launched', () => 'rejected');
  await approving;
  await registry.shutdown();
  const result = await Promise.race([admission, new Promise<string>(resolve => setTimeout(() => resolve('hung'), 100))]);
  assert.equal(result, 'rejected');
  assert.equal(launched, false);
});

test('aborting an owning signal after admission stops its running child', async () => {
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)']})});
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
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`]})});
  try {
    const result = await (await registry.spawn({task: 'recover', cwd: tmpdir()})).done;
    assert.equal(result.status, 'succeeded');
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'Completed');
  } finally { await registry.shutdown(); }
});

// Pi AgentEvent puts arguments on start only; end carries the result and call ID.
function toolCall(toolCallId: string, toolName: string, args: object, isError: boolean) {
  return [
    {type: 'tool_execution_start', toolCallId, toolName, args},
    {type: 'tool_execution_end', toolCallId, toolName, result: {content: [{type: 'text', text: 'result'}], details: {}}, isError},
  ];
}

async function eventResult(script: string) {
  const registry = new SubagentRegistry({invocation: () => ({command: process.execPath, args: ['-e', script]})});
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
