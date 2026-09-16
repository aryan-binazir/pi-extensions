import { fixtureModelRegistry } from '../extensions/subagents/test-support.ts';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('stock Pi active permissions support default and preset children and workflow replay across turns', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'stock-child-'));
  const oldPath = process.env.PATH, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({tools:process.argv[process.argv.indexOf('--tools')+1].split(',')})}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${oldPath ?? ''}`;
    const agentDir = join(cwd, 'agent');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({packages: [resolve(import.meta.dirname, '..')]});
    const resourceLoader = new DefaultResourceLoader({cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true});
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
    ({session} = await createAgentSession({cwd, agentDir, settingsManager, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(cwd)}));
    await session.bindExtensions({});
    const runner = session.extensionRunner!;
    assert.ok(!session.getActiveToolNames().includes('grep'));
    assert.notEqual((await runner.emitToolCall({type: 'tool_call', toolName: 'read', toolCallId: 'init', input: {path: join(cwd, 'pi')}}))?.block, true);
    const ctx = {...runner.createContext()};
    Object.assign(ctx, {model: {provider: 'test', id: 'fixture'}, thinkingLevel: 'off', modelRegistry: fixtureModelRegistry()});
    const execute = async (name: string, params: any) => await session!.getToolDefinition(name)!.execute(name, params, undefined, undefined, ctx) as any;
    const expectedTools = new Map<string, string[]>();
    for (const preset of [undefined, 'reader', 'writer']) {
      const result = await execute('subagent', {task: 'Synthetic child', ...(preset ? {preset} : {})});
      assert.ok(result.details.id);
      expectedTools.set(result.details.id, preset === 'reader' ? ['read'] : ['bash', 'edit', 'read', 'write']);
    }
    await assert.rejects(execute('subagent', {task: 'Forbidden explicit tool', tools: ['grep']}), /parent permissions/);
    const deadline = Date.now() + 5000;
    let tasks = (await execute('subagent_status', {})).details;
    while (tasks.some((task: any) => !['succeeded', 'failed'].includes(task.status)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      tasks = (await execute('subagent_status', {})).details;
    }
    assert.equal(tasks.length, 3);
    for (const task of tasks) {
      assert.equal(task.status, 'succeeded');
      assert.deepEqual(JSON.parse(task.output).tools.sort(), expectedTools.get(task.id));
    }
    let replayPrompts = 0;
    Object.assign(ctx, {hasUI: true, ui: {...ctx.ui, editor: async (_title: string, source: string) => source, confirm: async (title: string) => {if (title.includes('Replay')) replayPrompts++; return true;}, setWidget() {}}});
    const source = "return await api.spawn({task:'Workflow stock child',preset:'reader'},'stage');";
    await execute('workflow', {source});
    await runner.emitInput('Retry this exact workflow', [], 'interactive');
    await execute('workflow', {source});
    assert.equal(replayPrompts, 1);
    assert.equal((await execute('subagent_status', {})).details.length, 4, 'replay must not launch another child');
    session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== 'write'));
    await runner.emitInput('Permissions changed; run again', [], 'interactive');
    await execute('workflow', {source});
    assert.equal((await execute('subagent_status', {})).details.length, 5, 'changed permissions require a fresh journal');
  } finally {
    await session?.extensionRunner?.emit({type: 'session_shutdown', reason: 'quit'});
    session?.dispose();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
});
