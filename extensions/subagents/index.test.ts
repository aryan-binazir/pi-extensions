import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { until, withHost } from './test-support.ts';

const echoArgs = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})}],usage:{input:3,output:4}}}));`;

function assertChildTools(child: {args: string[]}, tools: string[]) {
  assert.ok(child.args.includes('--tools'));
  assert.equal(child.args[child.args.indexOf('--tools') + 1], tools.join(','));
  assert.ok(child.args.includes('--no-extensions'));
  assert.ok(!child.args.includes('-e'), 'no mandatory child extension');
}

test('workflow registration requires exact source approval and protects sensitive reads', async () =>
  withHost({prefix: 'workflow-extension-', ctx: {hasUI: false, model: undefined}, start: false}, async ({cwd, ctx, execute}) => {
    await assert.rejects(execute('workflow', {source: 'return 1;'}), /approval/);
    ctx.hasUI = true;
    await writeFile(join(cwd, '.env'), 'SYNTHETIC_SECRET');
    ctx.ui.editor = async () => 'return 2;';
    await assert.rejects(execute('workflow', {source: 'return 1;'}), /approv/i);
    ctx.ui.editor = async (_title: string, source: string) => source;
    await assert.rejects(execute('workflow', {source: 'return await api.readFile(".env");'}), /sensitive/);
  }));

test('registered background tool launches tool-limited Pi and pushes completion to its parent', async () =>
  withHost({prefix: 'subagent-extension-', pi: echoArgs, ctx: {hasUI: false}}, async ({cwd, execute, notifications, tools}) => {
    const response = await execute('subagent', {task: 'Read synthetic checkout', preset: 'reader'});
    const guidance = tools.get('subagent').promptGuidelines;
    assert.equal(JSON.parse(response.content[0].text).notification, guidance[0]);
    const completion = await until(() => notifications[0], 'the completion notification', 5000);
    assert.deepEqual(completion.options, {triggerTurn: true, deliverAs: 'followUp'});
    assert.equal(completion.type, 'subagent-complete');
    assert.equal(completion.task.status, 'succeeded');
    assert.equal(completion.task.id, response.details.id);
    assert.deepEqual(completion.task.usage, {input: 3, output: 4});
    const child = JSON.parse(completion.task.output);
    assert.equal(child.cwd, await realpath(cwd));
    assertChildTools(child, ['read', 'grep', 'find', 'ls']);
    assert.ok(child.args.includes('--no-session'));
    assert.equal(child.args.at(-1), 'Read synthetic checkout');
  }));

test('RPC UI approves extensions once per real spawn and reauthorizes cached workflow stages', async () =>
  withHost({
    prefix: 'workflow-rpc-',
    pi: `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'done'}]}}));`,
  }, async ({cwd, ctx, execute, notifications}) => {
    const approvals: string[] = [];
    let allowExtensions = true;
    ctx.ui.confirm = async (title: string) => { approvals.push(title); return title.includes('child extensions') ? allowExtensions : true; };
    await writeFile(join(cwd, 'trusted.ts'), 'export default () => {};');
    const source = `return await api.spawn({task:'read',preset:'reader',extensions:[${JSON.stringify(join(cwd, 'trusted.ts'))}]},'read');`;
    const workflow = () => execute('workflow', {source});
    await workflow();
    assert.equal(notifications.length, 0, 'workflow owns its child result');
    assert.equal((await execute('subagent_status')).details.length, 1);
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 1);
    allowExtensions = false;
    await assert.rejects(workflow(), /Child extension loading was not approved/);
    assert.equal((await execute('subagent_status')).details.length, 1, 'rejected replay must not launch a child');
    allowExtensions = true;
    await workflow();
    assert.equal((await execute('subagent_status')).details.length, 1, 'approved replay must reuse the cached child');
    assert.equal(notifications.length, 0);
    assert.equal(approvals.filter(title => title.includes('child extensions')).length, 3);
  }));

test('children keep running until a committed shutdown reaps them', async () =>
  withHost({
    prefix: 'subagent-switch-',
    pi: `console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:String(process.pid)}}));setInterval(()=>{},1000);`,
    ctx: {hasUI: false},
  }, async ({execute, shutdown}) => {
    const launch = () => execute('subagent', {task: 'wait', preset: 'reader'});
    await launch();
    await launch();
    const status = async () => (await execute('subagent_status')).details;
    const running = await until(async () => {
      const tasks = await status();
      return tasks.every((task: {output: string}) => task.output) ? tasks : undefined;
    }, 'both children to report their pid', 5000);
    assert.equal(running.length, 2);
    assert.ok(running.every((task: {status: string; output: string}) => task.status === 'running' && Number(task.output) > 0));
    const pids = running.map((task: {output: string}) => Number(task.output));
    await shutdown({reason: 'resume'});
    assert.ok((await status()).every((task: {status: string}) => task.status === 'cancelled'));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  }));

test('standalone registered subagents and workflows inherit active builtins and workspace without auto mode', async () => {
  let active = ['read', 'subagent', 'workflow'];
  await withHost({
    prefix: 'standalone-subagents-', pi: echoArgs, tools: () => active,
    before: host => writeFile(join(host.cwd, 'input'), 'safe'),
  }, async ({cwd, execute}) => {
    const direct = (params: Record<string, unknown>) => execute('subagent', params);
    const workflow = (source: string) => execute('workflow', {source});
    const directChild = async (preset?: string) => {
      const response = await direct({task: 'valid direct child', preset});
      const task = await until(async () => {
        const value = (await execute('subagent_status', {id: response.details.id})).details;
        assert.ok(['queued', 'running', 'succeeded'].includes(value.status), JSON.stringify(value));
        return value.status === 'succeeded' ? value : undefined;
      }, 'the direct child to succeed', 5000);
      return JSON.parse(task.output);
    };
    for (const tool of ['write', 'bash']) {
      await assert.rejects(direct({task: 'escalate', tools: [tool]}), /exceed parent permissions/);
      await assert.rejects(workflow(`return await api.spawn({task:'escalate',tools:['${tool}']},'${tool}');`), /exceed parent permissions/);
    }
    await assert.rejects(direct({task: 'escape', cwd: tmpdir()}), /outside parent workspace/);
    await assert.rejects(workflow(`return await api.spawn({task:'escape',cwd:${JSON.stringify(tmpdir())}},'escape');`), /escapes workflow cwd/);
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'valid', preset})},'valid');`);
      const child = JSON.parse(response.details.output);
      assertChildTools(child, ['read']);
      assertChildTools(await directChild(preset), ['read']);
      assert.equal(child.cwd, await realpath(cwd));
    }
    active = ['subagent', 'workflow'];
    for (const preset of [undefined, 'reader', 'writer']) {
      const response = await workflow(`return await api.spawn(${JSON.stringify({task: 'reason only', preset})},'reason');`);
      assertChildTools(JSON.parse(response.details.output), []);
      assertChildTools(await directChild(preset), []);
    }
    await assert.rejects(workflow('return await api.readFile("input");'), /outside parent permissions/);
  });
});
