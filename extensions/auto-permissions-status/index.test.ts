import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import statusExtension from './index.ts';
import { findConfigLoader, statusText, type PermissionConfig } from './adapter.ts';

const config: PermissionConfig = {
  enabled: true, reviewAllShell: true, rules: [{}],
  reviewer: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'low', prefilter: false },
};
const commands = (root: string): ReturnType<ExtensionAPI['getCommands']> => [{
  name: 'auto-permissions', source: 'extension',
  sourceInfo: { path: join(root, 'index.ts'), source: 'npm:@hank-warren/pi-auto-permissions@0.16.2', scope: 'user', origin: 'package' },
}];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-auto-status-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@hank-warren/pi-auto-permissions', version: '0.16.2', type: 'module' }));
  const file = join(root, 'config.json');
  // A synthetic versioned package, so tests never need an npm install or credentials.
  await writeFile(join(root, 'config.ts'), `import {readFileSync} from 'node:fs';
export function loadAutoPermissionsConfig() { return JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8')); }`);
  await writeFile(file, JSON.stringify(config));
  return { root, file, close: () => rm(root, { recursive: true, force: true }) };
}
function harness(list: ReturnType<ExtensionAPI['getCommands']> = []) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const statuses: (string | undefined)[] = [];
  let discoveryCount = 0;
  statusExtension({
    on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, hook),
    getCommands: () => { discoveryCount++; return list; },
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => {
    assert.equal(key, 'auto-permissions-status'); statuses.push(text);
  } } } as unknown as ExtensionContext;
  return { statuses, ctx, emit: (name: string, context = ctx) => handlers.get(name)!({}, context), discoveryCount: () => discoveryCount };
}

test('formats on/off, rules-only, empty rules, prefilter and active-model fallback', () => {
  assert.equal(statusText(config, undefined), 'Auto: on · Luna low');
  assert.equal(statusText({ ...config, enabled: false }, undefined), 'Auto: off');
  assert.equal(statusText({ ...config, reviewAllShell: false }, undefined), 'Auto: on · Luna low · rules only');
  assert.equal(statusText({ ...config, reviewAllShell: false, rules: [] }, undefined), 'Auto: on · no rules');
  assert.equal(statusText({ ...config, reviewer: { ...config.reviewer!, prefilter: true } }, undefined), 'Auto: on · Luna low · prefilter minimal');
  assert.equal(statusText({ ...config, reviewer: undefined }, { provider: 'test', id: 'model' } as ExtensionContext['model']), 'Auto: on · model low');
  assert.equal(statusText({ ...config, reviewer: { ...config.reviewer!, model: '\u001b[31m\nBad\u202e' } }, undefined), 'Auto: on · ??31m?Bad? low');
});

test('requires loaded command provenance and the supported package version', async () => {
  const f = await fixture();
  try {
    assert.equal(await findConfigLoader([]), undefined);
    assert.deepEqual((await findConfigLoader(commands(f.root)))!(), config);
    const suffixed = commands(f.root); suffixed[0].name += ':2';
    assert.ok(await findConfigLoader(suffixed));
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@ogulcancelik/pi-auto-permissions', version: '0.16.2' }));
    assert.equal(await findConfigLoader(commands(f.root)), undefined);
    await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: '@hank-warren/pi-auto-permissions', version: '99.0.0' }));
    await assert.rejects(findConfigLoader(commands(f.root)), /Unsupported/);
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
