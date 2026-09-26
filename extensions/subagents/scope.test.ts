import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertChildTask, assertWorkflowRead, assertWorkspacePath, delegationScope } from './scope.ts';

const ALL = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];

async function workspace(run: (paths: {root: string; inside: string; outside: string; file: string}) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'subagent-scope-')));
  try {
    const root = join(base, 'root'), inside = join(base, 'root', 'nested'), outside = join(base, 'sibling');
    await mkdir(inside, {recursive: true});
    await mkdir(outside);
    const file = join(root, 'file.txt');
    await writeFile(file, 'safe');
    await run({root, inside, outside, file});
  } finally { await rm(base, {recursive: true, force: true}); }
}

test('delegation scope keeps only builtin tools the parent still holds', () => {
  assert.deepEqual(delegationScope({cwd: '/workspace', tools: [...ALL, 'subagent', 'workflow']}).tools, ALL);
  assert.deepEqual(delegationScope({cwd: '/workspace', tools: ['read', 'bash', 'subagent']}).tools, ['read', 'bash']);
  assert.deepEqual(delegationScope({cwd: '/workspace', tools: ['subagent', 'workflow']}).tools, []);
});

test('replay identity changes with the workspace or the granted tools', () => {
  const identity = (cwd: string, tools: string[]) => delegationScope({cwd, tools}).replayIdentity;
  assert.equal(identity('/workspace', ['read', 'bash']), identity('/workspace', ['bash', 'read', 'subagent']));
  assert.notEqual(identity('/workspace', ['read']), identity('/other', ['read']));
  assert.notEqual(identity('/workspace', ['read']), identity('/workspace', ['read', 'bash']));
});

test('workspace paths inside the root are allowed and escapes are rejected', async () => workspace(async ({root, inside, outside, file}) => {
  await assertWorkspacePath(root, root);
  await assertWorkspacePath(root, inside);
  await assertWorkspacePath(root, file);
  await assert.rejects(assertWorkspacePath(root, join(root, '..')), /outside parent workspace/);
  await assert.rejects(assertWorkspacePath(root, outside), /outside parent workspace/);
  await assert.rejects(assertWorkspacePath(inside, root), /outside parent workspace/);
}));

test('repository control data and credential files are rejected inside the root', async () => workspace(async ({root}) => {
  for (const name of ['.git', '.pi', '.agents', 'credentials']) {
    await mkdir(join(root, name));
    await assert.rejects(assertWorkspacePath(root, join(root, name)), /sensitive or repository control data/);
  }
  for (const name of ['.env', '.env.local', 'AGENTS.md', 'CLAUDE.md', 'id_ed25519', 'credentials.json']) {
    await writeFile(join(root, name), 'x');
    await assert.rejects(assertWorkspacePath(root, join(root, name)), /sensitive or repository control data/);
  }
  await writeFile(join(root, 'environment'), 'x');
  await assertWorkspacePath(root, join(root, 'environment'));
}));

test('a sensitive component anywhere in the relative path is rejected, not only the leaf', async () => workspace(async ({root}) => {
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'x');
  await assert.rejects(assertWorkspacePath(root, join(root, '.git', 'config')), /sensitive or repository control data/);
}));

test('child tasks may not exceed the parent workspace or its tools', async () => workspace(async ({root, inside, outside}) => {
  const parent = {cwd: root, tools: ['read', 'grep', 'find', 'ls']};
  await assertChildTask({cwd: inside, tools: ['read', 'ls']}, {parent});
  await assert.rejects(assertChildTask({cwd: outside, tools: ['read']}, {parent}), /outside parent workspace/);
  await assert.rejects(assertChildTask({cwd: inside, tools: ['read', 'bash']}, {parent}), /exceed parent permissions/);
  await assert.rejects(assertChildTask({cwd: inside, tools: ['unknown']}, {parent}), /exceed parent permissions/);
}));

test('child extensions require absolute local files and explicit approval', async () => workspace(async ({root, inside, file}) => {
  const parent = {cwd: root, tools: ['read']};
  const approvals: string[] = [];
  const approve = async (request: string) => { approvals.push(request); return true; };
  await assert.rejects(assertChildTask({cwd: inside, tools: ['read'], extensions: ['relative.ts']}, {parent, approve}), /absolute local paths/);
  await assert.rejects(assertChildTask({cwd: inside, tools: ['read'], extensions: [inside]}, {parent, approve}), /must be a file/);
  await assert.rejects(assertChildTask({cwd: inside, tools: ['read'], extensions: [file]}, {parent}), /was not approved/);
  await assert.rejects(assertChildTask({cwd: inside, tools: ['read'], extensions: [file]}, {parent, approve: async () => false}), /was not approved/);
  assert.deepEqual(approvals, []);
  await assertChildTask({cwd: inside, tools: ['read'], extensions: [file]}, {parent, approve});
  assert.equal(approvals.length, 1);
  assert.match(approvals[0], /host privileges/);
}));

test('workflow reads require the read tool and stay inside the parent workspace', async () => workspace(async ({root, outside, file}) => {
  await assertWorkflowRead({cwd: root, tools: ['read', 'bash']}, file);
  await assert.rejects(assertWorkflowRead({cwd: root, tools: ['bash', 'edit']}, file), /Read is outside parent permissions/);
  await assert.rejects(assertWorkflowRead({cwd: root, tools: ['read']}, outside), /outside parent workspace/);
}));
