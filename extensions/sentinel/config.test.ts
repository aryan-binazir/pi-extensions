import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadPreferences, readBounded } from './config.ts';
import { systemPrompt } from './prompts.ts';

test('user-owned config defaults, explicit policy paths, strict validation and bounded files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sentinel-config-'));
  try {
    const config = await loadConfig(home);
    assert.equal(config.classifier, 'openai-codex/gpt-5.6-luna');
    assert.equal(config.reviewer, 'openai-codex/codex-auto-review');
    assert.equal(config.maxToolCallLag, 2);
    assert.equal(await loadPreferences(config, home), '');
    await writeFile(config.policyFile, 'Never push to production without asking me.');
    assert.match(await loadPreferences(config, home), /Never push/);
    for (const hidden of ['\x1b[8mHidden approval\x1b[0m', 'safe\rhidden', '\u202ehidden']) {
      await writeFile(config.policyFile, hidden);
      await assert.rejects(loadPreferences(config, home), /invisible/);
    }
    await writeFile(config.policyFile, 'Visible\r\npreferences');
    assert.equal(await loadPreferences(config, home), 'Visible\r\npreferences');
    await writeFile(config.policyFile, '');
    assert.equal(await loadPreferences(config, home), '', 'empty and absent defaults have identical effective preferences');
    await assert.rejects(loadPreferences({ ...config, policyFile: join(home, 'missing.md') }, home));
    for (const value of [{ enabled: false }, { maxToolCallLag: 3 }, { timeoutMs: 0 }, { classifier: 'bare' }, { policyFile: './project-policy.md' }, [], null]) {
      await writeFile(join(home, 'sentinel.json'), JSON.stringify(value));
      await assert.rejects(loadConfig(home));
    }
    await writeFile(join(home, 'oversize'), 'x'.repeat(100));
    await assert.rejects(readBounded(join(home, 'oversize'), 10));
    await symlink(config.policyFile, join(home, 'link'));
    await assert.rejects(readBounded(join(home, 'link'), 1000));
    await assert.rejects(readBounded(home, 1000));
    await writeFile(join(home, 'invalid'), Buffer.from([0xff]));
    await assert.rejects(readBounded(join(home, 'invalid'), 100));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('both prompts include preferences verbatim and replace upstream sandbox assumptions', () => {
  const preferences = 'Only push to acme/example after an explicit request.';
  for (const stage of ['classifier', 'reviewer'] as const) {
    const prompt = systemPrompt(stage, preferences);
    assert.ok(prompt.includes(preferences));
    assert.ok(!prompt.includes('{{ tenant_policy_config }}'));
    assert.match(prompt, /NOT in an OS sandbox/);
    assert.match(prompt, /delegation cannot widen/);
    assert.match(prompt, /Data Exfiltration/);
  }
  assert.ok(!systemPrompt('reviewer', '').includes('The coding-agent is running in a sandbox'));
});

test('replacement metacharacters in standing preferences reach both models verbatim', () => {
  const preferences = "Never alter regex $&; keep $$, $`, and $' literal.";
  for (const stage of ['classifier', 'reviewer'] as const) {
    assert.ok(systemPrompt(stage, preferences).includes(preferences));
  }
});
