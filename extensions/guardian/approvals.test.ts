// Routing and outcome handling ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f (Apache-2.0).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { createConnectorGate } from './connectors.ts';
import { Approvals, type ApprovalAuditEntry, type ApprovalContext, formatActionPretty, manualApprovalMessage } from './approvals.ts';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import type { ReviewOutcome } from './review/outcome.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX } from './review/context.ts';
import { REJECTION_INSTRUCTIONS, REVIEW_FAILURE_INSTRUCTIONS, TIMEOUT_INSTRUCTIONS } from './review/prompts.ts';

const allow: ReviewOutcome = { type: 'completed', assessment: { riskLevel: 'low', userAuthorization: 'high', outcome: 'allow', rationale: 'ok' } };
const deny: ReviewOutcome = { type: 'completed', assessment: { riskLevel: 'high', userAuthorization: 'low', outcome: 'deny', rationale: 'Pushes to main.' } };
const request = { action: { tool: 'bash', command: ['bash', '-lc', 'git push origin main'], cwd: '/repo', sandbox_permissions: 'require_escalated' }, summary: 'git push origin main' };

function harness(outcomes: ReviewOutcome[], config: Partial<GuardianConfig> = {}, ui: { hasUI?: boolean; choice?: string } = {}) {
  const reviews: { actionJson: string; reason?: string }[] = [], notices: [string, string][] = [], prompts: [string, string[]][] = [];
  const records: ApprovalAuditEntry[] = [];
  let aborted = 0;
  const approvals = new Approvals({
    config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, ...config }),
    review: async input => { reviews.push({ actionJson: input.actionJson, ...(input.reason === undefined ? {} : { reason: input.reason }) }); return outcomes.shift()!; },
    turnId: () => 'turn-1',
    record: entry => { records.push(entry); },
  });
  const ctx: ApprovalContext = {
    hasUI: ui.hasUI ?? true,
    sessionManager: { getSessionId: () => 'session-1', getLeafId: () => 'leaf-1' },
    abort: () => { aborted++; },
    ui: {
      notify: (message, type = 'info') => { notices.push([type, message]); },
      select: async (title, options) => { prompts.push([title, options]); return ui.choice === undefined ? undefined : options.find(option => option.startsWith(ui.choice!)); },
    },
  };
  return { approvals, ctx, reviews, notices, prompts, records, aborted: () => aborted };
}

test('on-request auto review approves through Guardian with the pretty sorted action', async () => {
  const h = harness([allow]);
  assert.deepEqual(await h.approvals.request({ ...request, reason: 'x'.repeat(10_000) }, h.ctx), { type: 'approved' });
  assert.equal(h.reviews[0].actionJson, '{\n  "command": [\n    "bash",\n    "-lc",\n    "git push origin main"\n  ],\n  "cwd": "/repo",\n  "sandbox_permissions": "require_escalated",\n  "tool": "bash"\n}');
  assert.ok(h.reviews[0].reason!.includes('<truncated omitted_approx_tokens='), 'approval reasons are capped at 512 tokens');
  assert.deepEqual(h.prompts, []);
});

test('a Guardian denial returns Codex rejection text and is remembered for manual approval', async () => {
  const h = harness([deny]);
  assert.deepEqual(await h.approvals.request(request, h.ctx), {
    type: 'rejected', message: `This action was rejected due to unacceptable risk.\nReason: Pushes to main.\n${REJECTION_INSTRUCTIONS}`,
  });
  assert.deepEqual(h.notices, [['warning', 'Automatic approval review denied (risk: high, authorization: low): Pushes to main.']]);
  assert.equal(h.approvals.takeDenied(h.ctx)?.summary, 'git push origin main');
});

test('three consecutive denials interrupt the turn like Codex', async () => {
  const h = harness([deny, deny, deny]);
  for (let index = 0; index < 3; index++) await h.approvals.request(request, h.ctx);
  assert.equal(h.aborted(), 1);
  assert.deepEqual(h.notices.at(-1), ['warning', 'Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.']);
});

