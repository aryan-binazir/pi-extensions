import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { beforeEach, describe, test, type TestContext } from 'node:test';
import { promisify, stripVTControlCharacters } from 'node:util';
import { ModelRuntime, ModelRegistry, SessionManager, type ExecResult, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, type OAuthCredential } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getCapabilities, getOsc8LinkAtColumn, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { withPi } from '../../tests/pi-session.ts';
import { permissionFooter, rightAligned, STATUS_KEY } from './footer.ts';
import { pullRequests } from './pull-request.ts';

let clock: TestContext['mock']['timers'];
const advance = async (ms = 1500) => { clock.tick(ms); await new Promise(setImmediate); };

const theme = { fg: (_color: string, text: string) => text } as Theme;
const usage = { input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0, totalTokens: 2100,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
function fakeGh() {
  const calls: { command: string; args: string[]; options: Parameters<ExtensionAPI['exec']>[2]; answer(result: Partial<ExecResult>): Promise<void> }[] = [];
  const exec: ExtensionAPI['exec'] = (command, args, options) => new Promise(resolve => {
    calls.push({ command, args, options, answer: async result => {
      resolve({ stdout: '', stderr: '', code: 0, killed: false, ...result });
      await new Promise(setImmediate);
    } });
  });
  return { exec, calls };
}
const prUrl = 'https://github.com/owner/repo/pull/42';
const prJson = (fields: object = {}) => JSON.stringify({ number: 42, url: prUrl, state: 'OPEN', isDraft: false, headRefName: 'main', ...fields });
setCapabilities({ ...getCapabilities(), hyperlinks: true });

function fixture(exec?: ExtensionAPI['exec'], reuse = false) {
  if (!reuse) delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('pi-interactive:footer.pull-requests.v1')];
  const statuses = new Map([[STATUS_KEY, 'Auto: on · Luna low']]);
  let branch: string | null = 'main', onChange = () => {}, renders = 0, disposals = 0;
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
  const requestRender = () => { renders++; };
  const prs = exec && pullRequests(exec, requestRender);
  const footer = permissionFooter(() => ctx, theme, data, requestRender, prs);
  return { footer, prs, statuses, ctx, changeBranch: (next: string | null = 'feature') => { branch = next; onChange(); }, renders: () => renders, disposals: () => disposals };
}

const pathRow = (f: ReturnType<typeof fixture>) => stripVTControlCharacters(f.footer.render(140)[0]).replace(/\s+Auto:.*$/, '');

test('discarded targets without lookups have bounded memory in offline and rapid-switch sessions', async () => {
  const source = `
    import { writeSync } from 'node:fs';
    import { pullRequests } from ${JSON.stringify(new URL('./pull-request.ts', import.meta.url).href)};
    let calls = 0;
    const requests = pullRequests(async () => { calls++; throw new Error('unexpected lookup'); }, () => {});
    global.gc();
    const initial = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100_000; i++) requests.get('/synthetic/footer', 'unused-' + i);
    requests.dispose();
    await new Promise(setImmediate);
    global.gc();
    writeSync(1, JSON.stringify({ retained: process.memoryUsage().heapUsed - initial, calls }));
  `;
  for (const offline of ['1', '0']) {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', source],
      { env: { ...process.env, PI_OFFLINE: offline }, timeout: 30000 });
    const { retained, calls } = JSON.parse(stdout);
    assert.equal(calls, 0, `PI_OFFLINE=${offline}`);
    assert.ok(retained < 8 * 1024 * 1024, `PI_OFFLINE=${offline} retained ${retained} bytes for unused targets`);
  }
});

