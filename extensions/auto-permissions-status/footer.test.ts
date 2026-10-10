import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRuntime, ModelRegistry, SessionManager, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, type OAuthCredential } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { visibleWidth } from '@earendil-works/pi-tui';
import { permissionFooter, rightAligned, STATUS_KEY } from './footer.ts';

const theme = { fg: (_color: string, text: string) => text } as Theme;
const usage = { input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0, totalTokens: 2100,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
function fixture() {
  const statuses = new Map([[STATUS_KEY, 'Auto: on · Luna low']]);
  let branch = 'main', onChange = () => {}, renders = 0, disposals = 0;
  const data: ReadonlyFooterDataProvider = {
    getGitBranch: () => branch, getAvailableProviderCount: () => 1, getExtensionStatuses: () => statuses,
    onBranchChange: callback => { onChange = callback; return () => { disposals++; }; },
  };
  const ctx = {
    model: { id: 'main-model', provider: 'test', reasoning: true, contextWindow: 128000 }, thinkingLevel: 'medium',
    modelRegistry: { isUsingOAuth: () => false }, getContextUsage: () => ({ percent: 12.5, contextWindow: 128000 }),
    sessionManager: { getCwd: () => '/workspace/project', getSessionName: () => 'Task', getSessionId: () => 'session', getLeafId: () => 'leaf', getEntries: () => [
      { type: 'message', message: { role: 'assistant', usage } },
      { type: 'message', message: { role: 'toolResult', usage } },
      { type: 'compaction', usage }, { type: 'branch_summary', usage },
    ] },
  } as unknown as ExtensionContext;
  const footer = permissionFooter(() => ctx, theme, data, () => { renders++; });
  return { footer, statuses, ctx, changeBranch: () => { branch = 'feature'; onChange(); }, renders: () => renders, disposals: () => disposals };
}

test('right-aligns Auto on path row without adding height; retains usage/model and other statuses', () => {
  const f = fixture();
  const lines = f.footer.render(140);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\/workspace\/project \(main\) • Task\s+Auto: on · Luna low$/);
  assert.equal(visibleWidth(lines[0]), 140);
  assert.match(lines[1], /↑4.0k ↓400 R4.0k CH50.0% \$0.120 12.5%\/128k/);
  assert.match(lines[1], /main-model • medium$/);
  f.statuses.set(STATUS_KEY, 'Auto: off');
  assert.match(f.footer.render(140)[0], /Auto: off$/);
  f.statuses.set('tracker', 'tracker · working');
  const other = f.footer.render(140);
  assert.equal(other.length, 3);
  assert.equal(other[2], 'tracker · working');
  assert.equal(other.filter(line => line.includes('Auto:')).length, 1);
  f.changeBranch();
  assert.equal(f.renders(), 1);
  assert.match(f.footer.render(140)[0], /\(feature\)/);
  f.footer.dispose(); f.footer.dispose();
  assert.equal(f.disposals(), 1);
});

test('narrow layouts and ANSI/wide paths stay within terminal width without wrapping', () => {
  const f = fixture();
  for (let width = 0; width <= 120; width++) {
    const line = rightAligned('\u001b[31m/很長的路徑/🦀/project\u001b[0m', 'Auto: on · Luna low', width);
    assert.ok(visibleWidth(line) <= width, `alignment at ${width}`);
    const lines = f.footer.render(width);
    assert.equal(lines.length, 2);
    for (const rendered of lines) assert.ok(visibleWidth(rendered) <= width, `footer at ${width}`);
  }
  assert.match(f.footer.render(24)[0], /Auto: on · Luna low$/);
  f.footer.dispose();
});

test('missing status and unknown context remain explicit; terminal controls are stripped', () => {
  const f = fixture(); f.statuses.clear();
  f.ctx.getContextUsage = () => undefined;
  f.ctx.sessionManager.getCwd = () => '/path\n\u001b[2J\u202eevil';
  const lines = f.footer.render(140);
  assert.match(lines[0], /Auto: unavailable$/);
  assert.doesNotMatch(lines.join(''), /[\n\u001b\u202e]/);
  assert.match(lines[1], /\?\/128k/);
  f.footer.dispose();
});

