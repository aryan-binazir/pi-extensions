import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { controlAction } from './controls.ts';

test('control-plane direct writes block including sessions, settings, tilde, and symlink aliases', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sentinel-controls-'));
  try {
    const policy = join(home, 'sec.md'); await writeFile(policy, 'policy');
    await mkdir(join(home, 'sessions'));
    await symlink(policy, join(home, 'alias.md'));
    for (const path of ['sec.md', 'alias.md', 'settings.json', 'models.json', 'sessions/forged.jsonl']) {
      assert.equal(controlAction('write', { path }, home, home, policy), 'deny', path);
    }
    assert.equal(controlAction('edit', { path: '~/.pi/agent/sec.md' }, home, join(homedir(), '.pi/agent'), join(homedir(), '.pi/agent/sec.md')), 'deny');
    assert.equal(controlAction('read', { path: policy }, home, home, policy), undefined);
    assert.equal(controlAction('write', { path: 'normal.ts' }, home, home, policy), undefined);
    assert.equal(controlAction('write', { path: 'normal.ts', content: `${policy} `.repeat(5000) }, home, home, policy), undefined, 'write payload is not an executing command or target path');
    assert.equal(controlAction('write', { path: './'.repeat(3000) + 'sec.md' }, home, home, policy), 'deny', 'normalize before applying path bounds');
    assert.equal(controlAction('bash', { command: 'x'.repeat(20000) }, home, home, policy), 'review', 'oversized opaque strings force review');
    assert.equal(controlAction('bash', { command: Array.from({ length: 100 }, (_, index) => `unknown-${index}`).join(' ') }, home, home, policy), 'review', 'exhausting path-resolution budget is not a safe result');
    assert.equal(controlAction('bash', { command: 'cat sessions/forged.jsonl' }, home, home, policy), 'review');
    assert.equal(controlAction('bash', { command: 'rm -rf .' }, home, home, policy), 'review', 'ancestor removal also touches control files');
    assert.equal(controlAction('write', { path: '/custom/current-session.jsonl' }, home, home, policy, undefined, '/custom/current-session.jsonl'), 'deny');
  } finally { await rm(home, { recursive: true, force: true }); }
});