test('review timeouts and failures fall back to you by default and never auto-allow', async () => {
  for (const outcome of [{ type: 'error', error: { type: 'timeout' } }, { type: 'error', error: { type: 'parse', message: 'bad JSON' } }] as ReviewOutcome[]) {
    const yes = harness([outcome], {}, { choice: 'Yes, proceed' });
    assert.deepEqual(await yes.approvals.request(request, yes.ctx), { type: 'approved' });
    assert.equal(yes.prompts.length, 1);
    const none = harness([outcome], {}, { hasUI: false });
    const decision = await none.approvals.request(request, none.ctx);
    assert.equal(decision.type, 'rejected');
    assert.deepEqual(none.records.map(entry => [entry.decider, entry.verdict]), [['auto_review', 'error'], ['policy', 'rejected']]);
  }
  const timedOut = harness([{ type: 'error', error: { type: 'timeout' } }], { autoReview: { ...DEFAULT_GUARDIAN_CONFIG.autoReview, failureFallback: 'reject' } });
  assert.deepEqual(await timedOut.approvals.request(request, timedOut.ctx), { type: 'rejected', message: TIMEOUT_INSTRUCTIONS });
  const failed = harness([{ type: 'error', error: { type: 'parse', message: 'bad JSON' } }], { autoReview: { ...DEFAULT_GUARDIAN_CONFIG.autoReview, failureFallback: 'reject' } });
  assert.deepEqual(await failed.approvals.request(request, failed.ctx), { type: 'rejected', message: `Automatic approval review failed: bad JSON\n${REVIEW_FAILURE_INSTRUCTIONS}` });
  assert.deepEqual(timedOut.prompts, []);
  assert.equal(failed.records.at(-1)?.verdict, 'rejected');
});

test('a review that throws takes the failure fallback instead of failing the tool call', async () => {
  const notices: string[] = [];
  const records: ApprovalAuditEntry[] = [];
  const approvals = new Approvals({
    config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => 'turn-1',
    record: entry => { records.push(entry); },
    review: async () => { throw new Error("ENOENT: no such file or directory, mkdtemp '/missing/guardian-claude-'"); },
  });
  const ctx: ApprovalContext = { hasUI: true, sessionManager: { getSessionId: () => 's', getLeafId: () => null }, abort: () => {}, ui: { notify: message => { notices.push(message); }, select: async (_title, options) => options[0] } };
  assert.deepEqual(await approvals.request(request, ctx), { type: 'approved' });
  assert.match(notices.join('\n'), /ENOENT[\s\S]*asking you instead/);
  assert.deepEqual(records.map(entry => entry.verdict), ['error', 'approved']);
  assert.match(records[0].rationale, /ENOENT/);
});

test('a cancelled review aborts', async () => {
  const h = harness([{ type: 'error', error: { type: 'cancelled' } }]);
  assert.equal((await h.approvals.request(request, h.ctx)).type, 'aborted');
});

test('approvalsReviewer user and unless-trusted ask you instead of Guardian', async () => {
  for (const config of [{ approvalsReviewer: 'user' as const }, { approvalPolicy: 'unless-trusted' as const }]) {
    const h = harness([], config, { choice: 'Yes, proceed' });
    assert.deepEqual(await h.approvals.request(request, h.ctx), { type: 'approved' });
    assert.deepEqual(h.reviews, []);
    assert.equal(h.prompts.length, 1);
  }
});

test('the user prompt offers Codex choices, including persisting the proposed prefix rule', async () => {
  const amend = { ...request, amendment: ['git', 'push'] };
  const always = harness([], { approvalsReviewer: 'user' }, { choice: "Yes, and don't ask again" });
  assert.deepEqual(await always.approvals.request(amend, always.ctx), { type: 'approved', persist: ['git', 'push'] });
  assert.deepEqual(always.prompts[0][1], ['Yes, proceed', "Yes, and don't ask again for commands that start with `git push`", 'No, and tell the agent what to do differently']);
  assert.equal(always.records[0].userChoice, 'approve_and_persist');
  assert.deepEqual(always.records[0].requestedRule, ['git', 'push']);
  const no = harness([], { approvalsReviewer: 'user' }, { choice: 'No' });
  assert.deepEqual(await no.approvals.request(request, no.ctx), { type: 'aborted', message: 'rejected by user' });
  assert.equal(no.aborted(), 1);
  assert.equal(no.records[0].userChoice, 'reject');
  const dismissed = harness([], { approvalsReviewer: 'user' });
  assert.equal((await dismissed.approvals.request(request, dismissed.ctx)).type, 'aborted');
  assert.equal(dismissed.records[0].userChoice, 'dismiss');
  const headless = harness([], { approvalsReviewer: 'user' }, { hasUI: false });
  assert.deepEqual(await headless.approvals.request(request, headless.ctx), { type: 'rejected', message: 'approval required, but no interactive user is available to approve it' });
});

