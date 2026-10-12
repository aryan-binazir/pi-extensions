import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { FollowQueue, type FollowClock } from './follow.ts';

class FakeClock implements FollowClock {
  private time = 0;
  private timers = new Set<{ at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, callback };
    this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    await setImmediate();
    for (;;) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > end) break;
      this.time = next.at;
      this.timers.delete(next);
      next.callback();
      await setImmediate();
    }
    this.time = end;
  }
}

function setup() {
  const clock = new FakeClock();
  const calls: { args: Record<string, unknown>; signal?: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const link = {
    connected: true,
    call(_name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> {
      return new Promise((resolve, reject) => { calls.push({ args, signal, resolve, reject }); });
    },
  };
  const state = { cwd: '/project', following: true, link: link as typeof link | undefined };
  const warnings: string[] = [];
  const queue = new FollowQueue({ clock, link: () => state.link, cwd: () => state.cwd, following: () => state.following, warn: message => warnings.push(message) });
  queue.update();
  return { clock, calls, link, state, warnings, queue, enqueue: (path: string, cwd = state.cwd) => queue.enqueue(path, cwd) };
}

test('coalescing uses a fixed 100 ms window and sends the latest destination without focus or selection', async () => {
  const h = setup();
  h.enqueue('/project/first.ts');
  await h.clock.advance(60);
  h.enqueue('/project/latest.ts');
  await h.clock.advance(39);
  assert.equal(h.calls.length, 0);
  await h.clock.advance(1);
  assert.deepEqual(h.calls.map(call => call.args), [{ filePath: '/project/latest.ts', preview: false, makeFrontmost: false }]);
});

test('one request stays in flight while newer edits replace the pending destination', async () => {
  const h = setup();
  h.enqueue('/project/first.ts');
  await h.clock.advance(100);
  h.enqueue('/project/older.ts');
  await h.clock.advance(100);
  h.enqueue('/project/latest.ts');
  await h.clock.advance(100);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve('opened');
  await h.clock.advance(99);
  assert.equal(h.calls.length, 1);
  await h.clock.advance(1);
  assert.equal(h.calls[1].args.filePath, '/project/latest.ts');
});

test('a stalled request aborts at five seconds and releases the next 100 ms window without retrying itself', async () => {
  const h = setup();
  h.enqueue('/project/stalled.ts');
  await h.clock.advance(100);
  h.calls[0].signal!.addEventListener('abort', () => h.calls[0].reject(new Error('aborted')), { once: true });
  h.enqueue('/project/newer.ts');
  await h.clock.advance(4999);
  assert.equal(h.calls[0].signal!.aborted, false);
  assert.equal(h.calls.length, 1);
  await h.clock.advance(1);
  assert.equal(h.calls[0].signal!.aborted, true);
  assert.deepEqual(h.warnings, ['Could not reveal stalled.ts in the editor: aborted']);
  await h.clock.advance(99);
  assert.equal(h.calls.length, 1);
  await h.clock.advance(1);
  assert.equal(h.calls[1].args.filePath, '/project/newer.ts');
  h.calls[1].resolve('opened');
  await h.clock.advance(30_000);
  assert.equal(h.calls.length, 2);
});

test('disconnected edits queue only after this session first connected', async () => {
  const clock = new FakeClock();
  const h = setup();
  h.link.connected = false;
  const queue = new FollowQueue({ clock, link: () => h.link, cwd: () => h.state.cwd, following: () => true, warn: message => h.warnings.push(message) });
  queue.enqueue('/project/never-connected.ts', h.state.cwd);
  h.link.connected = true;
  queue.update();
  await clock.advance(100);
  assert.equal(h.calls.length, 0);
  h.link.connected = false;
  queue.update();
  queue.enqueue('/project/older.ts', h.state.cwd);
  queue.enqueue('/project/latest.ts', h.state.cwd);
  await clock.advance(1000);
  assert.equal(h.calls.length, 0);
  h.link.connected = true;
  queue.update();
  await clock.advance(100);
  assert.equal(h.calls[0].args.filePath, '/project/latest.ts');
});

for (const [age, expected] of [[30_000, 1], [30_001, 0]] as const) {
  test(`replay age ${age} ms at dispatch ${expected ? 'is allowed' : 'is dropped quietly'}`, async () => {
    const h = setup();
    h.link.connected = false;
    h.queue.update();
    h.enqueue('/project/queued.ts');
    await h.clock.advance(age - 100);
    h.link.connected = true;
    h.queue.update();
    await h.clock.advance(100);
    assert.equal(h.calls.length, expected);
    assert.deepEqual(h.warnings, []);
    if (expected) h.calls[0].resolve('opened');
    await h.clock.advance(100);
    h.enqueue('/project/fresh.ts');
    await h.clock.advance(100);
    assert.equal(h.calls.at(-1)!.args.filePath, '/project/fresh.ts');
  });
}

for (const trigger of ['cwd change', 'follow off', 'explicit open', 'session replacement', 'shutdown'] as const) {
  test(`${trigger} clears coalescing and pending navigation, aborts in-flight work and ignores its late failure`, async () => {
    const h = setup();
    const invalidate = () => {
      if (trigger === 'cwd change') { h.state.cwd += '/other'; h.queue.update(); }
      else if (trigger === 'follow off') { h.state.following = false; h.queue.update(); }
      else if (trigger === 'session replacement') h.queue.reset();
      else h.queue.cancel();
    };
    h.enqueue('/project/coalescing.ts');
    invalidate();
    await h.clock.advance(100);
    assert.equal(h.calls.length, 0);
    h.state.following = true;
    h.queue.update();
    h.enqueue('/project/stalled.ts');
    await h.clock.advance(100);
    h.enqueue('/project/pending.ts');
    invalidate();
    assert.equal(h.calls[0].signal!.aborted, true);
    h.state.following = true;
    h.queue.update();
    h.enqueue('/project/fresh.ts');
    await h.clock.advance(100);
    h.enqueue('/project/latest.ts');
    h.calls[0].reject(new Error('late failure'));
    await h.clock.advance(100);
    assert.equal(h.calls.length, 2, 'late finally cannot release the new in-flight request');
    assert.deepEqual(h.warnings, []);
    h.calls[1].resolve('opened');
    await h.clock.advance(100);
    assert.deepEqual(h.calls.map(call => call.args.filePath), ['/project/stalled.ts', '/project/fresh.ts', '/project/latest.ts']);
  });
}

for (const newerPending of [false, true]) {
  test(`a lost reply replays ${newerPending ? 'the newer pending edit' : 'the same destination at least once'} after reconnect`, async () => {
    const h = setup();
    h.enqueue('/project/interrupted.ts');
    await h.clock.advance(100);
    if (newerPending) h.enqueue('/project/newer.ts');
    h.link.connected = false;
    h.calls[0].reject(new Error('connection lost'));
    h.queue.update();
    await h.clock.advance(1000);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.warnings, []);
    h.link.connected = true;
    h.queue.update();
    await h.clock.advance(100);
    assert.equal(h.calls[1].args.filePath, newerPending ? '/project/newer.ts' : '/project/interrupted.ts');
  });
}

test('connected failures warn once and never retry until a later automatic success starts a new episode', async () => {
  const h = setup();
  for (const [i, path] of ['bad1.ts', 'bad2.ts', 'good.ts', 'bad3.ts'].entries()) {
    h.enqueue(`/project/${path}`);
    await h.clock.advance(100);
    if (path === 'good.ts') h.calls[i].resolve('opened');
    else h.calls[i].reject(new Error('cannot open'));
    await h.clock.advance(1000);
    assert.equal(h.calls.length, i + 1);
    assert.equal(h.warnings.length, i === 3 ? 2 : 1);
  }
  assert.deepEqual(h.warnings, ['Could not reveal bad1.ts in the editor: cannot open', 'Could not reveal bad3.ts in the editor: cannot open']);
});

test('only an explicit success from the current link restarts the warning episode', async () => {
  const h = setup();
  for (const [i, path] of ['bad1.ts', 'bad2.ts', 'bad3.ts'].entries()) {
    if (i === 1) h.queue.succeeded({ ...h.link });
    if (i === 2) h.queue.succeeded(h.link);
    h.enqueue(`/project/${path}`);
    await h.clock.advance(100);
    h.calls[i].reject(new Error('cannot open'));
    await h.clock.advance(1000);
    assert.equal(h.warnings.length, i === 2 ? 2 : 1);
  }
});

test('a replay retains the original edit age even when the reply is lost much later', async () => {
  const h = setup();
  h.enqueue('/project/old.ts');
  await h.clock.advance(100);
  h.link.connected = false;
  await h.clock.advance(4900);
  h.calls[0].reject(new Error('connection lost'));
  await h.clock.advance(24_901);
  h.link.connected = true;
  h.queue.update();
  await h.clock.advance(100);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.warnings, []);
});

