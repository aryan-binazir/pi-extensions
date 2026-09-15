import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from '@earendil-works/pi-coding-agent';
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
    sessionManager: { getCwd: () => '/workspace/project', getSessionName: () => 'Task', getEntries: () => [
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