test('manual approval text matches Codex GuardianApprovedAction', () => {
  assert.equal(manualApprovalMessage('{"a":1}'), `${MANUAL_APPROVAL_DEVELOPER_PREFIX}\n\nTreat this as approval to perform that exact action in the same context in which it was originally requested.\nDo not assume this also authorizes similar operations with different payloads.\n\nApproved action:\n{"a":1}`);
  assert.equal(formatActionPretty({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: null }), '{\n  "a": null,\n  "b": {\n    "c": [\n      {\n        "e": 2,\n        "f": 1\n      }\n    ],\n    "d": 1\n  }\n}');
});

test('an action too large to review completely is rejected without a review', async () => {
  const h = harness([allow]);
  const decision = await h.approvals.request({ action: { tool: 'write', content: 'x'.repeat(600_000) }, summary: 'write big' }, h.ctx);
  assert.equal(decision.type, 'rejected');
  assert.match(decision.type === 'rejected' ? decision.message : '', /too large to review/);
  assert.deepEqual(h.reviews, []);
  assert.equal(h.records[0].decider, 'policy');
  assert.equal(h.records[0].verdict, 'rejected');
  assert.equal(h.records[0].actionTruncated, true);
  assert.ok(h.records[0].actionBytes > 600_000);
  assert.ok(Buffer.byteLength(h.records[0].actionJson) <= 256 * 1024);
});

test('automatic decisions retain the exact action, reviewer, rationale and latency', async () => {
  const h = harness([allow, deny]);
  for (let i = 0; i < 2; i++) await h.approvals.request({ ...request, reason: 'Protected metadata' }, h.ctx);
  assert.equal(h.records.length, 2);
  assert.deepEqual(h.records.map(record => [record.decider, record.verdict, record.rationale]), [
    ['auto_review', 'approved', 'ok'], ['auto_review', 'rejected', 'Pushes to main.'],
  ]);
  assert.notEqual(h.records[0].requestId, h.records[1].requestId);
  for (const record of h.records) {
    assert.equal(record.actionJson, formatActionPretty(request.action));
    assert.equal(record.requestReason, 'Protected metadata');
    assert.deepEqual(record.reviewer, DEFAULT_GUARDIAN_CONFIG.reviewer);
    assert.equal(record.approvalPolicy, 'on-request');
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.sessionLeafId, 'leaf-1');
    assert.equal(record.actionTruncated, false);
    assert.ok(Number.isFinite(Date.parse(record.timestamp)));
    assert.ok(record.durationMs >= 0 && record.durationMs < 10_000);
  }
  assert.deepEqual(h.records[1].assessment, deny.type === 'completed' && deny.assessment);
});

test('a failed review and the human fallback are distinct linked decisions', async () => {
  const h = harness([{ type: 'error', error: { type: 'timeout' } }], {}, { choice: 'Yes, proceed' });
  await h.approvals.request(request, h.ctx);
  assert.deepEqual(h.records.map(record => [record.decider, record.verdict]), [['auto_review', 'error'], ['user', 'approved']]);
  assert.equal(h.records[0].requestId, h.records[1].requestId);
  assert.match(h.records[0].rationale, /timed out/);
  assert.match(h.records[1].rationale, /Yes, proceed/);
  assert.equal(h.records[1].reviewer, undefined);
});

