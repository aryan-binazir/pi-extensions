import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import statusExtension from './index.ts';
import { findConfigLoader, statusText, type PermissionConfig } from './adapter.ts';

const config: PermissionConfig = {
  enabled: true, reviewAllShell: true, rules: [{}],
  reviewer: { provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'low' },
};
const legacyConfig: PermissionConfig = {
  ...config, reviewer: { ...config.reviewer!, model: 'gpt-5.6-luna', prefilter: false },
};
const commands = (root: string, version = '0.21.0'): ReturnType<ExtensionAPI['getCommands']> => [{
  name: 'auto-permissions', source: 'extension',
  sourceInfo: { path: join(root, 'index.ts'), source: `npm:@hank-warren/pi-auto-permissions@${version}`, scope: 'user', origin: 'package' },
}];
async function fixture(version = '0.21.0', fixtureConfig = config) {
  const root = await mkdtemp(join(tmpdir(), 'pi-auto-status-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@hank-warren/pi-auto-permissions', version, type: 'module' }));
  const file = join(root, 'config.json');
  await writeFile(join(root, 'config.ts'), `import {readFileSync} from 'node:fs';
export function loadAutoPermissionsConfig() { return JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8')); }`);
  await writeFile(file, JSON.stringify(fixtureConfig));
  return { root, file, close: () => rm(root, { recursive: true, force: true }) };
}
function harness(list: ReturnType<ExtensionAPI['getCommands']> = [], exec?: ExtensionAPI['exec']) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const statuses: (string | undefined)[] = [];
  let discoveryCount = 0;
  statusExtension({
    on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, hook),
    getCommands: () => { discoveryCount++; return list; },
    exec,
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => {
    assert.equal(key, 'auto-permissions-status'); statuses.push(text);
  } } } as unknown as ExtensionContext;
  return { statuses, ctx, emit: (name: string, context = ctx, event: object = {}) => handlers.get(name)!(event, context), discoveryCount: () => discoveryCount };
}

test('formats on/off, rules-only, empty rules, prefilter and active-model fallback', () => {
  assert.equal(statusText(config, undefined), 'Auto: on · Luna low');
  assert.equal(statusText(legacyConfig, undefined), 'Auto: on · Luna low');
  assert.equal(statusText({ ...config, reviewer: { ...config.reviewer!, provider: 'other' } }, undefined), 'Auto: on · gpt-6-luna low');
  assert.equal(statusText({ ...config, enabled: false }, undefined), 'Auto: off');
  assert.equal(statusText({ ...config, reviewAllShell: false }, undefined), 'Auto: on · Luna low · rules only');
  assert.equal(statusText({ ...config, reviewAllShell: false, rules: [] }, undefined), 'Auto: on · no rules');
  assert.equal(statusText({ ...legacyConfig, reviewer: { ...legacyConfig.reviewer!, prefilter: true } }, undefined), 'Auto: on · Luna low · prefilter minimal');
  assert.equal(statusText({ ...config, reviewer: undefined }, { provider: 'test', id: 'model' } as ExtensionContext['model']), 'Auto: on · model low');
  assert.equal(statusText({ ...config, reviewer: { ...config.reviewer!, model: '\u001b[31m\nBad\u202e' } }, undefined), 'Auto: on · ??31m?Bad? low');
});

test('requires loaded command provenance and a supported package version', async () => {
  const f = await fixture();
  try {
    assert.equal(await findConfigLoader([]), undefined);
    const loaded = (await findConfigLoader(commands(f.root)))!();
    assert.deepEqual(loaded, config);
    assert.equal(loaded.reviewer?.prefilter, undefined);
    const suffixed = commands(f.root); suffixed[0].name += ':2';
    assert.ok(await findConfigLoader(suffixed));
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@ogulcancelik/pi-auto-permissions', version: '0.21.0' }));
    assert.equal(await findConfigLoader(commands(f.root)), undefined);
    for (const version of ['0.20.0', '0.21.1', '99.0.0']) {
      await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@hank-warren/pi-auto-permissions', version }));
      await assert.rejects(findConfigLoader(commands(f.root)), /Unsupported/);
    }
  } finally { await f.close(); }
});

