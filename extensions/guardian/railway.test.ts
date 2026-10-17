// The Railway boundary lives in code, not in a writable rules file, and is evaluated without running
// any Railway command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExecApprovalRequirement, type ExecApprovalRequest } from './exec-policy.ts';
import { BUNDLED_EXTRA_POLICY_PATH, BUNDLED_RULES_DIR, extraPolicy, loadPolicies } from './policies.ts';
import { RAILWAY_FORBIDDEN_REASON, RAILWAY_REVIEW_REASON, railwayDecision } from './railway.ts';
import { loadShell } from './shell.ts';

const shell = await loadShell();
const decide = (script: string) => railwayDecision(shell, ['bash', '-lc', script]);
const decideArgv = (command: string[]) => railwayDecision(shell, command);

test('destructive Railway commands are forbidden however they are written', () => {
  for (const script of [
    'railway delete',
    'railway down --yes',
    'railway --json delete',
    'railway -v --json down',
    'railway volume delete pg-data',
    'railway bucket delete assets',
    'railway database delete main',
    'railway db reset',
    'railway environment delete staging',
    'railway service remove api',
    'railway project destroy',
    '/opt/homebrew/bin/railway volume delete pg',
    './railway delete',
    '~/.railway/bin/railway delete',
    String.raw`\railway delete`,
    'command railway delete',
    'exec railway down',
    'nohup railway delete',
    'timeout 30 railway delete',
    'time railway delete',
    'nice -n 5 railway delete',
    'stdbuf -o0 railway delete',
    'sudo -u deploy railway delete',
    'env -u RAILWAY_TOKEN railway delete',
    'npx @railway/cli delete',
    'npx -y @railway/cli volume delete pg',
    'pnpm dlx @railway/cli down',
    'bunx railway delete',
    'if true; then railway down; fi',
    'echo "$(railway env rm prod)"',
    "bash -c 'railway delete'",
    'bash -euc "railway delete"',
    'eval "railway delete"',
    'printf x | xargs railway delete',
    'railway delete ;;',
    'cd app && railway delete',
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
  assert.equal(decideArgv(['railway', 'delete']), 'forbidden');
  assert.equal(decideArgv(['/usr/local/bin/railway', 'volume', 'delete', 'pg']), 'forbidden');
});

test('Railway commands that can reach data are reviewed, and unrelated ones are untouched', () => {
  for (const script of ['railway connect postgres', 'railway run psql', 'railway variables', 'railway volume list',
    'railway environment', 'railway service', 'railway link', 'railway ssh', 'railway redeploy']) {
    assert.equal(decide(script), 'prompt', script);
  }
  for (const script of ['railway status', 'railway whoami', 'railway logs', 'railway --help', 'railway login',
    'git status', 'npm test', 'echo done']) {
    assert.equal(decide(script), undefined, script);
  }
});

test('the boundary holds through the bash tool in every mode, before any review', async t => {
  const { createGuardianBashTool } = await import('./bash.ts');
  const { DEFAULT_GUARDIAN_CONFIG } = await import('./config.ts');
  const { Policy, PolicyParser } = await import('./rules.ts');
  const cwd = mkdtempSync(join(tmpdir(), 'guardian-railway-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // An allow rule for railway, the most permissive user configuration possible.
  const parser = new PolicyParser();
  parser.parse('user.rules', 'prefix_rule(pattern=["railway"], decision="allow")\nprefix_rule(pattern=["npx"], decision="allow")');
  const policy = parser.build();
  const requests: unknown[] = [];
  for (const config of [{}, { enabled: false }, { sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode: 'danger-full-access' as const } },
    { approvalPolicy: 'never' as const }, { approvalPolicy: 'unless-trusted' as const }]) {
    const tool = createGuardianBashTool({
      config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, ...config }), policy: () => policy, shell,
      shellSettings: () => ({}), sandbox: { kind: 'seatbelt', summary: 'unused', spawn: async () => { throw new Error('nothing reaches the sandbox'); } },
      approvals: { request: async request => { requests.push(request); return { type: 'approved' }; } },
      persistAmendment: async () => {},
    }, cwd);
    const ctx = { cwd, hasUI: true, abort: () => {}, ui: { notify: () => {}, select: async () => undefined } };
    for (const command of ['railway delete', 'npx @railway/cli volume delete pg', 'command railway down']) {
      await assert.rejects((tool.execute as (...args: unknown[]) => Promise<unknown>)('c', { command }, undefined, undefined, ctx),
        new RegExp(RAILWAY_FORBIDDEN_REASON.slice(0, 40)), `${JSON.stringify(config)} ${command}`);
    }
  }
  assert.deepEqual(requests, [], 'a forbidden Railway command never reaches a reviewer');
  void Policy;
});

test('an approved prefix rule is never persisted when it would widen Railway access', async t => {
  const { persistableAmendment } = await import('./policies.ts');
  assert.equal(persistableAmendment(shell, ['railway']), undefined);
  assert.equal(persistableAmendment(shell, ['railway', 'status']), undefined);
  assert.equal(persistableAmendment(shell, ['npx']), undefined);
  assert.equal(persistableAmendment(shell, ['xargs']), undefined);
  assert.equal(persistableAmendment(shell, ['env']), undefined);
  assert.deepEqual(persistableAmendment(shell, ['cargo', 'test']), ['cargo', 'test']);
  void t;
});

test('the reviewer policy carries the Railway deny even when the bundled file is unreadable', async () => {
  assert.match(readFileSync(BUNDLED_EXTRA_POLICY_PATH, 'utf8'), /Railway Databases \(absolute deny\)[\s\S]*User authorization cannot override/);
  const policy = await extraPolicy(undefined, '/nonexistent/extra-policy.md');
  assert.match(policy, /Railway/);
  assert.match(policy, /cannot override/);
  const withUser = await extraPolicy('Never touch prod.', '/nonexistent/extra-policy.md');
  assert.match(withUser, /Never touch prod\./);
});

test('bundled rules load as defence in depth, and a missing or broken file never widens the boundary', async t => {
  const loaded = await loadPolicies([]);
  assert.equal(createExecApprovalRequirement(shell, loaded.policy, {
    command: ['railway', 'delete'], approvalPolicy: 'on-request', fileSystem: 'restricted', sandboxPermissions: 'use_default',
  } satisfies ExecApprovalRequest).type, 'forbidden');
  const dir = mkdtempSync(join(tmpdir(), 'guardian-user-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.rules'), 'prefix_rule(');
  const broken = await loadPolicies([dir]);
  assert.match(broken.warning ?? '', /broken\.rules/);
  assert.equal(railwayDecision(shell, ['bash', '-lc', 'railway delete']), 'forbidden');
  assert.match(BUNDLED_RULES_DIR, /guardian\/rules$/);
  assert.equal(RAILWAY_REVIEW_REASON.length > 0, true);
});

test('a rules file that stops loading keeps the last rules that did load', async t => {
  const { retainPolicies } = await import('./policies.ts');
  const dir = mkdtempSync(join(tmpdir(), 'guardian-retain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'mine.rules'), 'prefix_rule(pattern=["touch"], decision="forbidden")');
  const good = await loadPolicies([dir]);
  writeFileSync(join(dir, 'other.rules'), 'prefix_rule(');
  const broken = await loadPolicies([dir]);
  const kept = retainPolicies(good, broken);
  assert.equal(kept.policy, good.policy, 'your forbidden rules survive a later load failure');
  assert.match(kept.warning ?? '', /other\.rules[\s\S]*keeping the rules that last loaded/);
  assert.equal(retainPolicies(undefined, broken), broken, 'with nothing loaded before, the bundled rules apply');
  assert.equal(retainPolicies(good, good), good);
});
