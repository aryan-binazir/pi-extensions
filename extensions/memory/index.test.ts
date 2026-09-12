import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import memory from './index.js';

let base: string;
const oldHome = process.env.HOME;
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
before(async () => { base = await mkdtemp(join(tmpdir(), 'pi-memory-test-')); process.env.HOME = join(base, 'home'); await mkdir(process.env.HOME); process.env.PI_CODING_AGENT_DIR = join(base, 'agent'); await mkdir(process.env.PI_CODING_AGENT_DIR); });
after(async () => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; await rm(base, { recursive: true, force: true }); });
function runtime(cwd: string) {
  let tool: ToolDefinition;
  const hooks = new Map<string, (event: any, ctx: any) => any>();
  memory({ registerTool: (value: ToolDefinition) => { tool = value; }, on: (name: string, callback: any) => hooks.set(name, callback) } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => true } as ExtensionContext;
  return { call: (params: object, signal?: AbortSignal) => tool.execute('test', params, signal, undefined, ctx), before: (systemPrompt = 'BASE') => hooks.get('before_agent_start')!({ systemPrompt }, ctx), ctx };
}

test('memory global CRUD, exact updates, limits, cancellation and secret rejection', async () => {
  const app = runtime(base);
  await app.call({ action: 'write', scope: 'global', name: 'preferences', content: 'Prefer concise answers.' });
  await app.call({ action: 'update', scope: 'global', name: 'preferences', old_text: 'concise', content: 'direct' });
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'global', name: 'preferences' })), /Prefer direct answers/);
  await assert.rejects(app.call({ action: 'update', scope: 'global', name: 'preferences', old_text: 'absent', content: 'x' }), /exactly once/);
  await assert.rejects(app.call({ action: 'write', scope: 'global', name: '../escape', content: 'x' }), /slug/);
  await assert.rejects(app.call({ action: 'write', scope: 'global', name: 'MEMORY.md', content: 'x'.repeat(4097) }), /4096/);
  await assert.rejects(app.call({ action: 'write', scope: 'global', name: 'secrets', content: 'password = hunter22' }), /sensitive/);
  await app.call({ action: 'delete', scope: 'global', name: 'preferences' });
  await assert.rejects(app.call({ action: 'read', scope: 'global', name: 'preferences' }), /ENOENT/);
});

test('project fallback, Git exclusion and symlink rejection protect external files', async () => {
  const { symlink, writeFile } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const project = join(base, 'fallback'); await mkdir(join(project, '.pi', 'memory'), { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const app = runtime(project);
  await app.call({ action: 'write', scope: 'project', name: 'topic', content: 'safe' });
  assert.equal(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  const external = join(base, 'external'); await writeFile(external, 'do not change');
  await symlink(external, join(project, '.pi', 'memory', 'linked.md'));
  await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'linked', content: 'bad' }), /symlink/);
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'linked' }), /ELOOP|symlink/);
  await assert.rejects(app.call({ action: 'delete', scope: 'project', name: 'linked' }), /symlink/);
  const unsafe = join(base, 'unsafe'); await mkdir(unsafe); await symlink(project, join(unsafe, '.agents'));
  await assert.rejects(runtime(unsafe).call({ action: 'write', scope: 'project', name: 'topic', content: 'bad' }), /symlink/);
});


test('memory rejects linked files and mid-write aborts without persisting contents or leaking temp files', async (t) => {
  const { link, writeFile } = await import('node:fs/promises');
  const project = join(base, 'hardlink'); await mkdir(join(project, '.agents', 'memory'), { recursive: true });
  const outside = join(base, 'private'); await writeFile(outside, 'private unrecognized content');
  await link(outside, join(project, '.agents', 'memory', 'linked.md'));
  const app = runtime(project);
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'linked' }), /linked|regular/);
  const controller = new AbortController();
  const dir = join(project, '.agents', 'memory');
  const originalOpen = fs.open;
  let temporaryWritten = false;
  const mockedOpen = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(join(dir, 'cancelled.md.')) && String(args[0]).endsWith('.tmp')) {
      const originalWriteFile = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await originalWriteFile(...writeArgs);
        assert.equal(await fs.readFile(args[0], 'utf8'), 'value');
        temporaryWritten = true;
        controller.abort();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'cancelled', content: 'value' }, controller.signal), /abort/i);
  } finally { mockedOpen.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(temporaryWritten, true);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.gitignore', 'linked.md']);
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'cancelled' }), /ENOENT/);
});