test('human rejection, cancellation and unavailable approval are recorded accurately', async () => {
  const rejected = harness([], { approvalsReviewer: 'user' }, { choice: 'No' });
  await rejected.approvals.request(request, rejected.ctx);
  assert.equal(rejected.records[0].decider, 'user');
  assert.equal(rejected.records[0].verdict, 'aborted');
  const headless = harness([], { approvalsReviewer: 'user' }, { hasUI: false });
  await headless.approvals.request(request, headless.ctx);
  assert.equal(headless.records[0].decider, 'policy');
  assert.equal(headless.records[0].verdict, 'rejected');
  const cancelled = harness([{ type: 'error', error: { type: 'cancelled' } }]);
  await cancelled.approvals.request(request, cancelled.ctx);
  assert.equal(cancelled.records[0].verdict, 'aborted');
});

test('manual approval records the denied action once without replaying its reviewer assessment', async () => {
  const h = harness([deny]);
  await h.approvals.request(request, h.ctx);
  assert.equal(h.approvals.takeDenied(h.ctx)?.actionJson, formatActionPretty(request.action));
  assert.equal(h.approvals.takeDenied(h.ctx), undefined);
  assert.equal(h.records.length, 2);
  assert.equal(h.records[1].requestId, h.records[0].requestId);
  assert.equal(h.records[1].decider, 'user');
  assert.equal(h.records[1].verdict, 'approved');
  assert.equal(h.records[1].assessment, undefined);
  assert.match(h.records[1].rationale, /guardian approve/);
});

test('a decision that cannot be recorded never approves execution', async () => {
  const approvals = new Approvals({
    config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => 'turn-1', review: async () => allow,
    record: () => { throw new Error('audit disk full'); },
  });
  await assert.rejects(approvals.request(request, harness([]).ctx), /audit disk full/);
});

test('failed audit writes preserve human rejection and the denial circuit breaker', async () => {
  for (const choice of ['Yes, proceed', 'No']) {
    const h = harness([], {}, { choice });
    const approvals = new Approvals({
      config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, approvalsReviewer: 'user' }), turnId: () => 't', review: async () => allow,
      record: () => { throw new Error('disk full'); },
    });
    await assert.rejects(approvals.request(request, h.ctx), /disk full/);
    assert.equal(h.aborted(), choice === 'No' ? 1 : 0);
  }
  const h = harness([]);
  let fail = true;
  const approvals = new Approvals({
    config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => 't', review: async () => deny,
    record: () => { if (fail) throw new Error('disk full'); },
  });
  for (let i = 0; i < 3; i++) await assert.rejects(approvals.request(request, h.ctx), /disk full/);
  assert.equal(h.aborted(), 1);
  assert.throws(() => approvals.takeDenied(h.ctx), /disk full/);
  fail = false;
  assert.equal(approvals.takeDenied(h.ctx)?.summary, request.summary);
  assert.equal(approvals.takeDenied(h.ctx), undefined);
});

test('metadata-only connector requests show complete arguments but never retain echoes or stale manual approvals', async () => {
  const sensitive = 'synthetic-private-connector-value';
  const h = harness([deny, { type: 'completed', assessment: { riskLevel: 'high', userAuthorization: 'low', outcome: 'deny', rationale: sensitive } }]);
  await h.approvals.request(request, h.ctx);
  await h.approvals.request({ action: { tool: 'connector', arguments: { sensitive } }, summary: 'Connector call',
    reason: sensitive, justification: sensitive, audit: { action: { tool: 'connector', name: 'fixture_update' }, summary: 'Connector call' },
  }, h.ctx);
  assert.equal(h.approvals.takeDenied(h.ctx), undefined, 'connector denial clears an older replayable shell denial');
  assert.ok(!JSON.stringify(h.records[1]).includes(sensitive));
  assert.equal(h.records[1].assessment, undefined);
  assert.equal(h.records[1].contextHashes, undefined);
  assert.equal(h.records[1].actionRedacted, true);
  const human = harness([], { approvalsReviewer: 'user' }, { choice: 'Yes, proceed' });
  await human.approvals.request({ action: { tool: 'connector', arguments: { sensitive } }, summary: 'Connector call',
    audit: { action: { tool: 'connector' }, summary: 'Connector call' },
  }, human.ctx);
  assert.ok(human.prompts[0][0].includes(sensitive));
  assert.ok(!JSON.stringify(human.records).includes(sensitive));
});

