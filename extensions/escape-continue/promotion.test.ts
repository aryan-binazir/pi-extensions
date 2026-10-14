import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPromotion, type SessionPort, type Promotion, type Message } from './promotion.ts';

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const scenario of ['ordinary', 'owned preparation', 'foreign streaming', 'foreign compaction', 'cancelled preparation', 'handled input'] as const) {
  test(`promotion session seam: ${scenario}`, async () => {
    const calls: string[] = [], notices: string[] = [];
    let pending: Promotion | undefined, restored: Message[] = [];
    const selected = user('Next'), tail = user('Later');
    const port: SessionPort = {
      queued: { steer: [], followUp: [selected, tail] },
      clear() { calls.push('clear'); },
      restore(queues) { restored = [...queues.steer, ...queues.followUp]; },
      capture() {},
      async abort() { calls.push('abort'); },
      streaming: () => scenario === 'owned preparation',
      foreignRunActive() { calls.push('foreign'); return scenario.startsWith('foreign'); },
      async prompt(_message, check, events) {
        calls.push('prompt');
        if (scenario === 'cancelled preparation') pending!.cancel(false);
        check();
        if (scenario === 'handled input') return;
        events.started();
        events.runStarted();
        events.delivered();
        pending!.restoreAtContext();
        check();
      },
    };
    startPromotion(port, {
      current: () => true, notify: message => notices.push(message), status() {},
      pending: promotion => { pending = promotion; },
      release(promotion) { if (pending !== promotion) return false; pending = undefined; return true; },
    });
    await tick();
    assert.deepEqual(calls.slice(0, 3), ['clear', 'abort', 'foreign']);
    assert.equal(calls.filter(call => call === 'foreign').length, 1, 'foreign-run check never runs inside owned checkpoints');
    assert.equal(pending, undefined);
    const retained = scenario.startsWith('foreign') || scenario === 'cancelled preparation' || scenario === 'handled input';
    assert.deepEqual(restored, retained ? [selected, tail] : [tail]);
    assert.equal(calls.includes('prompt'), !scenario.startsWith('foreign'));
    assert.equal(notices.some(message => /Another prompt started/.test(message)), scenario.startsWith('foreign'));
  });
}