describe('PR links', () => {
beforeEach(t => {
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('pi-interactive:footer.pull-requests.v1')];
  clock = (t as TestContext).mock.timers;
  clock.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
});
test('links the PR number right after the branch once gh reports it', async () => {
  const gh = fakeGh(), f = fixture(gh.exec);
  assert.match(f.footer.render(140)[0], /^\/workspace\/project \(main\) • Task\s+Auto: on · Luna low$/);
  await advance();
  assert.deepEqual(gh.calls.map(call => [call.command, call.args, call.options?.cwd]),
    [['gh', ['pr', 'view', '--json', 'number,url,state,isDraft,headRefName', '--', 'main'], '/workspace/project']]);
  await gh.calls[0].answer({ stdout: prJson() });
  assert.equal(f.renders(), 1);
  const line = f.footer.render(140)[0], visible = stripVTControlCharacters(line);
  assert.match(visible, /^\/workspace\/project \(main\) #42 • Task\s+Auto: on · Luna low$/);
  assert.equal(visibleWidth(line), 140);
  const at = visible.indexOf('#42');
  assert.deepEqual([at - 1, at, at + 1, at + 2, at + 3].map(column => getOsc8LinkAtColumn(line, column)),
    [undefined, prUrl, prUrl, prUrl, undefined]);
  assert.equal(gh.calls.length, 1, 'repeat renders reuse the answer');
  const timeout = gh.calls[0].options?.timeout;
  assert.ok(timeout && timeout > 0 && timeout <= 15000, 'a hung gh cannot hold the lookup open');
  f.footer.dispose();
});

test('terminals without hyperlink support get the plain PR number', async () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: false });
  try {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson({ isDraft: true }) });
    const line = f.footer.render(140)[0];
    assert.match(line, /^\/workspace\/project \(main\) #42 draft • Task\s+Auto/);
    assert.doesNotMatch(line, /\u001b/);
    f.footer.dispose();
  } finally { setCapabilities(capabilities); }
});

test('a PR for another head branch is not shown, as when gh reads a numeric branch name as a PR number', async () => {
  const gh = fakeGh(), f = fixture(gh.exec);
  f.changeBranch('1');
  const before = f.footer.render(140); await advance();
  await gh.calls[0].answer({ stdout: prJson({ number: 1, headRefName: 'amb/interactive-tools' }) });
  assert.deepEqual(f.footer.render(140), before);
  f.footer.dispose();
});

test('gh output that is malformed or could smuggle terminal controls never reaches the footer', async () => {
  for (const stdout of [
    'not json', 'null', '[]',
    prJson({ number: 0 }), prJson({ number: 4.2 }), prJson({ number: '42' }),
    prJson({ url: 'javascript:alert(1)' }), prJson({ url: 'file:///etc/passwd' }), prJson({ url: 'not a url' }),
    prJson({ url: `${prUrl}\u001b]8;;https://evil.example\u0007` }), prJson({ url: `${prUrl}\u202e` }),
    prJson({ state: 'DRAFT' }), prJson({ isDraft: 'false' }),
  ]) {
    const gh = fakeGh(), f = fixture(gh.exec);
    const before = f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout });
    assert.deepEqual(f.footer.render(140), before, stdout);
    f.footer.dispose();
  }
});

test('names draft, merged and closed PRs outside the link; terminal states win over draft', async () => {
  for (const [fields, shown] of [
    [{ isDraft: true }, '#42 draft'],
    [{ state: 'MERGED' }, '#42 merged'],
    [{ state: 'CLOSED' }, '#42 closed'],
    [{ state: 'CLOSED', isDraft: true }, '#42 closed'],
    [{ state: 'MERGED', isDraft: true }, '#42 merged'],
  ] as const) {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson(fields) });
    const line = f.footer.render(140)[0], visible = stripVTControlCharacters(line);
    assert.match(visible, new RegExp(`^/workspace/project \\(main\\) ${shown} • Task\\s`), JSON.stringify(fields));
    assert.equal(getOsc8LinkAtColumn(line, visible.indexOf(shown) + shown.length - 1), undefined, 'the state word is not linked');
    f.footer.dispose();
  }
});