test('human connector rejection clears a prior automatic shell denial', async () => {
  const config: Partial<GuardianConfig> = {};
  const h = harness([deny], config);
  await h.approvals.request(request, h.ctx);
  config.approvalsReviewer = 'user';
  await h.approvals.request({ action: { tool: 'connector' }, summary: 'Connector call',
    audit: { action: { tool: 'connector' }, summary: 'Connector call' },
  }, h.ctx);
  assert.equal(h.approvals.takeDenied(h.ctx), undefined);
});

test('connector human approval makes invisible Unicode visible and puts identity before the complete action', async () => {
  const h = harness([], { approvalsReviewer: 'user' }, { choice: 'Yes, proceed' });
  const invisible = 'adm\u200bin\u200d\u2060\u061c\ufeff\u00ad\u2028\u2029\u{e0061}';
  await h.approvals.request({ action: { arguments: { value: invisible }, tool: 'connector' }, summary: 'Connector call: fixture_update',
    audit: { action: { tool: 'connector' }, summary: 'Connector call: fixture_update' },
  }, h.ctx);
  const title = h.prompts[0][0];
  for (const char of ['\u200b', '\u200d', '\u2060', '\u061c', '\ufeff', '\u00ad', '\u2028', '\u2029', '\u{e0061}']) assert.ok(!title.includes(char));
  assert.match(title, /\\u200b/);
  assert.match(title, /\\u\{e0061\}/);
  assert.ok(title.indexOf('fixture_update') < title.indexOf('"arguments"'));
  assert.match(title, /bytes/);
});

for (const early of ['never', 'oversize', 'cancelled'] as const) test(`connector ${early} preflight clears stale manual approval without recording a review`, async () => {
  const h = harness([deny]);
  await h.approvals.request(request, h.ctx);
  const cancellation = new AbortController();
  if (early === 'cancelled') cancellation.abort();
  const gate = createConnectorGate({
    config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, approvalPolicy: early === 'never' ? 'never' : 'on-request' }),
    tools: () => [{ name: 'fixture_update', description: 'Synthetic connector', parameters: Type.Object({}), exposure: 'direct',
      sourceInfo: { path: 'builtin:mcp', source: 'builtin', scope: 'temporary', origin: 'top-level' } }],
    approvals: h.approvals,
  });
  const result = await gate({ type: 'tool_call', toolName: 'fixture_update', toolCallId: 'call',
    input: early === 'oversize' ? { payload: '界'.repeat(90_000) } : {},
  }, { ...h.ctx, cwd: '/repo', signal: cancellation.signal } as any);
  assert.equal(result?.block, true);
  assert.equal(h.records.length, 1, 'preflight blocks produce tool errors rather than review audit entries');
  assert.equal(h.approvals.takeDenied(h.ctx), undefined);
});

test('connector metadata audits retain safe failure categories without model error text', async () => {
  const h = harness([{ type: 'error', error: { type: 'prompt_build', message: 'synthetic-private-model-error' } }], {}, { hasUI: false });
  await h.approvals.request({ action: { tool: 'connector' }, summary: 'Connector call', audit: { action: { tool: 'connector' }, summary: 'Connector call' } }, h.ctx);
  assert.ok(h.records.every(r => r.rationale.includes('prompt_build')));
  assert.ok(!JSON.stringify(h.records).includes('synthetic-private-model-error'));
  const human = harness([], { approvalsReviewer: 'user' }, { hasUI: false });
  await human.approvals.request({ action: { tool: 'connector' }, summary: 'Connector call', audit: { action: { tool: 'connector' }, summary: 'Connector call' } }, human.ctx);
  assert.match(human.records[0].rationale, /no_interactive_user/);
});

test('cancellation wins when a human choice resolves before the awaiting continuation', async () => {
  for (const fallback of [false, true]) for (const choice of [0, 1, 2]) {
    const controller = new AbortController();
    const h = harness(fallback ? [{ type: 'error', error: { type: 'timeout' } }] : [], fallback ? {} : { approvalsReviewer: 'user' });
    h.ctx.ui.select = (_title, options) => new Promise(resolve => {
      resolve(options[choice]);
      controller.abort();
    });
    const decision = await h.approvals.request({ ...request, amendment: ['git', 'push'] }, h.ctx, controller.signal);
    assert.equal(decision.type, 'aborted');
    assert.equal(h.aborted(), 0, 'signal cancellation must not abort a newer run');
    const human = h.records.filter(entry => entry.decider === 'user');
    assert.equal(human.length, 1);
    assert.equal(human[0].verdict, 'aborted');
    assert.equal(human[0].userChoice, undefined, 'a cancelled selection is not a user rejection or approval');
    assert.equal(human[0].requestedRule, undefined);
    assert.doesNotMatch(JSON.stringify(decision), /persist|rejected by user/);
  }
});

