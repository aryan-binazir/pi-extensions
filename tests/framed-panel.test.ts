import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FramedPanel } from '../extensions/framed-panel.ts';

const theme = { fg: (_color: 'border', text: string) => `\x1b[34m${text}\x1b[39m` };
const plain = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));

test('unchanged framed panels reuse their rendered lines', () => {
  for (const fit of ['wrap', 'truncate'] as const) {
    const panel = new FramedPanel('alt+t', fit);
    let builds = 0;
    const content = { summary: 'Todos', title: 'List', rows: () => { builds++; return ['Next']; } };
    const compact = panel.render(20, theme, content);
    assert.strictEqual(panel.render(20, theme, { ...content }), compact);
    assert.equal(builds, 0);
    panel.toggle();
    const expanded = panel.render(20, theme, content);
    assert.strictEqual(panel.render(20, theme, { ...content }), expanded);
    assert.equal(builds, 1);
    assert.deepEqual(plain(expanded), ['╭──────────────────╮', '│ List             │', '│ Next             │', '╰──────────────────╯']);
  }
});

test('framed panel cache follows every render input and preserves earlier output', () => {
  for (const fit of ['wrap', 'truncate'] as const) {
    const panel = new FramedPanel('alt+t', fit);
    const content = { summary: 'Todos', title: 'List', rows: ['Next', 'Later'] };
    const compact = panel.render(20, theme, content);
    assert.deepEqual(plain(panel.render(20, theme, { ...content, summary: 'Changed' })), ['Changed']);
    panel.toggle();
    const first = panel.render(20, theme, content);
    const saved = [...first];
    for (const [width, next, pattern] of [
      [10, content, /╭────────╮/],
      [20, { ...content, rows: ['Changed row'] }, /Changed row/],
      [20, { ...content, title: 'Changed title' }, /Changed title/],
      [20, { ...content, summary: 'Changed summary' }, /List/],
      [20, { ...content, maxHeight: 3 }, /List/],
    ] as const) {
      const before = panel.render(20, theme, content);
      const changed = panel.render(width, theme, next);
      assert.notStrictEqual(changed, before);
      assert.match(plain(changed).join('\n'), pattern);
      if ('maxHeight' in next) assert.equal(changed.length, 3);
      assert.strictEqual(panel.render(width, theme, { ...next }), changed);
    }
    assert.deepEqual(first, saved);
    panel.toggle();
    assert.deepEqual(panel.render(20, theme, content), compact);
    assert.equal(panel.render(5, theme, content).length, 0);
    const hidden = panel.render(5, theme, content);
    assert.strictEqual(panel.render(5, theme, content), hidden);
  }
});

test('height changes rebuild capacity rows and explicit invalidation refreshes a mutable theme', () => {
  const panel = new FramedPanel('alt+r', 'truncate');
  panel.toggle();
  let color = '34';
  const mutableTheme = { fg: (_color: 'border', text: string) => `\x1b[${color}m${text}\x1b[39m` };
  const capacities: number[] = [];
  const content = { summary: 'Agents', title: 'List', maxHeight: 5, rows: (capacity: number) => {
    capacities.push(capacity);
    return ['one', 'two', 'three'].slice(0, capacity);
  } };
  const first = panel.render(20, mutableTheme, content);
  assert.strictEqual(panel.render(20, mutableTheme, content), first);
  assert.deepEqual(capacities, [2]);
  const taller = panel.render(20, mutableTheme, { ...content, maxHeight: 6 });
  assert.deepEqual(capacities, [2, 3]);
  assert.equal(taller.length, 6);
  color = '31';
  panel.invalidate();
  const recolored = panel.render(20, mutableTheme, content);
  assert.notStrictEqual(recolored, first);
  assert.match(recolored[0], /^\x1b\[31m/);
  assert.strictEqual(panel.render(20, mutableTheme, content), recolored);
  const other = new FramedPanel('alt+r', 'truncate');
  other.toggle();
  assert.notStrictEqual(other.render(20, mutableTheme, content), recolored);
});

test('failed row rendering does not populate the panel cache', () => {
  const panel = new FramedPanel('alt+r', 'truncate');
  panel.toggle();
  let fail = true;
  const content = { summary: 'Agents', title: 'List', rows: () => {
    if (fail) throw new Error('rows unavailable');
    return ['Recovered'];
  } };
  assert.throws(() => panel.render(20, theme, content), /rows unavailable/);
  fail = false;
  assert.match(plain(panel.render(20, theme, content)).join('\n'), /Recovered/);
});

test('framed panels preserve compact and expanded output within width and height limits', () => {
  for (const fit of ['wrap', 'truncate'] as const) {
    const panel = new FramedPanel('alt+t', fit);
    const content = { summary: `Todos · ${theme.fg('border', panel.shortcut)}`, title: 'List', rows: ['○ Next'] };
    assert.equal(panel.expanded, false);
    assert.deepEqual(plain(panel.render(20, theme, content)), ['Todos · alt+t']);
    panel.toggle();
    assert.deepEqual(plain(panel.render(20, theme, content)), [
      '╭──────────────────╮',
      '│ List             │',
      '│ ○ Next           │',
      '╰──────────────────╯',
    ]);
    assert.deepEqual(plain(panel.render(6, theme, { ...content, title: 'L', rows: ['界'] })), ['╭────╮', '│ L  │', '│ 界 │', '╰────╯']);
    assert.deepEqual(plain(panel.render(7, theme, { ...content, title: 'L', rows: ['界'] })), ['╭─────╮', '│ L   │', '│ 界  │', '╰─────╯']);
    assert.deepEqual(plain(panel.render(7, theme, { ...content, title: 'L', rows: ['abcdef'] })), fit === 'wrap'
      ? ['╭─────╮', '│ L   │', '│ abc │', '│ def │', '╰─────╯']
      : ['╭─────╮', '│ L   │', '│ ab… │', '╰─────╯']);
    for (const width of [0, 5, 6, 7, 20, 200]) {
      for (const row of ['界 🧪 👍🏽', '漢ำ', 'क्ष्म', 'Long row '.repeat(70), theme.fg('border', '界 🧪 '.repeat(70))]) {
        for (const maxHeight of [undefined, 0, 1, 2, 3, 5, 12]) {
          for (const expanded of [true, false]) {
            if (panel.expanded !== expanded) panel.toggle();
            const lines = panel.render(width, theme, { ...content, rows: [row, row, row], maxHeight });
            assert.ok(lines.every(line => visibleWidth(line) <= width), `${fit}, width ${width}, height ${maxHeight}, expanded ${expanded}, row ${row}`);
            if (width < 6 || maxHeight === 0 || expanded && maxHeight !== undefined && maxHeight < 3) assert.deepEqual(lines, []);
            else if (!expanded) assert.equal(lines.length, 1);
            else assert.ok(lines.length >= 3);
            if (maxHeight !== undefined) assert.ok(lines.length <= maxHeight);
          }
        }
      }
    }
    if (!panel.expanded) panel.toggle();
    assert.deepEqual(plain(panel.render(20, theme, { ...content, rows: capacity => {
      assert.equal(capacity, 2);
      return ['one', '… 2 more'];
    }, maxHeight: 5 })), ['╭──────────────────╮', '│ List             │', '│ one              │', '│ … 2 more         │', '╰──────────────────╯']);
    panel.toggle();
    assert.deepEqual(plain(panel.render(20, theme, content)), ['Todos · alt+t']);
  }
});
