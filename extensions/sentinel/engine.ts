/** A snapshot for both scoring and review. identity must encode authorization,
 * policy, cwd and session; callers must change it whenever any of those change.
 * complete=false means evidence is incomplete and always requires review.
 * Callers must not mutate action while a decision or its score is in flight. */
export interface ReviewInput {
  identity: string;
  action: unknown;
  systemPrompt: string;
  evidence: string;
  complete: boolean;
}

/** Runtime-validated synchronous reviewer output. */
export interface Assessment {
  outcome: 'allow' | 'deny';
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  user_authorization?: 'unknown' | 'low' | 'medium' | 'high';
  rationale?: string;
}

/** Only a valid recent low score or a successful review can allow execution. */
export interface Verdict {
  allow: boolean;
  source: 'cached' | 'review';
  reason: string;
  assessment?: Assessment;
}

export interface SentinelEngineOptions {
  classify: (input: ReviewInput, signal: AbortSignal) => Promise<'high' | 'low'>;
  review: (input: ReviewInput, signal: AbortSignal) => Promise<Assessment>;
  maxToolCallLag?: number;
  timeoutMs?: number;
  maxConcurrentScores?: number;
}

type Score = { index: number; identity: string; risk: 0 | 1 };
type Work = { controller: AbortController };
const superseded = Symbol('superseded');

function assessment(value: unknown): Assessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_assessment');
  const v = value as Record<string, unknown>;
  if (v.outcome !== 'allow' && v.outcome !== 'deny') throw new Error('invalid_assessment');
  if (v.risk_level !== undefined && !['low', 'medium', 'high', 'critical'].includes(v.risk_level as string)) throw new Error('invalid_assessment');
  if (v.user_authorization !== undefined && !['unknown', 'low', 'medium', 'high'].includes(v.user_authorization as string)) throw new Error('invalid_assessment');
  if (v.rationale !== undefined && typeof v.rationale !== 'string') throw new Error('invalid_assessment');
  return { outcome: v.outcome, risk_level: v.risk_level as Assessment['risk_level'],
    user_authorization: v.user_authorization as Assessment['user_authorization'], rationale: v.rationale as string | undefined };
}

/** Sentinel routing: sample asynchronously, reuse recent low evidence, and
 * await a separate approval review on every fallback. Reviews never seed scores.
 * Cancellation bounds engine work even if a callback ignores its signal. Such a
 * callback's underlying I/O cannot be forcibly stopped; transports must honor abort. */
export class SentinelEngine {
  private readonly options: Required<SentinelEngineOptions>;
  private generation = 0;
  private identity: string | undefined;
  private callIndex = 0;
  private score: Score | undefined;
  private latestFailed = 0;
  private readonly scores = new Map<number, Work>();
  private readonly work = new Set<Work>();

  constructor(options: SentinelEngineOptions) {
    this.options = { ...options, maxToolCallLag: options.maxToolCallLag ?? 2,
      timeoutMs: options.timeoutMs ?? 60_000, maxConcurrentScores: options.maxConcurrentScores ?? 4 };
    for (const [name, min, max] of [['maxToolCallLag', 0, Number.MAX_SAFE_INTEGER],
      ['timeoutMs', 1, 2_147_483_647], ['maxConcurrentScores', 1, Number.MAX_SAFE_INTEGER]] as const) {
      const value = this.options[name];
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
    }
  }

  /** Invalidate evidence before aborting work, so late completions cannot publish. */
  reset(): void {
    this.generation++;
    this.identity = undefined;
    this.score = undefined;
    this.latestFailed = 0;
    for (const task of [...this.work]) task.controller.abort(superseded);
  }

  /** Detached diagnostics; call indices remain monotonic across resets. */
  status() {
    return { identity: this.identity, callIndex: this.callIndex,
      score: this.score ? { ...this.score } : undefined,
      latestFailedToolCall: this.latestFailed, activeScores: this.scores.size, activeWork: this.work.size };
  }

  async decide(input: ReviewInput, signal?: AbortSignal): Promise<Verdict> {
    const index = ++this.callIndex;
    const deny = (reason: string): Verdict => ({ allow: false, source: 'review', reason });
    if (signal?.aborted) return deny('aborted');
    // Capture primitive fields before callbacks run or callers mutate their object.
    input = { ...input };
    if (this.identity !== input.identity) {
      this.reset();
      this.identity = input.identity;
    }
    const generation = this.generation;
    if (input.complete) this.schedule(input, index, generation, signal);
    else this.latestFailed = index; // Do not pay for a score that cannot be reused.
    if (signal?.aborted || generation !== this.generation) return deny('aborted');
    const score = this.score;
    const reason = input.complete !== true ? 'incomplete_input'
      : !score ? 'missing_score'
      : this.latestFailed > score.index ? 'scoring_failure'
      : index - score.index > this.options.maxToolCallLag ? 'stale_score'
      : score.identity !== input.identity ? 'identity_changed'
      : score.risk === 1 ? 'elevated_risk' : undefined;
    if (!reason) return { allow: true, source: 'cached', reason: 'low_risk' };
    try {
      const result = assessment(await this.run((s) => this.options.review(input, s), signal));
      if (signal?.aborted || generation !== this.generation) return deny('aborted');
      return { allow: result.outcome === 'allow', source: 'review', reason, assessment: result };
    } catch {
      return deny(signal?.aborted || generation !== this.generation ? 'aborted' : 'review_failed');
    }
  }

  private schedule(input: ReviewInput, index: number, generation: number, signal?: AbortSignal): void {
    if (this.scores.size >= this.options.maxConcurrentScores) {
      this.scores.values().next().value?.controller.abort(superseded);
    }
    const task = { controller: new AbortController() };
    this.scores.set(index, task);
    void this.run((s) => this.options.classify(input, s), signal, task, () => this.scores.delete(index))
      .then((value) => {
        if (generation !== this.generation || task.controller.signal.aborted) return;
        if (value !== 'low' && value !== 'high') throw new Error('invalid_score');
        if (!this.score || index > this.score.index) {
          // Score and authorization identity are published as one value.
          this.score = { index, identity: input.identity, risk: value === 'low' ? 0 : 1 };
        }
      }).catch(() => {
        if (generation === this.generation && task.controller.signal.reason !== superseded) {
          this.latestFailed = Math.max(this.latestFailed, index);
        }
      });
  }

  private run<T>(callback: (signal: AbortSignal) => Promise<T>, external?: AbortSignal,
    task: Work = { controller: new AbortController() }, cleanup?: () => void): Promise<T> {
    const signal = task.controller.signal;
    this.work.add(task);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: boolean, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        external?.removeEventListener('abort', cancel);
        signal.removeEventListener('abort', abort);
        this.work.delete(task);
        cleanup?.();
        if (error) reject(value); else resolve(value as T);
      };
      const abort = () => finish(true, signal.reason);
      const cancel = () => task.controller.abort(external?.reason);
      const timer = setTimeout(() => task.controller.abort(new Error('timeout')), this.options.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      external?.addEventListener('abort', cancel, { once: true });
      if (external?.aborted) cancel();
      if (signal.aborted) { abort(); return; }
      try {
        Promise.resolve(callback(signal)).then(v => finish(false, v), e => finish(true, e));
      } catch (error) { finish(true, error); }
    });
  }
}
