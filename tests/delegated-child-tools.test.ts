import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import subagents from '../extensions/subagents/index.ts';
import {until} from '../extensions/subagents/test-support.ts';
import {SubagentRegistry} from '../extensions/subagents/registry.ts';
import {setActiveCwd} from '../extensions/worktree/routing.ts';

const read = 'claude_jira_get_issue', write = 'claude_jira_update_issue';
const request = (name = read, args: Record<string, unknown> = {issueKey: 'BBA-42'}, delay = 0) => JSON.stringify({name, args, delay});

async function fixture(run: (f: any) => Promise<void>, options: any = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'delegated-tools-'));
  const agentDir = join(cwd, 'agent');
  const priorPath = process.env.PATH, priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let toolContext: any;
  const secret = 'synthetic-connector-auth-kept-in-parent';
  const calls: any[] = [], hooks: any[] = [];
  const connector = (pi: ExtensionAPI) => {
    for (const name of [read, write, 'ungranted_connector', 'model_only_connector', 'deferred_connector']) pi.registerTool({
      name, label: name, description: name === read ? options.description ?? 'Deterministic connector' : 'Deterministic connector', parameters: Type.Object({issueKey: Type.String()}),
      exposure: name === 'model_only_connector' ? 'model-only' : name === 'deferred_connector' ? 'deferred' : 'direct',
      async execute(_id, args, signal) {
        assert.equal(secret, 'synthetic-connector-auth-kept-in-parent');
        calls.push({name, args, signal});
        if (options.connector) return options.connector(name, args, signal);
        return {content: [{type: 'text', text: JSON.stringify({issueKey: args.issueKey, summary: 'Fixture issue', authenticated: true})}], details: {issueKey: args.issueKey}, structuredContent: {issueKey: args.issueKey}};
      },
    });
    pi.on('tool_call', (event, ctx) => {
      hooks.push(event);
      if (options.permission) return options.permission(event, ctx);
      if (event.toolName === read && event.input.issueKey === 'DENIED') return {block: true, reason: 'Parent connector permission denied'};
    });
  };
  try {
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({retry: {enabled: true, maxRetries: 1, baseDelayMs: 1}, compaction: {enabled: false}}));
    await writeFile(join(cwd, 'pi'), options.binary
      ? `#!/bin/sh\nexec '${options.binary.replace(/'/g, "'\\''")}' "$@"\n`
      : `#!${process.execPath}\nimport(${JSON.stringify(new URL('./fixtures/delegated-child.mjs', import.meta.url).href)}).catch(error=>{console.error(error);process.exitCode=1;});`);
    await chmod(join(cwd, 'pi'), 0o700);
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({providers: {test: {baseUrl: 'http://127.0.0.1:1', api: 'openai-responses', apiKey: 'synthetic', models: [{id: 'fixture', name: 'Fixture', reasoning: true, contextWindow: 100000, maxTokens: 1000}]}}}));
    const settingsPath = join(agentDir, 'subagents.json');
    const settings = {profiles: {implement: {model: 'test/fixture', thinking: 'off'}}, delegatedTools: {[read]: 'read', [write]: 'write', model_only_connector: 'read', deferred_connector: 'read'}, ...options.settings};
    await writeFile(settingsPath, JSON.stringify(settings));
    process.env.PATH = `${cwd}:${priorPath ?? ''}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({cwd, agentDir, settingsManager, extensionFactories: [subagents, connector], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true});
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false});
    const registry = new ModelRegistry(modelRuntime);
    await registry.refresh({allowNetwork: false});
    const model = registry.find('test', 'fixture');
    ({session} = await createAgentSession({cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model, sessionManager: SessionManager.inMemory(cwd)}));
    await session.bindExtensions({uiContext: {confirm: async () => true, editor: async (_title: string, source: string) => source, setWidget() {}, setStatus() {}, notify() {}} as any});
    const runner = session.extensionRunner!;
    const context = runner.createToolContext('fixture-parent', undefined);
    toolContext = Object.defineProperties(Object.create(context), {
      hasUI: {value: true}, ui: {value: {...context.ui, confirm: async () => true, editor: async (_title: string, source: string) => source, setWidget() {}, setStatus() {}, notify() {}}},
      executeTool: {value: async (name: string, input: any, callOptions: any) => {
        try {return await context.executeTool(name, input, callOptions);}
        finally {options.executionDone?.(name);}
      }},
    });
    const execute = (name: string, params: any = {}, signal?: AbortSignal) => session!.getToolDefinition(name)!.execute(name, params, signal, undefined, toolContext) as Promise<any>;
    let promptCount = 0;
    const parentTurn = async (name?: string, params?: any) => {
      let response = 0;
      session!.agent.streamFunction = () => {
        const message: any = {role: 'assistant', api: 'openai-responses', provider: 'test', model: 'fixture', content: name && response++ === 0 ? [{type: 'toolCall', id: `parent-${promptCount}`, name, arguments: params}] : [{type: 'text', text: 'Parent continued'}], stopReason: name && response === 1 ? 'toolUse' : 'stop', usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, timestamp: Date.now()};
        if (message.content[0].type === 'text') message.stopReason = 'stop';
        const stream = createAssistantMessageEventStream(); stream.push({type: 'done', reason: message.stopReason, message}); stream.end(message); return stream;
      };
      promptCount++;
      await session!.agent.prompt('Fixture parent turn');
      return session!.agent.state.messages.filter((message: any) => message.role === 'toolResult').at(-1) as any;
    };
    await parentTurn();
    const completed = async (id: string) => until(async () => {
      const task = (await execute('subagent_status', {id})).details;
      return ['queued', 'running'].includes(task.status) ? undefined : task;
    }, 'the delegated child to complete', 10000).catch(async error => {
      throw new Error(`${error.message}: ${JSON.stringify((await execute('subagent_status', {id})).details)}`);
    });
    await run({cwd, agentDir, session, execute, calls, hooks, completed, parentTurn, secret, settings, settingsPath, reload: async () => {await runner.emit({type: 'session_shutdown', reason: 'reload'}); await runner.emit({type: 'session_start', reason: 'reload'});}});
  } finally {
    await session?.extensionRunner?.emit({type: 'session_shutdown', reason: 'quit'});
    session?.dispose();
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(cwd, {recursive: true, force: true});
  }
}

test('real Pi executable delegates connectors and preserves parent denials', {skip: !process.env.PI_SUBAGENT_TEST_BINARY}, async () => fixture(async ({execute, completed, calls}) => {
  for (const issueKey of ['BBA-42', 'DENIED']) {
    const child = await execute('subagent', {
      task: request(read, {issueKey}), tools: ['read', read],
      extensions: [new URL('./fixtures/delegated-provider.mjs', import.meta.url).pathname],
    });
    const task = await completed(child.details.id);
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const output = JSON.parse(task.output);
    assert.deepEqual(output.tools.sort(), ['read', read].sort());
    assert.equal(output.results[0].isError, issueKey === 'DENIED');
    assert.match(output.results[0].content[0].text, issueKey === 'DENIED' ? /Parent connector permission denied/ : /Fixture issue/);
  }
  assert.equal(calls.length, 1);
}, {binary: process.env.PI_SUBAGENT_TEST_BINARY}));

for (const [runtime, binary] of [['SDK', undefined], ['installed Pi', process.env.PI_SUBAGENT_TEST_BINARY]] as const) {
  test(`connector remains callable after automatic retry in ${runtime} child`, {skip: runtime === 'installed Pi' && !binary}, async () => fixture(async ({execute, completed, calls}) => {
    const child = await execute('subagent', {
      task: JSON.stringify({name: read, args: {issueKey: 'BBA-42'}, retry: true}), tools: [read],
      ...(binary ? {extensions: [new URL('./fixtures/delegated-provider.mjs', import.meta.url).pathname]} : {}),
    });
    const task = await completed(child.details.id);
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const output = JSON.parse(task.output);
    assert.equal(output.results[0].isError, false);
    assert.match(output.results[0].content[0].text, /Fixture issue/);
    assert.equal(calls.length, 1);
  }, {binary}));
}

test('switching the parent workspace revokes connector calls even with identical settings', async () => fixture(async ({cwd, execute, completed, calls, session}) => {
  const first = join(cwd, 'first-workspace'), other = join(cwd, 'other-workspace'), gate = join(cwd, 'call-ready');
  await mkdir(first); await mkdir(other);
  const sessionId = session.sessionManager.getSessionId();
  try {
    setActiveCwd(cwd, first, sessionId);
    const child = await execute('subagent', {task: JSON.stringify({name: read, args: {issueKey: 'BBA-42'}, waitFor: gate}), tools: [read]});
    setActiveCwd(cwd, other, sessionId);
    await writeFile(gate, 'ready');
    const task = await completed(child.details.id);
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const output = JSON.parse(task.output);
    assert.equal(output.results[0].isError, true);
    assert.match(output.results[0].content[0].text, /parent workspace changed.*resubmit task/);
    assert.equal(calls.length, 0);
  } finally {setActiveCwd(cwd, undefined, sessionId);}
}));

test('an explicitly granted connector executes in a real background child after another parent turn', async () => fixture(async ({execute, completed, parentTurn, calls, hooks, secret}) => {
  const launched = await parentTurn('subagent', {task: request(read, {issueKey: 'BBA-42'}, 300), preset: 'reader', tools: ['read', read]});
  assert.equal(launched.isError, false, JSON.stringify(launched));
  const id = JSON.parse(launched.content[0].text).id;
  await parentTurn();
  const task = await completed(id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  const child = JSON.parse(task.output);
  assert.deepEqual(child.tools.sort(), ['read', read].sort());
  assert.equal(child.results[0].isError, false);
  assert.equal(JSON.parse(child.results[0].content[0].text).authenticated, true);
  assert.deepEqual(child.executions[0].result.structuredContent, {issueKey: 'BBA-42'});
  assert.equal(calls.length, 1);
  assert.ok(hooks.some((event: any) => event.toolName === read && event.parentToolCallId));
  assert.ok(!JSON.stringify(task).includes(secret));
  assert.equal((await execute('subagent_status')).details.length, 1);
}));

test('forged child requests cannot invoke a parent tool outside that child selection', async () => fixture(async ({execute, completed, calls}) => {
  const child = await execute('subagent', {task: JSON.stringify({attack: write}), tools: [read]});
  const task = await completed(child.details.id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  assert.match(JSON.parse(task.output).error, /not delegated to this child.*claude_jira_update_issue/);
  assert.equal(calls.length, 0);
}));

test('an empty connector bridge error settles the child call normally', async () => fixture(async ({cwd}) => {
  const registry = new SubagentRegistry({allowedTools: () => [read], readTools: () => [read]});
  try {
    const child = await registry.spawn({task: request(), cwd, model: 'test/fixture', tools: [read], timeout: 3000}, undefined, 'parent', {
      tools: [{name: read, description: 'Fixture connector', parameters: Type.Object({issueKey: Type.String()})}],
      execute: async () => {throw new Error('');},
    });
    const task = await child.done;
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const result = JSON.parse(task.output).results[0];
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Connector execution failed/);
  } finally {await registry.shutdown();}
}));

test('cancelled uncooperative connector calls retain their execution slots without breaking the bridge', async () => {
  let release!: (value: any) => void;
  const held = new Promise(resolve => {release = resolve;});
  try {
    await fixture(async ({cwd, execute, completed, calls}) => {
      const gate = join(cwd, 'calls-entered');
      const call = (id: number) => ({type: 'call', id, name: read, args: {issueKey: 'BBA-42'}});
      const child = await execute('subagent', {tools: [read], task: JSON.stringify({
        protocol: Array.from({length: 32}, (_, i) => call(i + 1)), gate,
        afterGate: [{type: 'cancel', id: 1}, call(33)], finishId: 33,
      })});
      await until(() => calls.length === 32, 'all parent requests to enter the connector', 10000);
      await writeFile(gate, 'ready');
      const task = await completed(child.details.id);
      assert.equal(task.status, 'succeeded', JSON.stringify(task));
      assert.match(JSON.parse(task.output).error, /Too many outstanding connector requests/);
      assert.equal(calls.length, 32);
      assert.equal(calls[0].signal.aborted, true);
    }, {connector: async () => held});
  } finally {release({content: [{type: 'text', text: 'Released'}], details: {}});}
});

test('read connectors overlap a writer while queued connector writes recheck parent permissions', async () => fixture(async ({execute, calls, completed, session}) => {
  const first = await execute('subagent', {task: request(write), tools: [write]});
  await until(() => calls.length === 1, 'the first connector writer to start', 10000);
  const second = await execute('subagent', {task: request(write), tools: [write]});
  assert.equal((await execute('subagent_status', {id: second.details.id})).details.status, 'queued');
  const reader = await execute('subagent', {task: request(), tools: [read], preset: 'reader'});
  assert.equal((await completed(reader.details.id)).status, 'succeeded');
  assert.equal(calls.length, 2);
  session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== write));
  await execute('subagent_cancel', {id: first.details.id});
  const queued = await completed(second.details.id);
  assert.equal(queued.status, 'failed');
  assert.match(queued.error, /current parent permissions at launch.*claude_jira_update_issue/);
  assert.equal(calls.filter((call: any) => call.name === write).length, 1);
}, {connector: async (name: string, _args: unknown, signal: AbortSignal) => {
  if (name === read) return {content: [{type: 'text', text: 'Read while writer was running'}], details: {}};
  return new Promise((_resolve, reject) => {const abort = () => reject(new Error('Writer aborted')); signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();});
}}));

test('unsupported connector definitions fail before any child is admitted', async () => fixture(async ({execute}) => {
  await assert.rejects(execute('subagent', {task: request(), tools: [read]}), /connector definitions.*1 MiB.*claude_jira_get_issue/i);
  assert.deepEqual((await execute('subagent_status')).details, []);
}, {description: 'x'.repeat(1024 * 1024)}));

test('oversized structured connector data keeps its bounded visible result callable', async () => fixture(async ({execute, completed}) => {
  const child = await execute('subagent', {task: request(), tools: [read]});
  const task = await completed(child.details.id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  const output = JSON.parse(task.output);
  assert.equal(output.results[0].isError, false);
  assert.equal(output.results[0].content[0].text, 'Visible connector result');
  assert.equal(output.executions[0].result.structuredContent, undefined);
}, {connector: async () => ({content: [{type: 'text', text: 'Visible connector result'}], details: {}, structuredContent: {raw: 'x'.repeat(1024 * 1024)}})}));

test('cancelling a child aborts its connector request in the parent', async () => fixture(async ({execute, calls}) => {
  const child = await execute('subagent', {task: request(), tools: [read]});
  await until(() => calls.length > 0, 'the parent-hosted connector request to start', 10000);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal((await execute('subagent_cancel', {id: child.details.id})).details.cancelled, true);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await execute('subagent_status', {id: child.details.id})).details.status, 'cancelled');
}, {connector: async (_name: string, _args: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
  const abort = () => reject(new Error('Fixture connector aborted'));
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
})}));

test('cancelling during a parent permission hook prevents the connector effect', async () => {
  let entered = false, release!: () => void;
  let done!: () => void;
  const settled = new Promise<void>(resolve => {done = resolve;});
  const approval = new Promise<void>(resolve => {release = resolve;});
  await fixture(async ({execute, calls}) => {
    const child = await execute('subagent', {task: request(), tools: [read]});
    await until(() => entered, 'the parent permission hook to wait', 10000);
    try {
      await execute('subagent_cancel', {id: child.details.id});
      release();
      await settled;
      assert.equal(calls.length, 0);
      assert.equal((await execute('subagent_status', {id: child.details.id})).details.status, 'cancelled');
    } finally {release();}
  }, {permission: async (event: any) => {if (event.toolName === read) {entered = true; await approval;}}, executionDone: (name: string) => {if (name === read) done();}});
});

test('child timeout aborts a connector executing in the parent', async () => fixture(async ({execute, calls, completed}) => {
  const child = await execute('subagent', {task: request(), tools: [read], timeout: 5000});
  await until(() => calls.length === 1, 'the connector to begin before timeout', 10000);
  const task = await completed(child.details.id);
  assert.equal(task.status, 'timed-out');
  assert.equal(calls[0].signal.aborted, true);
}, {connector: async (_name: string, _args: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
  const abort = () => reject(new Error('Fixture timeout'));
  signal.addEventListener('abort', abort, {once: true});
  if (signal.aborted) abort();
})}));

test('oversized visible connector results return a normal child tool error', async () => fixture(async ({execute, completed}) => {
  const child = await execute('subagent', {task: request(), tools: [read]});
  const task = await completed(child.details.id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  const result = JSON.parse(task.output).results[0];
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceeds its buffer limit/);
}, {connector: async () => ({content: [{type: 'text', text: 'x'.repeat(2 * 1024 * 1024)}], details: {}})}));

test('workflow replay rechecks grant removal, reclassification, and active parent permissions', async () => fixture(async ({execute, calls, settings, settingsPath, reload, session}) => {
  const source = `return await api.spawn(${JSON.stringify({task: request(), tools: [read], preset: 'reader'})},'jira');`;
  const first = (await execute('workflow', {source})).details;
  assert.equal((await execute('workflow', {source})).details.id, first.id);
  assert.equal(calls.length, 1);
  session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== read));
  await assert.rejects(execute('workflow', {source}), /exceed parent permissions.*claude_jira_get_issue/);
  session.setActiveToolsByName([...session.getActiveToolNames(), read]);
  await writeFile(settingsPath, JSON.stringify({...settings, delegatedTools: {[read]: 'write'}}));
  await reload();
  await assert.rejects(execute('workflow', {source}), /Reader preset.*claude_jira_get_issue/);
  await writeFile(settingsPath, JSON.stringify({...settings, delegatedTools: {}}));
  await reload();
  await assert.rejects(execute('workflow', {source}), /Disallowed.*claude_jira_get_issue/);
  assert.equal(calls.length, 1);
}));

test('built-in defaults stay bounded and never implicitly include granted connectors', async () => fixture(async ({cwd, execute, completed, calls}) => {
  await writeFile(join(cwd, 'input'), 'Built-in tools still work');
  for (const preset of [undefined, 'reader', 'writer']) {
    const child = await execute('subagent', {task: request('read', {path: 'input'}), ...(preset ? {preset} : {})});
    const task = await completed(child.details.id);
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    const result = JSON.parse(task.output);
    assert.deepEqual(result.tools.sort(), preset === 'reader' ? ['read'] : ['bash', 'edit', 'read', 'write']);
    assert.equal(result.results[0].content[0].text, 'Built-in tools still work');
  }
  assert.equal(calls.length, 0);
}));

test('reader presets reject built-in and connector writes in both entry points while writer grants execute', async () => fixture(async ({execute, completed, calls}) => {
  for (const name of ['bash', write]) {
    const task = {task: request(name), preset: 'reader', tools: [name]};
    await assert.rejects(execute('subagent', task), new RegExp(`Reader preset.*${name}`));
    await assert.rejects(execute('workflow', {source: `return await api.spawn(${JSON.stringify(task)},'reject');`}), new RegExp(`Reader preset.*${name}`));
  }
  assert.deepEqual((await execute('subagent_status')).details, []);
  const child = await execute('subagent', {task: request(write), preset: 'writer', tools: [write]});
  const task = await completed(child.details.id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  assert.equal(JSON.parse(task.output).results[0].isError, false);
  assert.equal(calls[0].name, write);
}));

test('active and callable parent permissions both bound connector grants', async () => fixture(async ({session, execute, calls}) => {
  for (const name of ['model_only_connector', 'deferred_connector']) {
    const task = {task: request(name), tools: [name]};
    const expected = name === 'model_only_connector' ? /not callable.*model_only_connector/ : /exceed parent permissions.*deferred_connector/;
    await assert.rejects(execute('subagent', task), expected);
    await assert.rejects(execute('workflow', {source: `return await api.spawn(${JSON.stringify(task)},'reject');`}), expected);
  }
  session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== read));
  await assert.rejects(execute('subagent', {task: request(), tools: [read]}), /exceed parent permissions.*claude_jira_get_issue/);
  assert.equal(calls.length, 0);
  assert.deepEqual((await execute('subagent_status')).details, []);
}));

test('a running child cannot invoke a connector revoked by the parent', async () => fixture(async ({session, execute, completed, calls}) => {
  const child = await execute('subagent', {task: request(read, {issueKey: 'BBA-42'}, 300), tools: [read]});
  session.setActiveToolsByName(session.getActiveToolNames().filter((name: string) => name !== read));
  const task = await completed(child.details.id);
  assert.equal(task.status, 'succeeded', JSON.stringify(task));
  const result = JSON.parse(task.output).results[0];
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceed parent permissions.*claude_jira_get_issue/);
  assert.equal(calls.length, 0);
}));

test('workflow children execute connector tools and preserve parent permission errors', async () => fixture(async ({execute, calls}) => {
  const source = (key: string) => `return await api.spawn(${JSON.stringify({task: request(read, {issueKey: key}), preset: 'reader', tools: [read]})},'jira');`;
  const accepted = (await execute('workflow', {source: source('BBA-42')})).details;
  assert.equal(JSON.parse(accepted.output).results[0].isError, false);
  const denied = (await execute('workflow', {source: source('DENIED')})).details;
  const result = JSON.parse(denied.output).results[0];
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Parent connector permission denied/);
  assert.equal(calls.length, 1);
}));

test('a rejected selection names unavailable and disallowed tools, returns a normal error, and the parent continues', async () => fixture(async ({parentTurn, execute, calls}) => {
  const rejected = await parentTurn('subagent', {task: request(), tools: [read, 'missing_connector', 'ungranted_connector']});
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unavailable.*missing_connector/);
  assert.match(rejected.content[0].text, /Disallowed.*ungranted_connector/);
  assert.match(rejected.content[0].text, /subagents.json.*\/reload/);
  assert.deepEqual((await execute('subagent_status')).details, []);
  const continued = await parentTurn(read, {issueKey: 'BBA-7'});
  assert.equal(continued.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.issueKey, 'BBA-7');
}));
