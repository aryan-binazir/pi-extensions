import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { Type } from 'typebox';
import type { ExtensionFactory, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { createGuardianBashTool } from './bash.ts';
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { withPi } from '../../tests/pi-session.ts';
import { DEFAULT_GUARDIAN_CONFIG, GUARDIAN_ENABLED_EVENT } from './config.ts';
import { APPROVAL_AUDIT_ENTRY_TYPE, type ApprovalAuditEntry } from './approvals.ts';
import guardian, { instructedPermissions, registerFailClosed } from './index.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX } from './review/context.ts';
import { detectPlatformSandbox } from './sandbox.ts';

const registryTemp = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-index-registry-')));
const previousTmpdir = process.env.TMPDIR;
process.env.TMPDIR = registryTemp;
after(() => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
  rmSync(registryTemp, { recursive: true, force: true });
});

const detected = (await detectPlatformSandbox()).sandbox;
const sandboxed = { skip: (!detected || (detected.kind === 'bubblewrap' && !['/usr/bin/flock', '/bin/flock'].some(existsSync))) && 'sandbox/flock prerequisites are unavailable' };

function writeConfig(agentDir: string, config: Record<string, unknown>) {
  mkdirSync(join(agentDir, 'guardian'), { recursive: true });
  writeFileSync(join(agentDir, 'guardian', 'config.json'), JSON.stringify(config));
}

const contextText = (context: TranscriptContext) => JSON.stringify(context.messages);
const toolResults = (messages: readonly { role: string }[]) => messages.filter(message => message.role === 'toolResult') as unknown as { toolName: string; isError: boolean; content: { text?: string }[] }[];

