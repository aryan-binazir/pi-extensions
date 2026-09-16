import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedResult, toolName } from './client.ts';
import { displayLabel, schemaAllowed } from './index.ts';

const nestedSchema = (count: number) => {
  let schema: unknown = { type: 'object' };
  while (count--) schema = { type: 'object', properties: { child: schema } };
  return schema;
};

test('terminal labels remove controls and directional spoofing with bounded single-line text', () => {
  const raw = 'lookup\n\nFAKE REASSURANCE\x1b[8mconceal\x1b]0;title\x07\u202ehidden' + 'x'.repeat(100000);
  const label = displayLabel(raw);
  assert.ok(label.length <= 80);
  assert.doesNotMatch(label, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(label, /\[8m|0;title/);
});

test('schema guard rejects extreme depth before serialization and pins supported reference forms', () => {
  assert.equal(schemaAllowed(nestedSchema(15)), true);
  assert.equal(schemaAllowed(nestedSchema(16)), false);
  assert.equal(schemaAllowed(nestedSchema(10000)), false);
  assert.equal(schemaAllowed({ type: 'object', $ref: '#' }), true);
  assert.equal(schemaAllowed({ type: 'object', $ref: '#/$defs/item' }), true);
  assert.equal(schemaAllowed({ type: 'object', $ref: '#anchor' }), false);
  assert.equal(schemaAllowed({ type: 'object', $ref: 'https://example.invalid/schema' }), false);
  assert.equal(schemaAllowed({ type: 'object', description: 'x'.repeat(32768) }), false);
});

test('bounded output safely omits structures that overflow JSON serialization', () => {
  assert.match(boundedResult(nestedSchema(10000), 256), /output omitted/);
  const cycle: any = {}; cycle.self = cycle;
  const text = boundedResult(cycle, 256);
  assert.match(text, /not JSON serializable/);
  assert.ok(Buffer.byteLength(text) <= 256);
});

test('bounded output truncates to the same bytes as encoding the whole value', () => {
  // boundedResult slices before encoding to keep the temporary buffer small; the bytes it
  // keeps must stay identical to encoding everything and cutting at the limit.
  const reference = (value: unknown, maxBytes: number) => {
    const text = JSON.stringify(value)!;
    if (Buffer.byteLength(text) <= maxBytes) return text;
    return Buffer.from(text).subarray(0, maxBytes - 64).toString('utf8') + '\n[MCP output truncated]';
  };
  const values: unknown[] = [
    null, 0, '', { ok: true }, ['a', 'b'],
    { text: 'x'.repeat(200000) },
    { text: '\u00e9\u4e2d\ud83d\ude00'.repeat(40000) },
    { text: '\ud83d\ude00'.repeat(150) },
    { text: '\u4e2d'.repeat(90) },
    nestedSchema(12),
  ];
  for (const value of values) for (const maxBytes of [256, 300, 301, 302, 4000, 65536]) {
    assert.equal(boundedResult(value, maxBytes), reference(value, maxBytes), `${maxBytes} ${JSON.stringify(value).slice(0, 40)}`);
    assert.ok(Buffer.byteLength(boundedResult(value, maxBytes)) <= maxBytes);
  }
});

test('model tool names stay stable, bounded and collision-resistant across raw names', () => {
  assert.equal(toolName('fixture', 'echo'), 'mcp_fixture_echo_ec544279c5e5dba9');
  const names = [toolName('a_b', 'c'), toolName('a', 'b_c'), toolName('a', 'a.b'), toolName('a', 'a_b'), toolName('💡'.repeat(1000), 'long'.repeat(1000))];
  assert.equal(new Set(names).size, names.length);
  for (const name of names) { assert.match(name, /^[A-Za-z0-9_-]+$/); assert.ok(name.length <= 64); }
});
