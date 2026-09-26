import { stripVTControlCharacters } from 'node:util';
import { visibleWidth } from '@earendil-works/pi-tui';

export function sanitizeTrackerReport(report: string): string {
  const oscPayload = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
  const withoutOsc = report.replace(oscPayload, '');
  return stripVTControlCharacters(withoutOsc)
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\n' ? '\n' : ' ');
}

export function trackerFooter(report: string, columns = 100): string | undefined {
  const width = Number.isFinite(columns) ? Math.max(0, Math.min(100, Math.floor(columns))) : 100;
  const text = sanitizeTrackerReport(report)
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2')
    .replace(/[*`~]/g, '')
    .replace(/\b_([^_\n]+)_\b/g, '$1')
    .split('\n')
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-+•]\s+|\d+[.)]\s+)/, '').trim())
    .filter(line => line && !/^[\w ]+:$/.test(line))
    .join(' · ')
    .replace(/\s+[-+]\s+(?=[\w ]+:)/g, ' · ')
    .replace(/\s+/g, ' ').trim()
    .replace(/(?:\s*·\s*)?[\w ]+:$/, '').trim();
  if (!text || width < 1) return undefined;
  if (visibleWidth(text) <= width) return text;
  const words: string[] = [];
  for (const word of text.split(' ')) {
    if (visibleWidth([...words, word].join(' ')) + 1 > width) break;
    words.push(word);
  }
  const trailingSeparatorOrLabel = /^(?:·|[-+])$|:$/;
  while (words.length && trailingSeparatorOrLabel.test(words.at(-1)!)) words.pop();
  return words.length ? `${words.join(' ')}…` : '…';
}
