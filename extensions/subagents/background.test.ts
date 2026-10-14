import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from './test-support.ts';
import type { TaskResult } from './registry.ts';
import subagents from './index.ts';
import { withPi, type PiFixture } from '../../tests/pi-session.ts';

const pi = `const task=process.argv.at(-1);if(task==='fail'){process.exit(2);}else{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'fixture result'}]}}));}`;

interface Execute {
  (name: 'subagent', args: Record<string, unknown>): Promise<{ details: { id: string } }>;
  (name: 'workflow', args: Record<string, unknown>): Promise<{ details: TaskResult }>;
  (name: 'subagent_status', args: { id: string }): Promise<{ details: TaskResult }>;
  (name: 'subagent_status'): Promise<{ details: TaskResult[] }>;
}

function fixture(run: (host: PiFixture & { activity: { id: string; active: boolean }[]; closed: () => Promise<void>; execute: Execute }) => Promise<void>) {
  const activity: { id: string; active: boolean }[] = [];
  const priorPath = process.env.PATH;
  return withPi({ extensions: [host => {
    host.events.on('pi-interactive:background-activity', event => activity.push(event as { id: string; active: boolean }));
    subagents(host);
  }], configure: async ({ cwd, agentDir }, provider) => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'subagents.json'), JSON.stringify({ defaultProfile: 'fixture', profiles: { fixture: { model: `pi-test/${provider.getModel().id}`, thinking: 'off' } } }));
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\n${pi}`, { mode: 0o700 });
    process.env.PATH = `${cwd}:${priorPath ?? ''}`;
    return { model: provider.getModel() };
  }, bind: session => {
    session.setActiveToolsByName(['read', 'write', 'edit', 'bash', 'subagent', 'workflow', 'subagent_status']);
    return { mode: 'rpc', uiContext: { ...session.extensionRunner.createContext().ui, editor: async (_title, source) => source, confirm: async () => true } };
  } }, async host => {
    const execute = ((name: string, args: Record<string, unknown> = {}) => host.session.getToolDefinition(name)!.execute(name, args, undefined, undefined, host.runner.createToolContext(name, undefined))) as Execute;
    const closed = async () => {
      await until(() => activity.some(entry => !entry.active), 'the active interval to close');
      assert.equal(activity.length, 2);
      assert.deepEqual(activity.map(entry => entry.active), [true, false]);
      assert.equal(activity[1].id, activity[0].id);
      assert.match(activity[0].id, /^[0-9a-f-]{36}$/);
    };
    await run({ ...host, activity, closed, execute });
  }).finally(() => {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  });
}

const status = (host: { execute: Execute }, id: string) => host.execute('subagent_status', {id}).then(value => value.details.status);

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
  assert.deepEqual((await host.execute('subagent_status')).details.map(task => task.status), ['failed']);
}));
