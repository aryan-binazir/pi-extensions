import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { catalog } from './catalog/index.ts';
import { parseSwitches, unknownIds } from './config.ts';
import hooks, { createHooks } from './index.ts';
import { withHooks } from './test-support.ts';
import type { Hook } from './types.ts';

test('the tracked switches parse, name only real hooks, and are the live file the extension reads', async () => {
  const ids = catalog.map(hook => hook.id);
  assert.equal(new Set(ids).size, ids.length, 'hook ids are unique');
  const path = fileURLToPath(new URL('../../personal-settings/hooks.yaml', import.meta.url));
  const text = await readFile(path, 'utf8');
  assert.deepEqual(unknownIds(parseSwitches(text), new Set(ids)), []);
  const handlers: Record<string, any> = {};
  hooks({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => 'tracked' } };
  const result = await handlers.tool_call({ type: 'tool_call', toolName: 'write', toolCallId: 'w', input: { path, content: `${text}  not-a-hook: true\n` } }, ctx);
  assert.match(result?.reason ?? '', /no hooks named: not-a-hook/, 'only the live file rejects unknown hooks');
});

const blockEcho: Hook = { id: 'block-echo', type: 'block', check: call => call.toolName === 'bash' && String(call.input.command).startsWith('echo') ? 'No echo.' : undefined };

test('an enabled block hook stops matching calls with its id, and a disabled one does nothing', async () => {
  await withHooks([blockEcho], 'hooks:\n  block-echo: true\n', async ({ call, configure }) => {
    assert.deepEqual(await call('bash', { command: 'echo hi' }), { block: true, reason: '[hooks: block-echo] No echo.' });
    assert.equal(await call('bash', { command: 'ls' }), undefined);
    await configure('hooks:\n  block-echo: false\n');
    assert.equal(await call('bash', { command: 'echo hi' }), undefined);
    await configure('hooks: {}\n');
    assert.equal(await call('bash', { command: 'echo hi' }), undefined);
  });
});

test('block hooks run in catalog order and a throwing block hook fails closed', async () => {
  const first: Hook = { id: 'first', type: 'block', check: () => 'First.' };
  const broken: Hook = { id: 'broken', type: 'block', check: () => { throw new Error('boom'); } };
  await withHooks([first, blockEcho, broken], 'hooks:\n  first: true\n  block-echo: true\n', async ({ call, configure }) => {
    assert.equal((await call('bash', { command: 'echo' })).reason, '[hooks: first] First.');
    await configure('hooks:\n  broken: true\n');
    assert.deepEqual(await call('read', { path: 'x' }), { block: true, reason: '[hooks: broken] The hook failed, so the call was blocked: boom' });
  });
});

const adviseLs: Hook = { id: 'advise-ls', type: 'advise', check: call => String(call.input.command).startsWith('ls') ? 'Prefer fd.' : undefined };

test('an enabled advise hook appends its note after the result and keeps structured content', async () => {
  const broken: Hook = { id: 'broken', type: 'advise', check: () => { throw new Error('boom'); } };
  await withHooks([broken, adviseLs], 'hooks:\n  broken: true\n  advise-ls: true\n', async ({ emit, configure }) => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
    const result = (command: string) => emit('tool_result', {
      toolName: 'bash', toolCallId: 'call', input: { command }, content: [{ type: 'text', text: 'a.txt' }, image],
      structuredContent: { files: ['a.txt'] }, details: { exitCode: 0 }, isError: false,
    });
    assert.deepEqual(await result('ls -la'), {
      content: [{ type: 'text', text: 'a.txt' }, image, { type: 'text', text: '[hooks: advise-ls] Prefer fd.' }],
      structuredContent: { files: ['a.txt'] },
    });
    assert.equal(await result('pwd'), undefined);
    await configure('hooks:\n  advise-ls: false\n');
    assert.equal(await result('ls'), undefined);
    await configure('{');
    assert.equal(await result('ls'), undefined);
  });
});

test('a failing gate sends a completed run back to work after earlier boundary entries, up to three times per prompt', async () => {
  let failing = true;
  const seen: unknown[] = [];
  const gate: Hook = { id: 'tests-pass', type: 'gate', check: context => { seen.push(context.cwd); return failing ? 'Tests fail.' : undefined; } };
  await withHooks([gate], 'hooks:\n  tests-pass: true\n', async ({ dir, emit }) => {
    const prior = { type: 'custom', customType: 'other' };
    const settle = (outcome = 'completed') => emit('agent_before_settle', { entries: [prior], continue: false, outcome, context: { canContinue: false } });
    const feedback = { type: 'custom_message', customType: 'hooks', content: '[hooks: tests-pass] Tests fail.', display: true };
    for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await settle(), { entries: [prior, feedback], continue: true });
    await emit('input', { text: 'nudge', source: 'extension' });
    assert.deepEqual(await settle(), { entries: [prior, {
      type: 'custom_message', customType: 'hooks', display: true,
      content: '[hooks: tests-pass] Still not done after 3 continuations, so the agent stopped: Tests fail.',
    }] });
    await emit('input', { text: 'try again', source: 'interactive' });
    assert.deepEqual(await settle(), { entries: [prior, feedback], continue: true });
    await emit('session_start', { reason: 'new' });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await settle()).continue, true);
    assert.equal(await settle('aborted'), undefined);
    assert.equal(await settle('error'), undefined);
    failing = false;
    assert.equal(await settle(), undefined);
    assert.ok(seen.every(cwd => cwd === dir));
  });
});

