import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DelegationAdmission } from './scope.ts';
import { createHash } from 'node:crypto';
import { loadProfiles } from './profiles.ts';
import { fixtureModelRegistry } from './test-support.ts';

test('admission rejects tools beyond the parent scope', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'admission-')));
  try {
    const admission = new DelegationAdmission({cwd: () => cwd, tools: () => ['read']});
    assert.throws(() => admission.direct({task: 'inspect', cwd, tools: ['bash']}), {message: 'Explicit child tools exceed parent permissions: bash. Activate these tools in the parent before delegating. For Pi MCP, set the selected tools\' toolExposure to direct in user-scoped mcp.json and /reload.'});
    assert.deepEqual((await admission.queue(admission.direct({task: 'inspect', cwd, preset: 'reader'}).task, new AbortController().signal)).task.tools, ['read']);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('connector admission distinguishes ungranted and uncallable tools', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'admission-connector-')));
  let grants: Record<string, 'read' | 'write'> = {};
  let exposure = 'direct';
  try {
    const admission = new DelegationAdmission({cwd: () => cwd, tools: () => ['read', 'fixture_read'], grants: () => grants,
      definitions: () => [{name: 'fixture_read', exposure}] as any});
    assert.throws(() => admission.direct({task: 'inspect', tools: ['fixture_read']}), {message: 'Disallowed connector tools: fixture_read. Add exact read/write grants to user-scoped subagents.json and /reload.'});
    grants = {fixture_read: 'read'};
    exposure = 'hidden';
    assert.throws(() => admission.direct({task: 'inspect', tools: ['fixture_read']}), {message: 'Connector tools are not callable in the parent: fixture_read. Enable a callable tool exposure in Pi and /reload.'});
    exposure = 'direct';
    assert.deepEqual(admission.direct({task: 'inspect', tools: ['fixture_read']}).task.tools, ['fixture_read']);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('queue admission rejects reader writes and cwd escapes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'admission-queue-')));
  const cwd = join(root, 'workspace'), outside = join(root, 'outside');
  await mkdir(cwd); await mkdir(outside);
  const signal = new AbortController().signal;
  try {
    const admission = new DelegationAdmission({cwd: () => cwd, tools: () => ['read', 'bash']});
    await assert.rejects(admission.queue(admission.direct({task: 'inspect', preset: 'reader', tools: ['bash']}).task, signal), {message: 'Reader preset cannot grant write tools: bash'});
    await assert.rejects(admission.queue(admission.direct({task: 'inspect', cwd: outside, tools: ['read']}).task, signal), {message: 'Path is outside parent workspace'});
  } finally { await rm(root, {recursive: true, force: true}); }
});

async function configured(run: (fixture: any) => Promise<void>) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'admission-phases-')));
  let tools = ['read', 'bash', 'fixture_read'];
  let grants: Record<string, 'read' | 'write'> = {fixture_read: 'read'};
  let config = loadProfiles(cwd, false, join(cwd, 'agent'));
  let exposure = 'direct', parentCwd = cwd;
  let executions = 0;
  const ctx: any = {cwd, model: {provider: 'test', id: 'fixture'}, thinkingLevel: 'low', modelRegistry: fixtureModelRegistry(), hasUI: true,
    tools: [{name: 'fixture_read'}], executeTool: async () => { executions++; return {result: {content: []}, isError: false}; }};
  const admission = new DelegationAdmission({cwd: () => parentCwd, tools: () => tools, grants: () => grants,
    definitions: () => [{name: 'fixture_read', description: 'Synthetic connector', parameters: {type: 'object'}, exposure}] as any,
    selection: () => ctx, config: () => config});
  try {
    await run({cwd, ctx, admission, signal: new AbortController().signal,
      setTools: (value: string[]) => {tools = value;}, setGrant: (value: 'read' | 'write') => {grants = {fixture_read: value};},
      setConfig: () => {config = {...config, identity: 'changed'};}, setExposure: (value: string) => {exposure = value;},
      setCwd: (value: string) => {parentCwd = value; ctx.cwd = value;}, executions: () => executions});
  } finally { await rm(cwd, {recursive: true, force: true}); }
}

test('launch rechecks tools and configuration after queue admission', async () => configured(async ({ctx, admission, signal, setTools, setConfig}) => {
  const request = admission.direct({task: 'inspect', tools: ['read']}, ctx);
  const admitted = await admission.queue(request.task, signal);
  admission.launch(admitted.task);
  setTools([]);
  assert.throws(() => admission.launch(admitted.task), {message: 'Child tools exceed current parent permissions at launch: read'});
  setTools(['read']); setConfig();
  assert.throws(() => admission.launch(admitted.task), {message: 'Subagent configuration or trust changed while queued; resubmit task'});
}));

