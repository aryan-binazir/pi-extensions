import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  CURSOR_MARKER,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  placeCursor,
  retainRawText,
  projectDisplay,
  renderProjected,
} from "./adapter.ts";
type Snapshot = {
  text: string;
  pos: number;
};
export class ViEditor extends CustomEditor {
  private mode: "insert" | "normal" | "visual" | "line" = "insert";
  private count = "";
  private anchor = 0;
  private register = '"';
  private registerPending = false;
  private registers = new Map<
    string,
    {
      text: string;
      line: boolean;
    }
  >();
  private prefix = "";
  private prefixCount = 1;
  private paste: string | undefined;
  private pasteOpening = "";
  private op = "";
  private opCount = 1;
  private undoHistory: Snapshot[] = [];
  private redoHistory: Snapshot[] = [];
  private insertion?: Snapshot;
  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    this.cursorShape();
  }
  override setText(text: string): void {
    this.undoHistory = [];
    this.redoHistory = [];
    this.insertion = undefined;
    this.paste = undefined;
    this.pasteOpening = "";
    this.op = "";
    this.prefix = "";
    this.count = "";
    this.registerPending = false;
    this.writeText(text);
    this.move(text.length);
  }
  private writeText(text: string): void {
    super.setText(text);
    if (this.getText() !== text) {
      retainRawText(this, text);
      this.onChange?.(text);
    }
  }
  private next(p: number): number {
    const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(this.getText().slice(p))
      [Symbol.iterator]()
      .next().value;
    return p + (segment?.segment.length ?? 0);
  }
  private previous(p: number): number {
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        this.getText().slice(0, p),
      ),
    ];
    return segments.at(-1)?.index ?? 0;
  }
  private pos(): number {
    const c = this.getCursor();
    return (
      this.getLines()
        .slice(0, c.line)
        .reduce((n, l) => n + l.length + 1, 0) + c.col
    );
  }
  private snapshot(): Snapshot {
    return { text: this.getExpandedText(), pos: this.pos() };
  }
  private checkpoint(s = this.snapshot()): void {
    this.undoHistory.push(s);
    if (this.undoHistory.length > 200) this.undoHistory.shift();
    this.redoHistory = [];
  }
  private restore(s: Snapshot): void {
    this.writeText(s.text);
    placeCursor(this, s.pos);
  }
  private move(p: number): void {
    const clamped = Math.max(0, Math.min(p, this.getText().length));
    const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(this.getText())
      .containing(clamped);
    placeCursor(this, segment?.index ?? clamped);
  }
  private lineStart(p = this.pos()): number {
    return p <= 0 ? 0 : this.getText().lastIndexOf("\n", p - 1) + 1;
  }
  private lineEnd(p = this.pos()): number {
    const n = this.getText().indexOf("\n", p);
    return n < 0 ? this.getText().length : n;
  }
  private lineTarget(number: number): number {
    const lines = this.getLines();
    const line = Math.max(0, Math.min(number - 1, lines.length - 1));
    return (
      lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) +
      (lines[line].match(/^[ \t]*/)?.[0].length ?? 0)
    );
  }
  private motion(key: string, n: number): number | undefined {
    const text = this.getText();
    let p = this.pos();
    for (let i = 0; i < n; i++) {
      if (key === "h") p = Math.max(this.lineStart(p), this.previous(p));
      else if (key === "l") p = Math.min(this.lineEnd(p), this.next(p));
      else if (key === "0") p = this.lineStart(p);
      else if (key === "$")
        p = Math.max(this.lineStart(p), this.previous(this.lineEnd(p)));
      else if (key === "^")
        p =
          this.lineStart(p) +
          (text.slice(this.lineStart(p)).match(/^[ \t]*/)?.[0].length ?? 0);
      else if (key === "j" || key === "k") {
        const col = p - this.lineStart(p);
        if (key === "j" && this.lineEnd(p) < text.length) {
          const start = this.lineEnd(p) + 1;
          p = Math.min(start + col, this.lineEnd(start));
        } else if (key === "k" && this.lineStart(p) > 0) {
          const end = this.lineStart(p) - 1;
          p = Math.min(this.lineStart(end) + col, end);
        }
      } else if (key === "e") {
        p = Math.min(text.length, p + 1);
        while (p < text.length && /\s/.test(text[p])) p++;
        const word = /\w/.test(text[p] ?? "");
        while (
          p + 1 < text.length &&
          !/\s/.test(text[p + 1]) &&
          /\w/.test(text[p + 1]) === word
        )
          p++;
      } else if (key === "w") {
        const m = text.slice(p).match(/^(?:\w+|[^\w\s]+|\s+)\s*/u);
        p += m?.[0].length ?? 0;
      } else if (key === "b") {
        p = Math.max(0, p - 1);
        while (p > 0 && /\s/.test(text[p])) p--;
        const word = /\w/.test(text[p] ?? "");
        while (
          p > 0 &&
          !/\s/.test(text[p - 1]) &&
          /\w/.test(text[p - 1]) === word
        )
          p--;
      } else return undefined;
    }
    return p;
  }
  private range(): [number, number] {
    const a = Math.min(this.anchor, this.pos()),
      b = Math.max(this.anchor, this.pos());
    return this.mode === "line"
      ? [
          this.lineStart(a),
          Math.min(this.getText().length, this.lineEnd(b) + 1),
        ]
      : [a, this.next(b)];
  }
  private apply(op: string, a: number, b: number, line = false): void {
    const text = this.getText();
    const value = { text: text.slice(a, b), line };
    this.registers.set(this.register, value);
    this.registers.set('"', value);
    this.register = '"';
    if (op !== "y") {
      if (op === "c") this.insertion = this.snapshot();
      else this.checkpoint();
      this.writeText(text.slice(0, a) + text.slice(b));
    }
    this.move(a);
    this.mode = op === "c" ? "insert" : "normal";
    this.op = "";
    this.prefix = "";
    this.cursorShape();
  }
  private object(key: string, around: boolean): [number, number] | undefined {
    const t = this.getText(),
      p = this.pos();
    if (key === "w" || key === "W") {
      const match = (c: string) => (key === "W" ? /\S/.test(c) : /\w/.test(c));
      let a = p,
        b = p;
      while (a > 0 && match(t[a - 1])) a--;
      while (b < t.length && match(t[b])) b++;
      if (around) {
        while (b < t.length && /\s/.test(t[b])) b++;
      }
      return [a, b];
    }
    const pairs: Record<string, string> = {
      "(": ")",
      "[": "]",
      "{": "}",
      "<": ">",
      ")": ")",
      "]": "]",
      "}": "}",
      ">": ">",
      '"': '"',
      "'": "'",
      "`": "`",
    };
    const close = pairs[key];
    if (!close) return;
    const open =
      ({ ")": "(", "]": "[", "}": "{", ">": "<" } as Record<string, string>)[
        key
      ] ?? key;
    let a = -1,
      b = -1;
    if (open === close) {
      a = t.lastIndexOf(open, p);
      b = t.indexOf(close, a + 1);
    } else {
      let depth = 0;
      for (let i = p; i >= 0; i--) {
        if (t[i] === close && i !== p) depth++;
        if (t[i] === open) {
          if (depth === 0) {
            a = i;
            break;
          }
          depth--;
        }
      }
      if (a >= 0) {
        depth = 0;
        for (let i = a; i < t.length; i++) {
          if (t[i] === open) depth++;
          if (t[i] === close && --depth === 0) {
            b = i;
            break;
          }
        }
      }
    }
    return a >= 0 && b >= p
      ? [a + (around ? 0 : 1), b + (around ? 1 : 0)]
      : undefined;
  }
  dispose(): void {
    this.paste = undefined;
    this.pasteOpening = "";
    this.tui.terminal.write("\x1b[0 q");
  }
  handleInput(data: string): void {
    if (this.pasteOpening) {
      data = this.pasteOpening + data;
      this.pasteOpening = "";
    }
    if (data.length > 1 && data.length < 6 && "\x1b[200~".startsWith(data)) {
      this.pasteOpening = data;
      return;
    }
    // Buffer a bracketed paste across input chunks before interpreting any vi keys.
    if (this.paste !== undefined || data.startsWith("\x1b[200~")) {
      if (this.paste === undefined) {
        this.paste = "";
        data = data.slice(6);
      }
      this.paste += data;
      const end = this.paste.indexOf("\x1b[201~");
      if (end >= 0) {
        const payload = this.paste.slice(0, end),
          remaining = this.paste.slice(end + 6);
        this.paste = undefined;
        if (this.insertion && this.insertion.text !== this.getText())
          this.checkpoint(this.insertion);
        this.checkpoint();
        const p = this.pos();
        const text = this.getText();
        this.writeText(text.slice(0, p) + payload + text.slice(p));
        this.insertion = undefined;
        this.move(p + payload.length);
        if (remaining) this.handleInput(remaining);
      }
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.mode === "normal" && !this.op && !this.prefix && !this.count) {
        super.handleInput(data);
        return;
      }
      if (
        this.mode === "insert" &&
        this.insertion &&
        this.insertion.text !== this.getText()
      )
        this.checkpoint(this.insertion);
      this.insertion = undefined;
      this.mode = "normal";
      this.op = "";
      this.count = "";
      this.prefix = "";
      this.registerPending = false;
      this.cursorShape();
      return;
    }
    if (this.mode === "insert") {
      this.insertion ??= this.snapshot();
      super.handleInput(data);
      return;
    }
    if (data === "u" || matchesKey(data, "ctrl+r")) {
      const redo = data !== "u";
      const from = redo ? this.redoHistory : this.undoHistory;
      const to = redo ? this.undoHistory : this.redoHistory;
      const s = from.pop();
      if (s) {
        to.push(this.snapshot());
        this.restore(s);
      }
      return;
    }
    if (this.registerPending) {
      if (/^[a-z"]$/.test(data)) this.register = data;
      this.registerPending = false;
      return;
    }
    if (data === '"') {
      this.registerPending = true;
      return;
    }
    if (/^[1-9]$/.test(data) || (data === "0" && this.count)) {
      this.count = (this.count + data).slice(0, 4);
      return;
    }
    const hasCount = this.count !== "";
    const n = Number(this.count || 1);
    this.count = "";
    if (this.prefix === "i" || this.prefix === "a") {
      const r = this.object(data, this.prefix === "a");
      if (r) {
        if (this.op) this.apply(this.op, ...r);
        else {
          this.anchor = r[0];
          this.move(Math.max(r[0], r[1] - 1));
        }
      }
      this.prefix = "";
      return;
    }
    if (
      (this.op || this.mode === "visual" || this.mode === "line") &&
      (data === "i" || data === "a")
    ) {
      this.prefix = data;
      return;
    }
    if (
      "dcyx".includes(data) &&
      data.length === 1 &&
      (this.mode === "visual" || this.mode === "line")
    ) {
      this.apply(
        data === "x" ? "d" : data,
        ...this.range(),
        this.mode === "line",
      );
      this.cursorShape();
      return;
    }
    if ("dcy".includes(data) && data.length === 1) {
      if (this.op === data) {
        let b = this.pos();
        for (let i = 0; i < n * this.opCount; i++)
          b = Math.min(this.getText().length, this.lineEnd(b) + 1);
        this.apply(data, this.lineStart(), b, true);
      } else {
        this.op = data;
        this.opCount = n;
      }
      return;
    }
    let p: number | undefined;
    if (this.prefix === "g") {
      this.prefix = "";
      if (data === "g") p = this.lineTarget(this.prefixCount);
    } else if (data === "g") {
      this.prefix = "g";
      this.prefixCount = n;
      return;
    } else if (data === "G")
      p = this.lineTarget(hasCount ? n : this.getLines().length);
    else
      p = this.motion(
        this.op === "c" && data === "w" ? "e" : data,
        n * (this.op ? this.opCount : 1),
      );
    if (p !== undefined) {
      if (this.op) {
        if (data === "G" || data === "g") {
          this.apply(
            this.op,
            this.lineStart(Math.min(this.pos(), p)),
            Math.min(
              this.getText().length,
              this.lineEnd(Math.max(this.pos(), p)) + 1,
            ),
            true,
          );
          return;
        }
        const inclusive =
          data === "$" || data === "e" || (this.op === "c" && data === "w");
        this.apply(
          this.op,
          Math.min(this.pos(), p),
          Math.min(
            this.getText().length,
            inclusive
              ? this.next(Math.max(this.pos(), p))
              : Math.max(this.pos(), p),
          ),
        );
      } else this.move(p);
      return;
    }
    if (data === "v" || data === "V") {
      this.mode = data === "v" ? "visual" : "line";
      this.anchor = this.pos();
      this.cursorShape();
      return;
    }
    if (data === "x") {
      this.apply(
        "d",
        this.pos(),
        Math.min(this.lineEnd(), this.motion("l", n) ?? this.pos()),
      );
      return;
    }
    if (data === "D" || data === "C") {
      this.apply(data === "D" ? "d" : "c", this.pos(), this.lineEnd());
      return;
    }
    if (data === "p" || data === "P") {
      const r = this.registers.get(this.register);
      this.register = '"';
      if (r) {
        this.checkpoint();
        const t = this.getText();
        let p =
          data === "P"
            ? this.pos()
            : Math.min(this.lineEnd(), this.next(this.pos()));
        let value = r.text.repeat(n);
        if (r.line) {
          p =
            data === "P"
              ? this.lineStart()
              : Math.min(t.length, this.lineEnd() + 1);
          if (p === t.length && t && !t.endsWith("\n"))
            value = "\n" + value.replace(/\n$/, "");
          else if (!value.endsWith("\n")) value += "\n";
        }
        this.writeText(t.slice(0, p) + value + t.slice(p));
        this.move(p);
      }
      return;
    }
    if ("iaIAoO".includes(data) && data.length === 1) {
      if (data === "a")
        this.move(Math.min(this.lineEnd(), this.next(this.pos())));
      if (data === "I") this.move(this.lineStart());
      if (data === "A") this.move(this.lineEnd());
      this.insertion = this.snapshot();
      if (data === "o" || data === "O") {
        const t = this.getText();
        const p = data === "O" ? this.lineStart() : this.lineEnd();
        this.writeText(t.slice(0, p) + "\n" + t.slice(p));
        this.move(p + (data === "o" ? 1 : 0));
      }
      this.mode = "insert";
      this.cursorShape();
      return;
    }
    this.op = "";
    if (data.length !== 1 || data.charCodeAt(0) < 32) super.handleInput(data);
  }
  private cursorShape(): void {
    this.tui.terminal.write(
      this.mode === "insert"
        ? "\x1b[6 q"
        : this.mode === "normal"
          ? "\x1b[2 q"
          : "\x1b[4 q",
    );
    this.tui.requestRender();
  }
  protected renderBottomBorder(width: number, hidden: number): string {
    const label = ` ${this.mode.toUpperCase()} ${this.count}${this.op}${this.prefix} `;
    return truncateToWidth(
      label + super.renderBottomBorder(width, hidden),
      width,
    );
  }
  render(width: number): string[] {
    if (this.mode !== "visual" && this.mode !== "line")
      return renderProjected(this, () => super.render(width));
    const [rawStart, rawEnd] = this.range();
    const projection = projectDisplay(this.getText());
    const a = projection.offsets[rawStart],
      b = projection.offsets[rawEnd];
    const text = projection.text;
    const cursor = projection.offsets[this.pos()];
    const rows: string[] = [];
    let row = "",
      cols = 0,
      cursorRow = 0;
    for (const { segment: char, index: i } of new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    }).segment(text)) {
      if (char === "\n") {
        if (i === cursor) {
          cursorRow = rows.length;
          row += this.focused ? CURSOR_MARKER : "";
        }
        rows.push(row);
        row = "";
        cols = 0;
        continue;
      }
      const w = visibleWidth(char);
      if (cols + w > Math.max(1, width - 1)) {
        rows.push(row);
        row = "";
        cols = 0;
      }
      if (i === cursor) cursorRow = rows.length;
      row +=
        (i === cursor && this.focused ? CURSOR_MARKER : "") +
        (i >= a && i < b ? "\x1b[7m" + char + "\x1b[0m" : char);
      cols += w;
    }
    if (cursor === text.length) {
      if (cols >= Math.max(1, width - 1)) {
        rows.push(row);
        row = "";
      }
      cursorRow = rows.length;
      row += this.focused ? CURSOR_MARKER : "";
    }
    rows.push(row);
    const max = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
    const start = Math.max(0, Math.min(cursorRow, rows.length - max));
    return [
      this.renderTopBorder(width, start),
      ...rows.slice(start, start + max),
      this.renderBottomBorder(width, Math.max(0, rows.length - start - max)),
    ];
  }
}
