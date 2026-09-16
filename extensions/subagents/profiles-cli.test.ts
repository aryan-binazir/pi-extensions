import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';

const launcher = join(dirname(fileURLToPath(import.meta.url)), 'show-config');
test('config CLI shares merging, gates local settings on saved trust, and fails on invalid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'profiles-cli-'));
  const agent = join(root, 'agent');
  const cwd = join(root, 'project with spaces');
  mkdirSync(agent); mkdirSync(join(cwd, '.pi'), {recursive: true});
  const env = {...process.env, PI_CODING_AGENT_DIR: agent};
  const run = (...args: string[]) => execFileSync('bash', [launcher, '--cwd', cwd, ...args], {env, encoding: 'utf8'});
  try {
    assert.equal(JSON.parse(run('--json')).profiles.implement.thinking, 'medium');
    writeFileSync(join(agent, 'subagents.json'), JSON.stringify({profiles: {implement: {thinking: 'high'}}}));
    writeFileSync(join(cwd, '.pi', 'subagents.local.json'), JSON.stringify({profiles: {implement: {thinking: 'low'}}}));
    assert.equal(JSON.parse(run('--json')).profiles.implement.thinking, 'high');
    new ProjectTrustStore(agent).set(cwd, true);
    const config = JSON.parse(run('--json'));
    assert.equal(config.profiles.implement.thinking, 'low');
    assert.equal(config.profiles.implement.model, 'openai-codex/gpt-6-astra');
    assert.match(run(), /Default profile.*implement/);
    assert.match(run('--help'), /Usage: show-config/);
    writeFileSync(join(cwd, '.pi', 'subagents.local.json'), '{broken');
    const failed = spawnSync('bash', [launcher, '--cwd', cwd], {env, encoding: 'utf8'});
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Fix settings and \/reload/);
    new ProjectTrustStore(agent).set(cwd, false);
    assert.equal(JSON.parse(run('--json')).profiles.implement.thinking, 'high');
    assert.equal(spawnSync('bash', [launcher, '--unknown'], {env}).status, 1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
