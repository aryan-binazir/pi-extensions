import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId } from '@earendil-works/pi-tui';

interface Content {
  summary: string;
  title: string;
  // Replace rows when content changes; callbacks must capture immutable content.
  rows: readonly string[] | ((capacity: number) => readonly string[]);
  maxHeight?: number;
}
interface Theme { fg(color: 'border', text: string): string }

export class FramedPanel {
  private expandedView = false;
  private cache?: Content & { width: number; expanded: boolean; theme: Theme; lines: string[] };
  constructor(readonly shortcut: KeyId, private readonly fit: 'wrap' | 'truncate') {}
  get expanded() { return this.expandedView; }
  toggle() { this.expandedView = !this.expandedView; }
  invalidate() { this.cache = undefined; }
  render(width: number, theme: Theme, { summary, title, rows, maxHeight }: Content): string[] {
    const cached = this.cache;
    if (cached && cached.width === width && cached.expanded === this.expandedView && cached.summary === summary && cached.title === title && cached.rows === rows && Object.is(cached.maxHeight, maxHeight) && cached.theme === theme) return cached.lines;
    let rendered: string[];
    if (width < 6 || maxHeight !== undefined && maxHeight < 1) rendered = [];
    else if (!this.expandedView) rendered = [visibleWidth(summary) > width ? truncateToWidth(summary, width) : summary];
    else if (maxHeight !== undefined && maxHeight < 3) rendered = [];
    else {
      const blue = (text: string) => theme.fg('border', text);
      const inner = width - 4;
      const capacity = maxHeight === undefined ? Infinity : Math.floor(maxHeight) - 3;
      const lines = [title, ...(typeof rows === 'function' ? rows(capacity) : rows)];
      const body = this.fit === 'wrap' ? lines.flatMap(line => wrapTextWithAnsi(line, inner)) : lines.map(line => visibleWidth(line) > inner ? truncateToWidth(line, inner, '…', true) : line);
      rendered = [
        blue(`╭${'─'.repeat(inner + 2)}╮`),
        ...body.slice(0, maxHeight === undefined ? undefined : Math.floor(maxHeight) - 2).map(line => `${blue('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${blue('│')}`),
        blue(`╰${'─'.repeat(inner + 2)}╯`),
      ].map(line => visibleWidth(line) > width ? truncateToWidth(line, width, '') : line);
    }
    this.cache = { width, expanded: this.expandedView, summary, title, rows, maxHeight, theme, lines: rendered };
    return rendered;
  }
}