test('forwarded connector calls recheck reader grants and callability', async () => configured(async ({ctx, admission, signal, setGrant, setExposure, executions}) => {
  const request = admission.direct({task: 'inspect', preset: 'reader', tools: ['fixture_read']}, ctx);
  await admission.queue(request.task, signal, request.bridge);
  await request.bridge.execute('fixture_read', {}, signal);
  assert.equal(executions(), 1);
  setGrant('write');
  await assert.rejects(request.bridge.execute('fixture_read', {}, signal), {message: 'Reader preset cannot grant write tools: fixture_read'});
  setGrant('read'); setExposure('hidden');
  await assert.rejects(request.bridge.execute('fixture_read', {}, signal), {message: 'Connector tools are not callable in the parent: fixture_read. Enable a callable tool exposure in Pi and /reload.'});
  setExposure('direct'); ctx.tools = [];
  await assert.rejects(request.bridge.execute('fixture_read', {}, signal), {message: 'Connector tool is no longer callable in the parent: fixture_read'});
  assert.equal(executions(), 1);
}));

test('forwarded connector calls recheck configuration and spawning workspace', async () => configured(async ({cwd, ctx, admission, signal, setCwd, setConfig, executions}) => {
  const request = admission.direct({task: 'inspect', tools: ['fixture_read']}, ctx);
  await mkdir(join(cwd, 'nested'));
  setCwd(join(cwd, 'nested'));
  await assert.rejects(request.bridge.execute('fixture_read', {}, signal), {message: 'Subagent parent workspace changed; resubmit task'});
  setCwd(cwd); setConfig();
  await assert.rejects(request.bridge.execute('fixture_read', {}, signal), {message: 'Subagent delegation configuration changed; resubmit task'});
  assert.equal(executions(), 0);
}));

test('workflow admission and cached replay recheck live permissions and workspace', async () => configured(async ({cwd, ctx, admission, signal, setTools, setCwd}) => {
  const workflow = admission.workflow(ctx);
  const task = await workflow.admit({task: 'inspect', tools: ['read']}, cwd);
  await workflow.replay(task, signal);
  setTools([]);
  await assert.rejects(workflow.replay(task, signal), {message: 'Explicit child tools exceed parent permissions: read. Activate these tools in the parent before delegating. For Pi MCP, set the selected tools\' toolExposure to direct in user-scoped mcp.json and /reload.'});
  setTools(['read']); await mkdir(join(cwd, 'nested')); setCwd(join(cwd, 'nested'));
  await assert.rejects(workflow.admit({task: 'inspect', tools: ['read']}, cwd), {message: 'Workflow configuration or workspace changed; restart workflow'});
  await assert.rejects(workflow.replay(task, signal), {message: 'Path is outside parent workspace'});
}));

test('live queue and cached replay retain separate extension approvals', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'admission-extension-')));
  const extension = join(cwd, 'extension.ts');
  await writeFile(extension, 'export default () => {};');
  const titles: string[] = [], signal = new AbortController().signal;
  try {
    const admission = new DelegationAdmission({cwd: () => cwd, tools: () => ['read'], approve: async title => {titles.push(title); return true;}});
    const workflow = admission.workflow();
    const task = await workflow.admit({task: 'inspect', preset: 'reader', extensions: [extension]}, cwd);
    await admission.queue(task, signal);
    await workflow.replay(task, signal);
    assert.deepEqual(titles, ['Approve local child extensions', 'Approve workflow child extensions']);
    const denied = new DelegationAdmission({cwd: () => cwd, tools: () => ['read'], approve: async () => false});
    await assert.rejects(denied.queue(task, signal), {message: 'Child extension loading was not approved', retryable: false});
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('workflow task signatures retain the pre-refactor validated shape and property order', async () => {
  const admission = new DelegationAdmission({cwd: () => '/tmp', tools: () => ['read']});
  const task = await admission.workflow().admit({task: 'compatibility', cwd: '/tmp', model: 'test/fixture', thinking: 'low', tools: ['read'], preset: 'reader'}, '/tmp');
  const json = JSON.stringify(task).replace(task.hooks, '<hooks>');
  assert.equal(createHash('sha256').update(json).digest('hex'), '87a92b23c6e0d9427fa1c749f32c525599a6bc1295d2d717fe0c584a1e4924f3');
});
