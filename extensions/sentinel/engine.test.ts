import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { SentinelEngine, type Assessment, type ReviewInput } from './engine.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const input: ReviewInput = { identity: 'authorization|policy|cwd|session', action: { command: 'ls' },
  systemPrompt: 'policy', evidence: 'evidence', complete: true };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(options: { maxToolCallLag?: number; maxConcurrentScores?: number; timeoutMs?: number } = {}) {
  const scores: { result: ReturnType<typeof deferred<'high' | 'low'>>; signal: AbortSignal }[] = [];
  const reviews: { result: ReturnType<typeof deferred<Assessment>>; signal: AbortSignal; input: ReviewInput }[] = [];
  const engine = new SentinelEngine({ ...options,
    classify: (_input, signal) => { const result = deferred<'high' | 'low'>(); scores.push({ result, signal }); return result.promise; },
    review: (input, signal) => { const result = deferred<Assessment>(); reviews.push({ result, signal, input }); return result.promise; },
  });
  return { engine, scores, reviews };
}

test('cold review is independent of scoring; cached path does not await current score; lag is inclusive', async () => {
  const { engine, scores, reviews } = harness();
  try {
    const first = engine.decide(input);
    scores[0].result.resolve('low');
    await flush();
    reviews[0].result.resolve({ outcome: 'deny', rationale: 'not authorized' });
    assert.equal((await first).allow, false);
    assert.equal((await engine.decide(input)).source, 'cached');
    assert.equal((await engine.decide(input)).source, 'cached');
    const stale = engine.decide(input);
    reviews[1].result.resolve({ outcome: 'allow' });
    assert.equal((await stale).reason, 'stale_score');
    assert.equal(scores.length, 4);
  } finally { engine.reset(); }
});

test('reviews never create cached evidence', async () => {
  const { engine, reviews } = harness();
  try {
    for (let i = 0; i < 2; i++) {
      const result = engine.decide(input);
      reviews[i].result.resolve({ outcome: 'allow' });
      assert.equal((await result).reason, 'missing_score');
    }
  } finally { engine.reset(); }
});

for (const [older, newer] of [['low', 'high'], ['high', 'low']] as const) {
  test(`late ${older} cannot overwrite newer ${newer}`, async () => {
    const { engine, scores, reviews } = harness();
    try {
      const a = engine.decide(input);
      const b = engine.decide(input);
      scores[1].result.resolve(newer);
      await flush();
      scores[0].result.resolve(older);
      await flush();
      assert.equal(engine.status().score?.risk, newer === 'low' ? 0 : 1);
      const c = engine.decide(input);
      if (newer === 'high') reviews[2].result.resolve({ outcome: 'allow' });
      assert.equal((await c).source, newer === 'low' ? 'cached' : 'review');
      engine.reset();
      assert.equal((await a).allow, false);
      assert.equal((await b).allow, false);
    } finally { engine.reset(); }
  });
}

test('a newer failure blocks an older low score, until a still newer score succeeds', async () => {
  const { engine, scores, reviews } = harness({ maxToolCallLag: 10 });
  try {
    const first = engine.decide(input);
    scores[0].result.resolve('low');
    reviews[0].result.resolve({ outcome: 'allow' });
    await first;
    await flush();
    await engine.decide(input);
    scores[1].result.reject(new Error('offline'));
    await flush();
    const third = engine.decide(input);
    reviews[1].result.resolve({ outcome: 'deny' });
    assert.equal((await third).reason, 'scoring_failure');
    scores[2].result.resolve('low');
    await flush();
    assert.equal((await engine.decide(input)).source, 'cached');
  } finally { engine.reset(); }
});

test('older low arriving after newer failure remains unusable', async () => {
  const { engine, scores, reviews } = harness();
  const a = engine.decide(input);
  const b = engine.decide(input);
  scores[1].result.reject(new Error('failed'));
  await flush();
  scores[0].result.resolve('low');
  await flush();
  const c = engine.decide(input);
  reviews[2].result.resolve({ outcome: 'deny' });
  assert.equal((await c).reason, 'scoring_failure');
  engine.reset();
  await Promise.all([a, b]);
});

for (const change of ['reset', 'identity'] as const) {
  test(`${change} aborts reviews and scores; ignored aborts cannot publish or allow`, async () => {
    const { engine, scores, reviews } = harness();
    const first = engine.decide(input);
    let next: Promise<unknown> | undefined;
    if (change === 'reset') engine.reset();
    else next = engine.decide({ ...input, identity: 'new session' });
    assert.equal(scores[0].signal.aborted, true);
    assert.equal(reviews[0].signal.aborted, true);
    scores[0].result.resolve('low');
    reviews[0].result.resolve({ outcome: 'allow' });
    assert.equal((await first).allow, false);
    await flush();
    assert.equal(engine.status().score, undefined);
    engine.reset();
    await next;
    assert.equal(engine.status().activeWork, 0);
  });
}

test('identity change invalidates cached low, including a change back to the original identity', async () => {
  const { engine, scores, reviews } = harness();
  const first = engine.decide(input);
  scores[0].result.resolve('low');
  reviews[0].result.resolve({ outcome: 'allow' });
  await first;
  await flush();
  const second = engine.decide({ ...input, identity: 'different cwd' });
  const third = engine.decide(input);
  assert.equal((await second).allow, false);
  assert.equal(reviews.length, 3);
  engine.reset();
  assert.equal((await third).allow, false);
});