test('memory uses the configured agent directory and gates project scope on current trust', async () => {
  const { writeFile } = await import('node:fs/promises');
  const configured = join(process.env.PI_CODING_AGENT_DIR!, 'memory'); await mkdir(configured, { recursive: true });
  await writeFile(join(configured, 'configured.md'), 'Configured agent note');
  const project = join(base, 'untrusted'); await mkdir(join(project, '.agents', 'memory'), { recursive: true });
  await writeFile(join(project, '.agents', 'memory', 'MEMORY.md'), 'UNTRUSTED_PROJECT_INDEX');
  const app = runtime(project); app.ctx.isProjectTrusted = () => false;
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'global', name: 'configured' })), /Configured agent note/);
  for (const action of ['read', 'write', 'update', 'delete']) await assert.rejects(app.call({ action, scope: 'project', name: 'MEMORY.md', content: 'changed', old_text: 'UNTRUSTED_PROJECT_INDEX' }), /trust/i);
  assert.doesNotMatch((await app.before()).systemPrompt, /UNTRUSTED_PROJECT_INDEX/);
  app.ctx.isProjectTrusted = () => true;
  assert.match((await app.before()).systemPrompt, /UNTRUSTED_PROJECT_INDEX/);
});

test('interrupted ignore creation never publishes an empty file and can be retried', async (t) => {
  const project = join(base, 'ignore-interrupted'); const dir = join(project, '.agents', 'memory'); await mkdir(dir, { recursive: true });
  const path = join(dir, '.gitignore'); const app = runtime(project);
  const originalOpen = fs.open;
  let published: string | undefined;
  const mockedOpen = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(path)) {
      t.mock.method(handle, 'writeFile', async () => {
        published = await fs.readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
        throw new Error('interrupted ignore write');
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'topic', content: 'note' }), /interrupted ignore write/);
  } finally { mockedOpen.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(published, undefined);
  assert.deepEqual(await fs.readdir(dir), []);
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'topic' }), /ENOENT/);
  await app.call({ action: 'write', scope: 'project', name: 'topic', content: 'retry succeeds' });
  assert.equal(await fs.readFile(path, 'utf8'), '*\n');
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'project', name: 'topic' })), /retry succeeds/);
});

test('project writes repair empty and whitespace-only ignore files', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const project = join(base, 'ignore-repair'); const dir = join(project, '.agents', 'memory'); await mkdir(dir, { recursive: true });
  const app = runtime(project);
  for (const blank of ['', ' \t\r\n']) {
    await writeFile(join(dir, '.gitignore'), blank);
    const content = `repaired ${JSON.stringify(blank)}`;
    await app.call({ action: 'write', scope: 'project', name: 'topic', content });
    assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n');
    const result = await app.call({ action: 'read', scope: 'project', name: 'topic' });
    assert.deepEqual(result.content, [{ type: 'text', text: content }]);
  }
});

test('memory preserves existing ignore rules and refuses writes when complete exclusion is not proven', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const project = join(base, 'ignore-preserved'); const dir = join(project, '.agents', 'memory'); await mkdir(dir, { recursive: true });
  const path = join(dir, '.gitignore'); const safe = '# User-owned comments\n*.old\n*\n# End\n';
  await writeFile(path, safe);
  const app = runtime(project); await app.call({ action: 'write', scope: 'project', name: 'topic', content: 'safe note' });
  assert.equal(await readFile(path, 'utf8'), safe);
  const unsafe = '*\n!topic.md\n'; await writeFile(path, unsafe);
  await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'topic', content: 'must not be saved' }), /ignore/i);
  assert.equal(await readFile(path, 'utf8'), unsafe);
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'project', name: 'topic' })), /safe note/);
  const comments = ' \n# User-owned comment\n'; await writeFile(path, comments);
  await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'topic', content: 'must not be saved' }), /ignore/i);
  assert.equal(await readFile(path, 'utf8'), comments);
});

