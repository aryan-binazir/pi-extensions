import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rename, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventBus, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { withPi } from '../../tests/pi-session.ts';
import statusExtension from './index.ts';
import { findConfigLoader } from './adapter.ts';
import { GUARDIAN_ENABLED_EVENT } from '../guardian/config.ts';
import { detectPlatformSandbox } from '../guardian/sandbox.ts';

const GUARDIAN_INDEX = fileURLToPath(new URL('../guardian/index.ts', import.meta.url));
const guardian = (path = GUARDIAN_INDEX): ReturnType<ExtensionAPI['getCommands']> => [{ name: 'guardian', source: 'extension',
  sourceInfo: { path, source: 'local', scope: 'user', origin: 'top-level' } }];
const off = { enabled: false };

/** A temporary agent directory holding Guardian's config; `on` is the status its defaults render on this machine. */
async function fixture(t: TestContext, initial?: object) {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-guardian-status-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  });
  const file = join(agentDir, 'guardian', 'config.json');
  await mkdir(dirname(file));
  if (initial) await writeFile(file, JSON.stringify(initial));
  const on = `Auto: on · Luna low${(await detectPlatformSandbox()).sandbox ? '' : ' · no sandbox'}`;
  return { agentDir, file, on };
}
function harness(list: ReturnType<ExtensionAPI['getCommands']> = [], exec?: ExtensionAPI['exec']) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const statuses: (string | undefined)[] = [];
  let discoveryCount = 0;
  const events = createEventBus();
  statusExtension({
    on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, hook),
    getCommands: () => { discoveryCount++; return list; },
    exec, events,
  } as unknown as ExtensionAPI);
  const ctx = { hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => {
    assert.equal(key, 'auto-permissions-status'); statuses.push(text);
  } } } as unknown as ExtensionContext;
  return { statuses, ctx, events, emit: (name: string, context = ctx, event: object = {}) => handlers.get(name)!(event, context), discoveryCount: () => discoveryCount };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'footer update within one second');
    await delay(5);
  }
}

