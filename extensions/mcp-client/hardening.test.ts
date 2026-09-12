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

test('model tool names stay stable, bounded and collision-resistant across raw names', () => {
  assert.equal(toolName('fixture', 'echo'), 'mcp_fixture_echo_ec544279c5e5dba9');
  const names = [toolName('a_b', 'c'), toolName('a', 'b_c'), toolName('a', 'a.b'), toolName('a', 'a_b'), toolName('💡'.repeat(1000), 'long'.repeat(1000))];
  assert.equal(new Set(names).size, names.length);
  for (const name of names) { assert.match(name, /^[A-Za-z0-9_-]+$/); assert.ok(name.length <= 64); }
});
