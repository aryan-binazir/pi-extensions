// Routing and outcome handling ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f (Apache-2.0).
import assert from 'node:assert/strict';
import test from 'node:test';
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