test('a throwing gate is reported without stopping later gates, and disabled gates do not run', async () => {
  const broken: Hook = { id: 'broken', type: 'gate', check: () => { throw new Error('boom'); } };
  const failing: Hook = { id: 'failing', type: 'gate', check: () => 'Not done.' };
  await withHooks([broken, failing], 'hooks:\n  broken: true\n', async ({ emit, configure }) => {
    const settle = () => emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed', context: { canContinue: false } });
    const failure = { type: 'custom_message', customType: 'hooks', content: '[hooks: broken] The gate failed and was skipped: boom', display: true };
    assert.deepEqual(await settle(), { entries: [failure] });
    await configure('hooks:\n  broken: true\n  failing: true\n');
    assert.deepEqual(await settle(), { entries: [failure, { type: 'custom_message', customType: 'hooks', content: '[hooks: failing] Not done.', display: true }], continue: true });
    await configure('hooks:\n  broken: false\n');
    assert.equal(await settle(), undefined);
    await configure('{');
    assert.equal(await settle(), undefined);
  });
});

test('switches for hooks this session has not loaded are reported once while known hooks keep running', async () => {
  await withHooks([blockEcho], 'hooks:\n  block-echo: true\n  pulled-hook: true\n', async ({ call, notices, configure }) => {
    assert.equal((await call('bash', { command: 'echo hi' }))?.reason, '[hooks: block-echo] No echo.');
    assert.equal(await call('bash', { command: 'ls' }), undefined);
    assert.deepEqual(notices, ['hooks.yaml switches on hooks this session has not loaded: pulled-hook. Run /reload to load them.']);
    await configure('hooks:\n  # every hook commented out\n');
    assert.equal(await call('bash', { command: 'echo hi' }), undefined, 'an empty hooks mapping switches everything off');
    assert.equal(notices.length, 1);
  });
});

test('a missing or malformed config blocks every tool except reads and questions', async () => {
  await withHooks([blockEcho], undefined, async ({ call, configure }) => {
    const invalid = [
      undefined, '', 'hooks: [block-echo]\n', 'hooks:\n  block-echo: yes\n', 'other: {}\nhooks: {}\n',
      'hooks:\n  block-echo: true\n  block-echo: false\n', 'hooks: {}\n---\nhooks:\n  block-echo: false\n', '{',
      'hooks: !!omap\n  - block-echo: true\n', 'hooks: !!set\n  ? block-echo\n',
    ];
    for (const text of invalid) {
      if (text !== undefined) await configure(text);
      for (const tool of ['bash', 'edit', 'write', 'subagent']) {
        const result = await call(tool, { command: 'ls', path: 'x' });
        assert.equal(result?.block, true, `${tool}: ${text}`);
        assert.match(result.reason, /^\[hooks\] .*hooks\.yaml is invalid: .+Ask the user to fix it/s, `${tool}: ${text}`);
      }
      for (const tool of ['read', 'grep', 'find', 'ls', 'questionnaire']) assert.equal(await call(tool, { path: 'x' }), undefined, `${tool}: ${text}`);
    }
  });
});

test('settle is subscribed only when the loaded catalog contains a gate, including disabled gates', () => {
  for (const [entries, expected] of [[catalog, 0], [[{ id: 'gate', type: 'gate', check: () => undefined }], 1]] as const) {
    const events: string[] = [];
    createHooks({ catalog: entries, configPath: '/unused/hooks.yaml' })({ on: (event: string) => { events.push(event); } } as any);
    assert.equal(events.filter(event => event === 'agent_before_settle').length, expected);
  }
});

test('same-size config edits and recovery from invalid config apply on the next event without reload', async () => {
  const other: Hook = { id: 'other-echo', type: 'block', check: () => 'Other.' };
  await withHooks([blockEcho, other], 'hooks:\n  block-echo: true\n', async ({ call, configure }) => {
    assert.match((await call('bash', { command: 'echo' })).reason, /block-echo/);
    await configure('hooks:\n  other-echo: true\n');
    assert.match((await call('bash', { command: 'echo' })).reason, /other-echo/);
    await configure('{');
    assert.match((await call('bash', { command: 'echo' })).reason, /is invalid/);
    await configure('hooks:\n  block-echo: true\n');
    assert.match((await call('bash', { command: 'echo' })).reason, /block-echo/);
  });
});

test('escaped gh commands and config paths remain protected across repeated and changing commands', async () => {
  await withHooks([...catalog], 'hooks:\n  draft-prs: true\n  no-admin-merge: true\n', async ({ call }) => {
    for (const command of [String.raw`g\h pr create`, String.raw`g\h pr create`, 'gh pr create --draft', String.raw`g\h pr merge --admin`, String.raw`rm personal-settings/hook\s.yaml`]) {
      const result = await call('bash', { command });
      if (command === 'gh pr create --draft') assert.equal(result, undefined);
      else assert.equal(result?.block, true, command);
    }
  });
});

test('protection uses fresh live switches after a cached event and still permits adding a hook', async () => {
  const other: Hook = { id: 'other-echo', type: 'block', check: () => undefined };
  await withHooks([blockEcho, other], 'hooks:\n  block-echo: true\n', async ({ call, configure, dir }) => {
    assert.equal(await call('read', { path: 'x' }), undefined);
    assert.equal(await call('write', { path: `${dir}/hooks.yaml`, content: 'hooks:\n  block-echo: true\n  other-echo: true\n' }), undefined);
    await configure('hooks:\n  block-echo: true\n  other-echo: true\n');
    assert.match((await call('write', { path: `${dir}/hooks.yaml`, content: 'hooks:\n  block-echo: true\n' })).reason, /switch off: other-echo/);
    await configure('{');
    assert.match((await call('write', { path: `${dir}/hooks.yaml`, content: 'hooks: {}\n' })).reason, /only the user can repair/);
  });
});
