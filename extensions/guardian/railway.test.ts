// Evaluates the bundled Railway rules without running any Railway command.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExecApprovalRequirement, type ExecApprovalRequest } from './exec-policy.ts';
import { BUNDLED_EXTRA_POLICY_PATH, BUNDLED_RULES_DIR, loadPolicies } from './policies.ts';
import { loadShell } from './shell.ts';

const shell = await loadShell();
const { policy } = await loadPolicies([]);
const requirement = (script: string, overrides: Partial<ExecApprovalRequest> = {}) =>
  createExecApprovalRequirement(shell, policy, { command: ['bash', '-lc', script], approvalPolicy: 'on-request', fileSystem: 'restricted', sandboxPermissions: 'use_default', ...overrides });

test('destructive Railway commands are forbidden in every mode', () => {
  for (const script of ['railway delete', 'railway down --yes', 'railway volume delete pg-data', 'railway volumes rm x', 'railway environment delete staging',
    'railway env rm prod', 'railway service delete db', 'cd app && railway volume delete pg-data', 'railway status; railway down']) {
    for (const overrides of [{}, { sandboxPermissions: 'require_escalated' as const }, { fileSystem: 'unrestricted' as const }, { approvalPolicy: 'never' as const },
      { prefixRule: ['railway'] }]) {
      const result = requirement(script, overrides);
      assert.equal(result.type, 'forbidden', `${script} ${JSON.stringify(overrides)}`);
      assert.match(result.type === 'forbidden' ? result.reason : '', /destructive Railway operations are permanently blocked/);
    }
  }
});

test('read-only Railway commands are not forbidden by the rules', () => {
  for (const script of ['railway status', 'railway logs', 'railway volume list', 'railway environment']) {
    assert.notEqual(requirement(script).type, 'forbidden', script);
  }
});

test('user rules cannot allow what the bundled rules forbid', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-user-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'default.rules'), 'prefix_rule(pattern=["railway"], decision="allow")\n');
  const loaded = await loadPolicies([dir]);
  assert.equal(createExecApprovalRequirement(shell, loaded.policy, {
    command: ['railway', 'volume', 'delete', 'pg'], approvalPolicy: 'on-request', fileSystem: 'restricted', sandboxPermissions: 'use_default',
  }).type, 'forbidden');
});

test('a broken user rules file keeps the bundled rules and reports the error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-user-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'broken.rules'), 'prefix_rule(');
  const loaded = await loadPolicies([dir]);
  assert.match(loaded.warning ?? '', /broken\.rules/);
  assert.equal(createExecApprovalRequirement(shell, loaded.policy, {
    command: ['railway', 'delete'], approvalPolicy: 'on-request', fileSystem: 'restricted', sandboxPermissions: 'use_default',
  }).type, 'forbidden');
});

test('the bundled reviewer policy carries the Railway absolute deny', () => {
  assert.match(readFileSync(BUNDLED_EXTRA_POLICY_PATH, 'utf8'), /Railway Databases \(absolute deny\)[\s\S]*User authorization cannot override/);
  assert.match(BUNDLED_RULES_DIR, /personal-settings\/guardian\/rules$/);
});
