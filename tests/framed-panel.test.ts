import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { FramedPanel } from '../extensions/framed-panel.ts';

const theme = { fg: (_color: 'border', text: string) => `\x1b[34m${text}\x1b[39m` };
const plain = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));

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
