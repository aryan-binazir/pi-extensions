import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { assertTaskFields, loadProfiles, profileGuidance, profileLocation, resolveProfile } from './profiles.ts';
import { fixtureModelRegistry } from './test-support.ts';

async function fixture(run: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'subagent-profiles-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), {recursive: true}); await mkdir(agentDir);
  const global = join(agentDir, 'subagents.json'), local = join(cwd, '.pi/subagents.local.json');
  const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  const ctx: any = {cwd, isProjectTrusted: () => true, model: {provider: 'test', id: 'selected'}, thinkingLevel: 'low', modelRegistry: fixtureModelRegistry()};
  const load = (trusted = true) => loadProfiles(cwd, trusted, agentDir);
  try { await run({root, cwd, agentDir, global, local, put, ctx, load}); }
  finally { await rm(root, {recursive: true, force: true}); }
}

test('missing files use committed defaults; presets do not choose models', async () => fixture(async ({load, ctx, cwd}) => {
  const config = load();
  assert.equal(config.defaultProfile, 'implement');
  assert.deepEqual(Object.keys(config.profiles), ['research', 'implement-small', 'implement', 'implement-complex', 'review']);
  for (const preset of ['reader', 'writer']) {
    const task = resolveProfile({task: 'work', cwd, preset} as any, config, ctx);
    assert.equal(task.model, 'openai-codex/gpt-6-astra'); assert.equal(task.thinking, 'medium'); assert.equal(task.profile, 'implement');
    assert.equal(task.configProvenance?.model, 'bundled');
  }
}));

test('layers merge each profile field and custom profiles independently', async () => fixture(async ({load, put, global, local, ctx, cwd}) => {
  await put(global, {profiles: {implement: {thinking: 'high'}, custom: {model: 'test/fixture', thinking: 'low', description: 'Custom'}}});
  await put(local, {defaultProfile: 'custom', profiles: {implement: {description: 'Local implementation'}, custom: {useWhen: 'Fixture tasks'}}});
  const config = load();
  assert.equal(config.profiles.implement.model, 'openai-codex/gpt-6-astra');
  assert.equal(config.profiles.implement.thinking, 'high'); assert.equal(config.profiles.implement.description, 'Local implementation');
  assert.equal(config.profiles.custom.description, 'Custom'); assert.equal(config.profiles.custom.useWhen, 'Fixture tasks');
  const task = resolveProfile({task: 'custom', cwd}, config, ctx);
  assert.equal(task.profile, 'custom'); assert.equal(task.configProvenance?.model, global); assert.equal(task.configProvenance?.profile, local);
  assert.deepEqual(config.sources, ['bundled', global, local]);
}));

test('untrusted local settings are not read, and ancestor settings are not discovered', async () => fixture(async ({load, global, local, put, cwd, agentDir}) => {
  await put(global, {profiles: {implement: {thinking: 'high'}}});
  await writeFile(local, 'malformed untrusted content');
  assert.equal(load(false).profiles.implement.thinking, 'high');
  assert.equal(load(false).local, 'excluded');
  await mkdir(join(cwd, 'nested'));
  assert.equal(loadProfiles(join(cwd, 'nested'), true, agentDir).profiles.implement.thinking, 'high');
  assert.throws(() => load(true), /subagents.local.json.*Fix settings and \/reload/);
}));

for (const bad of [
  null, [], {unknown: true}, {profiles: []}, {profiles: {bad: null}}, {profiles: {bad: {model: 'test/fixture'}}},
  {profiles: {implement: {tools: ['bash']}}}, {profiles: {implement: {thinking: 'huge'}}},
  {profiles: {implement: {model: 'fixture'}}}, {profiles: {implement: {model: 'test/fixture:high'}}},
  {profiles: {implement: {description: 'x\n'}}}, {profiles: {implement: {useWhen: 3}}}, {defaultProfile: 'missing'},
  {profiles: {'__proto__': null, 'Bad Name': {model: 'inherit'}}},
]) test(`invalid settings fail closed: ${JSON.stringify(bad)}`, async () => fixture(async ({load, put, global}) => {
  await put(global, bad); assert.throws(load, /settings|profile|defaultProfile/i);
}));

test('oversize settings and malformed JSON are actionable, not defaults', async () => fixture(async ({load, global}) => {
  for (const data of ['{', ' '.repeat(65537)]) {
    await writeFile(global, data); assert.throws(load, /subagents.json.*Fix settings and \/reload/);
  }
}));

test('explicit thinking > explicit model suffix > profile thinking; model and thinking inherit independently', async () => fixture(async ({load, ctx, cwd, put, global}) => {
  await put(global, {profiles: {parent: {model: 'inherit', thinking: 'inherit'}, medium: {model: 'inherit', thinking: 'medium'}}});
  const config = load();
  const selection = (input: any) => resolveProfile({task: 'work', cwd, ...input}, config, ctx);
  assert.equal(selection({}).thinking, 'medium');
  assert.equal(selection({model: 'test/fixture:high'}).thinking, 'high');
  assert.equal(selection({model: 'test/fixture:high', thinking: 'off'}).thinking, 'off');
  assert.equal(selection({model: 'test/fixture'}).thinking, 'medium');
  assert.equal(selection({model: 'inherit'}).thinking, 'medium');
  assert.equal(selection({profile: 'parent'}).thinking, 'low');
  assert.equal(selection({profile: 'parent'}).model, 'test/selected');
  assert.equal(selection({profile: 'medium'}).thinking, 'medium');
  assert.equal(selection({profile: 'parent', model: 'test/fixture'}).thinking, 'low');
  assert.equal(selection({profile: 'parent', model: 'test/fixture:high'}).thinking, 'high');
  ctx.model = undefined;
  assert.throws(() => selection({profile: 'parent'}), /parent model.*required/);
  assert.equal(selection({}).model, 'openai-codex/gpt-6-astra');
}));

