import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import subagents from './index.ts';
import { fixtureModelRegistry } from './test-support.ts';
import { setActiveCwd } from '../worktree/routing.ts';

async function fixture(run: (f: any) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'profile-integration-'));
  const oldPath = process.env.PATH, oldAgent = process.env.PI_CODING_AGENT_DIR;
  const tools = new Map<string, any>(), hooks = new Map<string, any>();
  const agent = join(cwd, 'agent'), global = join(agent, 'subagents.json'), local = join(cwd, '.pi/subagents.local.json');
  const ctx: any = {cwd, model: {provider: 'test', id: 'selected'}, thinkingLevel: 'low', modelRegistry: fixtureModelRegistry(), isProjectTrusted: () => true,
    hasUI: true, sessionManager: {getSessionId: () => cwd}, ui: {notify() {}, setStatus() {}, setWidget() {}, editor: async (_title: string, source: string) => source, confirm: async () => true}};
  const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  try {
    await mkdir(agent); await mkdir(join(cwd, '.pi'));
    await writeFile(join(cwd, 'pi'), `#!${process.execPath}\nif(process.argv.at(-1)==='hold')setInterval(()=>{},1000);else console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify(process.argv.slice(2))}]}}));`);
    await chmod(join(cwd, 'pi'), 0o700);
    process.env.PATH = `${cwd}:${oldPath}`; process.env.PI_CODING_AGENT_DIR = agent;
    subagents({getActiveTools: () => ['read', 'subagent', 'workflow'], registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, hook: any) => hooks.set(name, hook), events: {emit() {}}, sendMessage() {}} as any);
    await hooks.get('session_start')({reason: 'startup'}, ctx);
    const execute = (name: string, args: any = {}) => tools.get(name).execute(name, args, undefined, undefined, ctx);
    const direct = async (input: any) => {
      const start = await execute('subagent', input);
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const value = (await execute('subagent_status', {id: start.details.id})).details;
        if (!['running', 'queued'].includes(value.status)) { assert.equal(value.status, 'succeeded', JSON.stringify(value)); return value; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('child did not complete');
    };
    const workflow = async (input: any) => (await execute('workflow', {source: `return await api.spawn(${JSON.stringify(input)},'stage');`})).details;
    const prompt = async () => (await hooks.get('before_agent_start')({systemPrompt: 'parent'}, ctx)).systemPrompt;
    const reload = async () => { await hooks.get('session_shutdown')({reason: 'reload'}, ctx); await hooks.get('session_start')({reason: 'reload'}, ctx); };
    await run({cwd, global, local, ctx, put, execute, direct, workflow, prompt, reload, tools, hooks});
  } finally {
    setActiveCwd(cwd, undefined, cwd);
    await hooks.get('session_shutdown')?.();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    await rm(cwd, {recursive: true, force: true});
  }
}

test('registered direct/workflow parity: defaults, custom profiles, overrides and bounded provenance', async () => fixture(async ({put, global, local, reload, direct, workflow, tools}) => {
  await put(global, {profiles: {custom: {model: 'test/fixture', thinking: 'high'}}});
  await put(local, {profiles: {custom: {thinking: 'low', useWhen: 'Fixture work'}}});
  await reload();
  assert.match(tools.get('subagent').description, /Profiles:.*custom/);
  assert.ok(tools.get('subagent').parameters.properties.profile);
  for (const options of [{}, {profile: 'research'}, {profile: 'custom'}, {profile: 'custom', model: 'test/selected:high'}, {profile: 'custom', model: 'test/selected:high', thinking: 'off'}]) {
    const input = {task: 'fixture', preset: 'reader', ...options};
    const a = await direct(input), b = await workflow(input);
    for (const key of ['model', 'thinking', 'profile', 'configProvenance']) assert.deepEqual(a[key], b[key]);
    const args = JSON.parse(a.output);
    assert.equal(args[args.indexOf('--model') + 1], a.model); assert.equal(args[args.indexOf('--thinking') + 1], a.thinking);
    assert.equal(args[args.indexOf('--tools') + 1], 'read');
    assert.ok(Buffer.byteLength(JSON.stringify(a.configProvenance)) < 1200);
  }
  const custom = await direct({task: 'fixture', profile: 'custom'});
  assert.equal(custom.configProvenance.model, global); assert.equal(custom.configProvenance.thinking, await realpath(local));
}));

test('session snapshot stays stable until reload, then prompt, tool choices and workflow identity update', async () => fixture(async ({put, global, prompt, direct, workflow, reload, tools}) => {
  const input = {task: 'snapshot', profile: 'implement'};
  const first = await workflow(input);
  await put(global, {profiles: {implement: {thinking: 'high'}, extra: {model: 'inherit', thinking: 'inherit'}}});
  assert.match(await prompt(), /implement: openai-codex\/gpt-6-astra \/ medium/);
  assert.equal((await workflow(input)).id, first.id, 'same snapshot can replay');
  assert.equal((await direct(input)).thinking, 'medium');
  await reload();
  assert.match(await prompt(), /implement: openai-codex\/gpt-6-astra \/ high/);
  assert.match(tools.get('subagent').description, /extra/);
  const next = await workflow(input);
  assert.notEqual(next.id, first.id); assert.equal(next.thinking, 'high');
  assert.notEqual(next.configProvenance.config, first.configProvenance.config);
}));

