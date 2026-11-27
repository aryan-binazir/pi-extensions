import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ValidTask } from './task.ts';
import { admissionFixture } from './test-support.ts';

const ALL = ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'];
const signal = new AbortController().signal;

function parent(cwd: string, tools: string[], approve?: (request: string) => Promise<boolean>) {
  const fixture = admissionFixture({cwd: () => cwd, tools: () => tools, ...(approve ? {approve: (_title: string, request: string) => approve(request)} : {})});
  const workflow = fixture.admission.workflow(fixture.ctx);
  return {
    queue: (task: {cwd: string; tools?: string[]}) => fixture.admission.queue({task: 'inspect', ...task}, signal),
    admit: (task: {cwd: string; tools: string[]; extensions?: string[]}) => workflow.admit({task: 'inspect', ...task}, cwd),
    replay: (task: ValidTask) => workflow.replay(task, signal),
    read: workflow.read,
    identity: workflow.policyIdentity,
  };
}

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

test('delegation scope keeps only builtin tools the parent still holds', async () => workspace(async ({root}) => {
  const tools = async (held: string[]) => {
    const scoped = JSON.parse(parent(root, held).identity).tools;
    assert.deepEqual((await parent(root, held).queue({cwd: root})).task.tools, scoped);
    return scoped;
  };
  assert.deepEqual(await tools([...ALL, 'subagent', 'workflow']), ALL);
  assert.deepEqual(await tools(['read', 'bash', 'subagent']), ['read', 'bash']);
  assert.deepEqual(await tools(['subagent', 'workflow']), []);
}));

test('replay identity changes with the workspace or the granted tools', () => {
  const identity = (cwd: string, tools: string[]) => parent(cwd, tools).identity;
  assert.equal(identity('/workspace', ['read', 'bash']), identity('/workspace', ['bash', 'read', 'subagent']));
  assert.notEqual(identity('/workspace', ['read']), identity('/other', ['read']));
  assert.notEqual(identity('/workspace', ['read']), identity('/workspace', ['read', 'bash']));
});

test('builtin-only delegation retains the persisted version-one replay identity', () => {
  assert.equal(parent('/workspace', ['bash', 'read']).identity, '{"version":1,"cwd":"/workspace","tools":["read","bash"]}');
});

test('workspace paths inside the root are allowed and escapes are rejected', async () => workspace(async ({root, inside, outside, file}) => {
  const {read} = parent(root, ['read']);
  await read(root);
  await read(inside);
  await read(file);
  await assert.rejects(read(join(root, '..')), /outside parent workspace/);
  await assert.rejects(read(outside), /outside parent workspace/);
  await assert.rejects(parent(inside, ['read']).read(root), /outside parent workspace/);
}));

test('repository control data and credential files are rejected inside the root', async () => workspace(async ({root}) => {
  const {read} = parent(root, ['read']);
  for (const name of ['.git', '.pi', '.agents', 'credentials']) {
    await mkdir(join(root, name));
    await assert.rejects(read(join(root, name)), /sensitive or repository control data/);
  }
  for (const name of ['.env', '.env.local', 'AGENTS.md', 'CLAUDE.md', 'id_ed25519', 'credentials.json']) {
    await writeFile(join(root, name), 'x');
    await assert.rejects(read(join(root, name)), /sensitive or repository control data/);
  }
  await writeFile(join(root, 'environment'), 'x');
  await read(join(root, 'environment'));
}));

test('a sensitive component anywhere in the relative path is rejected, not only the leaf', async () => workspace(async ({root}) => {
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'config'), 'x');
  await assert.rejects(parent(root, ['read']).read(join(root, '.git', 'config')), /sensitive or repository control data/);
}));

test('child tasks may not exceed the parent workspace or its tools', async () => workspace(async ({root, inside, outside}) => {
  const {queue} = parent(root, ['read', 'grep', 'find', 'ls']);
  await queue({cwd: inside, tools: ['read', 'ls']});
  await assert.rejects(queue({cwd: outside, tools: ['read']}), /outside parent workspace/);
  await assert.rejects(queue({cwd: inside, tools: ['read', 'bash']}), /exceed parent permissions/);
  await assert.rejects(queue({cwd: inside, tools: ['unknown']}), /exceed parent permissions/);
}));

test('child extensions require absolute local files and explicit approval', async () => workspace(async ({root, inside, file}) => {
  const approvals: string[] = [];
  const {admit, replay} = parent(root, ['read'], async request => { approvals.push(request); return true; });
  const task = await admit({cwd: inside, tools: ['read'], extensions: [file]});
  await assert.rejects(replay({...task, extensions: ['relative.ts']}), /absolute local paths/);
  await assert.rejects(replay({...task, extensions: [inside]}), /must be a file/);
  await assert.rejects(parent(root, ['read']).replay(task), /was not approved/);
  await assert.rejects(parent(root, ['read'], async () => false).replay(task), /was not approved/);
  assert.deepEqual(approvals, []);
  await replay(task);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0], /host privileges/);
}));

test('workflow reads require the read tool and stay inside the parent workspace', async () => workspace(async ({root, outside, file}) => {
  await parent(root, ['read', 'bash']).read(file);
  await assert.rejects(parent(root, ['bash', 'edit']).read(file), /Read is outside parent permissions/);
  await assert.rejects(parent(root, ['read']).read(outside), /outside parent workspace/);
}));
