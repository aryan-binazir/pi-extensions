import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { trackerFooter } from './tracker-footer.ts';

test('reported Running/Status markdown is plain and never ends in an empty label', () => {
  assert.equal(trackerFooter('- **Running:** id abc - **Status:**'), 'Running: id abc');
  assert.equal(trackerFooter('- **Running:** id abc\n- **Status:** tests pending'), 'Running: id abc · Status: tests pending');
  assert.equal(trackerFooter('Tests pending · Status: checking logs', 24), 'Tests pending…');
});

test('long reports truncate at words with an explicit ellipsis', () => {
  assert.equal(trackerFooter('Tests are running with output pending', 22), 'Tests are running…');
  assert.equal(trackerFooter('x'.repeat(200)), '…');
  for (const width of [0, 1, 5, 20, 80, 100, 160]) {
    const value = trackerFooter('界界 tests pending '.repeat(100), width);
    assert.ok(visibleWidth(value ?? '') <= Math.min(width, 100));
  }
});

test('multiline markdown and terminal controls cannot leak into the footer', () => {
  assert.equal(trackerFooter('# Summary\n- **Tests** pending\n> See [logs](https://example.com)\n```\n`build` output\n```'), 'Summary · Tests pending · See logs · build output');
  assert.equal(trackerFooter('\x1b[31mTests\x1b[0m\x00 pending\u202e'), 'Tests pending');
  assert.equal(trackerFooter('\x1b]0;malicious title\x07Tests pending'), 'Tests pending');
});

test('empty or formatting-only reports do not invent a status', () => {
  for (const report of ['', ' \n\t', '**', '- **Status:**', '\x00']) assert.equal(trackerFooter(report), undefined);
});