test('invalid snapshot blocks direct and workflow until reload repairs it', async () => fixture(async ({global, reload, prompt, execute, put, direct}) => {
  await writeFile(global, '{bad'); await reload();
  assert.match(await prompt(), /delegation is unavailable/);
  await assert.rejects(execute('subagent', {task: 'no'}), /Fix settings and \/reload/);
  await assert.rejects(execute('workflow', {source: 'return 1;'}), /Fix settings and \/reload/);
  await put(global, {});
  await assert.rejects(execute('subagent', {task: 'no'}), /Fix settings and \/reload/);
  await reload(); assert.equal((await direct({task: 'yes'})).thinking, 'medium');
}));

test('trust revocation and routed cwd drop local overrides without transferring trust', async () => fixture(async ({local, put, reload, direct, ctx, cwd, prompt}) => {
  await put(local, {profiles: {implement: {thinking: 'high'}}}); await reload();
  assert.equal((await direct({task: 'trusted'})).thinking, 'high');
  ctx.isProjectTrusted = () => false;
  assert.equal((await direct({task: 'untrusted'})).thinking, 'medium');
  ctx.isProjectTrusted = () => true;
  const routed = join(cwd, 'checkout'); await mkdir(join(routed, '.pi'), {recursive: true});
  await put(join(routed, '.pi/subagents.local.json'), {profiles: {implement: {model: 'test/fixture', thinking: 'off'}}});
  setActiveCwd(cwd, routed, cwd);
  assert.match(await prompt(), /implement: openai-codex\/gpt-6-astra \/ medium/);
  const task = await direct({task: 'routed'}); assert.equal(task.thinking, 'medium'); assert.equal(task.cwd, await realpath(routed));
}));

test('both public spawn boundaries reject unknown fields/profiles and unavailable models; replay rechecks availability', async () => fixture(async ({execute, workflow, ctx}) => {
  for (const bad of [{profile: 'unknown'}, {model: 'test/missing'}, {bogus: 1}, {thinking: 'invalid'}, {configProvenance: {model: 'forged'}}]) {
    await assert.rejects(execute('subagent', {task: 'reject', ...bad}));
    await assert.rejects(workflow({task: 'reject', ...bad}));
  }
  const input = {task: 'replay'};
  await workflow(input);
  ctx.modelRegistry.getAvailable = () => [];
  await assert.rejects(workflow(input), /unavailable.*No fallback/);
}));

test('workflow captures inherited parent selection and aborts new stages after workspace changes', async () => fixture(async ({execute, ctx, cwd}) => {
  const originalConfirm = ctx.ui.confirm;
  ctx.ui.confirm = async () => { ctx.model = {provider: 'test', id: 'different'}; return true; };
  const value = await execute('workflow', {source: "return await api.spawn({task:'inherit',model:'inherit'},'one');"});
  assert.equal(value.details.model, 'test/selected'); assert.equal(value.details.thinking, 'medium');
  const routed = join(cwd, 'other'); await mkdir(routed);
  ctx.ui.confirm = async () => { setActiveCwd(cwd, routed, cwd); return true; };
  await assert.rejects(execute('workflow', {source: "return await api.spawn({task:'moved'},'moved');"}), /configuration or workspace changed/);
  ctx.ui.confirm = originalConfirm;
}));

test('real Pi runtime refreshes profile tool descriptions without enabling disabled tools', async () => fixture(async ({cwd, global, put}) => {
  const {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} = await import('@earendil-works/pi-coding-agent');
  const agentDir = join(cwd, 'agent');
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({cwd, agentDir, settingsManager, extensionFactories: [subagents], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true});
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false});
  const {session} = await createAgentSession({cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, sessionManager: SessionManager.inMemory(cwd)});
  try {
    await session.bindExtensions({});
    session.setActiveToolsByName(['read']);
    const runner = session.extensionRunner!;
    await put(global, {profiles: {fresh: {model: 'inherit', thinking: 'medium'}}});
    await runner.emit({type: 'session_start', reason: 'reload'});
    assert.match(session.getToolDefinition('subagent')!.description, /fresh/);
    assert.deepEqual(session.getActiveToolNames(), ['read']);
    await runner.emit({type: 'session_shutdown', reason: 'quit'});
  } finally { session.dispose(); }
}));


for (const change of ['trust', 'availability']) test(`queued children recheck ${change} before launch`, async () => fixture(async ({execute, ctx, local, put, reload}) => {
  await put(local, {profiles: {implement: {thinking: 'high'}}}); await reload();
  const children = [];
  for (let i = 0; i < 9; i++) children.push((await execute('subagent', {task: 'hold', preset: 'reader'})).details.id);
  assert.equal((await execute('subagent_status', {id: children[8]})).details.status, 'queued');
  if (change === 'trust') ctx.isProjectTrusted = () => false;
  else ctx.modelRegistry.getAvailable = () => [];
  await execute('subagent_cancel', {id: children[0]});
  const queued = (await execute('subagent_status', {id: children[8]})).details;
  assert.equal(queued.status, 'failed');
  assert.match(queued.error, change === 'trust' ? /configuration or trust changed/ : /unavailable/);
}));
