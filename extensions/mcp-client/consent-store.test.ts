import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsentStore, serverIdentity } from './consent-store.ts';
import type { ServerConfig } from './config.ts';

const config = { url: 'https://mcp.example/mcp', oauth: {}, headers: { 'X-Test': 'SYNTHETIC-SECRET' } };
const key = serverIdentity('linear', config, 'global', '/synthetic');

test('remembered approvals persist across instances, contain no config/secrets and can be forgotten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-consent-'));
  try {
    const store = new ConsentStore(dir);
    assert.equal(await store.approved(key), false);
    await store.remember(key);
    const next = new ConsentStore(dir);
    assert.equal(await next.approved(key), true);
    assert.deepEqual(await readdir(join(dir, 'harbor-mcp', 'approvals')), [`${key}.consent`]);
    assert.equal(await readFile(join(dir, 'harbor-mcp', 'approvals', `${key}.consent`), 'utf8'), 'approved\n');
    await next.forget(key); await next.forget(key);
    assert.equal(await store.approved(key), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approval identity binds full configuration and authority; global HTTP identity is cwd-independent', () => {
  assert.equal(key, serverIdentity('linear', { headers: { 'X-Test': 'SYNTHETIC-SECRET' }, oauth: {}, url: config.url }, 'global', '/another-project'));
  for (const [name, changed, scope] of [
    ['other', config, 'global'], ['linear', { ...config, url: 'https://other.example/mcp' }, 'global'],
    ['linear', { ...config, allowTools: ['new-tool'] }, 'global'], ['linear', { ...config, oauth: { scope: 'write' } }, 'global'],
    ['linear', config, 'project:/unrelated'], ['linear', { ...config, headers: { 'X-Test': 'ROTATED' } }, 'global'],
  ] satisfies [string, ServerConfig, string][]) assert.notEqual(key, serverIdentity(name, changed, scope, '/synthetic'));
  assert.notEqual(serverIdentity('s', { command: 'node' }, 'global', '/a'), serverIdentity('s', { command: 'node' }, 'global', '/b'));
});

test('unsafe, corrupt and symlinked approval state fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-consent-'));
  try {
    const store = new ConsentStore(dir);
    await assert.rejects(store.approved('../escape'), /Invalid/);
    await store.remember(key);
    const path = join(dir, 'harbor-mcp', 'approvals', `${key}.consent`);
    await chmod(path, 0o644); await assert.rejects(store.approved(key), /unsafe/);
    await chmod(path, 0o600); await writeFile(path, 'garbage'); await assert.rejects(store.approved(key), /unsafe/);
    await store.forget(key); await symlink(join(dir, 'victim'), path); await assert.rejects(store.approved(key), /unsafe/);
    await store.forget(key); await chmod(join(dir, 'harbor-mcp'), 0o755); await assert.rejects(store.approved(key), /private/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