test('retains discovery of the reviewed legacy package and its prefilter status', async () => {
  const f = await fixture('0.16.2', legacyConfig);
  try {
    const loaded = (await findConfigLoader(commands(f.root, '0.16.2')))!();
    assert.deepEqual(loaded, legacyConfig);
    assert.equal(statusText(loaded, undefined), 'Auto: on · Luna low');
    await writeFile(f.file, JSON.stringify({ ...legacyConfig, reviewer: { ...legacyConfig.reviewer!, prefilter: true } }));
    assert.equal(statusText((await findConfigLoader(commands(f.root, '0.16.2')))!(), undefined), 'Auto: on · Luna low · prefilter minimal');
  } finally { await f.close(); }
});

test('refreshes idle edits, recovers from config errors, deduplicates and cleans up timers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(); const h = harness(commands(f.root));
  try {
    assert.deepEqual(h.statuses, [], 'factory starts no UI or background work');
    await h.emit('session_start');
    assert.equal(h.statuses.at(-1), 'Auto: on · Luna low');
    const count = h.statuses.length;
    t.mock.timers.tick(2000);
    assert.equal(h.statuses.length, count, 'unchanged state does not repaint');
    await writeFile(f.file, JSON.stringify({ ...config, enabled: false }));
    t.mock.timers.tick(1000);
    assert.equal(h.statuses.at(-1), 'Auto: off');
    await writeFile(f.file, '{'); t.mock.timers.tick(1000);
    assert.equal(h.statuses.at(-1), 'Auto: config error');
    await writeFile(f.file, JSON.stringify(config)); t.mock.timers.tick(1000);
    assert.equal(h.statuses.at(-1), 'Auto: on · Luna low');
    await h.emit('session_start');
    await h.emit('session_shutdown');
    const stopped = h.statuses.length;
    assert.equal(h.statuses.at(-1), undefined);
    t.mock.timers.tick(5000);
    assert.equal(h.statuses.length, stopped, 'no stale timer after restart/shutdown');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('unavailable is visible; headless mode performs no discovery or polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  await h.emit('session_start');
  assert.equal(h.statuses.at(-1), 'Auto: unavailable');
  await h.emit('session_shutdown');
  const count = h.statuses.length, discoveries = h.discoveryCount();
  await h.emit('session_start', { ...h.ctx, hasUI: false });
  t.mock.timers.tick(10000);
  assert.equal(h.statuses.length, count);
  assert.equal(h.discoveryCount(), discoveries);
});

test('real Pi loader discovers command provenance and dynamically loads the optional config adapter', async () => {
  const f = await fixture();
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let stop: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(f.root, 'index.ts'), `export default function(pi) {
      pi.registerCommand('auto-permissions', {description: 'Synthetic settings', handler: async () => {}});
    }`);
    const path = fileURLToPath(new URL('./index.ts', import.meta.url));
    const settingsManager = SettingsManager.inMemory({ extensions: [path, join(f.root, 'index.ts')] });
    const resourceLoader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, settingsManager,
      noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const modelRuntime = await ModelRuntime.create({ authPath: join(f.root, 'auth.json'), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false });
    ({ session } = await createAgentSession({ cwd: f.root, agentDir: f.root, settingsManager,
      resourceLoader, sessionManager: SessionManager.inMemory(f.root), modelRuntime }));
    await session.bindExtensions({});
    const extension = loaded.extensions.find(entry => entry.path === path)!;
    const statuses: (string | undefined)[] = [];
    const ctx = { ...session.extensionRunner!.createContext(), hasUI: true,
      ui: { ...session.extensionRunner!.createContext().ui, setStatus: (_key: string, value: string | undefined) => statuses.push(value) } };
    stop = async () => { for (const hook of extension.handlers.get('session_shutdown') ?? []) await hook({type: 'session_shutdown', reason: 'quit'}, ctx); };
    for (const hook of extension.handlers.get('session_start') ?? []) await hook({type: 'session_start', reason: 'startup'}, ctx);
    assert.equal(statuses.at(-1), 'Auto: on · Luna low');
    await stop();
    stop = undefined;
    assert.equal(statuses.at(-1), undefined);
  } finally { await stop?.(); session?.dispose(); await f.close(); }
});