test('footer labels use the terminal label policy before theme styling', async () => {
  const f = fixture();
  f.ctx.sessionManager.getCwd = () => '/work\n\u202espace';
  f.changeBranch('feature\u202ename');
  f.ctx.sessionManager.getSessionName = () => 'Task\u202ename';
  f.ctx.model!.id = 'model\u202ename';
  f.statuses.set(STATUS_KEY, 'Auto: on\u202estatus');
  f.statuses.set('other', 'Other\u202estatus');
  const lines = f.footer.render(140); await advance();
  assert.match(lines[0], /^\/work space \(feature name\) • Task name +Auto: on status$/);
  assert.match(lines[1], /model name/);
  assert.equal(lines[2], 'Other status');
  assert.ok(!lines.join('').includes('\u202e'));
  f.footer.dispose();
});

test('narrow footers never exceed the width or leave a PR link open', async () => {
  const gh = fakeGh(), f = fixture(gh.exec);
  f.changeBranch('evil\u001b[2J\u202ebranch');
  f.footer.render(140); await advance();
  await gh.calls[0].answer({ stdout: prJson({ headRefName: 'evil\u001b[2J\u202ebranch' }) });
  for (let width = 0; width <= 140; width++) {
    const lines = f.footer.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `footer at ${width}`);
    const row = lines[0], lastLink = row.lastIndexOf('\u001b]8;;');
    if (lastLink >= 0) assert.ok(row.startsWith('\u001b]8;;\u001b\\', lastLink), `link closed at ${width}`);
    const visible = stripVTControlCharacters(row), at = visible.indexOf('#');
    if (at >= 0) assert.equal(getOsc8LinkAtColumn(row, at), prUrl, `link target at ${width}`);
    if (at >= 0) assert.match(visible, /\) #42 /, `the number is whole or absent at ${width}: ${visible}`);
  }
  assert.match(stripVTControlCharacters(f.footer.render(140)[0]), /\(evil branch\) #42 • Task/);
  f.footer.dispose();
});

