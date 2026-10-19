// Ported from openai/codex codex-rs/ext/guardian-reviewer/src/{circuit_breaker,reporting}.rs @ ce0323f (Apache-2.0);
// see docs/licenses/README.md. Counts policy denials per turn; the host carries out any interruption.

const MAX_CONSECUTIVE_CYBER_GUARDIAN_DENIALS_PER_TURN = 1;
const MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN = 3;
const MAX_RECENT_CYBER_AUTO_REVIEW_DENIALS_PER_TURN = 1;
const MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN = 10;
export const AUTO_REVIEW_DENIAL_WINDOW_SIZE = 50;

export type CircuitBreakerPolicy = 'standard' | 'cyber_model';
export type CircuitBreakerAction =
  | { type: 'continue' }
  | { type: 'interrupt_turn'; consecutiveDenials: number; recentDenials: number };

interface TurnState {
  consecutiveDenials: number;
  recentDenials: boolean[];
  interruptTriggered: boolean;
}

export class GuardianRejectionCircuitBreaker {
  private readonly turns = new Map<string, TurnState>();

  clearTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  recordDenial(turnId: string, policy: CircuitBreakerPolicy): CircuitBreakerAction {
    const turn = this.turn(turnId);
    turn.consecutiveDenials++;
    this.recordRecentReview(turn, true);
    const recentDenials = turn.recentDenials.filter(Boolean).length;
    const [maxConsecutive, maxRecent] = policy === 'standard'
      ? [MAX_CONSECUTIVE_GUARDIAN_DENIALS_PER_TURN, MAX_RECENT_AUTO_REVIEW_DENIALS_PER_TURN]
      : [MAX_CONSECUTIVE_CYBER_GUARDIAN_DENIALS_PER_TURN, MAX_RECENT_CYBER_AUTO_REVIEW_DENIALS_PER_TURN];
    if (!turn.interruptTriggered && (turn.consecutiveDenials >= maxConsecutive || recentDenials >= maxRecent)) {
      turn.interruptTriggered = true;
      return { type: 'interrupt_turn', consecutiveDenials: turn.consecutiveDenials, recentDenials };
    }
    return { type: 'continue' };
  }

  recordNonDenial(turnId: string): void {
    const turn = this.turn(turnId);
    turn.consecutiveDenials = 0;
    this.recordRecentReview(turn, false);
  }

  private turn(turnId: string): TurnState {
    let turn = this.turns.get(turnId);
    if (!turn) this.turns.set(turnId, turn = { consecutiveDenials: 0, recentDenials: [], interruptTriggered: false });
    return turn;
  }

  private recordRecentReview(turn: TurnState, denied: boolean): void {
    turn.recentDenials.push(denied);
    if (turn.recentDenials.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) turn.recentDenials.shift();
  }
}

/** Session-scoped denial accounting; returns a warning exactly once when a turn reaches its limit. */
export class ReviewDenials {
  private readonly breaker = new GuardianRejectionCircuitBreaker();

  clearTurn(turnId: string): void {
    this.breaker.clearTurn(turnId);
  }

  recordNonDenial(turnId: string): void {
    this.breaker.recordNonDenial(turnId);
  }

  recordDenial(turnId: string, policy: CircuitBreakerPolicy = 'standard'): string | undefined {
    const action = this.breaker.recordDenial(turnId, policy);
    if (action.type === 'continue') return undefined;
    return `Automatic approval review rejected too many approval requests for this turn (${action.consecutiveDenials} consecutive, ${action.recentDenials} in the last ${AUTO_REVIEW_DENIAL_WINDOW_SIZE} reviews); interrupting the turn.`;
  }
}