test('unknown profiles, malformed overrides and unavailable models cannot substitute a model', async () => fixture(async ({load, ctx, cwd}) => {
  for (const input of [{profile: 'missing'}, {profile: null}, {model: null}, {model: '--bad'}, {thinking: null}, {thinking: 'inherit'}]) {
    assert.throws(() => resolveProfile({task: 'work', cwd, ...input} as any, load(), ctx));
  }
  assert.throws(() => resolveProfile({task: 'work', cwd, model: 'test/missing'}, load(), ctx), /unavailable.*models.json.*No fallback/);
  ctx.modelRegistry.getAvailable = () => [];
  assert.throws(() => resolveProfile({task: 'work', cwd}, load(), ctx), /unavailable/);
  assert.throws(() => assertTaskFields({task: 'work', configProvenance: {model: 'forged'}}), /unknown field/);
}));

test('fast aliases use their registered base; capability clamping is visible', async () => fixture(async ({load, ctx, cwd}) => {
  const task = resolveProfile({task: 'work', cwd, model: 'openai-codex/gpt-5.6-luna~fast:high'}, load(), ctx);
  assert.equal(task.model, 'openai-codex/gpt-5.6-luna'); assert.equal(task.thinking, 'high');
  ctx.modelRegistry.find = () => ({provider: 'test', id: 'fixture', reasoning: false});
  const clamped = resolveProfile({task: 'work', cwd, model: 'test/fixture'}, load(), ctx);
  assert.equal(clamped.thinking, 'off'); assert.match(clamped.configProvenance!.thinking, /clamped medium to off/);
}));

test('generated guidance uses effective custom descriptions and remappings, not hard-coded brands', async () => fixture(async ({load, put, global, ctx}) => {
  const defaults = profileGuidance(load(), ctx);
  assert.match(defaults, /Default profile \(used when profile is omitted\): implement \(openai-codex\/gpt-6-astra \/ medium\)/);
  assert.match(defaults, /Available subagent profiles/);
  assert.doesNotMatch(defaults, /Choose by uncertainty|Use low only/);
  await put(global, {defaultProfile: 'local', profiles: {local: {model: 'inherit', thinking: 'inherit', description: 'Local model', useWhen: 'Local work'}, implement: {model: 'test/fixture', thinking: 'high', useWhen: 'Uncertain implementation'}}});
  const guidance = profileGuidance(load(), ctx);
  assert.match(guidance, /Default profile \(used when profile is omitted\): local \(test\/selected \(inherit\) \/ low \(inherit\)\)/);
  assert.match(guidance, /implement: test\/fixture \/ high.*Uncertain implementation/);
}));

test('session trust is not transferred to a routed checkout', async () => fixture(async ({ctx, root, cwd}) => {
  assert.equal(profileLocation(ctx, cwd).trusted, true);
  assert.equal(profileLocation(ctx, root).trusted, false);
  ctx.isProjectTrusted = () => false;
  assert.equal(profileLocation(ctx, cwd).trusted, false);
}));

test('resolution uses real Pi ModelRegistry find/getAvailable snapshots and custom model IDs', async () => fixture(async ({cwd, agentDir, put, load}) => {
  const modelsPath = join(agentDir, 'models.json');
  await put(modelsPath, {providers: {'fixture-provider': {baseUrl: 'http://localhost:1', api: 'openai-completions', apiKey: 'synthetic', models: [{id: 'local:8b', reasoning: true}]}}});
  const runtime = await ModelRuntime.create({modelsPath, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false});
  const registry = new ModelRegistry(runtime);
  await registry.refresh({allowNetwork: false});
  const task = resolveProfile({task: 'work', cwd, model: 'fixture-provider/local:8b'}, load(), {modelRegistry: registry, model: undefined, thinkingLevel: 'low'});
  assert.equal(task.model, 'fixture-provider/local:8b'); assert.equal(task.thinking, 'medium');
  assert.throws(() => resolveProfile({task: 'work', cwd, model: 'fixture-provider/unknown'}, load(), {modelRegistry: registry, model: undefined, thinkingLevel: 'low'}), /unavailable/);
}));

test('symlinked or non-regular settings files are rejected rather than followed', async () => fixture(async ({load, global, root, put}) => {
  await put(join(root, 'real.json'), {profiles: {implement: {thinking: 'high'}}});
  await symlink(join(root, 'real.json'), global);
  assert.throws(load, /subagents\.json.*ELOOP.*Fix settings and \/reload/);
  await rm(global); await mkdir(global);
  assert.throws(load, /expected a regular file/);
}));
