import assert from 'node:assert/strict';
import test from 'node:test';
import { until, withHost, type Host } from './test-support.ts';

const pi = `const task=process.argv.at(-1);if(task==='fail'){process.exit(2);}else{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'fixture result'}]}}));}`;

function fixture(run: (host: Host & {closed: () => Promise<void>}) => Promise<void>) {
  return withHost({prefix: 'pi-background-preflight-', pi}, async host => {
    const closed = async () => {
      await until(() => host.activity.some(entry => !entry.active), 'the active interval to close');
      assert.equal(host.activity.length, 2);
      assert.deepEqual(host.activity.map(entry => entry.active), [true, false]);
      assert.equal(host.activity[1].id, host.activity[0].id);
      assert.match(host.activity[0].id, /^[0-9a-f-]{36}$/);
    };
    await run({...host, closed});
  });
}

const status = (host: Host, id: string) => host.execute('subagent_status', {id}).then(value => value.details.status);

test('subagent completion emits one active interval', async () => fixture(async host => {
  const value = await host.execute('subagent', {task: 'complete', preset: 'reader'});
  await host.closed();
  assert.equal(host.activity[0].id, value.details.id);
  assert.equal(await status(host, value.details.id), 'succeeded');
}));

test('workflow spawn emits and closes an active interval', async () => fixture(async host => {
  const value = await host.execute('workflow', {source: `return await api.spawn({task:'complete',cwd:${JSON.stringify(host.cwd)},preset:'reader'},'child');`});
  await host.closed();
  assert.equal(value.details.status, 'succeeded');
}));

test('failed workflow child closes its active interval', async () => fixture(async host => {
  await assert.rejects(host.execute('workflow', {source: `return await api.spawn({task:'fail',cwd:${JSON.stringify(host.cwd)},preset:'reader'},'child');`}), /failed/);
  await host.closed();
  assert.deepEqual((await host.execute('subagent_status')).details.map((task: any) => task.status), ['failed']);
}));