test('TUI installs and restores the compact footer; RPC retains its status API', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  const footers: unknown[] = [];
  const ctx = { ...h.ctx, mode: 'tui' as const, ui: { ...h.ctx.ui, setFooter: (factory: unknown) => { footers.push(factory); } } };
  await h.emit('session_start', ctx);
  assert.equal(typeof footers[0], 'function');
  assert.equal(h.statuses.at(-1), 'Auto: unavailable');
  await h.emit('session_shutdown', ctx);
  assert.equal(footers.at(-1), undefined);
  const count = footers.length;
  await h.emit('session_start', { ...ctx, mode: 'rpc' });
  assert.equal(footers.length, count, 'RPC must not install a TUI footer');
  await h.emit('session_shutdown');
});

test('the TUI footer links the branch PR and asks gh again after each turn and each git or gh Bash call', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const asked: string[][] = [];
  const exec: ExtensionAPI['exec'] = async (_command, args) => {
    asked.push(args);
    return { stdout: JSON.stringify({ number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN', isDraft: false }), stderr: '', code: 0, killed: false };
  };
  const h = harness([], exec);
  let factory: Parameters<ExtensionContext['ui']['setFooter']>[0];
  const ctx = { ...h.ctx, mode: 'tui' as const, model: undefined, getContextUsage: () => undefined, modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getCwd: () => '/workspace/repo', getSessionName: () => undefined, getSessionId: () => 'session', getLeafId: () => null, getEntries: () => [] },
    ui: { ...h.ctx.ui, setFooter: (next: typeof factory) => { factory = next; } } } as unknown as ExtensionContext;
  await h.emit('session_start', ctx);
  let renders = 0;
  const data = { getGitBranch: () => 'feature', getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
  const footer = factory!({ requestRender: () => { renders++; } } as never, { fg: (_color: string, text: string) => text } as never, data);
  footer.render(120);
  await new Promise(setImmediate);
  assert.equal(renders, 1);
  assert.match(stripVTControlCharacters(footer.render(120)[0]), /^\/workspace\/repo \(feature\) #42\s+Auto: unavailable$/);
  const bash = (command: string) => h.emit('tool_result', ctx, { type: 'tool_result', toolName: 'bash', input: { command } });
  await h.emit('agent_end', ctx);
  assert.equal(asked.length, 2);
  for (const command of ['git switch -c next', 'gh pr create --draft', 'cd sub && git push']) await bash(command);
  assert.equal(asked.length, 5);
  for (const command of ['ls .github', 'echo digit', 'rg legit']) await bash(command);
  await h.emit('tool_result', ctx, { type: 'tool_result', toolName: 'read', input: { path: 'git' } });
  assert.equal(asked.length, 5, 'unrelated tool calls ask nothing');
  await h.emit('session_shutdown', ctx);
  await h.emit('agent_end', ctx);
  await bash('git status');
  assert.equal(asked.length, 5, 'a stopped session asks nothing');
  footer.dispose?.();
});

test('shutdown during async discovery prevents late status and timers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(); const h = harness(commands(f.root));
  try {
    const starting = h.emit('session_start');
    await h.emit('session_shutdown');
    const count = h.statuses.length;
    await starting;
    t.mock.timers.tick(5000);
    assert.equal(h.statuses.length, count);
    assert.equal(h.statuses.at(-1), undefined);
  } finally { await f.close(); }
});