test('pre-aborted requests never enter the selector or reviewer', async () => {
  for (const approvalsReviewer of ['user', 'auto_review'] as const) {
    const controller = new AbortController();
    controller.abort();
    const h = harness([allow], { approvalsReviewer }, { choice: 'Yes, proceed' });
    assert.equal((await h.approvals.request(request, h.ctx, controller.signal)).type, 'aborted');
    assert.deepEqual(h.prompts, []);
    assert.deepEqual(h.reviews, []);
    assert.equal(h.aborted(), 0);
    assert.deepEqual(h.records.map(entry => entry.verdict), ['aborted']);
  }
});

test('late human rejection keeps its original audit identity and cannot abort a new turn', async () => {
  const h = harness([], { approvalsReviewer: 'user' });
  let session = 'old-session', leaf = 'old-leaf';
  h.ctx.sessionManager = { getSessionId: () => session, getLeafId: () => leaf };
  let choose!: (choice: string) => void;
  h.ctx.ui.select = () => new Promise(resolve => { choose = resolve; });
  const pending = h.approvals.request(request, h.ctx);
  session = 'new-session';
  leaf = 'new-leaf';
  choose('No, and tell the agent what to do differently');
  assert.equal((await pending).type, 'aborted');
  assert.equal(h.aborted(), 0);
  assert.equal(h.records[0].sessionId, 'old-session');
  assert.equal(h.records[0].sessionLeafId, 'old-leaf');
  assert.equal(h.records[0].userChoice, undefined);
});

test('late automatic results cannot authorize or replace a newer turns denial and circuit breaker', async () => {
  for (const outcome of [allow, deny, { type: 'error', error: { type: 'timeout' } } as ReviewOutcome]) {
    const h = harness([]);
    let turn = 'old';
    let finish!: (outcome: ReviewOutcome) => void;
    let pending = true;
    const approvals = new Approvals({ config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => turn,
      review: (): Promise<ReviewOutcome> => pending ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(deny),
      record: entry => { h.records.push(entry); },
    });
    const old = approvals.request(request, h.ctx);
    turn = 'new';
    pending = false;
    const fresh = { ...request, summary: 'fresh denied action' };
    await approvals.request(fresh, h.ctx);
    await approvals.request(fresh, h.ctx);
    finish(outcome);
    assert.equal((await old).type, 'aborted');
    assert.equal(h.aborted(), 0, 'the late denial must not count toward the new turn');
    assert.equal(approvals.takeDenied(h.ctx)?.summary, fresh.summary);
    assert.deepEqual(h.prompts, [], 'late failure must not open a fallback prompt');
    await approvals.request(fresh, h.ctx);
    assert.equal(h.aborted(), 1, 'the late allow must not reset the new turn breaker');
    assert.equal(h.records[2].verdict, 'aborted');
  }
});

test('manual approval cannot replay a denial in a different session', async () => {
  const h = harness([deny]);
  await h.approvals.request(request, h.ctx);
  h.ctx.sessionManager = { getSessionId: () => 'new-session', getLeafId: () => 'new-leaf' };
  assert.equal(h.approvals.takeDenied(h.ctx), undefined);
  assert.equal(h.records.length, 1);
});