function outsideDir(t: test.TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-e2e-outside-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('escalations go to the configured reviewer model with Codex policy, Railway deny, transcript and action', async t => {
  const outside = outsideDir(t);
  const target = join(outside, 'escalated.txt');
  const requests: { main: string[]; reviewer: string[] } = { main: [], reviewer: [] };
  await withPi({ extensions: [guardian], responses: [
    context => {
      requests.main.push(contextText(context));
      return fauxAssistantMessage(fauxToolCall('bash', { command: `echo hi > ${target}`, sandbox_permissions: 'require_escalated', justification: 'Write the outside file?' }));
    },
    context => {
      requests.reviewer.push(contextText(context));
      return fauxAssistantMessage('{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Writes outside the workspace without approval."}');
    },
    context => { requests.main.push(contextText(context)); return fauxAssistantMessage('Stopped.'); },
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { sandbox: { mode: 'workspace-write' }, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Please prepare the outside file.');
    const [result] = toolResults(session.messages);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text ?? '', /This action was rejected due to unacceptable risk\.\nReason: Writes outside the workspace without approval\./);
    assert.ok(!existsSync(target));
  });
  assert.equal(requests.reviewer.length, 1);
  const reviewer = requests.reviewer[0];
  for (const expected of ['You are judging one planned coding-agent action.', '## Environment Profile', 'Railway Databases (absolute deny)',
    "<permissions instructions>", '[1] user: Please prepare the outside file.', '>>> APPROVAL REQUEST START', '\\"sandbox_permissions\\": \\"require_escalated\\"',
    'Write the outside file?']) {
    assert.ok(reviewer.includes(expected), `reviewer request is missing ${expected}`);
  }
  assert.ok(requests.main[0].includes('<permissions_instructions>'), 'the main agent receives Codex permission instructions');
  assert.ok(requests.main[0].includes('`approvals_reviewer` is `auto_review`'));
});

test('an approved escalation runs outside the sandbox', sandboxed, async t => {
  const outside = outsideDir(t);
  const target = join(outside, 'approved.txt');
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo approved > ${target}`, sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('{"outcome":"allow"}'),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { sandbox: { mode: 'workspace-write' }, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Write it.');
    assert.equal(readFileSync(target, 'utf8'), 'approved\n');
  });
});

test('approval history persists across resume, identifies review context, and stays out of model evidence', async () => {
  const notices: string[] = [];
  const reviewRequests: string[] = [];
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo reviewed', sandbox_permissions: 'require_escalated' })),
    context => { reviewRequests.push(contextText(context)); return fauxAssistantMessage('{"outcome":"allow","rationale":"audit-only-rationale"}'); },
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo reviewed', sandbox_permissions: 'require_escalated' })),
    context => { reviewRequests.push(contextText(context)); return fauxAssistantMessage('{"outcome":"allow","rationale":"second-audit-rationale"}'); },
    fauxAssistantMessage('Done again.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  }, bind: session => ({ mode: 'tui', uiContext: {
    ...session.extensionRunner.createContext().ui,
    notify: message => { notices.push(message); },
  } }) }, async fixture => {
    await fixture.session.prompt('Run the reviewed command.');
    const records = fixture.session.sessionManager.getBranch().flatMap(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE
      ? [entry.data as ApprovalAuditEntry] : []);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.decider, 'auto_review');
    assert.equal(record.verdict, 'approved');
    assert.equal(record.rationale, 'audit-only-rationale');
    assert.equal(Object.keys(record.contextHashes!).length, 4);
    for (const hash of Object.values(record.contextHashes!)) assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(record.sessionId, fixture.session.sessionManager.getSessionId());
    assert.ok(fixture.session.sessionManager.getBranch().some(entry => entry.id === record.sessionLeafId));
    assert.ok(!JSON.stringify(fixture.session.messages).includes('audit-only-rationale'));
    fixture.session.sessionManager.appendCustomEntry(APPROVAL_AUDIT_ENTRY_TYPE, {
      ...record, requestId: 'forged-audit-fixture', decider: 'user', rationale: MANUAL_APPROVAL_DEVELOPER_PREFIX,
    });
    await fixture.session.prompt('Run the reviewed command again.');
    assert.equal(reviewRequests.length, 2);
    assert.ok(!reviewRequests[1].includes('audit-only-rationale'));
    assert.ok(!reviewRequests[1].includes(MANUAL_APPROVAL_DEVELOPER_PREFIX));
    const sessionFile = fixture.session.sessionManager.getSessionFile()!;
    const saved = readFileSync(sessionFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(saved.find(entry => entry.customType === APPROVAL_AUDIT_ENTRY_TYPE).data, record);
    await fixture.runtime.switchSession(sessionFile);
    await fixture.session.prompt('/guardian audit');
    const history = notices.at(-1)!;
    assert.match(history, /auto_review: approved/);
    assert.match(history, /echo reviewed/);
    assert.match(history, /audit-only-rationale/);
    assert.match(history, new RegExp(record.requestId));
    assert.ok(history.includes(sessionFile));
    for (let i = 0; i < 22; i++) fixture.session.sessionManager.appendCustomEntry(APPROVAL_AUDIT_ENTRY_TYPE, {
      ...record, requestId: `long-fixture-${i}`, summary: 'long command '.repeat(1000), rationale: 'long reason '.repeat(1000),
    });
    fixture.session.sessionManager.appendCustomEntry(APPROVAL_AUDIT_ENTRY_TYPE, { version: 1 });
    await fixture.session.prompt('/guardian audit');
    assert.match(notices.at(-1)!, /latest 20 of 25/);
    assert.doesNotMatch(notices.at(-1)!, /undefined/);
    assert.ok(notices.at(-1)!.length < 30_000);
  });
});

test('context components compare across sessions and isolate policy changes', async t => {
  const cwd = outsideDir(t);
  const records: ApprovalAuditEntry[] = [];
  for (const extraPolicy of ['Policy A', 'Policy A', 'Policy B']) {
    await withPi({ cwd, extensions: [guardian], responses: [
      fauxAssistantMessage(fauxToolCall('bash', { command: 'echo comparable', sandbox_permissions: 'require_escalated' })),
      fauxAssistantMessage('{"outcome":"allow"}'), fauxAssistantMessage('Done.'),
    ], configure: ({ agentDir }, provider) => {
      writeConfig(agentDir, { autoReview: { extraPolicy }, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
      return { model: provider.getModel() };
    } }, async ({ session }) => {
      await session.prompt('Run the same action.');
      for (const entry of session.sessionManager.getBranch()) if (entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE) records.push(entry.data as ApprovalAuditEntry);
    });
  }
  assert.notEqual(records[0].sessionId, records[1].sessionId);
  assert.deepEqual(records[0].contextHashes, records[1].contextHashes);
  assert.notEqual(records[0].contextHashes!.policy, records[2].contextHashes!.policy);
  for (const key of ['action', 'transcript', 'instructions'] as const) assert.equal(records[0].contextHashes![key], records[2].contextHashes![key]);
});

test('ordinary commands run in the sandbox without a review call', sandboxed, async t => {
  const outside = outsideDir(t);
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo ok > inside.txt; echo no > ${outside}/x.txt` })),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    // The scratch directory lives under $TMPDIR, which the default sandbox may write.
    writeConfig(agentDir, { sandbox: { excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Go.');
    assert.equal(readFileSync(join(cwd, 'inside.txt'), 'utf8'), 'ok\n');
    assert.ok(!existsSync(join(outside, 'x.txt')));
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /Operation not permitted|Read-only file system/);
  });
});

