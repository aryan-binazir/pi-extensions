// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/{retry_tests,completion}.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { completeReview, isTransientProviderError, MAX_REVIEW_ATTEMPTS, REVIEW_TIMEOUT_MS, type ReviewOutcome, runWithRetry, shouldRetryReview } from './outcome.ts';
import { REJECTION_INSTRUCTIONS, REVIEW_FAILURE_INSTRUCTIONS, TIMEOUT_INSTRUCTIONS } from './prompts.ts';

const deny: ReviewOutcome = { type: 'completed', assessment: { riskLevel: 'high', userAuthorization: 'unknown', outcome: 'deny', rationale: 'deny' } };

test('Codex review limits', () => {
  assert.equal(MAX_REVIEW_ATTEMPTS, 3);
  assert.equal(REVIEW_TIMEOUT_MS, 90_000);
});

test('review retry only retries recoverable errors', () => {
  const transient = ['503 Service Unavailable', 'HTTP 429 Too Many Requests', 'server overloaded', 'Rate limit exceeded', 'socket hang up', 'ECONNRESET', 'HTTP 502 Bad Gateway', 'stream disconnected'];
  for (const message of transient) assert.ok(isTransientProviderError(message), message);
  for (const message of ['400 Bad Request', 'invalid prompt', 'Unauthorized', 'usage limit reached', 'context window exceeded']) {
    assert.ok(!isTransientProviderError(message), message);
  }
  for (const [outcome, expected] of [
    ...transient.map(message => [{ type: 'error', error: { type: 'session', message, transient: true } }, true] as const),
    [deny, false],
    [{ type: 'error', error: { type: 'prompt_build', message: 'prompt' } }, false],
    [{ type: 'error', error: { type: 'session', message: 'session', transient: false } }, false],
    [{ type: 'error', error: { type: 'parse', message: 'parse' } }, true],
    [{ type: 'error', error: { type: 'timeout' } }, false],
    [{ type: 'error', error: { type: 'cancelled' } }, false],
  ] as const) {
    assert.equal(shouldRetryReview(outcome as ReviewOutcome), expected);
  }
});

test('retry wait honors cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  const outcome = await runWithRetry({ maxAttempts: 3, deadline: Date.now() + 1_000 }, controller.signal, async () => {
    attempts++;
    return { type: 'error', error: { type: 'parse', message: 'bad' } };
  });
  assert.deepEqual(outcome, { type: 'error', error: { type: 'cancelled' } });
  assert.equal(attempts, 1);
});

test('retry wait honors deadline', async () => {
  const outcome = await runWithRetry({ maxAttempts: 3, deadline: Date.now() }, undefined, async () => ({ type: 'error', error: { type: 'parse', message: 'bad' } }));
  assert.deepEqual(outcome, { type: 'error', error: { type: 'timeout' } });
});

test('retries share the attempt budget and the deadline', async () => {
  let attempts = 0;
  const deadline = Date.now() + 5_000;
  const outcome = await runWithRetry({ maxAttempts: 3, deadline }, undefined, async attemptDeadline => {
    assert.equal(attemptDeadline, deadline);
    attempts++;
    return attempts === 2 ? deny : { type: 'error', error: { type: 'parse', message: 'bad' } };
  });
  assert.deepEqual([outcome, attempts], [deny, 2]);
  attempts = 0;
  const exhausted = await runWithRetry({ maxAttempts: 3, deadline }, undefined, async () => {
    attempts++;
    return { type: 'error', error: { type: 'parse', message: 'bad' } };
  });
  assert.deepEqual([exhausted, attempts], [{ type: 'error', error: { type: 'parse', message: 'bad' } }, 3]);
});

test('completion maps outcomes to Codex decisions and warnings', () => {
  assert.deepEqual(completeReview({ type: 'completed', assessment: { riskLevel: 'low', userAuthorization: 'high', outcome: 'allow', rationale: 'fine' } }), {
    decision: { type: 'approved' }, assessmentOutcome: 'allow',
    warning: 'Automatic approval review approved (risk: low, authorization: high): fine',
  });
  assert.deepEqual(completeReview(deny), {
    decision: { type: 'denied', message: `This action was rejected due to unacceptable risk.\nReason: deny\n${REJECTION_INSTRUCTIONS}` },
    assessmentOutcome: 'deny', warning: 'Automatic approval review denied (risk: high, authorization: unknown): deny',
  });
  assert.deepEqual(completeReview({ type: 'error', error: { type: 'timeout' } }), {
    decision: { type: 'timed_out', message: TIMEOUT_INSTRUCTIONS },
    warning: 'Automatic approval review timed out while evaluating the requested approval.',
  });
  assert.deepEqual(completeReview({ type: 'error', error: { type: 'cancelled' } }), { decision: { type: 'abort' } });
  assert.deepEqual(completeReview({ type: 'error', error: { type: 'parse', message: 'guardian assessment was not valid JSON' } }), {
    decision: { type: 'denied', message: `Automatic approval review failed: guardian assessment was not valid JSON\n${REVIEW_FAILURE_INSTRUCTIONS}` },
    warning: 'Automatic approval review failed: guardian assessment was not valid JSON',
  });
});
