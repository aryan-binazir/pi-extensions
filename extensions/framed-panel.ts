import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId } from '@earendil-works/pi-tui';

interface Content {
  summary: string;
  title: string;
  rows: readonly string[] | ((capacity: number) => readonly string[]);
  maxHeight?: number;
}

export class FramedPanel {
  #expanded = false;
  constructor(readonly shortcut: KeyId, private readonly fit: 'wrap' | 'truncate') {}
  get expanded() { return this.#expanded; }
  toggle() { this.#expanded = !this.#expanded; }
  render(width: number, theme: { fg(color: 'border', text: string): string }, { summary, title, rows, maxHeight }: Content): string[] {
    if (width < 6 || maxHeight !== undefined && maxHeight < 1) return [];
    if (!this.#expanded) return [truncateToWidth(summary, width)];
    if (maxHeight !== undefined && maxHeight < 3) return [];
    const blue = (text: string) => theme.fg('border', text);
    const inner = width - 4;
    const capacity = maxHeight === undefined ? Infinity : Math.floor(maxHeight) - 3;
    const lines = [title, ...(typeof rows === 'function' ? rows(capacity) : rows)];
    const body = this.fit === 'wrap' ? lines.flatMap(line => wrapTextWithAnsi(line, inner)) : lines.map(line => truncateToWidth(line, inner, '…', true));
    return [
      blue(`╭${'─'.repeat(inner + 2)}╮`),
      ...body.slice(0, maxHeight === undefined ? undefined : Math.floor(maxHeight) - 2).map(line => `${blue('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${blue('│')}`),
      blue(`╰${'─'.repeat(inner + 2)}╯`),
    ].map(line => truncateToWidth(line, width, ''));
  }
}