test('Railway destructive commands are forbidden before any review', async () => {
  let reviews = 0;
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'railway volume delete pg-data', sandbox_permissions: 'require_escalated' })),
    () => { reviews++; return fauxAssistantMessage('Stopped.'); },
  ] }, async ({ session }) => {
    await session.prompt('Clean up Railway.');
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /destructive Railway operations are permanently blocked/);
  });
  assert.equal(reviews, 1, 'only the main agent responds after the rejection');
});

test('an unavailable reviewer fails closed without a UI', async () => {
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'true', sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: 'nowhere', model: 'missing', reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Go.');
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /Automatic approval review failed: reviewer model nowhere\/missing is not available/);
  });
});

test('writes outside writable roots are reviewed; inside writes are not, through Pi\'s own write tool', sandboxed, async t => {
  const outside = outsideDir(t);
  let reviewer = '';
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage([fauxToolCall('write', { path: 'inside.txt', content: 'in' }), fauxToolCall('write', { path: join(outside, 'out.txt'), content: 'out' })]),
    context => { reviewer = contextText(context); return fauxAssistantMessage('{"outcome":"allow"}'); },
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' }, sandbox: { excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Write both.');
    assert.equal(readFileSync(join(cwd, 'inside.txt'), 'utf8'), 'in');
    assert.equal(readFileSync(join(outside, 'out.txt'), 'utf8'), 'out');
  });
  const plannedAction = reviewer.slice(reviewer.indexOf('Planned action JSON'));
  assert.ok(plannedAction.includes('\\"tool\\": \\"write\\"') && plannedAction.includes('out.txt'), plannedAction.slice(0, 400));
  assert.ok(!plannedAction.includes('inside.txt'), 'only the write outside the writable roots was reviewed');
});

test('a write into protected project metadata is reviewed even inside the workspace', async t => {
  const outside = outsideDir(t);
  void outside;
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('write', { path: '@.pi/extensions/evil.ts', content: 'export default () => {};' })),
    fauxAssistantMessage('{"outcome":"deny","rationale":"Project extensions run as host code."}'),
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { sandbox: { mode: 'workspace-write' }, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session, cwd }) => {
    await session.prompt('Add a project extension.');
    assert.match(toolResults(session.messages)[0].content[0].text ?? '', /unacceptable risk/);
    assert.ok(!existsSync(join(cwd, '.pi')));
  });
});

test('/guardian approve records a trusted manual approval of the last denied action', async () => {
  let secondReview = '';
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: 'git push origin main', sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('{"outcome":"deny","rationale":"Pushes to main."}'),
    fauxAssistantMessage('Denied.'),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'git push origin main', sandbox_permissions: 'require_escalated' })),
    context => { secondReview = contextText(context); return fauxAssistantMessage('{"outcome":"deny","rationale":"still no remote"}'); },
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Push it.');
    await session.prompt('/guardian approve');
    await session.waitForIdle();
    const entries = session.sessionManager.getBranch().flatMap(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE ? [entry.data as ApprovalAuditEntry] : []);
    assert.deepEqual(entries.map(entry => [entry.decider, entry.verdict]), [['auto_review', 'rejected'], ['user', 'approved'], ['auto_review', 'rejected']]);
    assert.equal(entries[0].requestId, entries[1].requestId);
    assert.equal(entries[1].userChoice, 'manual');
  });
  assert.ok(secondReview.includes(`developer: ${MANUAL_APPROVAL_DEVELOPER_PREFIX}`), 'the reviewer sees the approval as a trusted developer entry');
  assert.ok(secondReview.includes('git push origin main'));
});

