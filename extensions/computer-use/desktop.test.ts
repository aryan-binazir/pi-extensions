import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSession, type DesktopBackend } from './desktop.ts';

test('desktop serializes operations and does not repeat mutations after transport failure', async () => {
  let active = 0, maximum = 0, calls = 0;
  const backend: DesktopBackend = {
    async run() { calls++; active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--; throw new Error('Disconnected'); },
    close() {},
  };
  const session = new DesktopSession(() => backend);
  await Promise.allSettled([session.run({ action: 'type', text: 'first' }), session.run({ action: 'type', text: 'second' })]);
  assert.equal(maximum, 1); assert.equal(calls, 2);
  await session.close();
});

test('inspection reconnects once after a transport failure', async () => {
  let created = 0, closed = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run() { if (generation === 1) throw new Error('stale socket'); return { available: true }; }, close() { closed++; } };
  });
  assert.deepEqual(await session.run({ action: 'accessibility' }), { available: true });
  assert.equal(created, 2); await session.close(); assert.equal(closed, 2);
});

test('a timed-out mutation closes its transport and releases the queue', async () => {
  let closed = 0;
  const hanging = new DesktopSession(() => ({ run: () => new Promise<never>(() => {}), close() { closed++; } }), 15);
  await assert.rejects(hanging.run({ action: 'type', text: 'one' }), /outcome may be partial/);
  assert.equal(closed, 1);
  await hanging.close(); assert.equal(closed, 1);
});

test('invalid desktop commands never reach transport', async () => {
  let calls = 0;
  const session = new DesktopSession(() => ({ async run() { calls++; return {}; }, close() {} }));
  for (const action of [{ action: 'click', output: 'HEADLESS-1', x: NaN, y: 0 }, { action: 'type', text: 'x', command: 'oops' }, { action: 'scroll', output: 'a', dx: 100000, dy: 0 }]) {
    await assert.rejects(session.run(action as any), /Invalid desktop/);
  }
  assert.equal(calls, 0); await session.close();
});

test('already cancelled calls do not create a native transport', async () => {
  let created = 0;
  const session = new DesktopSession(() => { created++; throw new Error('must not run'); });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.run({ action: 'type', text: 'never' }, abort.signal), /abort/i);
  assert.equal(created, 0); await session.close();
});

test('inspection still reconnects when closing the failed transport also rejects', async () => {
  let created = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run() { if (generation === 1) throw new Error('stale socket'); return { available: true }; }, async close() { throw new Error('Close failed'); } };
  });
  assert.deepEqual(await session.run({ action: 'accessibility' }), { available: true });
  assert.equal(created, 2);
  await assert.rejects(session.close(), /Close failed/);
});

test('inspection that cannot be retried keeps its originating failure as the cause of a close failure', async () => {
  const failures = [new Error('first stale socket'), new Error('second stale socket')];
  let created = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run(): Promise<never> { throw failures[generation - 1]; }, async close() { throw new Error('Close failed'); } };
  });
  await assert.rejects(session.run({ action: 'accessibility' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Close failed/);
    assert.equal(error.cause, failures[1]);
    return true;
  });
  assert.equal(created, 2);
  await session.close();
});

test('failed mutation retains its unknown-outcome warning when transport close rejects', async () => {
  const failure = new Error('Disconnected during typing');
  const session = new DesktopSession(() => ({
    async run() { throw failure; },
    async close() { throw new Error('Close failed'); },
  }));
  try {
    await assert.rejects(session.run({ action: 'type', text: 'once' }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Desktop mutation failed or was cancelled; outcome may be partial or unknown/);
      assert.equal(error.cause, failure);
      return true;
    });
  } finally { await session.close(); }
});
