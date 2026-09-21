import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWorkflow } from './workflow.ts';

test('journal loading does not follow a substituted symlink', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-link-'));
  const journalDirectory = join(cwd, 'journals');
  const options = {source: "return await api.checkpoint('one',async()=>1);", cwd, journalDirectory, policyIdentity: 'journal-link', approve: async () => true, approveReplay: async () => true, spawn: async () => { throw new Error('unused'); }};
  try {
    await runWorkflow(options);
    const path = join(journalDirectory, (await readdir(journalDirectory))[0]);
    await rename(path, `${path}.original`);
    await symlink(`${path}.original`, path);
    await assert.rejects(runWorkflow(options), /ELOOP|symbolic link/);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('workflow retry returns supervision failures to its orchestrator without relaunching', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-stalled-'));
  let launches = 0;
  try {
    await assert.rejects(runWorkflow({source: "return await api.retry(5,()=>api.spawn({task:'stalled'},'child'));", cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'stalled', approve: async () => true,
      spawn: async () => { launches++; throw Object.assign(new Error('Child stalled'), {retryable: false}); },
    }), /Child stalled/);
    assert.equal(launches, 1);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('a changed ancestor cannot substitute another file after read authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-path-'));
  const cwd = join(root, 'workspace'), data = join(cwd, 'data'), outside = join(root, 'outside');
  try {
    await mkdir(data, {recursive: true}); await mkdir(outside);
    await writeFile(join(data, 'file'), 'allowed'); await writeFile(join(outside, 'file'), 'synthetic outside');
    await assert.rejects(runWorkflow({source: "return await api.readFile('data/file');", cwd, journalDirectory: join(root, 'journals'), policyIdentity: 'path', approve: async () => true,
      authorizeRead: async () => { await rm(data, {recursive: true}); await symlink(outside, data); },
      spawn: async () => { throw new Error('unused'); },
    }), /changed during authorization/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('multibyte checkpoints cannot create a journal that violates its reload byte limit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-bytes-'));
  try {
    await assert.rejects(runWorkflow({
      source: "for(let i=0;i<4;i++) await api.checkpoint('part'+i,async()=> '界'.repeat(100000));return 'ok';",
      cwd, journalDirectory: join(cwd, 'journals'), policyIdentity: 'bytes', approve: async () => true,
      spawn: async () => { throw new Error('unused'); },
    }), /journal exceeds limit/);
  } finally { await rm(cwd, {recursive: true, force: true}); }
});

test('known journal-write failure cannot be retried into undurable success', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'journal-failure-'));
  const journalDirectory = join(cwd, 'journals');
  let effects = 0;
  try {
    await assert.rejects(runWorkflow({
      source: "return await api.retry(2,()=>api.spawn({task:'synthetic effect'},'once'));",
      cwd, journalDirectory, policyIdentity: 'test', approve: async () => true,
      spawn: async () => { effects++; await rm(journalDirectory, {recursive: true, force: true}); return 'effect'; },
    }), /persistence failed/);
    assert.equal(effects, 1, 'known failure must return control for reconciliation, not repeat the effect');
  } finally { await rm(cwd, {recursive: true, force: true}); }
});
