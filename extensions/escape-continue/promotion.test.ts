import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPromotion, SupersededPromotion, type SessionPort, type Promotion, type Message } from './promotion.ts';

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));
const versions = ['0.87 event start', '0.99 preflight start', '1.2 early streaming'] as const;

for (const scenario of [...versions, 'foreign run', 'cancelled preparation', 'handled input', 'cancelled before run start'] as const) {
  test(`version session adapter: ${scenario}`, async () => {
    const calls: string[] = [], notices: string[] = [];
    let pending: Promotion | undefined, restored: Message[] = [], streaming = true;
    const selected = user('Next'), tail = user('Later');
    const port: SessionPort = {
      queued: { steer: [], followUp: [selected, tail] },
      clear() { calls.push('clear'); },
      restore(queues) { restored = [...queues.steer, ...queues.followUp]; },
      capture() {},
      async abort() { calls.push('abort'); streaming = false; },
      streaming: () => streaming,
      async prompt(_message, check, events) {
        await this.abort();
        check();
        if (scenario === 'foreign run') throw new SupersededPromotion('Another prompt started during the promotion');
        if (scenario === '1.2 early streaming') streaming = true;
        if (scenario === 'cancelled preparation') pending!.cancel(false);
        check();
        if (scenario === 'handled input') return;
        if (scenario !== '0.87 event start') events.started();
        if (scenario === 'cancelled before run start') pending!.cancel();
        streaming = true;
        if (scenario === '0.87 event start') events.started();
        events.runStarted();
        events.delivered();
        pending!.restoreAtContext();
        calls.push('prompt');
        check();
      },
    };
    startPromotion(port, {
      current: () => true, notify: message => notices.push(message), status() {},
      pending: promotion => { pending = promotion; },
      release(promotion) { if (pending !== promotion) return false; pending = undefined; return true; },
    });
    await tick();
    assert.equal(pending, undefined);
    const retained = scenario === 'foreign run' || scenario === 'cancelled preparation' || scenario === 'handled input';
    assert.deepEqual(restored, retained ? [selected, tail] : [tail]);
    assert.equal(calls.includes('prompt'), !retained);
    assert.equal(notices.some(message => /Another prompt started/.test(message)), scenario === 'foreign run');
    assert.equal(calls.filter(call => call === 'abort').length, scenario === 'cancelled before run start' ? 2 : 1);
  });
}