test('external abort blocks callbacks before execution and bounds uncooperative callbacks', async () => {
  const { engine, scores, reviews } = harness();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await engine.decide(input, controller.signal)).allow, false);
  assert.equal(scores.length, 0);
  const active = new AbortController();
  const pending = engine.decide(input, active.signal);
  assert.equal(getEventListeners(active.signal, 'abort').length, 2);
  active.abort();
  assert.equal((await pending).allow, false);
  assert.equal(scores[0].signal.aborted, true);
  assert.equal(reviews[0].signal.aborted, true);
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
  assert.equal(engine.status().activeWork, 0);
  engine.reset();
});

test('capacity cancels the oldest classifier without marking supersession as failure', async () => {
  const { engine, scores, reviews } = harness({ maxToolCallLag: 20 });
  try {
    const first = engine.decide(input);
    scores[0].result.resolve('low');
    reviews[0].result.resolve({ outcome: 'allow' });
    await first;
    await flush();
    for (let i = 0; i < 9; i++) {
      assert.equal((await engine.decide(input)).source, 'cached');
      assert.ok(engine.status().activeScores <= 4);
      assert.ok(scores.filter(s => !s.signal.aborted).length <= 5); // Includes completed initial score.
    }
    assert.equal(scores[1].signal.aborted, true);
    scores[1].result.resolve('high');
    await flush();
    assert.equal(engine.status().latestFailedToolCall, 0);
    assert.equal(engine.status().score?.risk, 0);
  } finally { engine.reset(); }
});

test('incomplete input always reaches review unchanged and cannot seed reusable low evidence', async () => {
  const { engine, scores, reviews } = harness();
  try {
    const first = engine.decide(input);
    scores[0].result.resolve('low');
    reviews[0].result.resolve({ outcome: 'allow' });
    await first;
    await flush();
    const incomplete = engine.decide({ ...input, complete: false });
    assert.equal(reviews[1].input.complete, false);
    assert.equal(scores.length, 1, 'incomplete evidence must not launch an unusable classifier');
    reviews[1].result.resolve({ outcome: 'deny' });
    assert.equal((await incomplete).reason, 'incomplete_input');
    await flush();
    const complete = engine.decide(input);
    reviews[2].result.resolve({ outcome: 'deny' });
    assert.equal((await complete).reason, 'scoring_failure');
  } finally { engine.reset(); }
});

test('timeout bounds both callbacks, aborts their signals, and removes listeners and timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, scores, reviews } = harness({ timeoutMs: 100 });
  const controller = new AbortController();
  const result = engine.decide(input, controller.signal);
  t.mock.timers.tick(100);
  assert.equal((await result).allow, false);
  await flush();
  assert.equal(scores[0].signal.aborted, true);
  assert.equal(reviews[0].signal.aborted, true);
  assert.equal(engine.status().latestFailedToolCall, 1);
  assert.equal(engine.status().activeWork, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  scores[0].result.resolve('low');
  reviews[0].result.resolve({ outcome: 'allow' });
  await flush();
  assert.equal(engine.status().score, undefined);
});

test('successful settlement cleans listeners and cancels timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, scores, reviews } = harness({ timeoutMs: 100 });
  const controller = new AbortController();
  const pending = engine.decide(input, controller.signal);
  scores[0].result.resolve('high');
  reviews[0].result.resolve({ outcome: 'allow', risk_level: 'low', user_authorization: 'high', rationale: 'approved' });
  assert.equal((await pending).assessment?.rationale, 'approved');
  await flush();
  t.mock.timers.tick(100);
  assert.equal(scores[0].signal.aborted, false);
  assert.equal(reviews[0].signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(engine.status().activeWork, 0);
});

for (const malformed of [null, {}, 'allow', { outcome: true }, { outcome: 'ALLOW' },
  { outcome: 'allow', risk_level: 'safe' }, { outcome: 'allow', user_authorization: 1 },
  { outcome: 'allow', rationale: false }]) {
  test(`malformed review denies: ${JSON.stringify(malformed)}`, async () => {
    const engine = new SentinelEngine({ classify: async () => 'low', review: async () => malformed as any });
    assert.equal((await engine.decide(input)).allow, false);
    engine.reset();
  });
}

test('malformed classification cannot authorize; thrown callbacks deny', async () => {
  const engine = new SentinelEngine({ classify: async () => 'LOW' as any,
    review: () => { throw new Error('failed'); } });
  assert.equal((await engine.decide(input)).allow, false);
  await flush();
  assert.equal(engine.status().score, undefined);
  assert.equal(engine.status().latestFailedToolCall, 1);
  assert.equal((await engine.decide(input)).allow, false);
  engine.reset();
});

test('reset between review resolution and continuation prevents allow', async () => {
  const { engine, reviews } = harness();
  const pending = engine.decide(input);
  reviews[0].result.resolve({ outcome: 'allow' });
  engine.reset();
  assert.equal((await pending).allow, false);
});

test('abort on cached path prevents allow even when classifier aborts synchronously', async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = new SentinelEngine({ classify: async () => {
    if (++calls === 2) controller.abort();
    return 'low';
  }, review: async () => ({ outcome: 'allow' }) });
  await engine.decide(input);
  await flush();
  assert.equal((await engine.decide(input, controller.signal)).allow, false);
  engine.reset();
});

test('invalid limits reject construction', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxConcurrentScores: 0 },
    { maxToolCallLag: -1 }, { maxToolCallLag: NaN }, { maxConcurrentScores: 1.5 }]) {
    assert.throws(() => new SentinelEngine({ ...options, classify: async () => 'low', review: async () => ({ outcome: 'allow' }) }), RangeError);
  }
});
