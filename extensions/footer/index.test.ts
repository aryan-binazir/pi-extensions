import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPi } from '../../tests/pi-session.ts';
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
  const file = join(root, 'settings', 'config.json');
  await mkdir(dirname(file));
  await writeFile(join(root, 'config.ts'), `import {readFileSync} from 'node:fs';
export function autoPermissionsConfigPath() { return ${JSON.stringify(file)}; }
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

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'footer update within one second');
    await delay(5);
  }
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
    const loaded = (await findConfigLoader(commands(f.root)))!.load();
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
    const loaded = (await findConfigLoader(commands(f.root, '0.16.2')))!.load();
    assert.deepEqual(loaded, legacyConfig);
    assert.equal(statusText(loaded, undefined), 'Auto: on · Luna low');
    await writeFile(f.file, JSON.stringify({ ...legacyConfig, reviewer: { ...legacyConfig.reviewer!, prefilter: true } }));
    assert.equal(statusText((await findConfigLoader(commands(f.root, '0.16.2')))!.load(), undefined), 'Auto: on · Luna low · prefilter minimal');
  } finally { await f.close(); }
});

test('discovery leaves startup immediately and watches atomic idle config edits without polling', async t => {
  const interval = t.mock.method(globalThis, 'setInterval');
  const f = await fixture(); const h = harness(commands(f.root));
  try {
    assert.deepEqual(h.statuses, [], 'factory starts no UI or background work');
    assert.equal(h.emit('session_start'), undefined, 'Pi must not await config discovery');
    await until(() => h.statuses.at(-1) === 'Auto: on · Luna low');
    const count = h.statuses.length;
    await delay(30);
    assert.equal(h.statuses.length, count, 'unchanged state does not repaint');
    await writeFile(f.file + '.tmp', JSON.stringify({ ...config, enabled: false }));
    await rename(f.file + '.tmp', f.file);
    await until(() => h.statuses.at(-1) === 'Auto: off');
    await writeFile(f.file, '{');
    await until(() => h.statuses.at(-1) === 'Auto: config error');
    await writeFile(f.file, JSON.stringify(config));
    await until(() => h.statuses.at(-1) === 'Auto: on · Luna low');
    assert.equal(interval.mock.callCount(), 0, 'the watcher has no polling timer');
    await h.emit('session_shutdown');
    const stopped = h.statuses.length;
    await writeFile(f.file, JSON.stringify({ ...config, enabled: false }));
    await delay(30);
    assert.equal(h.statuses.length, stopped, 'no stale watcher after shutdown');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('model and turn events recompute cached config labels for the active model', async () => {
  const f = await fixture('0.21.0', { ...config, reviewer: undefined });
  const h = harness(commands(f.root));
  try {
    await h.emit('session_start');
    await until(() => h.statuses.at(-1) === 'Auto: on · no?model low');
    const model = (id: string) => ({ ...h.ctx, model: { provider: 'test', id } } as ExtensionContext);
    await h.emit('model_select', model('first'));
    assert.equal(h.statuses.at(-1), 'Auto: on · first low');
    await h.emit('agent_start', model('second'));
    assert.equal(h.statuses.at(-1), 'Auto: on · second low');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('unavailable settles without any timer or watcher; headless mode never discovers', async t => {
  const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
  const watcher = t.mock.method(fs, 'watch'); syncBuiltinESMExports();
  t.after(() => { watcher.mock.restore(); syncBuiltinESMExports(); });
  const h = harness();
  await h.emit('session_start');
  await until(() => h.discoveryCount() === 1);
  await new Promise(setImmediate);
  assert.equal(h.statuses.at(-1), 'Auto: unavailable');
  assert.equal(timeout.mock.callCount(), 1, 'only the completed discovery timeout was scheduled');
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(watcher.mock.callCount(), 0);
  await delay(30);
  assert.equal(timeout.mock.callCount(), 1, 'no timeout polling after discovery settles');
  await h.emit('session_shutdown');
  const count = h.statuses.length, discoveries = h.discoveryCount();
  await h.emit('session_start', { ...h.ctx, hasUI: false });
  await delay(30);
  assert.equal(h.statuses.length, count);
  assert.equal(h.discoveryCount(), discoveries, 'flush the deferred startup before checking');
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(watcher.mock.callCount(), 0);
});

test('real Pi loader discovers command provenance and dynamically loads the optional config adapter', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'index.ts'), `export default function(pi) {
      pi.registerCommand('auto-permissions', {description: 'Synthetic settings', handler: async () => {}});
    }`);
    const path = fileURLToPath(new URL('./index.ts', import.meta.url));
    const statuses: (string | undefined)[] = [];
    await withPi({ cwd: f.root, settings: { extensions: [path, join(f.root, 'index.ts')] },
      bind: session => ({ mode: 'rpc', uiContext: { ...session.extensionRunner.createContext().ui, setStatus: (_key, value) => statuses.push(value) } }),
    }, async ({ runtime }) => {
      const loaded = runtime.services.resourceLoader.getExtensions();
      assert.ok(loaded.extensions.find(entry => entry.path === path));
      await until(() => statuses.at(-1) === 'Auto: on · Luna low');
    });
    assert.equal(statuses.at(-1), undefined);
  } finally { await f.close(); }
});

test('TUI installs and restores the compact footer; RPC retains its status API', async () => {
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

test('the TUI footer schedules PR lookups, coalesces mutations and throttles turns', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const asked: string[][] = [];
  const exec: ExtensionAPI['exec'] = async (_command, args) => {
    asked.push(args);
    return { stdout: JSON.stringify({ number: 42, url: 'https://github.com/owner/repo/pull/42', state: 'OPEN', isDraft: false, headRefName: 'feature' }), stderr: '', code: 0, killed: false };
  };
  const h = harness([], exec);
  let factory: Parameters<ExtensionContext['ui']['setFooter']>[0];
  const ctx = { ...h.ctx, mode: 'tui' as const, model: undefined, getContextUsage: () => undefined, modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getCwd: () => '/workspace/event-test', getSessionName: () => undefined, getSessionId: () => 'session', getLeafId: () => null, getEntries: () => [] },
    ui: { ...h.ctx.ui, setFooter: (next: typeof factory) => { factory = next; } } } as unknown as ExtensionContext;
  await h.emit('session_start', ctx);
  let renders = 0;
  const data = { getGitBranch: () => 'feature', getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };
  const footer = factory!({ requestRender: () => { renders++; } } as never, { fg: (_color: string, text: string) => text } as never, data);
  footer.render(120);
  assert.equal(asked.length, 0, 'render cannot spawn gh');
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 1);
  assert.equal(renders, 1);
  assert.match(stripVTControlCharacters(footer.render(120)[0]), /\(feature\) #42\s+Auto: unavailable$/);
  const bash = (command: string) => h.emit('tool_result', ctx, { type: 'tool_result', toolName: 'bash', input: { command } });
  await h.emit('agent_end', ctx);
  for (const command of ['git status', 'git diff', 'git log', 'echo git push', 'echo "gh pr create"', 'git -c alias.x=push status', '# git push\ngit status']) await bash(command);
  t.mock.timers.tick(2000); await new Promise(setImmediate);
  assert.equal(asked.length, 1, 'read-only git commands and command text ask nothing');
  await bash('git push');
  t.mock.timers.tick(1000);
  await bash('gh pr create --draft');
  await h.emit('agent_end', ctx);
  t.mock.timers.tick(1499);
  assert.equal(asked.length, 1);
  t.mock.timers.tick(1); await new Promise(setImmediate);
  assert.equal(asked.length, 2, 'mutation bursts and their agent_end coalesce');
  await bash('gh pr create --draft');
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 3, 'gh pr create refreshes on its own');
  await h.emit('agent_end', ctx);
  t.mock.timers.tick(59000); await new Promise(setImmediate);
  assert.equal(asked.length, 3, 'no periodic background lookup');
  await h.emit('agent_end', ctx);
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 3, 'fresh completed lookup throttles turns');
  await h.emit('agent_end', ctx);
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 4, 'an old completed lookup refreshes on the next turn end');
  footer.dispose?.();
  await h.emit('session_shutdown', ctx);
  await h.emit('session_start', ctx);
  const next = factory!({ requestRender: () => {} } as never, { fg: (_color: string, text: string) => text } as never, data);
  assert.match(stripVTControlCharacters(next.render(120)[0]), /#42/);
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 4, 'session_start reuses process PR state');
  next.dispose?.(); await h.emit('session_shutdown', ctx);
  const reloaded = harness([], exec);
  await reloaded.emit('session_start', ctx);
  const latest = factory!({ requestRender: () => {} } as never, { fg: (_color: string, text: string) => text } as never, data);
  assert.match(stripVTControlCharacters(latest.render(120)[0]), /#42/);
  t.mock.timers.tick(1500); await new Promise(setImmediate);
  assert.equal(asked.length, 4, 'a newly registered extension reuses process PR state');
  latest.dispose?.(); await reloaded.emit('session_shutdown', ctx);
});

test('mutation command words handle quoting, assignments, global flags and command chains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const { changesPullRequest } = await import('./pull-request.ts');
  for (const command of [
    'git push', 'git pull', 'git switch main', 'git checkout main', 'git merge topic', 'git rebase main', 'git reset --hard', 'git branch topic',
    'gh pr create --draft', 'gh -R owner/repo pr view', 'gh --repo=owner/repo pr merge',
    'cd sub && FOO=bar /usr/bin/git -C "folder with space" -c key=value push',
    'command git --no-pager push', 'env FLAG=value git pull', "'git' 'push'", 'git status; gh pr create --draft',
  ]) assert.equal(changesPullRequest(command), true, command);
  for (const command of ['git status', 'git diff', 'git log', 'git -c x=push status', 'echo "git push"', "printf '%s' 'gh pr create'", 'ls .github', 'echo digit', 'rg legit', '# git push']) {
    assert.equal(changesPullRequest(command), false, command);
  }
});

for (const fails of [false, true]) test(`late ${fails ? 'failed' : 'successful'} config discovery cannot attach to a replacement session`, async t => {
  const f = await fixture(), list = commands(f.root), h = harness(list);
  const watcher = t.mock.method(fs, 'watch'); syncBuiltinESMExports();
  t.after(() => { watcher.mock.restore(); syncBuiltinESMExports(); });
  try {
    const module = join(f.root, 'config.ts');
    await writeFile(module, `await new Promise(resolve => setTimeout(resolve, 50));
${fails ? "throw new Error('synthetic discovery failure');" : ''}
` + await readFile(module, 'utf8'));
    h.emit('session_start');
    await until(() => h.discoveryCount() === 1);
    list.length = 0;
    h.emit('session_start');
    await until(() => h.discoveryCount() === 2);
    await delay(150);
    assert.equal(h.statuses.at(-1), 'Auto: unavailable');
    assert.equal(watcher.mock.callCount(), 0, 'stale discovery must not install a watcher');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('an atomically replaced config directory is watched again while idle', async () => {
  const f = await fixture(), h = harness(commands(f.root));
  try {
    h.emit('session_start');
    await until(() => h.statuses.at(-1) === 'Auto: on · Luna low');
    await rm(dirname(f.file), { recursive: true });
    await delay(100);
    await mkdir(dirname(f.file));
    await writeFile(f.file, JSON.stringify({ ...config, enabled: false }));
    await until(() => h.statuses.at(-1) === 'Auto: off');
    await writeFile(f.file, JSON.stringify(config));
    await until(() => h.statuses.at(-1) === 'Auto: on · Luna low');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});
