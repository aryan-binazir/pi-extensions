import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prefix } from './text.ts';

test('truncated prefixes preserve UTF-16 code units without retaining the raw selection', async () => {
  assert.equal(prefix('a😀b', 2), 'a');
  assert.equal(prefix('a😀b', 3), 'a😀');
  assert.equal(prefix('a\uD800b\uDC00c', 4), 'a\uD800b\uDC00');
  assert.equal(prefix('abc', 0), '');
  assert.equal(prefix('abc', -1), '');
  assert.equal(prefix('abc', 3), 'abc');
  const source = `
    import { getHeapSnapshot } from 'node:v8';
    import { prefix } from ${JSON.stringify(new URL('./text.ts', import.meta.url).href)};
    globalThis.selection = prefix('raw-selection-parent-'.repeat(500_000), 50_000);
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    const chunks = [];
    for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
    const heap = JSON.parse(Buffer.concat(chunks).toString());
    const fields = heap.snapshot.meta.node_fields;
    const types = heap.snapshot.meta.node_types[fields.indexOf('type')];
    let retained = false;
    for (let i = 0; i < heap.nodes.length; i += fields.length) {
      if (types[heap.nodes[i + fields.indexOf('type')]] === 'string'
        && heap.nodes[i + fields.indexOf('self_size')] > 1_000_000
        && heap.strings[heap.nodes[i + fields.indexOf('name')]].startsWith('raw-selection-parent-')) retained = true;
    }
    console.log(JSON.stringify({ retained, length: globalThis.selection.length }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', source]);
  assert.deepEqual(JSON.parse(stdout), { retained: false, length: 50_000 });
});