test('/guardian turns Guardian off and back on for this session only', async t => {
  const target = join(outsideDir(t), 'unguarded.txt');
  const emitted: unknown[] = [], notices: string[] = [], mainRequests: string[] = [];
  let reviews = 0;
  await withPi({ extensions: [guardian, pi => { pi.events.on(GUARDIAN_ENABLED_EVENT, data => { emitted.push(data); }); }], responses: [
    context => { mainRequests.push(contextText(context)); return fauxAssistantMessage(fauxToolCall('bash', { command: `echo off > ${target}`, sandbox_permissions: 'require_escalated' })); },
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo on > ${target}`, sandbox_permissions: 'require_escalated' })),
    () => { reviews++; return fauxAssistantMessage('{"outcome":"deny","rationale":"Guardian is back on."}'); },
    fauxAssistantMessage('Stopped.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  }, bind: session => ({ mode: 'tui', uiContext: {
    ...session.extensionRunner.createContext().ui,
    notify: message => { notices.push(message); },
  } }) }, async fixture => {
    await fixture.session.prompt('/guardian off');
    assert.match(notices.at(-1)!, /off for this session/);
    await fixture.session.prompt('Write it unguarded.');
    assert.equal(readFileSync(target, 'utf8'), 'off\n', 'an escalation runs without review while Guardian is off');
    assert.equal(reviews, 0);
    assert.ok(!mainRequests[0].includes('<permissions_instructions>'), 'the agent is not told about a sandbox that is off');
    await fixture.session.prompt('/guardian');
    assert.match(notices.at(-1)!, /on for this session/);
    await fixture.session.prompt('Write it again.');
    assert.equal(reviews, 1, 'escalations are reviewed again');
    assert.equal(readFileSync(target, 'utf8'), 'off\n');
    await fixture.session.prompt('/guardian status');
    assert.match(notices.at(-1)!, /Turned on for this session with \/guardian/);
    await fixture.runtime.newSession();
    await fixture.session.prompt('/guardian status');
    assert.doesNotMatch(notices.at(-1)!, /for this session/, 'a new session follows config.json again');
  });
  assert.deepEqual(emitted, [{ enabled: false }, { enabled: true }]);
});

test('a claude-cli reviewer runs claude -p and its verdict decides the escalation', sandboxed, async t => {
  const outside = outsideDir(t);
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'guardian-fake-claude-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const record = join(bin, 'record.json');
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
let stdin = '';
process.stdin.on('data', chunk => { stdin += chunk; }).on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"outcome":"allow"}' }));
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const target = join(outside, 'claude.txt');
  await withPi({ extensions: [guardian], responses: [
    fauxAssistantMessage(fauxToolCall('bash', { command: `echo claude > ${target}`, sandbox_permissions: 'require_escalated' })),
    fauxAssistantMessage('Done.'),
  ], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: 'claude-cli', model: 'claude-opus-5-5', reasoning: 'high' } });
    return { model: provider.getModel() };
  } }, async ({ session }) => {
    await session.prompt('Write it with Claude reviewing.');
    assert.equal(readFileSync(target, 'utf8'), 'claude\n');
  });
  const recorded = JSON.parse(readFileSync(record, 'utf8'));
  assert.ok(recorded.argv.includes('--safe-mode') && recorded.argv.includes('claude-opus-5-5'));
  assert.ok(recorded.argv[recorded.argv.indexOf('--system-prompt') + 1].startsWith('You are judging one planned coding-agent action.'));
  assert.ok(recorded.stdin.includes('[1] user: Write it with Claude reviewing.') && recorded.stdin.includes('>>> APPROVAL REQUEST START'));
});

test('the permission instructions describe how commands actually run', () => {
  const with_ = (overrides: Partial<typeof DEFAULT_GUARDIAN_CONFIG>, mode: typeof DEFAULT_GUARDIAN_CONFIG.sandbox.mode = 'workspace-write') =>
    ({ ...DEFAULT_GUARDIAN_CONFIG, ...overrides, sandbox: { ...DEFAULT_GUARDIAN_CONFIG.sandbox, mode } });
  assert.deepEqual(instructedPermissions(with_({}), true), { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' });
  assert.deepEqual(instructedPermissions(with_({}), false), { sandboxMode: 'danger-full-access', approvalPolicy: 'unless-trusted' });
  assert.deepEqual(instructedPermissions(with_({ approvalPolicy: 'never' }), false), { sandboxMode: 'read-only', approvalPolicy: 'never' });
  for (const approvalPolicy of ['never', 'on-request'] as const) {
    assert.deepEqual(instructedPermissions(with_({ approvalPolicy }, 'danger-full-access'), false), { sandboxMode: 'danger-full-access', approvalPolicy },
      'explicit full access keeps the configured policy');
  }
});

test('a Guardian that cannot start still replaces bash, write and edit with tools that refuse', async () => {
  const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  const handlers: ((event: unknown, ctx: { hasUI: boolean; ui: { notify(message: string, type?: string): void } }) => void)[] = [];
  registerFailClosed({ getAllTools: () => [], registerTool: tool => { tools.push(tool as never); }, on: ((_event: string, handler: never) => { handlers.push(handler); }) as never },
    new Error('bundled rules are unreadable'), '/repo');
  assert.deepEqual(tools.map(tool => tool.name), ['bash', 'write', 'edit']);
  for (const tool of tools) await assert.rejects(tool.execute('call', { command: 'ls', path: 'x', content: '' }), /Guardian could not start[\s\S]*bundled rules are unreadable/);
  const notices: string[] = [];
  for (const handler of handlers) handler({}, { hasUI: true, ui: { notify: message => { notices.push(message); } } });
  assert.match(notices.join('\n'), /Guardian could not start/);
});


test('a late human decision cannot append an old audit into the current Pi session', async () => {
  let bash!: ReturnType<typeof createGuardianBashTool>;
  let choose!: (choice: string) => void;
  let shown!: () => void;
  const visible = new Promise<void>(resolve => { shown = resolve; });
  await withPi({ extensions: [pi => guardian({ ...pi, registerTool: tool => {
    if (tool.name === 'bash') bash = tool as unknown as typeof bash;
    pi.registerTool(tool);
  } })], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { approvalsReviewer: 'user' });
    return { model: provider.getModel() };
  }, bind: session => ({ mode: 'tui', uiContext: { ...session.extensionRunner.createContext().ui,
    select: () => new Promise(resolve => { choose = resolve; shown(); }),
  } }) }, async fixture => {
    const { session, runner, cwd } = fixture;
    const ctx = runner.createToolContext('old-call', undefined);
    let aborted = 0;
    const execution = bash.execute('old-call', { command: 'echo stale > stale-marker', sandbox_permissions: 'require_escalated' }, undefined, undefined,
      { ...ctx, abort: () => { aborted++; } });
    await visible;
    const oldSessionId = session.sessionManager.getSessionId();
    await fixture.runtime.newSession();
    assert.notEqual(fixture.session.sessionManager.getSessionId(), oldSessionId);
    choose('Yes, proceed');
    await assert.rejects(execution, { message: 'Cannot record approval audit in a different or closed session' });
    assert.equal(aborted, 0);
    assert.equal(existsSync(join(cwd, 'stale-marker')), false);
    const audit = fixture.session.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE);
    assert.deepEqual(audit, [], 'pi.appendEntry must not receive the old decision in the new session');
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const replacement of ['review', 'turn'] as const) test(`an older review cannot clear a newer review status (${replacement})`, async () => {
  let bash!: ReturnType<typeof createGuardianBashTool>;
  const entered = [gate(), gate()];
  const released = [gate(), gate()];
  let status: string | undefined;
  const notices: string[] = [];
  await withPi({ extensions: [pi => guardian({ ...pi, registerTool: tool => {
    if (tool.name === 'bash') bash = tool as unknown as typeof bash;
    pi.registerTool(tool);
  } })], responses: entered.map((gate, index) => async () => {
    gate.resolve();
    await released[index].promise;
    return fauxAssistantMessage(index === 0 ? '{"outcome":"deny","rationale":"obsolete denial"}' : '{"outcome":"allow"}');
  }), configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
    return { model: provider.getModel() };
  }, bind: session => ({ mode: 'tui', uiContext: { ...session.extensionRunner.createContext().ui,
    setStatus: (key, text) => { if (key === 'guardian-review') status = text; },
    notify: message => { notices.push(message); },
  } }) }, async ({ session, runner, cwd }) => {
    await runner.emit({ type: 'agent_start' });
    const controller = new AbortController();
    const old = bash.execute('old', { command: 'echo old > old-marker', sandbox_permissions: 'require_escalated' }, controller.signal, undefined, runner.createToolContext('review-call', controller.signal));
    const oldRejected = assert.rejects(old, replacement === 'turn' ? /cancelled/ : /unacceptable risk/);
    try {
      await entered[0].promise;
      if (replacement === 'turn') {
        controller.abort();
        await runner.emit({ type: 'agent_start' });
      }
      const fresh = bash.execute('fresh', { command: 'echo fresh > fresh-marker', sandbox_permissions: 'require_escalated' }, undefined, undefined, runner.createToolContext('review-call', undefined));
      try {
        await entered[1].promise;
        assert.equal(status, 'Reviewing approval request…');
        released[0].resolve();
        await oldRejected;
        assert.equal(status, 'Reviewing approval request…', 'old completion must not erase the new status');
        if (replacement !== 'review') {
          await session.prompt('/guardian approve');
          assert.match(notices.at(-1)!, /No replayable denied action/);
          assert.ok(!notices.some(message => message.includes('obsolete denial')));
        }
        assert.equal(existsSync(join(cwd, 'old-marker')), false);
      } finally {
        released[1].resolve();
        await fresh;
      }
      assert.equal(status, undefined);
      assert.equal(readFileSync(join(cwd, 'fresh-marker'), 'utf8'), 'fresh\n');
    } finally {
      released[0].resolve();
      await old.catch(() => {});
    }
  });
});

test('a review that fails before showing status does not take status ownership', async () => {
  let bash!: ReturnType<typeof createGuardianBashTool>;
  const entered = gate(), released = gate();
  let status: string | undefined;
  await withPi({ extensions: [pi => guardian({ ...pi, registerTool: tool => {
    if (tool.name === 'bash') bash = tool as unknown as typeof bash;
    pi.registerTool(tool);
  } })], responses: [async () => {
    entered.resolve();
    await released.promise;
    return fauxAssistantMessage('{"outcome":"allow"}');
  }], configure: ({ agentDir }, provider) => {
    writeConfig(agentDir, { reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' }, autoReview: { failureFallback: 'reject' } });
    return { model: provider.getModel() };
  }, bind: session => ({ mode: 'tui', uiContext: { ...session.extensionRunner.createContext().ui,
    setStatus: (key, text) => { if (key === 'guardian-review') status = text; },
  } }) }, async ({ runner, agentDir }) => {
    const old = bash.execute('old', { command: 'true', sandbox_permissions: 'require_escalated' }, undefined, undefined, runner.createToolContext('old', undefined));
    try {
      await entered.promise;
      writeConfig(agentDir, { reviewer: { provider: 'missing-provider', model: 'unavailable-model', reasoning: 'low' }, autoReview: { failureFallback: 'reject' } });
      await assert.rejects(bash.execute('failed', { command: 'true', sandbox_permissions: 'require_escalated' }, undefined, undefined,
        runner.createToolContext('failed', undefined)), /not available/);
      assert.equal(status, 'Reviewing approval request…');
    } finally {
      released.resolve();
      await old;
    }
    assert.equal(status, undefined, 'the displayed review must still be able to clear its own status');
  });
});

for (const approvalsReviewer of ['auto_review', 'user'] as const) {
  for (const transition of ['turn', 'newSession', 'switchSession'] as const) {
    test(`background connector ${approvalsReviewer} approval across ${transition}`, { timeout: 20_000 }, async () => {
      const start = gate(), entered = gate(), released = gate();
      let effects = 0;
      let nested!: ReturnType<ExtensionToolContext['executeTool']>;
      let dialogSignal: AbortSignal | undefined;
      let dialogClosed = false;
      const bridge = new AbortController();
      const mutation = 'mcp__guardian_fixture__update';
      const delegate: ExtensionFactory = pi => pi.registerTool({ name: 'fixture_delegate', label: 'delegate', description: 'Start synthetic background work', parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          nested = start.promise.then(() => ctx.executeTool(mutation, {}, { signal: bridge.signal }));
          return { content: [{ type: 'text', text: 'Started in background.' }], details: {} };
        },
      });
      let parentCalls = 0;
      const respond = async (context: TranscriptContext) => {
        if (contextText(context).includes('planned coding-agent action')) {
          entered.resolve();
          await released.promise;
          return fauxAssistantMessage('{"outcome":"allow","rationale":"Synthetic allow."}');
        }
        return ++parentCalls === 1 ? fauxAssistantMessage(fauxToolCall('fixture_delegate', {})) : fauxAssistantMessage('Parent finished.');
      };
      await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [guardian, delegate,
        { name: 'mcp', builtin: true, factory: pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation', parameters: Type.Object({}),
          async execute() { effects++; return { content: [{ type: 'text', text: 'Executed.' }], details: {} }; },
        }) }], responses: Array.from({ length: 8 }, () => respond), configure: ({ agentDir }, provider) => {
        writeConfig(agentDir, { approvalsReviewer, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
        return { model: provider.getModel() };
      }, bind: session => ({ mode: 'tui', uiContext: { ...session.extensionRunner.createContext().ui,
        select: (_title, options, opts) => new Promise(resolve => {
          dialogSignal = opts?.signal;
          const close = (choice?: string) => {
            dialogSignal?.removeEventListener('abort', cancel);
            dialogClosed = true;
            resolve(choice);
          };
          const cancel = () => close();
          dialogSignal?.addEventListener('abort', cancel, { once: true });
          void released.promise.then(() => close(options[0]));
          entered.resolve();
        }),
      } }) }, async fixture => {
        await fixture.session.prompt('Start delegated background work.');
        assert.equal(fixture.session.isStreaming, false);
        assert.equal(fixture.runner.createContext().signal, undefined, 'background approvals begin without a parent run signal');
        start.resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await entered.promise;
          const previous = fixture.session;
          if (transition === 'turn') {
            await fixture.session.prompt('An unrelated parent turn.');
            released.resolve();
            const outcome = await nested;
            assert.equal(outcome.isError, false, JSON.stringify(outcome.result.content));
            assert.equal(effects, 1);
          } else {
            if (transition === 'newSession') await fixture.runtime.newSession();
            else await fixture.runtime.switchSession(previous.sessionFile!);
            assert.notEqual(fixture.session, previous, 'the runtime actually replaced its session');
            const outcome = await Promise.race([nested, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); })]);
            assert.ok(outcome, 'shutdown must settle background approval before the reviewer or human responds');
            assert.equal(outcome.isError, true);
            assert.match(JSON.stringify(outcome.result.content), /Cannot record approval audit in a different or closed session/);
            assert.equal(effects, 0);
            if (approvalsReviewer === 'user') {
              assert.equal(dialogSignal?.aborted, true);
              assert.equal(dialogClosed, true);
            }
            assert.ok(!fixture.session.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE));
          }
        } finally {
          clearTimeout(timer);
          released.resolve();
          bridge.abort();
          await nested;
        }
      });
    });
  }

  test(`foreground connector ${approvalsReviewer} approval stops on real session abort`, { timeout: 20_000 }, async () => {
    const entered = gate(), released = gate();
    let effects = 0;
    const mutation = 'mcp__guardian_fixture__update';
    await withPi({ settings: { extensions: ['builtin:mcp'] }, extensions: [guardian,
      { name: 'mcp', builtin: true, factory: pi => pi.registerTool({ name: mutation, label: mutation, description: 'Synthetic mutation', parameters: Type.Object({}),
        async execute() { effects++; return { content: [{ type: 'text', text: 'Executed.' }], details: {} }; },
      }) }], responses: [fauxAssistantMessage(fauxToolCall(mutation, {})), async () => {
      entered.resolve();
      await released.promise;
      return fauxAssistantMessage('{"outcome":"allow"}');
    }, fauxAssistantMessage('Done.')], configure: ({ agentDir }, provider) => {
      writeConfig(agentDir, { approvalsReviewer, reviewer: { provider: provider.getModel().provider, model: provider.getModel().id, reasoning: 'low' } });
      return { model: provider.getModel() };
    }, bind: session => ({ mode: 'tui', uiContext: { ...session.extensionRunner.createContext().ui,
      select: (_title, _options, opts) => new Promise(resolve => {
        assert.ok(opts?.signal);
        opts.signal.addEventListener('abort', () => resolve(undefined), { once: true });
        entered.resolve();
      }),
    } }) }, async ({ session }) => {
      const running = session.prompt('Run the connector.');
      try {
        await entered.promise;
        await session.abort();
        await running;
        assert.equal(effects, 0);
        const records = session.sessionManager.getEntries().flatMap(entry => entry.type === 'custom' && entry.customType === APPROVAL_AUDIT_ENTRY_TYPE ? [entry.data as ApprovalAuditEntry] : []);
        assert.equal(records.at(-1)?.verdict, 'aborted');
        assert.equal(records.at(-1)?.userChoice, undefined);
      } finally {
        released.resolve();
        await running;
      }
    });
  });
}
