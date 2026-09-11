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

test('inspection reconnects once; timeout closes transport and releases queue', async () => {
  let created = 0, closed = 0;
  const session = new DesktopSession(() => {
    const generation = ++created;
    return { async run() { if (generation === 1) throw new Error('stale socket'); return { available: true }; }, close() { closed++; } };
  });
  assert.deepEqual(await session.run({ action: 'accessibility' }), { available: true });
  assert.equal(created, 2); await session.close(); assert.equal(closed, 2);
  const hanging = new DesktopSession(() => ({ run: () => new Promise(() => {}), close() { closed++; } }), 15);
  await assert.rejects(hanging.run({ action: 'type', text: 'one' }), /outcome may be partial/);
  await hanging.close(); assert.equal(closed, 3);
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
  await assert.rejects(session.run({ action: 'type', text: 'never' }, abort.signal));
  assert.equal(created, 0); await session.close();
});