test('memoised rows still follow width, cwd and empty-status changes', () => {
  const f = fixture();
  const wide = f.footer.render(140);
  assert.equal(visibleWidth(f.footer.render(80)[0]), 80);
  assert.deepEqual(f.footer.render(140), wide);
  f.ctx.sessionManager.getCwd = () => '/workspace/other';
  assert.match(f.footer.render(140)[0], /^\/workspace\/other \(main\)/);
  f.statuses.set('tracker', '');
  const blank = f.footer.render(140);
  assert.equal(blank.length, 3);
  assert.equal(blank[2], '');
  f.statuses.delete('tracker');
  assert.equal(f.footer.render(140).length, 2);
  f.footer.dispose();
});

test('subscription labels require explicit provider metadata and OAuth, except for Kimi', async t => {
  for (const scenario of [
    { name: 'metered OAuth', providerId: 'footer-billing-test', isSubscription: false, oauth: true, subscription: false },
    { name: 'OAuth without subscription metadata', providerId: 'footer-billing-test', isSubscription: undefined, oauth: true, subscription: false },
    { name: 'subscription OAuth', providerId: 'footer-billing-test', isSubscription: true, oauth: true, subscription: true },
    { name: 'subscription provider using an API key', providerId: 'footer-billing-test', isSubscription: true, oauth: false, subscription: false },
    { name: 'Kimi using an API key', providerId: 'kimi-coding', isSubscription: false, oauth: false, subscription: true },
  ]) await t.test(scenario.name, async t => {
    const { providerId } = scenario;
    const credentials = new InMemoryCredentialStore();
    const oauthCredential: OAuthCredential = { type: 'oauth', access: 'synthetic-unused', refresh: 'synthetic-unused', expires: Date.now() + 3600000 };
    await credentials.modify(providerId, async () => scenario.oauth ? oauthCredential : { type: 'api_key', key: 'synthetic-unused' });
    const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false });
    const base = openaiProvider();
    const model = { ...base.getModels()[0], id: 'billing-model', provider: providerId };
    runtime.registerNativeProvider({ ...base, id: providerId, getModels: () => [model], auth: {
      apiKey: { name: 'Synthetic API key', resolve: async () => ({ auth: { apiKey: 'synthetic-unused' } }) },
      oauth: { name: 'Synthetic OAuth', ...(scenario.isSubscription === undefined ? {} : { isSubscription: scenario.isSubscription }),
        login: async () => { throw new Error('Unexpected login'); }, refresh: async () => { throw new Error('Unexpected token refresh'); }, toAuth: async () => ({ apiKey: 'synthetic-unused' }) },
    } });
    await runtime.refresh({ providers: [providerId], allowNetwork: false });
    const registry = new ModelRegistry(runtime);
    assert.equal(registry.isUsingOAuth(model), scenario.oauth);
    const manager = SessionManager.inMemory('/workspace/project');
    const f = fixture();
    t.after(() => f.footer.dispose());
    f.ctx.model = model;
    f.ctx.modelRegistry = registry;
    f.ctx.sessionManager = manager;
    const beforeUsage = f.footer.render(140)[1];
    if (scenario.subscription) assert.match(beforeUsage, /\$0\.000 \(sub\)/);
    else assert.doesNotMatch(beforeUsage, /\$|\(sub\)/);
    manager.appendMessage({ role: 'assistant', content: [], api: model.api, provider: providerId, model: model.id,
      usage, stopReason: 'stop', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [], api: model.api, provider: providerId, model: model.id,
      usage, stopReason: 'stop', timestamp: Date.now() });
    const afterUsage = f.footer.render(140)[1];
    assert.match(afterUsage, /\$0\.060/);
    if (scenario.subscription) assert.match(afterUsage, /\$0\.060 \(sub\)/);
    else assert.doesNotMatch(afterUsage, /\(sub\)/);
    if (scenario.oauth && scenario.subscription) {
      await credentials.modify(providerId, async () => ({ type: 'api_key', key: 'synthetic-unused' }));
      await runtime.refresh({ providers: [providerId], allowNetwork: false });
      assert.equal(registry.isUsingOAuth(model), false);
      assert.doesNotMatch(f.footer.render(140)[1], /\(sub\)/);
    }
    f.ctx.model = undefined;
    assert.match(f.footer.render(140)[1], /no-model$/);
    assert.doesNotMatch(f.footer.render(140)[1], /\(sub\)/);
  });
});