test('topic names cannot alias the index on case-insensitive filesystems', async () => {
  const app = runtime(base);
  await app.call({ action: 'write', scope: 'global', name: 'MEMORY.md', content: 'Index stays intact' });
  for (const name of ['memory', 'memory.md', 'Memory', 'Memory.md', 'MEMORY', 'MEMORY.MD']) {
    await assert.rejects(app.call({ action: 'write', scope: 'global', name, content: 'x'.repeat(8192) }), /reserved|slug/i);
  }
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'global', name: 'MEMORY.md' })), /Index stays intact/);
});

test('memory writes and reads explicit topics; only small index enters current project context', async () => {
  const project = join(base, 'project'); await mkdir(project);
  const app = runtime(project);
  await app.call({ action: 'write', scope: 'global', name: 'MEMORY.md', content: 'GLOBAL_INDEX_MARKER' });
  await app.call({ action: 'write', scope: 'project', name: 'architecture', content: 'TOPIC DETAILS' });
  await app.call({ action: 'write', scope: 'project', name: 'MEMORY.md', content: '- architecture: design decisions' });
  const topic = await app.call({ action: 'read', scope: 'project', name: 'architecture' });
  assert.match(JSON.stringify(topic), /TOPIC DETAILS/);
  const prompt = (await app.before()).systemPrompt;
  assert.match(prompt, /architecture: design decisions/);
  assert.doesNotMatch(prompt, /TOPIC DETAILS/);
  const second = join(base, 'second'); await mkdir(second); app.ctx.cwd = second;
  const isolated = (await app.before()).systemPrompt;
  assert.match(isolated, /GLOBAL_INDEX_MARKER/);
  assert.doesNotMatch(isolated, /architecture: design decisions|TOPIC DETAILS/);
});

test('overlapping registered memory calls retain both edits and respect delete ordering', async () => {
  const app = runtime(base);
  await app.call({ action: 'write', scope: 'global', name: 'concurrent', content: 'alpha beta' });
  await Promise.all([
    app.call({ action: 'update', scope: 'global', name: 'concurrent', old_text: 'alpha', content: 'ALPHA' }),
    app.call({ action: 'update', scope: 'global', name: 'concurrent', old_text: 'beta', content: 'BETA' }),
  ]);
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'global', name: 'concurrent' })), /ALPHA BETA/);
  await Promise.all([
    app.call({ action: 'update', scope: 'global', name: 'concurrent', old_text: 'ALPHA', content: 'finished' }),
    app.call({ action: 'delete', scope: 'global', name: 'concurrent' }),
  ]);
  await assert.rejects(app.call({ action: 'read', scope: 'global', name: 'concurrent' }), /ENOENT/);
  await app.call({ action: 'write', scope: 'global', name: 'after-failure', content: 'queue remains usable' });
  assert.match(JSON.stringify(await app.call({ action: 'read', scope: 'global', name: 'after-failure' })), /queue remains usable/);
});

test('memory enforces UTF-8, plain text, and the exact 32 KiB topic boundary', async () => {
  const { writeFile } = await import('node:fs/promises');
  const project = join(base, 'content-validation'); await mkdir(project);
  const app = runtime(project);
  await app.call({ action: 'write', scope: 'project', name: 'boundary', content: 'x'.repeat(32768) });
  const result = await app.call({ action: 'read', scope: 'project', name: 'boundary' });
  const text = result.content[0]; assert.ok(text.type === 'text'); assert.equal(text.text.length, 32768);
  await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'oversized', content: 'é'.repeat(16385) }), /32768/);
  await assert.rejects(app.call({ action: 'write', scope: 'project', name: 'control', content: 'before\x1b[2Jafter' }), /control/);
  const dir = join(project, '.agents', 'memory');
  await writeFile(join(dir, 'invalid-utf8.md'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'invalid-utf8' }), /encoded|encoding|utf/i);
  await writeFile(join(dir, 'external-control.md'), 'before\x00after');
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'external-control' }), /control/);
  await writeFile(join(dir, 'external-oversized.md'), 'x'.repeat(32769));
  await assert.rejects(app.call({ action: 'read', scope: 'project', name: 'external-oversized' }), /32768/);
});
