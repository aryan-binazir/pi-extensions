import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPages, withDeadline } from './pagination.ts';

test('catalog pagination follows empty cursors and preserves item order', async () => {
  const seen: (string | undefined)[] = [];
  assert.deepEqual(await collectPages(async cursor => {
    seen.push(cursor);
    return cursor === undefined ? { items: [1], nextCursor: '' } : { items: [2] };
  }), [1, 2]);
  assert.deepEqual(seen, [undefined, '']);
});

test('catalog rejects cursor cycles, oversized cursors, excess pages and items', async () => {
  let calls = 0;
  await assert.rejects(collectPages(async () => { calls++; return { items: [], nextCursor: 'same' }; }), /repeated/);
  assert.equal(calls, 2);
  await assert.rejects(collectPages(async () => ({ items: [], nextCursor: '🔥'.repeat(16385) })), /64 KiB/);
  await assert.rejects(collectPages(async () => ({ items: Array(257).fill(0) })), /256 items/);
  calls = 0;
  await assert.rejects(collectPages(async () => ({ items: [], nextCursor: String(calls++) })), /32 pages/);
  assert.equal(calls, 32);
});

test('one deadline covers all pages, even when each page finishes before it', async () => {
  let calls = 0;
  await assert.rejects(withDeadline(60, [], signal => collectPages(async () => {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 25));
    signal.throwIfAborted();
    return { items: [], nextCursor: String(calls++) };
  })), { name: 'TimeoutError' });
  assert.ok(calls < 4);
});

test('already aborted operations do not run; pending operations observe cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withDeadline(100, [controller.signal], async () => { assert.fail('must not run'); }), { name: 'AbortError' });
  const active = new AbortController();
  let observed = false;
  const pending = withDeadline(1000, [active.signal], signal => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { observed = true; resolve(); }, { once: true });
  }));
  active.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(observed, true);
});