test('branch and cwd changes hide stale PRs and reuse fresh completed answers', async () => {
  const gh = fakeGh(), f = fixture(gh.exec);
  f.footer.render(140); await advance();
  f.changeBranch('feature');
  assert.equal(pathRow(f), '/workspace/project (feature) • Task');
  await advance();
  assert.deepEqual(gh.calls.map(call => call.args.at(-1)), ['main', 'feature']);
  const renders = f.renders();
  await gh.calls[0].answer({ stdout: prJson() });
  assert.equal(pathRow(f), '/workspace/project (feature) • Task');
  assert.equal(f.renders(), renders, 'a stale answer requests no render');
  await gh.calls[1].answer({ stdout: prJson({ number: 7, url: 'https://github.com/owner/repo/pull/7', headRefName: 'feature' }) });
  assert.equal(pathRow(f), '/workspace/project (feature) #7 • Task');
  for (const detached of ['detached', null]) {
    f.changeBranch(detached);
    assert.doesNotMatch(pathRow(f), /#7/);
    f.prs!.refresh(false); await advance();
  }
  assert.equal(gh.calls.length, 2);
  f.changeBranch('feature');
  assert.equal(pathRow(f), '/workspace/project (feature) #7 • Task');
  await advance();
  assert.equal(gh.calls.length, 2, 'reattaching reuses the fresh answer');
  f.ctx.sessionManager.getCwd = () => '/workspace/other';
  assert.equal(pathRow(f), '/workspace/other (feature) • Task');
  await advance();
  assert.equal(gh.calls[2].options?.cwd, '/workspace/other');
  f.footer.dispose();
});

test('refresh coalesces while keeping the link, including a trigger during an in-flight lookup', async () => {
  const gh = fakeGh(), f = fixture(gh.exec);
  f.footer.render(140); await advance();
  await gh.calls[0].answer({ stdout: prJson() });
  f.prs!.refresh(); f.prs!.refresh();
  assert.equal(pathRow(f), '/workspace/project (main) #42 • Task');
  await advance();
  assert.equal(gh.calls.length, 2);
  f.prs!.refresh(); await advance();
  assert.equal(gh.calls.length, 2, 'an in-flight lookup is never aborted and respawned');
  await gh.calls[1].answer({ stdout: prJson({ state: 'MERGED' }) });
  await advance();
  assert.equal(gh.calls.length, 3, 'a change during the lookup gets one trailing refresh');
  await gh.calls[2].answer({ stdout: prJson({ state: 'MERGED' }) });
  assert.equal(pathRow(f), '/workspace/project (main) #42 merged • Task');
  f.footer.dispose();
});

test('disposing cancels scheduled lookups and running lookups survive a replacement footer', async () => {
  const gh = fakeGh(), cancelled = fixture(gh.exec);
  cancelled.footer.render(140); cancelled.footer.dispose(); await advance();
  assert.equal(gh.calls.length, 0);
  const first = fixture(gh.exec);
  first.footer.render(140); await advance();
  first.footer.dispose();
  const replacement = fixture(gh.exec, true);
  replacement.footer.render(140); await advance();
  assert.equal(gh.calls.length, 1, 'a replacement subscribes to the running lookup');
  await gh.calls[0].answer({ stdout: prJson() });
  assert.equal(pathRow(replacement), '/workspace/project (main) #42 • Task');
  assert.equal(replacement.renders(), 1);
  first.prs!.refresh();
  assert.equal(first.prs!.get('/workspace/project', 'feature'), undefined);
  replacement.footer.dispose();
});

test('no PR, a missing or failing gh, or a killed lookup leaves the footer as it is today', async () => {
  for (const answer of [
    { code: 1, stderr: 'no pull requests found for branch "main"' },
    { code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' },
    { code: 1, stderr: 'spawn gh ENOENT' },
      { code: 1, stderr: 'no git remotes found' },
    { code: 0, killed: true, stdout: prJson() },
  ]) {
    const gh = fakeGh(), f = fixture(gh.exec);
    const before = f.footer.render(140); await advance();
    await gh.calls[0].answer(answer);
    assert.deepEqual(f.footer.render(140), before, JSON.stringify(answer));
    f.footer.dispose();
  }
  const rejecting = fixture(() => Promise.reject(new Error('exec failed')));
  const throwing = fixture(() => { throw new Error('exec threw'); });
  for (const f of [rejecting, throwing]) {
    const before = f.footer.render(140); await advance();
    await new Promise(setImmediate);
    assert.deepEqual(f.footer.render(140), before);
    f.footer.dispose();
  }
});

});

