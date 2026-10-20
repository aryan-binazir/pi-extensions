import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import claudeArtifacts from './index.ts';

const fakeClaude = fileURLToPath(new URL('../../tests/fixtures/fake-claude.mjs', import.meta.url));
const noTmux = spawnSync('tmux', ['-V']).status === 0 ? false : 'tmux is not installed';
const deck = { title: 'Deck', url: 'https://claude.ai/artifact/6NpfWe2dnXZorqLXk5wV7Z', updatedAt: '2026-10-17T21:42:45Z' };

async function setup(t: TestContext, scenario: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-claude-artifacts-'));
  const bin = join(root, 'bin'), cwd = join(root, 'project');
  await mkdir(bin); await mkdir(cwd);
  await writeFile(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`); await chmod(join(bin, 'claude'), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(root, 'agent'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    FAKE_CLAUDE_SCENARIO: JSON.stringify(scenario), FAKE_CLAUDE_LOG: join(root, 'fake.jsonl') };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const handlers = new Map<string, (...args: any[]) => Promise<void>>(); const tools = new Map<string, any>();
  claudeArtifacts({ on(name: string, handler: any) { handlers.set(name, handler); }, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  const confirms: string[] = [];
  const ctx = { cwd, hasUI: true, ui: { confirm: async (_title: string, message: string) => { confirms.push(message); return true; } } };
  t.after(async () => {
    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  const fakeLog = async () => (await readFile(env.FAKE_CLAUDE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, cwd, ctx, tools, handlers, confirms, fakeLog, run: (name: string, params: object, context: object = ctx, signal?: AbortSignal) => tools.get(name).execute(`call-${name}`, params, signal, undefined, context) };
}

test('list returns the artifacts Claude Code reports', { skip: noTmux }, async t => {
  const { run } = await setup(t, { responses: { list: { artifacts: [deck], total: 1, pins_enabled: true } } });
  const result = await run('claude_artifact_list', {});
  assert.deepEqual(result.details, { artifacts: [deck], total: 1 });
  assert.match(result.content[0].text, /Deck/);
});

test('a folder-trust dialog stops the job and says how to trust the helper folder once', { skip: noTmux }, async t => {
  const { run, root } = await setup(t, { screen: 'Accessing workspace:\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder' });
  await assert.rejects(run('claude_artifact_list', {}), (error: Error) => /trust/i.test(error.message) && error.message.includes(join(root, 'agent', 'claude-artifacts', 'helper')));
});

test('a Claude Code that exits during startup fails the job with its last screen', { skip: noTmux }, async t => {
  const { run } = await setup(t, { exit: true });
  await assert.rejects(run('claude_artifact_list', {}), /fake claude exited/);
});

const page = '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3 numbers</h1></body></html>\n';
const pageHash = createHash('sha256').update(page).digest('hex');
const published = { url: 'https://claude.ai/artifact/1Tnqd5SZSshD1VHdpDgJW8', artifact_id: '03bd963d-ef4b-4a48-b88f-faaee477cc35', title: 'Q3', updated: false, owned: true, icon: 'chart', audience: 'owner', seq: 1, version: '1792524027-15b0', warnings: ['The document\'s own <title> names this artifact.'], contract: '0.0.0', liveSubscription: 'arming' };

test('publish refuses without an approval dialog and never starts Claude Code', async t => {
  const { run, cwd, ctx, fakeLog } = await setup(t);
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_publish', { path: 'q3.html' }, { ...ctx, hasUI: false }), /approval/);
  await assert.rejects(fakeLog(), /ENOENT/);
});

test('a declined publish never starts Claude Code and leaves no staged copy', async t => {
  const { run, cwd, ctx, root, fakeLog } = await setup(t);
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_publish', { path: 'q3.html' }, { ...ctx, ui: { confirm: async () => false } }), /declined/);
  await assert.rejects(fakeLog(), /ENOENT/);
  assert.deepEqual(await readdir(join(root, 'agent', 'claude-artifacts', 'helper')).catch(() => []), []);
});

test('an approved publish shows the staged page, survives a forced call and returns the new artifact', { skip: noTmux }, async t => {
  const { run, cwd, root, confirms, fakeLog } = await setup(t, { calls: [{ from: 0, add: { force: true } }, { from: 0, add: { icon: 'chart' } }], responses: { publish: published } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_publish', { path: 'q3.html', title: 'Q3 numbers' });
  assert.deepEqual(result.details, { url: published.url, version: '1792524027-15b0', title: 'Q3', artifactId: published.artifact_id, audience: 'owner', warnings: published.warnings });
  assert.match(confirms[0], new RegExp(`${join(cwd, 'q3.html')}[\\s\\S]*Q3 numbers[\\s\\S]*${pageHash}[\\s\\S]*<h1>Q3 numbers</h1>`));
  const calls = (await fakeLog()).filter(entry => entry.event === 'PreToolUse');
  assert.deepEqual(calls.map(entry => entry.output.hookSpecificOutput.permissionDecision), ['deny', 'allow']);
  assert.equal(calls[1].body.tool_input.file_path, 'q3.html');
  assert.equal(calls[1].body.tool_input.title, 'Q3 numbers');
  assert.deepEqual(await readdir(join(root, 'agent', 'claude-artifacts', 'helper')), []);
});

const liveSource = '[Artifact 03bd963d (version 1792524210-5480) — owned by you, private; raw HTML follows]\n<html><body><h1>Q3 numbers (edited in the page)</h1></body></html>';
const read = (ver: string) => ({ read: { bytes: 650, code: 200, codeText: 'OK', result: liveSource, url: published.url, title: 'Q3' }, artifactRead: { slug: published.artifact_id, ver }, owned: true });
const updated = { ...published, updated: true, seq: 2, version: '1792524571-abe6', warnings: undefined };

test('update reads the live artifact and republishes when it is still at base_version', { skip: noTmux }, async t => {
  const { run, cwd, confirms, fakeLog } = await setup(t, { responses: { read: read('1792524027-15b0'), publish: updated } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' });
  assert.deepEqual(result.details, { published: true, url: published.url, version: '1792524571-abe6', baseVersion: '1792524027-15b0' });
  assert.match(confirms[0], new RegExp(`${published.url}[\\s\\S]*1792524027-15b0`));
  const allowed = (await fakeLog()).filter(entry => entry.event === 'PreToolUse').map(entry => entry.body.tool_input);
  assert.deepEqual(allowed.map(input => input.action), ['read', 'publish']);
  assert.equal(allowed[1].url, published.url);
});

test('update publishes nothing when the live artifact moved past base_version, and saves the live source', { skip: noTmux }, async t => {
  const { run, cwd, fakeLog } = await setup(t, { responses: { read: read('1792524210-5480'), publish: updated } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' });
  assert.equal(result.details.published, false);
  assert.equal(result.details.liveVersion, '1792524210-5480');
  assert.equal(await readFile(result.details.sourceFile, 'utf8'), liveSource);
  assert.ok(!(await fakeLog()).some(entry => entry.event === 'PreToolUse' && entry.body.tool_input.action === 'publish'));
});

test('a publish the service refuses because someone else published first comes back as a conflict', { skip: noTmux }, async t => {
  const refusal = 'Publish refused — nothing was merged or published: a newer version (1792524802-1a28) published by another session or agent at 2026-10-20T19:33:22Z is live and this publish was not built on it.\n<cowritten-artifact-html>\n<h1>B</h1>\n</cowritten-artifact-html>';
  const { run, cwd } = await setup(t, { responses: { read: read('1792524027-15b0') }, failures: { publish: refusal } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' });
  assert.deepEqual([result.details.published, result.details.liveVersion], [false, '1792524802-1a28']);
  assert.equal(await readFile(result.details.sourceFile, 'utf8'), refusal);
});

test('any other Artifact failure is an error, not a conflict', { skip: noTmux }, async t => {
  const { run, cwd } = await setup(t, { responses: { read: read('1792524027-15b0') }, failures: { publish: 'Request failed with status 401: sign in again' } });
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' }), /status 401/);
});

test('read needs no approval and saves the live source for the model', { skip: noTmux }, async t => {
  const { run, ctx, confirms } = await setup(t, { responses: { read: read('1792524210-5480') } });
  const result = await run('claude_artifact_read', { url: published.url }, { ...ctx, hasUI: false });
  assert.deepEqual({ ...result.details, sourceFile: undefined }, { url: published.url, title: 'Q3', version: '1792524210-5480', owned: true, sourceFile: undefined });
  assert.equal(await readFile(result.details.sourceFile, 'utf8'), liveSource);
  assert.deepEqual(confirms, []);
});

test('a finished job deletes the transcript and session folders the hidden session wrote', { skip: noTmux }, async t => {
  const { run, root } = await setup(t, { responses: { list: { artifacts: [deck], total: 1 } } });
  await run('claude_artifact_list', {});
  assert.deepEqual(await readdir(join(root, 'claude', 'projects')), []);
  assert.deepEqual(await readdir(join(root, 'claude', 'scratch')), []);
  assert.deepEqual(await readdir(join(root, 'agent', 'claude-artifacts', 'helper')), []);
});

test('cleanup leaves another session\'s fresh scratchpad in the helper folder alone', { skip: noTmux }, async t => {
  const { run, root } = await setup(t, { responses: { list: { artifacts: [], total: 0 } }, foreignScratchpad: true });
  await run('claude_artifact_list', {});
  const helperState = join(root, 'claude', 'scratch', join(root, 'agent', 'claude-artifacts', 'helper').replace(/[^A-Za-z0-9]/g, '-'));
  assert.equal((await readdir(helperState)).length, 1);
});

test('a hidden session that ignores the hangup is killed before its files are deleted', { skip: noTmux }, async t => {
  const { run, root, fakeLog } = await setup(t, { responses: { list: { artifacts: [], total: 0 } }, ignoreHangup: true });
  await run('claude_artifact_list', {});
  const { pid } = (await fakeLog()).find(entry => entry.argv?.[0] !== '--version');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await delay(200);
  assert.deepEqual(await readdir(join(root, 'claude', 'projects')), []);
});

test('a publish that fails without a refusal may still have gone through, so its outcome is unknown', { skip: noTmux }, async t => {
  const { run, cwd } = await setup(t, { failures: { publish: 'Request failed: socket hang up' } });
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_publish', { path: 'q3.html' }), /socket hang up[\s\S]*outcome is unknown/);
});

test('an update whose read has no version is an error, not a conflict', { skip: noTmux }, async t => {
  const { run, cwd } = await setup(t, { responses: { read: { read: { code: 401, codeText: 'Unauthorized' } } } });
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' }), /unexpected read result/);
});

test('cleanup leaves files alone that the session did not create under its own id', { skip: noTmux }, async t => {
  const { root, run } = await setup(t);
  const keep = join(root, 'keep'), busy = join(root, 'claude', 'scratch', 'other-session', 'scratchpad');
  await mkdir(join(keep, 'scratchpad'), { recursive: true }); await writeFile(join(keep, 'notes.jsonl'), 'mine');
  await mkdir(busy, { recursive: true }); await writeFile(join(busy, 'work.txt'), 'in use');
  process.env.FAKE_CLAUDE_SCENARIO = JSON.stringify({ responses: { list: { artifacts: [], total: 0 } }, transcriptPath: join(keep, 'notes.jsonl'), scratchpadDir: join(keep, 'scratchpad') });
  await run('claude_artifact_list', {});
  assert.deepEqual((await readdir(keep)).sort(), ['notes.jsonl', 'scratchpad']);
  assert.deepEqual(await readdir(busy), ['work.txt']);
});

test('a cancelled publish that Claude Code may already have sent says its outcome is unknown', { skip: noTmux }, async t => {
  const { run, cwd, fakeLog } = await setup(t, { stall: 'publish' });
  await writeFile(join(cwd, 'q3.html'), page);
  const controller = new AbortController();
  const job = run('claude_artifact_publish', { path: 'q3.html' }, undefined, controller.signal);
  while (!(await fakeLog().catch(() => [])).some(entry => entry.event === 'PreToolUse')) await delay(50);
  controller.abort();
  await assert.rejects(job, /outcome is unknown[\s\S]*claude_artifact_list/);
});

test('cancelling before any upload is allowed simply cancels', { skip: noTmux }, async t => {
  const { run } = await setup(t, { screen: 'Starting…' });
  const controller = new AbortController();
  const job = run('claude_artifact_list', {}, undefined, controller.signal);
  await delay(300); controller.abort();
  await assert.rejects(job, (error: Error) => /cancelled/.test(error.message) && !/unknown/.test(error.message));
});

test('Pi shutdown stops a running job', { skip: noTmux }, async t => {
  const { run, handlers, ctx } = await setup(t, { stall: 'list' });
  const job = run('claude_artifact_list', {});
  await delay(300);
  await handlers.get('session_shutdown')!({ type: 'session_shutdown' }, ctx);
  await assert.rejects(job, /cancelled/);
});

test('an older Claude Code is refused before any session starts', { skip: noTmux }, async t => {
  const { run, fakeLog } = await setup(t, { version: '2.1.200' });
  await assert.rejects(run('claude_artifact_list', {}), /2\.1\.302/);
  assert.ok((await fakeLog()).every(entry => entry.argv?.[0] === '--version'));
});

test('the hidden session runs restricted, without API-key or provider overrides, on the user\'s login', { skip: noTmux }, async t => {
  const { run, fakeLog } = await setup(t, { responses: { list: { artifacts: [], total: 0 } } });
  const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await run('claude_artifact_list', {});
  const session = (await fakeLog()).find(entry => entry.argv && entry.argv[0] !== '--version');
  assert.deepEqual(session.env, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test', CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, DISABLE_AUTOUPDATER: '1' });
  for (const flag of ['--restricted', '--strict-mcp-config', 'dontAsk', 'Artifact,Read', 'haiku']) assert.ok(session.argv.includes(flag), flag);
});

test('Claude Code stopping without the planned call fails with its last message', { skip: noTmux }, async t => {
  const { run } = await setup(t, { calls: [], lastMessage: 'I would rather not.' });
  await assert.rejects(run('claude_artifact_list', {}), /I would rather not/);
});

test('repeated calls outside the plan end the job', { skip: noTmux }, async t => {
  const { run } = await setup(t, { calls: [{ input: { action: 'delete' } }, { tool: 'Bash', input: { command: 'ls' } }, { input: { action: 'list', scope: 'all' } }, { from: 0 }] });
  await assert.rejects(run('claude_artifact_list', {}), /kept making calls/);
});

test('a permission prompt in the hidden session ends the job instead of waiting for an answer', { skip: noTmux }, async t => {
  const { run, fakeLog } = await setup(t, { events: [{ event: 'PermissionRequest', body: { tool_name: 'Artifact', tool_input: { action: 'share' } } }], stall: 'list' });
  await assert.rejects(run('claude_artifact_list', {}), /permission/);
  const request = (await fakeLog()).find(entry => entry.event === 'PermissionRequest');
  assert.equal(request.output.hookSpecificOutput.decision.behavior, 'deny');
});

test('once a job has failed, the hooks allow nothing more', { skip: noTmux }, async t => {
  const { run, cwd, fakeLog } = await setup(t, { events: [{ event: 'PermissionRequest', body: { tool_name: 'Artifact', tool_input: { action: 'share' } } }], responses: { publish: published } });
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_publish', { path: 'q3.html' }), /permission/);
  assert.ok(!(await fakeLog()).some(entry => entry.event === 'PreToolUse' && entry.output?.hookSpecificOutput?.permissionDecision === 'allow'));
});

test('an update publishes only after the read result shows base_version, even when both calls are asked at once', { skip: noTmux }, async t => {
  const { run, cwd, fakeLog } = await setup(t, { parallel: true, responses: { read: read('1792524210-5480'), publish: updated } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' });
  assert.equal(result.details.published, false);
  const decisions = (await fakeLog()).filter(entry => entry.event === 'PreToolUse').map(entry => [entry.body.tool_input.action, entry.output?.hookSpecificOutput?.permissionDecision]);
  assert.deepEqual(decisions, [['read', 'allow'], ['publish', 'deny']]);
});

test('cancelling while the approval dialog is open is a cancellation, not a decline', async t => {
  const { run, cwd, ctx } = await setup(t);
  await writeFile(join(cwd, 'q3.html'), page);
  const controller = new AbortController();
  const confirm = (_title: string, _message: string, options: { signal: AbortSignal }) => new Promise<boolean>(resolve => options.signal.addEventListener('abort', () => resolve(false)));
  const job = run('claude_artifact_publish', { path: 'q3.html' }, { ...ctx, ui: { confirm } }, controller.signal);
  await delay(50); controller.abort();
  await assert.rejects(job, (error: Error) => !/declined/.test(error.message));
});

test('a refusal that names no live version points the model to claude_artifact_read', { skip: noTmux }, async t => {
  const refusal = "You hadn't viewed the live version of this artifact, so the publish was refused.";
  const { run, cwd } = await setup(t, { responses: { read: read('1792524027-15b0') }, failures: { publish: refusal } });
  await writeFile(join(cwd, 'q3.html'), page);
  const result = await run('claude_artifact_update', { path: 'q3.html', url: published.url, base_version: '1792524027-15b0' });
  assert.deepEqual([result.details.published, result.details.liveVersion], [false, undefined]);
  assert.match(result.details.reason, /claude_artifact_read/);
});

test('a result missing the fields the tool reports is an error, not an empty success', { skip: noTmux }, async t => {
  const { run } = await setup(t, { responses: { list: { items: [] } } });
  await assert.rejects(run('claude_artifact_list', {}), /unexpected/);
});

test('a publish that went through but fails verification says it may be live and where', { skip: noTmux }, async t => {
  const { run, cwd } = await setup(t, { responses: { publish: { ...published, path: '/home/ar/.ssh/config' } } });
  await writeFile(join(cwd, 'q3.html'), page);
  await assert.rejects(run('claude_artifact_publish', { path: 'q3.html' }), new RegExp(`${published.url}[\\s\\S]*not the approved file`));
});

test('Claude Code dying after the job started fails it without waiting for the timeout', { skip: noTmux }, async t => {
  const { run } = await setup(t, { exitAfterPrompt: true });
  const started = Date.now();
  await assert.rejects(run('claude_artifact_list', {}), /exited/);
  assert.ok(Date.now() - started < 10_000);
});

test('a signed-out Claude Code stops the job with a sign-in instruction', { skip: noTmux }, async t => {
  const { run } = await setup(t, { screen: 'Select login method:\n ❯ 1. Claude account with subscription' });
  await assert.rejects(run('claude_artifact_list', {}), /not signed in/);
});

test('a Claude Code turn that fails outright ends the job with its error', { skip: noTmux }, async t => {
  const { run } = await setup(t, { events: [{ event: 'StopFailure', body: { error: 'rate_limit: try again later' } }], stall: 'list' });
  await assert.rejects(run('claude_artifact_list', {}), /rate_limit/);
});

test('the approval preview shows the first lines and marks the rest as clipped', async t => {
  const { run, cwd, ctx } = await setup(t);
  const long = Array.from({ length: 40 }, (_, line) => `<p>line ${line + 1}</p>`).join('\n');
  await writeFile(join(cwd, 'long.html'), long);
  let shown = '';
  await assert.rejects(run('claude_artifact_publish', { path: 'long.html' }, { ...ctx, ui: { confirm: async (_title: string, message: string) => { shown = message; return false; } } }), /declined/);
  assert.match(shown, /<p>line 20<\/p>\n…$/);
  assert.doesNotMatch(shown, /line 21/);
});

test('publish refuses pages over 10 MiB before asking', async t => {
  const { run, cwd, confirms } = await setup(t);
  await writeFile(join(cwd, 'big.html'), Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
  await assert.rejects(run('claude_artifact_publish', { path: 'big.html' }), /larger than 10 MiB/);
  assert.deepEqual(confirms, []);
});

test('publish accepts only an HTML page', async t => {
  const { run, cwd } = await setup(t);
  await writeFile(join(cwd, 'notes.txt'), 'notes');
  await assert.rejects(run('claude_artifact_publish', { path: 'notes.txt' }), /\.html/);
});
