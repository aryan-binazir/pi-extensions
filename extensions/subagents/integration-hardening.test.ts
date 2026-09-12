import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import subagents from './index.ts';

async function fixture(run: (host: any) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'subagent-integration-'));
  const oldPath = process.env.PATH, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tools = new Map<string, any>(), hooks = new Map<string, any>(), notifications: any[] = [];
  const ctx = {cwd, hasUI: true, model: {provider: 'test', id: 'selected'}, thinkingLevel: 'low', sessionManager: {getSessionId: () => cwd}, ui: {setWidget() {}, editor: async (_title: string, source: string) => source, confirm: async () => true}};
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nif(process.argv.at(-1)==='large')console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'界'.repeat(50000)}]}}));else if(process.argv.at(-1)==='batch'){console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'ready'}}));const timer=setInterval(()=>{if(require('node:fs').existsSync('release')){clearInterval(timer);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));}},5);}else if(process.argv.at(-1)==='hold')setInterval(()=>{},1000);else if(process.argv.at(-1)==='loop'){for(let i=0;i<4;i++)console.log(JSON.stringify({type:'tool_execution_end',toolName:'bash',args:{command:'missing'},isError:true}));setInterval(()=>{},1000);}else console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(process.argv.slice(2))}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${oldPath ?? ''}`; process.env.PI_CODING_AGENT_DIR = join(cwd, 'agent');
    subagents({events: {emit() {}}, getActiveTools: () => ['read','write','edit','bash'], registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, hook: any) => hooks.set(name, hook), sendMessage: (message: any, options: any) => notifications.push({task: JSON.parse(message.content), options})} as any);
    await hooks.get('session_start')({}, ctx);
    const execute = (name: string, args: any = {}, signal?: AbortSignal) => tools.get(name).execute(name, args, signal, undefined, ctx);
    const settle = async (id: string) => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const task = (await execute('subagent_status')).details.find((task: any) => task.id === id);
        if (task && !['queued','running'].includes(task.status)) return task;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Child did not settle');
    };
    await run({execute, settle, notifications, ctx, hooks, cwd});
  } finally {
    await hooks.get('session_shutdown')?.();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
}

test('cancel all stops current children and leaves the orchestrator usable', async () => fixture(async ({execute, settle}: any) => {
  await Promise.all([execute('subagent', {task: 'hold', preset: 'reader'}), execute('subagent', {task: 'hold', preset: 'reader'})]);
  const cancelled = await execute('subagent_cancel', {id: 'all'});
  assert.equal(cancelled.details.count, 2);
  assert.ok((await execute('subagent_status')).details.every((task: any) => task.status === 'cancelled'));
  const next = await execute('subagent', {task: 'next', preset: 'reader'});
  assert.equal((await settle(next.details.id)).status, 'succeeded');
}));

test('shutdown settles an open workflow editor and ignores its late submission', async () => fixture(async ({execute, ctx, hooks}: any) => {
  let release!: (value: string) => void, entered!: () => void;
  let confirmations = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  ctx.ui.editor = () => { entered(); return new Promise<string>(resolve => { release = resolve; }); };
  ctx.ui.confirm = async () => { confirmations++; return true; };
  const run = execute('workflow', {source: 'return 1;'}).then(() => 'succeeded', () => 'aborted');
  await ready;
  await hooks.get('session_shutdown')();
  release('return 1;');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await run, 'aborted');
  assert.equal(confirmations, 0);
}));

test('workflow inheritance is recorded and changing the parent model invalidates replay', async () => fixture(async ({execute, ctx}: any) => {
  const source = "return await api.spawn({task:'inherited workflow',preset:'reader'},'one');";
  const first = await execute('workflow', {source});
  const args = JSON.parse(first.details.output);
  assert.equal(args[args.indexOf('--model') + 1], 'test/selected');
  assert.equal(args[args.indexOf('--thinking') + 1], 'low');
  ctx.model = {provider: 'test', id: 'different'};
  await execute('workflow', {source});
  assert.equal((await execute('subagent_status')).details.length, 2);
}));

test('a missing parent model cannot silently select a different paid model', async () => fixture(async ({execute, ctx}: any) => {
  ctx.model = undefined;
  await assert.rejects(execute('subagent', {task: 'inherit', preset: 'reader'}), /model.*required/i);
}));

test('direct children inherit the selected parent model and thinking level', async () => fixture(async ({execute, settle}: any) => {
  const launched = await execute('subagent', {task: 'inherit', preset: 'reader'});
  await settle(launched.details.id);
  const detail = (await execute('subagent_status', {id: launched.details.id})).details;
  const args = JSON.parse(detail.output);
  assert.equal(args[args.indexOf('--model') + 1], 'test/selected');
  assert.equal(args[args.indexOf('--thinking') + 1], 'low');
}));

test('near-simultaneous child completions produce one compact parent continuation', async () => fixture(async ({execute, notifications, cwd}: any) => {
  await Promise.all([execute('subagent', {task: 'batch', preset: 'reader'}), execute('subagent', {task: 'batch', preset: 'reader'})]);
  const readyBy = Date.now() + 3000;
  while ((await execute('subagent_status')).details.some((task: any) => task.output !== 'ready') && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok((await execute('subagent_status')).details.every((task: any) => task.output === 'ready'));
  await writeFile(join(cwd, 'release'), 'go');
  const end = Date.now() + 3000;
  while (notifications.length < 1 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].task.tasks.length, 2);
}));

test('status and completion delivery stay bounded when several children return large results', async () => fixture(async ({execute, settle, notifications}: any) => {
  const children = await Promise.all(Array.from({length: 4}, () => execute('subagent', {task: 'large', preset: 'reader'})));
  await Promise.all(children.map(task => settle(task.details.id)));
  const status = await execute('subagent_status');
  assert.ok(Buffer.byteLength(status.content[0].text, 'utf8') <= 32768);
  const end = Date.now() + 3000;
  while (!notifications.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(notifications.length > 0);
  for (const notice of notifications) assert.ok(Buffer.byteLength(JSON.stringify(notice.task), 'utf8') <= 16384);
}));

test('a stalled workflow child is not relaunched by automatic retry', async () => fixture(async ({execute}: any) => {
  await assert.rejects(execute('workflow', {source: "return await api.retry(5,()=>api.spawn({task:'loop',preset:'reader'},'loop'));"}), /stalled/);
  assert.equal((await execute('subagent_status')).details.length, 1);
}));

test('workflow children report to the awaiting workflow without duplicate parent notifications', async () => fixture(async ({execute, notifications}: any) => {
  const result = await execute('workflow', {source: "await api.spawn({task:'one',preset:'reader'},'one');await api.spawn({task:'two',preset:'reader'},'two');return 'done';"});
  assert.equal(result.details, 'done');
  assert.deepEqual(notifications, []);
}));

test('cancelling a child does not wake the parent model for another paid turn', async () => fixture(async ({execute, notifications}: any) => {
  const task = await execute('subagent', {task: 'hold', preset: 'reader'});
  await execute('subagent_cancel', {id: task.details.id});
  const end = Date.now() + 3000;
  while (!notifications.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.triggerTurn, false);
}));

test('registered delegation remains attached to its owning abort signal after returning', async () => fixture(async ({execute, settle}: any) => {
  const controller = new AbortController();
  const task = await execute('subagent', {task: 'hold', preset: 'reader'}, controller.signal);
  controller.abort();
  assert.equal((await settle(task.details.id)).status, 'cancelled');
}));
