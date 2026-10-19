// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/circuit_breaker_tests.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTO_REVIEW_DENIAL_WINDOW_SIZE, GuardianRejectionCircuitBreaker, ReviewDenials } from './circuit-breaker.ts';

const CONTINUE = { type: 'continue' } as const;
const interrupt = (consecutiveDenials: number, recentDenials: number) => ({ type: 'interrupt_turn', consecutiveDenials, recentDenials });

test('circuit breaker interrupts after three consecutive denials', () => {
  const breaker = new GuardianRejectionCircuitBreaker();
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), interrupt(3, 3));
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
});

test('circuit breaker interrupts cyber models after one denial', () => {
  const breaker = new GuardianRejectionCircuitBreaker();
  assert.deepEqual(breaker.recordDenial('turn-1', 'cyber_model'), interrupt(1, 1));
  assert.deepEqual(breaker.recordDenial('turn-1', 'cyber_model'), CONTINUE);
});

test('circuit breaker resets consecutive denials on non-denial', () => {
  const breaker = new GuardianRejectionCircuitBreaker();
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
  breaker.recordNonDenial('turn-1');
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), interrupt(3, 4));
});

test('auto review circuit breaker interrupts after ten recent denials', () => {
  const breaker = new GuardianRejectionCircuitBreaker();
  for (let index = 0; index < 9; index++) {
    assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
    breaker.recordNonDenial('turn-1');
  }
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), interrupt(1, 10));
});

test('auto review circuit breaker forgets denials outside recent review window', () => {
  const breaker = new GuardianRejectionCircuitBreaker();
  for (let index = 0; index < 9; index++) {
    assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
    breaker.recordNonDenial('turn-1');
  }
  for (let index = 0; index < AUTO_REVIEW_DENIAL_WINDOW_SIZE - 18; index++) breaker.recordNonDenial('turn-1');
  assert.deepEqual(breaker.recordDenial('turn-1', 'standard'), CONTINUE);
});

test('review denials warn once per turn with Codex wording', () => {
  const denials = new ReviewDenials();
  assert.equal(denials.recordDenial('turn-1'), undefined);
  assert.equal(denials.recordDenial('turn-1'), undefined);
  assert.equal(denials.recordDenial('turn-1'),
    'Automatic approval review rejected too many approval requests for this turn (3 consecutive, 3 in the last 50 reviews); interrupting the turn.');
  denials.clearTurn('turn-1');
  assert.equal(denials.recordDenial('turn-1'), undefined);
});