test('a cancelled late success cannot clear a newer failure episode', async () => {
  const h = setup();
  h.enqueue('/project/old.ts');
  await h.clock.advance(100);
  h.queue.cancel();
  h.enqueue('/project/bad1.ts');
  await h.clock.advance(100);
  h.calls[1].reject(new Error('cannot open'));
  await h.clock.advance(100);
  h.calls[0].resolve('late success');
  await h.clock.advance(100);
  h.enqueue('/project/bad2.ts');
  await h.clock.advance(100);
  h.calls[2].reject(new Error('cannot open'));
  await h.clock.advance(100);
  assert.equal(h.warnings.length, 1);
});

test('session replacement forgets the old connection and failure episode', async () => {
  const h = setup();
  h.enqueue('/project/old.ts');
  await h.clock.advance(100);
  h.calls[0].reject(new Error('cannot open'));
  await h.clock.advance(100);
  h.queue.reset();
  h.link.connected = false;
  h.queue.update();
  h.enqueue('/project/never-connected.ts');
  h.link.connected = true;
  h.queue.update();
  await h.clock.advance(100);
  assert.equal(h.calls.length, 1);
  h.enqueue('/project/new.ts');
  await h.clock.advance(100);
  h.calls[1].reject(new Error('cannot open'));
  await h.clock.advance(100);
  assert.equal(h.warnings.length, 2);
});

test('an edit from a different cwd cancels the old flight and is dropped when it differs from the live workspace', async () => {
  const h = setup();
  h.enqueue('/project/old.ts');
  await h.clock.advance(100);
  h.enqueue('/other/new.ts', '/other');
  assert.equal(h.calls[0].signal!.aborted, true);
  h.calls[0].reject(new Error('aborted'));
  await h.clock.advance(100);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.warnings, []);
});

for (const change of ['cwd', 'connection'] as const) {
  test(`dispatch rechecks the live ${change} after the coalescing window`, async () => {
    const h = setup();
    h.enqueue('/project/queued.ts');
    if (change === 'cwd') h.state.cwd = '/other';
    else h.link.connected = false;
    await h.clock.advance(100);
    assert.equal(h.calls.length, 0);
    h.state.cwd = '/project';
    h.link.connected = true;
    h.queue.update();
    await h.clock.advance(100);
    assert.equal(h.calls.length, change === 'connection' ? 1 : 0);
  });
}