test('eight shared-signal dialogs close without cancelling an independent dialog owner', async () => {
  for (const fallback of [false, true]) {
    const shared = new AbortController(), independent = new AbortController(), external = new AbortController();
    const h = harness(Array.from({ length: 9 }, () => ({ type: 'error', error: { type: 'timeout' } })), fallback ? {} : { approvalsReviewer: 'user' });
    const visible = new Map<AbortSignal, Set<(choice: string | undefined) => void>>();
    h.ctx.ui.select = (_title, _options, opts) => new Promise(resolve => {
      assert.ok(opts?.signal, 'the public selector receives the owning signal');
      const signal = opts.signal;
      const dialogs = visible.get(signal) ?? new Set();
      visible.set(signal, dialogs);
      const close = (choice: string | undefined) => {
        signal.removeEventListener('abort', cancel);
        dialogs.delete(close);
        resolve(choice);
      };
      const cancel = () => close(undefined);
      dialogs.add(close);
      signal.addEventListener('abort', cancel, { once: true });
    });
    const pending = Array.from({ length: 8 }, () => h.approvals.request(request, h.ctx, shared.signal));
    const other = h.approvals.request(request, h.ctx, independent.signal);
    const externalDialog = h.ctx.ui.select('Another extension', ['Keep open'], { signal: external.signal });
    await Promise.resolve();
    assert.equal(visible.get(shared.signal)?.size, 8);
    assert.equal(visible.get(independent.signal)?.size, 1);
    shared.abort();
    assert.deepEqual((await Promise.all(pending)).map(decision => decision.type), Array(8).fill('aborted'));
    assert.equal(visible.get(shared.signal)?.size, 0);
    assert.equal(visible.get(independent.signal)?.size, 1);
    assert.equal(h.aborted(), 0);
    assert.equal(visible.get(external.signal)?.size, 1);
    for (const close of visible.get(external.signal)!) close('Keep open');
    assert.equal(await externalDialog, 'Keep open');
    for (const close of visible.get(independent.signal)!) close('Yes, proceed');
    assert.deepEqual(await other, { type: 'approved' });
    assert.equal(visible.get(independent.signal)?.size, 0);
    assert.equal(h.records.filter(entry => entry.decider === 'user' && entry.verdict === 'aborted').length, 8);
  }
});

test('a signal cancelled during automatic review overrides late allow and deny results', async () => {
  for (const outcome of [allow, deny]) {
    const h = harness([]);
    const controller = new AbortController();
    const approvals = new Approvals({ config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => 't',
      review: async () => { controller.abort(); return outcome; }, record: entry => { h.records.push(entry); },
    });
    assert.equal((await approvals.request(request, h.ctx, controller.signal)).type, 'aborted');
    assert.equal(approvals.takeDenied(h.ctx), undefined);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.aborted(), 0);
    assert.deepEqual(h.records.map(entry => entry.verdict), ['aborted']);
  }
});

test('cancellation while recording a review failure prevents fallback UI', async () => {
  const h = harness([]);
  const controller = new AbortController();
  const approvals = new Approvals({ config: () => DEFAULT_GUARDIAN_CONFIG, turnId: () => 't',
    review: async () => ({ type: 'error', error: { type: 'timeout' } }),
    record: entry => { h.records.push(entry); controller.abort(); },
  });
  assert.equal((await approvals.request(request, h.ctx, controller.signal)).type, 'aborted');
  assert.deepEqual(h.prompts, []);
  assert.equal(h.aborted(), 0);
  assert.deepEqual(h.records.map(entry => entry.verdict), ['error', 'aborted']);
});

test('a late human choice in the same session cannot abort a newer turn', async () => {
  const h = harness([]);
  let turn = 'old';
  const approvals = new Approvals({ config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, approvalsReviewer: 'user' }),
    turnId: () => turn, review: async () => allow, record: entry => { h.records.push(entry); },
  });
  h.ctx.ui.select = async () => { turn = 'new'; return 'No, and tell the agent what to do differently'; };
  assert.equal((await approvals.request(request, h.ctx)).type, 'aborted');
  assert.equal(h.aborted(), 0);
  assert.equal(h.records[0].userChoice, undefined);
});

test('a cancellation audit failure never aborts another run or permits execution', async () => {
  const controller = new AbortController();
  const h = harness([]);
  const approvals = new Approvals({ config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, approvalsReviewer: 'user' }),
    turnId: () => 't', review: async () => allow, record: () => { throw new Error('audit disk full'); },
  });
  h.ctx.ui.select = async () => { controller.abort(); return 'Yes, proceed'; };
  await assert.rejects(approvals.request(request, h.ctx, controller.signal), /audit disk full/);
  assert.equal(h.aborted(), 0);
});
