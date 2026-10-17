import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_GUARDIAN_CONFIG, guardianStatusText, loadGuardianConfig, reviewerLabel } from './config.ts';

function configDir(t: test.TestContext, config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

test('defaults match Codex on-request auto review with the Luna reviewer', t => {
  assert.deepEqual(loadGuardianConfig(join(configDir(t), 'config.json')), DEFAULT_GUARDIAN_CONFIG);
  assert.deepEqual(DEFAULT_GUARDIAN_CONFIG, {
    enabled: true,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    reviewer: { provider: 'openai-codex', model: 'gpt-6-luna~fast', reasoning: 'low' },
    autoReview: { policy: undefined, extraPolicy: undefined, failureFallback: 'user' },
    sandbox: { mode: 'workspace-write', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  });
});

test('Claude reviews through claude-cli and GPT through the registry', t => {
  const claude = configDir(t, { reviewer: { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' } });
  assert.deepEqual(loadGuardianConfig(join(claude, 'config.json')).reviewer, { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' });
  const gpt = configDir(t, { reviewer: { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoning: 'medium' } });
  assert.deepEqual(loadGuardianConfig(join(gpt, 'config.json')).reviewer, { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoning: 'medium' });
});

test('Codex permission preferences merge over defaults', t => {
  const dir = configDir(t, {
    approvalPolicy: 'unless-trusted', approvalsReviewer: 'user',
    autoReview: { extraPolicy: 'Never push to main.', failureFallback: 'reject' },
    sandbox: { networkAccess: true, writableRoots: ['/opt/cache'], excludeSlashTmp: true },
  });
  assert.deepEqual(loadGuardianConfig(join(dir, 'config.json')), {
    ...DEFAULT_GUARDIAN_CONFIG,
    approvalPolicy: 'unless-trusted', approvalsReviewer: 'user',
    autoReview: { policy: undefined, extraPolicy: 'Never push to main.', failureFallback: 'reject' },
    sandbox: { mode: 'workspace-write', networkAccess: true, writableRoots: ['/opt/cache'], excludeTmpdirEnvVar: false, excludeSlashTmp: true },
  });
});

test('policy text can come from files relative to the config directory', t => {
  const dir = configDir(t, { autoReview: { policyFile: 'policy.md', extraPolicyFile: '/abs/missing.md' } });
  assert.throws(() => loadGuardianConfig(join(dir, 'config.json')), /policy\.md/);
  writeFileSync(join(dir, 'policy.md'), 'My tenant policy.\n');
  assert.throws(() => loadGuardianConfig(join(dir, 'config.json')), /missing\.md/);
  mkdirSync(join(dir, 'shared'));
  writeFileSync(join(dir, 'shared', 'extra.md'), 'Extra.\n');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ autoReview: { policyFile: 'policy.md', extraPolicyFile: 'shared/extra.md' } }));
  assert.deepEqual(loadGuardianConfig(join(dir, 'config.json')).autoReview, { policy: 'My tenant policy.\n', extraPolicy: 'Extra.\n', failureFallback: 'user' });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ autoReview: { policy: 'inline', policyFile: 'policy.md' } }));
  assert.throws(() => loadGuardianConfig(join(dir, 'config.json')), /autoReview\.policy and autoReview\.policyFile/);
});

test('invalid configs are rejected with the offending field', t => {
  const cases: [unknown, RegExp][] = [
    ['{', /config\.json/],
    [{ approvalPolicy: 'sometimes' }, /approvalPolicy/],
    [{ approvalsReviewer: 'robot' }, /approvalsReviewer/],
    [{ sandbox: { mode: 'yolo' } }, /sandbox\.mode/],
    [{ sandbox: { writableRoots: ['relative'] } }, /writableRoots/],
    [{ reviewer: { reasoning: 'extreme' } }, /reviewer\.reasoning/],
    [{ reviewer: { model: '' } }, /reviewer\.model/],
    [{ reviewer: { provider: 'claude-bridge', model: 'claude-opus-5-5' } }, /use "claude-cli"/],
    [{ enabled: 'yes' }, /enabled/],
    [{ autoReview: { failureFallback: 'allow' } }, /autoReview\.failureFallback/],
    [{ unknownKey: true }, /unknown setting `unknownKey`/],
  ];
  for (const [config, error] of cases) assert.throws(() => loadGuardianConfig(join(configDir(t, config), 'config.json')), error, JSON.stringify(config));
});

test('reviewer labels name Claude and GPT families', () => {
  assert.equal(reviewerLabel({ provider: 'openai-codex', model: 'gpt-6-luna~fast' }), 'Luna');
  assert.equal(reviewerLabel({ provider: 'openai-codex', model: 'gpt-6.1-sol' }), 'Sol');
  assert.equal(reviewerLabel({ provider: 'claude-cli', model: 'claude-opus-5-5' }), 'Opus');
  assert.equal(reviewerLabel({ provider: 'anthropic', model: 'claude-sonnet-5-5' }), 'Sonnet');
  assert.equal(reviewerLabel({ provider: 'x', model: 'odd model!' }), 'odd?model?');
});

test('status text keeps the Auto Permissions indicator format', () => {
  assert.equal(guardianStatusText(DEFAULT_GUARDIAN_CONFIG, true), 'Auto: on · Luna low');
  assert.equal(guardianStatusText({ ...DEFAULT_GUARDIAN_CONFIG, enabled: false }, true), 'Auto: off');
  assert.equal(guardianStatusText(DEFAULT_GUARDIAN_CONFIG, false), 'Auto: on · Luna low · no sandbox');
  assert.equal(guardianStatusText({ ...DEFAULT_GUARDIAN_CONFIG, sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, networkAccess: true } }, true), 'Auto: on · Luna low · network');
  assert.equal(guardianStatusText({ ...DEFAULT_GUARDIAN_CONFIG, approvalsReviewer: 'user' }, true), 'Auto: on · you review');
  assert.equal(guardianStatusText({ ...DEFAULT_GUARDIAN_CONFIG, reviewer: { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' } }, true), 'Auto: on · Opus high');
});
