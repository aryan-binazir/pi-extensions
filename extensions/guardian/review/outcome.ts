// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/{lib,outcome,retry,completion}.rs @ ce0323f (Apache-2.0);
// see docs/licenses/README.md. Pi reports provider failures as text, so transient errors are recognized from
// the message instead of Codex's structured error info.
import type { GuardianAssessment, GuardianAssessmentOutcome } from './assessment.ts';
import { REJECTION_INSTRUCTIONS, renderGuardianRejection, REVIEW_FAILURE_INSTRUCTIONS, TIMEOUT_INSTRUCTIONS } from './prompts.ts';

export const MAX_REVIEW_ATTEMPTS = 3;
export const REVIEW_TIMEOUT_MS = 90_000;

export type ReviewError =
  | { type: 'prompt_build'; message: string }
  | { type: 'session'; message: string; transient: boolean }
  | { type: 'parse'; message: string }
  | { type: 'timeout' }
  | { type: 'cancelled' };

export type ReviewOutcome = ({ type: 'completed'; assessment: GuardianAssessment } | { type: 'error'; error: ReviewError }) & { contextSha256?: string };

export type ReviewDecision =
  | { type: 'approved' }
  | { type: 'denied'; message: string }
  | { type: 'timed_out'; message: string }
  | { type: 'abort' };

/** Rate limits, overload, 408/429/5xx and dropped connections: the failures Codex retries. */
export function isTransientProviderError(message: string): boolean {
  return /\b(408|429|5\d\d)\b|overload|rate.?limit|temporar|unavailable|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|disconnect|fetch failed|network/i.test(message);
}

export function shouldRetryReview(outcome: ReviewOutcome): boolean {
  if (outcome.type !== 'error') return false;
  return outcome.error.type === 'parse' || (outcome.error.type === 'session' && outcome.error.transient);
}

const sleep = (ms: number, signal: AbortSignal | undefined) => new Promise<boolean>(resolve => {
  if (signal?.aborted) return resolve(false);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, ms);
  const onAbort = () => { clearTimeout(timer); resolve(false); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Retries recoverable failures with exponential backoff, within one shared deadline (epoch ms). */
export async function runWithRetry(
  limits: { maxAttempts: number; deadline: number },
  signal: AbortSignal | undefined,
  attempt: (deadline: number) => Promise<ReviewOutcome>,
): Promise<ReviewOutcome> {
  for (let attemptCount = 1; ; attemptCount++) {
    const outcome = await attempt(limits.deadline);
    if (attemptCount >= limits.maxAttempts || !shouldRetryReview(outcome)) return outcome;
    const delay = 200 * 2 ** (attemptCount - 1) * (0.9 + Math.random() * 0.2);
    const waitMs = Math.max(0, Math.min(Date.now() + delay, limits.deadline) - Date.now());
    if (!await sleep(waitMs, signal)) return { type: 'error', error: { type: 'cancelled' } };
    if (Date.now() >= limits.deadline) return { type: 'error', error: { type: 'timeout' } };
  }
}

export interface ReviewCompletion {
  decision: ReviewDecision;
  warning?: string;
  /** Only completed assessments count toward the denial circuit breaker. */
  assessmentOutcome?: GuardianAssessmentOutcome;
}

export function completeReview(outcome: ReviewOutcome): ReviewCompletion {
  if (outcome.type === 'error') {
    const { error } = outcome;
    if (error.type === 'timeout') {
      return { decision: { type: 'timed_out', message: TIMEOUT_INSTRUCTIONS }, warning: 'Automatic approval review timed out while evaluating the requested approval.' };
    }
    if (error.type === 'cancelled') return { decision: { type: 'abort' } };
    const rationale = `Automatic approval review failed: ${error.message}`;
    return { decision: { type: 'denied', message: `${rationale}\n${REVIEW_FAILURE_INSTRUCTIONS}` }, warning: rationale };
  }
  const { assessment } = outcome;
  const approved = assessment.outcome === 'allow';
  return {
    decision: approved ? { type: 'approved' } : { type: 'denied', message: renderGuardianRejection(assessment.rationale, REJECTION_INSTRUCTIONS) },
    warning: `Automatic approval review ${approved ? 'approved' : 'denied'} (risk: ${assessment.riskLevel}, authorization: ${assessment.userAuthorization}): ${assessment.rationale}`,
    assessmentOutcome: assessment.outcome,
  };
}