test('discovers only the Guardian this package loaded and renders its config', async t => {
  const f = await fixture(t);
  assert.equal(await findConfigLoader([]), undefined);
  const loader = (await findConfigLoader(guardian()))!;
  assert.equal(loader.path, f.file);
  assert.equal(loader.status(loader.load()), f.on, 'a missing config means the defaults');
  await writeFile(loader.path, JSON.stringify({ reviewer: { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' } }));
  assert.equal(loader.status(loader.load()), f.on.replace('Luna low', 'Opus high'));
  assert.equal(loader.status(loader.load(), false), 'Auto: off');
  const suffixed = guardian(); suffixed[0].name += ':2';
  assert.ok(await findConfigLoader(suffixed));
  assert.equal(await findConfigLoader(guardian('/elsewhere/guardian/index.ts')), undefined);
});

test('the Guardian indicator follows /guardian on and off for this session until shutdown', async t => {
  const f = await fixture(t, off);
  const h = harness(guardian());
  await h.emit('session_start');
  await until(() => h.statuses.at(-1) === 'Auto: off');
  h.events.emit(GUARDIAN_ENABLED_EVENT, { enabled: true });
  assert.equal(h.statuses.at(-1), f.on);
  h.events.emit(GUARDIAN_ENABLED_EVENT, { enabled: false });
  assert.equal(h.statuses.at(-1), 'Auto: off');
  await h.emit('session_shutdown');
  const stopped = h.statuses.length;
  h.events.emit(GUARDIAN_ENABLED_EVENT, { enabled: true });
  assert.equal(h.statuses.length, stopped, 'a stopped footer no longer listens');
});

test('discovery leaves startup immediately and watches atomic idle config edits without polling', async t => {
  const interval = t.mock.method(globalThis, 'setInterval');
  const f = await fixture(t, {}); const h = harness(guardian());
  try {
    assert.deepEqual(h.statuses, [], 'factory starts no UI or background work');
    assert.equal(h.emit('session_start'), undefined, 'Pi must not await config discovery');
    await until(() => h.statuses.at(-1) === f.on);
    const count = h.statuses.length;
    await delay(30);
    assert.equal(h.statuses.length, count, 'unchanged state does not repaint');
    await writeFile(f.file + '.tmp', JSON.stringify(off));
    await rename(f.file + '.tmp', f.file);
    await until(() => h.statuses.at(-1) === 'Auto: off');
    await writeFile(f.file, '{');
    await until(() => h.statuses.at(-1) === 'Auto: config error');
    await writeFile(f.file, '{}');
    await until(() => h.statuses.at(-1) === f.on);
    assert.equal(interval.mock.callCount(), 0, 'the watcher has no polling timer');
    await h.emit('session_shutdown');
    const stopped = h.statuses.length;
    await writeFile(f.file, JSON.stringify(off));
    await delay(30);
    assert.equal(h.statuses.length, stopped, 'no stale watcher after shutdown');
  } finally { await h.emit('session_shutdown'); }
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

test('real Pi loader discovers Guardian by command provenance and dynamically loads its config', async () => {
  const footer = fileURLToPath(new URL('./index.ts', import.meta.url));
  const statuses: (string | undefined)[] = [];
  const on = `Auto: on · Luna low${(await detectPlatformSandbox()).sandbox ? '' : ' · no sandbox'}`;
  await withPi({ settings: { extensions: [footer, GUARDIAN_INDEX] },
    bind: session => ({ mode: 'rpc', uiContext: { ...session.extensionRunner.createContext().ui, setStatus: (_key, value) => statuses.push(value) } }),
  }, async ({ runtime }) => {
    const loaded = runtime.services.resourceLoader.getExtensions();
    assert.ok(loaded.extensions.find(entry => entry.path === footer));
    await until(() => statuses.at(-1) === on);
  });
  assert.equal(statuses.at(-1), undefined);
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
  await fixture(t, {});
  // A command without source info makes discovery throw.
  const list = fails ? [{ name: 'guardian', source: 'extension' }] as ReturnType<ExtensionAPI['getCommands']> : guardian();
  const h = harness(list);
  const watcher = t.mock.method(fs, 'watch'); syncBuiltinESMExports();
  t.after(() => { watcher.mock.restore(); syncBuiltinESMExports(); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    h.emit('session_start');
    t.mock.timers.tick(0);
    assert.equal(h.discoveryCount(), 1, 'discovery is pending');
    list.length = 0;
    h.emit('session_start');
    t.mock.timers.tick(0);
    assert.equal(h.discoveryCount(), 2);
    for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    assert.equal(h.statuses.at(-1), 'Auto: unavailable');
    assert.equal(watcher.mock.callCount(), 0, 'stale discovery must not install a watcher');
  } finally {
    await h.emit('session_shutdown');
    // Restore real timers before cleanup re-syncs builtin exports, or later tests keep the mocked timers/promises.
    t.mock.timers.reset();
  }
});

test('an atomically replaced config directory is watched again while idle', async t => {
  const f = await fixture(t, {}), h = harness(guardian());
  try {
    h.emit('session_start');
    await until(() => h.statuses.at(-1) === f.on);
    await rm(dirname(f.file), { recursive: true });
    await delay(100);
    await mkdir(dirname(f.file));
    await writeFile(f.file, JSON.stringify(off));
    await until(() => h.statuses.at(-1) === 'Auto: off');
    await writeFile(f.file, '{}');
    await until(() => h.statuses.at(-1) === f.on);
  } finally { await h.emit('session_shutdown'); }
});

test('config symlinks observe target edits and atomic retargeting while idle', async t => {
  const f = await fixture(t, {}), h = harness(guardian());
  const target = join(f.agentDir, 'target', 'config.json'), other = join(f.agentDir, 'other', 'config.json');
  try {
    await mkdir(dirname(target)); await mkdir(dirname(other));
    await rename(f.file, target); await symlink(target, f.file);
    h.emit('session_start');
    await until(() => h.statuses.at(-1) === f.on);
    await writeFile(target, JSON.stringify(off));
    await until(() => h.statuses.at(-1) === 'Auto: off');
    await writeFile(other, '{}');
    await symlink(other, f.file + '.next'); await rename(f.file + '.next', f.file);
    await until(() => h.statuses.at(-1) === f.on);
    await writeFile(other, JSON.stringify(off));
    await until(() => h.statuses.at(-1) === 'Auto: off');
  } finally { await h.emit('session_shutdown'); }
});
