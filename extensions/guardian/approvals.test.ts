// Routing and outcome handling ported from openai/codex codex-rs/ext/guardian-reviewer/src/{routing,review}.rs,
// codex-rs/core/src/tools/approvals.rs and codex-rs/core/src/context/guardian_approved_action.rs @ ce0323f (Apache-2.0).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Approvals, type ApprovalContext, formatActionPretty, manualApprovalMessage } from './approvals.ts';
import { DEFAULT_GUARDIAN_CONFIG, type GuardianConfig } from './config.ts';
import type { ReviewOutcome } from './review/outcome.ts';
import { MANUAL_APPROVAL_DEVELOPER_PREFIX } from './review/context.ts';
import { REJECTION_INSTRUCTIONS, REVIEW_FAILURE_INSTRUCTIONS, TIMEOUT_INSTRUCTIONS } from './review/prompts.ts';

const allow: ReviewOutcome = { type: 'completed', assessment: { riskLevel: 'low', userAuthorization: 'high', outcome: 'allow', rationale: 'ok' } };
const deny: ReviewOutcome = { type: 'completed', assessment: { riskLevel: 'high', userAuthorization: 'low', outcome: 'deny', rationale: 'Pushes to main.' } };
const request = { action: { tool: 'bash', command: ['bash', '-lc', 'git push origin main'], cwd: '/repo', sandbox_permissions: 'require_escalated' }, summary: 'git push origin main' };

function harness(outcomes: ReviewOutcome[], config: Partial<GuardianConfig> = {}, ui: { hasUI?: boolean; choice?: string } = {}) {
  const reviews: { actionJson: string; reason?: string }[] = [], notices: [string, string][] = [], prompts: [string, string[]][] = [];
  let aborted = 0;
  const approvals = new Approvals({
    config: () => ({ ...DEFAULT_GUARDIAN_CONFIG, ...config }),
    review: async input => { reviews.push({ actionJson: input.actionJson, ...(input.reason === undefined ? {} : { reason: input.reason }) }); return outcomes.shift()!; },
    turnId: () => 'turn-1',
  });
  const ctx: ApprovalContext = {
    hasUI: ui.hasUI ?? true,
    abort: () => { aborted++; },
    ui: {
      notify: (message, type = 'info') => { notices.push([type, message]); },
      select: async (title, options) => { prompts.push([title, options]); return ui.choice === undefined ? undefined : options.find(option => option.startsWith(ui.choice!)); },
    },
  };
  return { approvals, ctx, reviews, notices, prompts, aborted: () => aborted };
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
  assert.equal(h.approvals.lastDenied()?.summary, 'git push origin main');
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
  }
  const timedOut = harness([{ type: 'error', error: { type: 'timeout' } }], { autoReview: { ...DEFAULT_GUARDIAN_CONFIG.autoReview, failureFallback: 'reject' } });
  assert.deepEqual(await timedOut.approvals.request(request, timedOut.ctx), { type: 'rejected', message: TIMEOUT_INSTRUCTIONS });
  const failed = harness([{ type: 'error', error: { type: 'parse', message: 'bad JSON' } }], { autoReview: { ...DEFAULT_GUARDIAN_CONFIG.autoReview, failureFallback: 'reject' } });
  assert.deepEqual(await failed.approvals.request(request, failed.ctx), { type: 'rejected', message: `Automatic approval review failed: bad JSON\n${REVIEW_FAILURE_INSTRUCTIONS}` });
  assert.deepEqual(timedOut.prompts, []);
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
  const no = harness([], { approvalsReviewer: 'user' }, { choice: 'No' });
  assert.deepEqual(await no.approvals.request(request, no.ctx), { type: 'aborted', message: 'rejected by user' });
  assert.equal(no.aborted(), 1);
  const dismissed = harness([], { approvalsReviewer: 'user' });
  assert.equal((await dismissed.approvals.request(request, dismissed.ctx)).type, 'aborted');
  const headless = harness([], { approvalsReviewer: 'user' }, { hasUI: false });
  assert.deepEqual(await headless.approvals.request(request, headless.ctx), { type: 'rejected', message: 'approval required, but no interactive user is available to approve it' });
});

test('manual approval text matches Codex GuardianApprovedAction', () => {
  assert.equal(manualApprovalMessage('{"a":1}'), `${MANUAL_APPROVAL_DEVELOPER_PREFIX}\n\nTreat this as approval to perform that exact action in the same context in which it was originally requested.\nDo not assume this also authorizes similar operations with different payloads.\n\nApproved action:\n{"a":1}`);
  assert.equal(formatActionPretty({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: null }), '{\n  "a": null,\n  "b": {\n    "c": [\n      {\n        "e": 2,\n        "f": 1\n      }\n    ],\n    "d": 1\n  }\n}');
});