describe('PR lookup lifecycle', () => {
  beforeEach(t => {
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('pi-interactive:footer.pull-requests.v1')];
    clock = (t as TestContext).mock.timers;
    clock.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  });
  test('offline skips initial lookups, triggers and expired turns', async () => {
    const previous = process.env.PI_OFFLINE;
    try {
      for (const flag of ['1', 'yes', 'TRUE']) {
        process.env.PI_OFFLINE = flag;
        const gh = fakeGh(), f = fixture(gh.exec);
        f.footer.render(140); await advance();
        f.prs!.refresh(); f.prs!.refresh(false); await advance(120000);
        assert.equal(gh.calls.length, 0, flag);
        f.footer.dispose();
      }
      process.env.PI_OFFLINE = '0';
      const gh = fakeGh(), f = fixture(gh.exec);
      f.footer.render(140); await advance();
      assert.equal(gh.calls.length, 1);
      f.footer.dispose();
    } finally {
      if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous;
    }
  });
  test('missing gh and non-GitHub repos stay suppressed across replacement until a mutation or branch change', async () => {
    for (const failure of [
      { code: 1, stderr: '' },
      { code: 1, stderr: 'spawn gh ENOENT' },
      { code: 1, stderr: 'no git remotes found' },
      { code: 1, stderr: 'none of the git remotes configured for this repository point to a known GitHub host' },
    ]) {
      const gh = fakeGh(), f = fixture(gh.exec);
      f.footer.render(140); await advance();
      await gh.calls[0].answer(failure);
      f.prs!.refresh(false); await advance(120000);
      f.prs!.refresh(false); await advance();
      assert.equal(gh.calls.length, 1);
      f.footer.dispose();
      const replacement = fixture(gh.exec, true);
      replacement.footer.render(140); replacement.prs!.refresh(false); await advance();
      assert.equal(gh.calls.length, 1, 'new session preserves suppression');
      replacement.prs!.refresh(); await advance();
      assert.equal(gh.calls.length, 2, 'a triggering command retries');
      await gh.calls[1].answer(failure);
      replacement.changeBranch('feature'); replacement.footer.render(140); await advance();
      assert.equal(gh.calls.length, 3, 'a branch change retries');
      await gh.calls[2].answer(failure);
      replacement.changeBranch('main'); replacement.footer.render(140); await advance();
      assert.equal(gh.calls.length, 4, 'returning to a suppressed branch retries');
      replacement.footer.dispose();
    }
  });
  test('a mutation queued before replacement refreshes the cached answer', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson() });
    first.prs!.refresh(); first.footer.dispose();
    const replacement = fixture(gh.exec, true);
    replacement.footer.render(140); await advance();
    assert.equal(gh.calls.length, 2);
    replacement.footer.dispose();
  });
  test('a mutation during a running lookup survives replacement even when its answer is unchanged', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    first.prs!.refresh(); first.footer.dispose();
    const replacement = fixture(gh.exec, true);
    replacement.footer.render(140);
    await gh.calls[0].answer({ stdout: '' });
    await advance();
    assert.equal(gh.calls.length, 2);
    replacement.footer.dispose();
  });
  test('a triggering command carries invalidation to a freshly cached branch before its next render', async () => {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson() });
    f.changeBranch('feature'); f.footer.render(140); await advance();
    await gh.calls[1].answer({ stdout: prJson({ headRefName: 'feature' }) });
    f.changeBranch('main'); f.footer.render(140);
    f.prs!.refresh();
    f.changeBranch('feature'); f.footer.render(140); await advance();
    assert.equal(gh.calls.length, 3);
    assert.equal(gh.calls[2].args.at(-1), 'feature');
    f.footer.dispose();
  });
  test('a trigger while detached refreshes a cached branch after reattachment', async () => {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson() });
    f.changeBranch('detached'); f.footer.render(140);
    f.prs!.refresh();
    f.changeBranch('main'); f.footer.render(140); await advance();
    assert.equal(gh.calls.length, 2);
    f.footer.dispose();
  });
  test('quitting aborts running lookups without affecting replacement disposal', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    first.prs!.dispose(true);
    assert.equal(gh.calls[0].options?.signal?.aborted, true);
    first.footer.dispose();
  });
  test('a fresh completed answer survives new sessions and a freshly loaded module', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson() });
    first.footer.dispose();
    const replacement = fixture(gh.exec, true);
    assert.equal(pathRow(replacement), '/workspace/project (main) #42 • Task');
    await advance();
    assert.equal(gh.calls.length, 1, 'new session reuses the answer');
    replacement.footer.dispose();
    const reloaded = await import(new URL('./pull-request.ts?reload=footer', import.meta.url).href);
    const prs = reloaded.pullRequests(gh.exec, () => {});
    assert.equal(prs.get('/workspace/project', 'main')?.number, 42);
    await advance();
    assert.equal(gh.calls.length, 1, 'reload reuses the process registry');
    prs.dispose();
  });
  test('fresh no-PR answers throttle revisits, and stale ones refresh once', async () => {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ code: 1, stderr: 'no pull requests found' });
    for (const branch of ['feature', 'other', 'main']) {
      f.changeBranch(branch); f.footer.render(140);
    }
    await advance();
    assert.equal(gh.calls.length, 1, 'a fresh negative answer is reusable');
    await advance(60000);
    for (const branch of ['feature', 'other', 'main']) {
      f.changeBranch(branch); f.footer.render(140);
    }
    await advance();
    assert.equal(gh.calls.length, 2, 'a stale negative answer gets one lookup');
    assert.equal(gh.calls[1].args.at(-1), 'main');
    await gh.calls[1].answer({ code: 1, stderr: 'no pull requests found' });
    f.footer.dispose();
  });
  test('stale PR links remain visible immediately after unused target churn', async () => {
    const gh = fakeGh(), f = fixture(gh.exec);
    f.footer.render(140); await advance();
    await gh.calls[0].answer({ stdout: prJson() });
    f.changeBranch('feature'); f.footer.render(140);
    await advance(60000);
    await gh.calls[1].answer({ code: 1, stderr: 'no pull requests found' });
    f.changeBranch('other'); f.footer.render(140);
    f.changeBranch('main');
    assert.equal(pathRow(f), '/workspace/project (main) #42 • Task');
    await advance();
    assert.equal(gh.calls.length, 3);
    await gh.calls[2].answer({ stdout: prJson({ state: 'MERGED' }) });
    assert.equal(pathRow(f), '/workspace/project (main) #42 merged • Task');
    f.footer.dispose();
  });
  test('unused target pruning preserves orphaned pending work', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    for (const branch of ['feature', 'other', 'detached']) {
      first.changeBranch(branch); first.footer.render(140);
    }
    const shared = fixture(gh.exec, true);
    shared.footer.render(140); await advance();
    assert.equal(gh.calls.length, 1, 'an unobserved running lookup remains shared');
    first.changeBranch('main'); first.footer.render(140);
    for (const branch of ['feature', 'other', 'detached']) {
      first.changeBranch(branch); first.footer.render(140);
    }
    first.footer.dispose();
    await gh.calls[0].answer({ stdout: prJson() });
    assert.equal(pathRow(shared), '/workspace/project (main) #42 • Task');
    assert.equal(shared.renders(), 1, 'the remaining listener receives completion');
    shared.footer.dispose();
  });
  test('an idle shared target remains available for a replacement to join its refresh', async () => {
    const gh = fakeGh(), first = fixture(gh.exec);
    first.footer.render(140); await advance();
    await gh.calls[0].answer({ code: 1, stderr: 'no pull requests found' });
    const shared = fixture(gh.exec, true);
    shared.footer.render(140);
    await advance(60000);
    for (const branch of ['feature', 'other', 'detached']) {
      first.changeBranch(branch); first.footer.render(140);
    }
    shared.prs!.refresh(false);
    const replacement = fixture(gh.exec, true);
    replacement.footer.render(140); await advance();
    assert.equal(gh.calls.length, 2, 'the live listener keeps the same cache entry for both refreshes');
    await gh.calls[1].answer({ stdout: prJson() });
    assert.equal(pathRow(shared), '/workspace/project (main) #42 • Task');
    assert.equal(pathRow(replacement), '/workspace/project (main) #42 • Task');
    first.footer.dispose(); shared.footer.dispose(); replacement.footer.dispose();
  });
});

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

test('missing status and unknown context remain explicit', () => {
  const f = fixture(); f.statuses.clear();
  f.ctx.getContextUsage = () => undefined;
  const lines = f.footer.render(140);
  assert.match(lines[0], /Auto: unavailable$/);
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


test('footer statistics refresh when the real Pi host appends session entries', async () => withPi({}, async ({ session, runner }) => {
  const ctx = runner.createContext();
  const data: ReadonlyFooterDataProvider = {
    getGitBranch: () => null, getAvailableProviderCount: () => 1, getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  };
  const footer = permissionFooter(() => ctx, theme, data, () => {});
  try {
    assert.doesNotMatch(footer.render(140)[1], /↑/);
    session.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First reply' }],
      api: 'faux', provider: 'pi-test', model: session.model!.id, usage, stopReason: 'stop', timestamp: 0 });
    assert.match(footer.render(140)[1], /↑1\.0k.*↓100.*R1\.0k/);
    session.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Second reply' }],
      api: 'faux', provider: 'pi-test', model: session.model!.id, usage, stopReason: 'stop', timestamp: 1 });
    assert.match(footer.render(140)[1], /↑2\.0k.*↓200.*R2\.0k/);
  } finally { footer.dispose(); }
}));