const assistant = (manager: SessionManager) => manager.appendMessage({ role: 'assistant', content: [], api: 'openai-responses',
  provider: 'test', model: 'main-model', usage, stopReason: 'stop', timestamp: Date.now() });

test('cache-warm usage entries count toward totals but not the cache-hit rate, like Pi', () => {
  const f = fixture(), manager = SessionManager.inMemory('/workspace/project');
  f.ctx.sessionManager = manager;
  assistant(manager);
  manager.appendUsage('cache_warm', 'test', 'main-model', { ...usage, input: 500, output: 50, cacheRead: 3000, cost: { ...usage.cost, total: 0.004 } });
  assert.match(f.footer.render(140)[1], /↑1.5k ↓150 R4.0k CH50.0% \$0.034 /);
  f.footer.dispose();
});

test('session stats are reused until the session, leaf, entry count or model changes', () => {
  const f = fixture(), manager = SessionManager.inMemory('/workspace/project');
  let scans = 0, estimates = 0;
  const getEntries = manager.getEntries.bind(manager);
  manager.getEntries = () => { scans++; return getEntries(); };
  f.ctx.sessionManager = manager;
  f.ctx.getContextUsage = () => { estimates++; return { tokens: 1280, percent: 1, contextWindow: f.ctx.model!.contextWindow }; };
  // Returns the stats row and how many session scans and context estimates the render made.
  const render = (width = 140) => {
    const before = [scans, estimates], line = f.footer.render(width)[1];
    return { line, work: [scans - before[0], estimates - before[1]] };
  };
  const first = assistant(manager);
  assert.deepEqual(render().work, [1, 1]);
  f.statuses.set('tracker', 'busy');
  for (const width of [140, 80, 140]) assert.deepEqual(render(width).work, [0, 0]);
  assert.match(render().line, /\$0.030 1.0%\/128k/);
  assistant(manager);
  assert.deepEqual(render().work, [1, 1]);
  assert.match(render().line, /\$0.060/);
  manager.branch(first);
  assert.deepEqual(render().work, [1, 1]);
  f.ctx.model = { ...f.ctx.model!, contextWindow: 200000 };
  assert.deepEqual(render().work, [1, 1]);
  assert.match(render().line, /1.0%\/200k/);
  assistant(manager); manager.branch(first);
  assert.deepEqual(render().work, [1, 1]);
  assert.match(render().line, /\$0.090/);
  manager.appendCompaction('summary', first, 5000, undefined, false, usage);
  assert.deepEqual(render().work, [1, 1]);
  assert.match(render().line, /\$0.120/);
  manager.newSession();
  assert.deepEqual(render().work, [1, 1]);
  assert.doesNotMatch(render().line, /\$/);
  f.footer.invalidate();
  assert.deepEqual(render().work, [1, 1]);
  assert.deepEqual(render().work, [0, 0]);
  f.footer.dispose();
});

test('stats follow the entry list length when getEntryCount is unavailable', () => {
  const f = fixture(), entries = f.ctx.sessionManager.getEntries();
  f.ctx.sessionManager.getEntries = () => [...entries];
  assert.match(f.footer.render(140)[1], /\$0.120/);
  entries.push({ type: 'usage', usage } as never);
  assert.match(f.footer.render(140)[1], /\$0.150/);
  f.footer.dispose();
});
