import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  decodeKittyPrintable,
  CURSOR_MARKER,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  placeCursor,
  retainRawText,
  projectDisplay,
  renderProjected,
  clearBaseUndo,
  readPastes, writePastes, pasteMarkers, expandPastes, collapsePaste,
  type PasteState, installEditorHandoff,
} from "./adapter.ts";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MAX_DRAFT = 1024 * 1024;
function safeDraft(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}
type Snapshot = {
  text: string;
  pos: number;
  payloads: PasteState;
};
export class ViEditor extends CustomEditor {
  private mode: "insert" | "normal" | "visual" | "line" = "insert";
  private previousHardwareCursor: boolean;
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
  private discardArgument = false;
  private preferredColumn: number | undefined;
  private visualScroll = 0;
  private boundaryText = "";
  private boundaries = [0];
  private wordClass(p: number): number {
    const c = String.fromCodePoint(this.getText().codePointAt(p) ?? 32);
    return /\s/u.test(c) ? 0 : /[\p{L}\p{N}\p{M}_]/u.test(c) ? 1 : 2;
  }
  private wordNext(p: number): number {
    const kind = this.wordClass(p),
      end = this.getText().length;
    while (p < end && this.wordClass(p) === kind) p = this.next(p);
    while (p < end && this.wordClass(p) === 0) p = this.next(p);
    return p;
  }
  private wordEnd(p: number): number {
    const end = this.getText().length;
    while (p < end && this.wordClass(p) === 0) p = this.next(p);
    const kind = this.wordClass(p);
    while (this.next(p) < end && this.wordClass(this.next(p)) === kind)
      p = this.next(p);
    return p;
  }
  private baseInput(data: string): void {
    const submit = this.onSubmit;
    const before = this.mode === "insert" ? undefined : this.snapshot();
    const history = this.undoHistory;
    this.onSubmit = (expanded) => {
      this.setText("");
      submit?.(expanded.trim().replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""));
    };
    try {
      super.handleInput(data);
      // Public replacement/submission replaces the history array and must stay a reset.
      if (before && history === this.undoHistory && before.text !== this.getText())
        this.checkpoint(before);
    } finally {
      this.onSubmit = submit;
    }
  }
  override getExpandedText(): string {
    return expandPastes(this, this.getText());
  }
  override insertTextAtCursor(text: string): void {
    text = safeDraft(text);
    if (!text) return;
    this.checkpoint();
    const p = this.pos(),
      draft = this.getText();
    this.writeText(draft.slice(0, p) + text + draft.slice(p));
    this.move(p + text.length);
  }

  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    installEditorHandoff(this);
    this.previousHardwareCursor = this.tui.getShowHardwareCursor();
    this.tui.setShowHardwareCursor(true);
    this.cursorShape();
  }
  override setText(text: string): void {
    if (this.mode === "visual" || this.mode === "line") this.mode = "normal";
    this.anchor = 0;
    this.visualScroll = 0;
    this.preferredColumn = undefined;
    this.discardArgument = false;
    this.undoHistory = [];
    this.redoHistory = [];
    this.insertion = undefined;
    this.paste = undefined;
    this.pasteOpening = "";
    this.op = "";
    this.prefix = "";
    this.count = "";
    this.registerPending = false;
    writePastes(this, { pastes: new Map(), counter: 0 });
    this.writeText(collapsePaste(this, safeDraft(text)));
    this.move(this.getText().length);
    clearBaseUndo(this);
    this.cursorShape();
  }
  private writeText(text: string): void {
    text = safeDraft(text);
    this.boundaryText = "";
    const payloads = readPastes(this);
    super.setText(text);
    writePastes(this, payloads);
    clearBaseUndo(this);
    if (this.getText() !== text) {
      retainRawText(this, text);
      this.onChange?.(text);
    }
  }
  private boundaryIndex(p: number): number {
    const text = this.getText();
    if (this.boundaryText !== text) {
      this.boundaryText = text;
      const markers = pasteMarkers(this);
      this.boundaries = [...segmenter.segment(text)].map((s) => s.index)
        .filter((p) => !markers.some((m) => p > m.index && p < m.index + m[0].length));
      this.boundaries.push(text.length);
    }
    let low = 0,
      high = this.boundaries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.boundaries[mid] < p) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  private next(p: number): number {
    const i = this.boundaryIndex(p);
    return this.boundaries[Math.min(this.boundaries.length - 1, i + 1)] ?? p;
  }
  private previous(p: number): number {
    const index = this.boundaryIndex(p);
    return this.boundaries[Math.max(0, index - 1)] ?? 0;
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
    return { text: this.getText(), pos: this.pos(), payloads: readPastes(this) };
  }
  private checkpoint(s = this.snapshot()): void {
    this.undoHistory.push(s);
    if (this.undoHistory.length > 200) this.undoHistory.shift();
    this.redoHistory = [];
  }
  private restore(s: Snapshot): void {
    writePastes(this, s.payloads);
    this.boundaryText = "";
    this.writeText(s.text);
    placeCursor(this, s.pos);
  }
  private move(p: number): void {
    const clamped = Math.max(0, Math.min(p, this.getText().length));
    const i = this.boundaryIndex(clamped);
    placeCursor(this, this.boundaries[i] === clamped ? clamped : this.boundaries[Math.max(0, i - 1)]);
  }
  private lineStart(p = this.pos()): number {
    return p <= 0 ? 0 : this.getText().lastIndexOf("\n", p - 1) + 1;
  }
  private lineEnd(p = this.pos()): number {
    const n = this.getText().indexOf("\n", p);
    return n < 0 ? this.getText().length : n;
  }
  private deleteEnd(n: number): number {
    let p = this.pos();
    for (let i = 0; i < n && p < this.lineEnd(); i++) p = this.next(p);
    return p;
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
    let p = this.pos();
    n = Math.min(10000, n);
    if (key === "j" || key === "k") {
      const cursor = this.getCursor();
      this.preferredColumn ??= cursor.col;
      const line = Math.max(
        0,
        Math.min(
          this.getLines().length - 1,
          cursor.line + (key === "j" ? n : -n),
        ),
      );
      const start = this.getLines()
        .slice(0, line)
        .reduce((sum, l) => sum + l.length + 1, 0);
      return Math.min(
        start + this.preferredColumn,
        Math.max(start, this.previous(this.lineEnd(start))),
      );
    }
    this.preferredColumn = undefined;
    for (let i = 0; i < n; i++) {
      const before: number = p;
      if (key === "h") p = Math.max(this.lineStart(p), this.previous(p));
      else if (key === "l")
        p = Math.min(
          Math.max(this.lineStart(p), this.previous(this.lineEnd(p))),
          this.next(p),
        );
      else if (key === "0") return this.lineStart(p);
      else if (key === "$")
        return Math.max(this.lineStart(p), this.previous(this.lineEnd(p)));
      else if (key === "^") return this.lineTarget(this.getCursor().line + 1);
      else if (key === "w") p = this.wordNext(p);
      else if (key === "e") p = this.wordEnd(this.next(p));
      else if (key === "b") {
        p = this.previous(p);
        while (p > 0 && this.wordClass(p) === 0) p = this.previous(p);
        const kind = this.wordClass(p);
        while (p > 0 && this.wordClass(this.previous(p)) === kind)
          p = this.previous(p);
      } else return undefined;
      if (p === before) break;
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
  private apply(op: string, a: number, b: number, line = false, insertOnEmpty = false): void {
    this.preferredColumn = undefined;
    const text = this.getText();
    for (const marker of pasteMarkers(this)) {
      const end = marker.index + marker[0].length;
      if (a < end && b > marker.index) {
        a = Math.min(a, marker.index);
        b = Math.max(b, end);
      }
    }
    if (line && op === "d" && a === b && a > 0 && text[a - 1] === "\n") a--;
    if (a >= b) {
      if (op === "c" && insertOnEmpty) {
        this.insertion = this.snapshot();
        this.mode = "insert";
        this.cursorShape();
      }
      this.op = "";
      this.prefix = "";
      this.register = '"';
      return;
    }
    const value = { text: expandPastes(this, text.slice(a, b)), line };
    this.registers.set(this.register, value);
    this.registers.set('"', value);
    this.register = '"';
    if (op !== "y") {
      if (op === "c") this.insertion = this.snapshot();
      else this.checkpoint();
      let replacement = "";
      if (line && op === "c" && text.slice(a, b).endsWith("\n"))
        replacement = "\n";
      if (
        line &&
        op === "d" &&
        b === text.length &&
        a > 0 &&
        text[a - 1] === "\n"
      )
        a--;
      this.writeText(text.slice(0, a) + replacement + text.slice(b));
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
      const kind =
        key === "W" ? (this.wordClass(p) === 0 ? 0 : 1) : this.wordClass(p);
      const kindAt = (pos: number) =>
        key === "W" ? (this.wordClass(pos) === 0 ? 0 : 1) : this.wordClass(pos);
      let a = p,
        b = p;
      while (a > 0 && kindAt(this.previous(a)) === kind) a = this.previous(a);
      while (b < t.length && kindAt(b) === kind) b = this.next(b);
      if (around)
        while (b < t.length && this.wordClass(b) === 0) b = this.next(b);
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
    this.tui.setShowHardwareCursor(this.previousHardwareCursor);
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
        const payload = safeDraft(this.paste.slice(0, end).replace(/\x1b\[(\d+);5u/g, (sequence, code: string) => {
          const cp = Number(code);
          return cp >= 97 && cp <= 122 ? String.fromCharCode(cp - 96)
            : cp >= 65 && cp <= 90 ? String.fromCharCode(cp - 64) : sequence;
        })),
          remaining = this.paste.slice(end + 6);
        this.paste = undefined;
        if (this.insertion && this.insertion.text !== this.getText())
          this.checkpoint(this.insertion);
        this.checkpoint();
        const [p, selectionEnd] =
          this.mode === "visual" || this.mode === "line"
            ? this.range()
            : [this.pos(), this.pos()];
        const text = this.getText();
        const visible = collapsePaste(this, payload);
        this.writeText(text.slice(0, p) + visible + text.slice(selectionEnd));
        if (this.mode === "visual" || this.mode === "line") {
          this.mode = "normal";
          this.cursorShape();
        }
        this.insertion = undefined;
        this.move(p + visible.length);
        if (remaining) this.handleInput(remaining);
      }
      return;
    }
    if (matchesKey(data, "escape")) {
      const discarded = this.discardArgument;
      this.discardArgument = false;
      this.visualScroll = 0;
      if (this.mode === "normal" && !this.op && !this.prefix && !this.count && !discarded && !this.registerPending) {
        this.baseInput(data);
        return;
      }
      if (
        this.mode === "insert" &&
        this.insertion &&
        this.insertion.text !== this.getText()
      )
        this.checkpoint(this.insertion);
      if (this.mode === "insert")
        this.move(Math.max(this.lineStart(), this.previous(this.pos())));
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
      if (matchesKey(data, "backspace")) {
        const p = this.pos();
        const marker = pasteMarkers(this).find((m) => m.index + m[0].length === p);
        if (marker) {
          const text = this.getText();
          this.writeText(text.slice(0, marker.index) + text.slice(p));
          this.move(marker.index);
          return;
        }
      }
      this.baseInput(data);
      return;
    }
    data = decodeKittyPrintable(data) ?? data;
    if ((data.length !== 1 || data.charCodeAt(0) < 32) && !matchesKey(data, "ctrl+r")) {
      this.baseInput(data);
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
      this.mode = "normal";
      this.anchor = 0;
      this.visualScroll = 0;
      this.preferredColumn = undefined;
      this.op = "";
      this.count = "";
      this.prefix = "";
      this.register = '"';
      this.registerPending = false;
      this.discardArgument = false;
      this.cursorShape();
      return;
    }
    if (this.prefix === "i" || this.prefix === "a") {
      const r = this.object(data, this.prefix === "a");
      if (r) {
        if (this.op) this.apply(this.op, ...r);
        else {
          this.move(r[0]);
          this.anchor = this.pos();
          this.move(Math.max(r[0], r[1] - 1));
        }
      }
      this.prefix = "";
      this.op = "";
      this.registerPending = false;
      this.register = '"';
      return;
    }
    if (this.discardArgument) {
      this.discardArgument = false;
      return;
    }
    if (this.registerPending) {
      if (/^[a-z"]$/.test(data)) this.register = data;
      this.registerPending = false;
      return;
    }
    if (this.prefix === "g" && data !== "g") {
      this.prefix = ""; this.op = ""; this.count = "";
      return;
    }
    if (["r", "m", "q"].includes(data)) {
      this.discardArgument = true;
      this.op = "";
      this.prefix = "";
      return;
    }
    if (data === '"') {
      this.registerPending = true;
      return;
    }
    if (/^[1-9]$/.test(data) || (data === "0" && this.count)) {
      this.count = String(Math.min(10000, Number(this.count + data)));
      return;
    }
    const hasCount = this.count !== "";
    const n = Number(this.count || 1);
    this.count = "";
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
        for (
          let i = 0;
          i < Math.min(10000, n * this.opCount) && b < this.getText().length;
          i++
        )
          b = Math.min(this.getText().length, this.lineEnd(b) + 1);
        this.apply(data, this.lineStart(), b, true, data === "c");
      } else {
        this.op = data;
        this.opCount = n;
      }
      return;
    }
    let p: number | undefined;
    if (data === "g" || data === "G") this.preferredColumn = undefined;
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
      p = this.motion(data, Math.min(10000, n * (this.op ? this.opCount : 1)));
    const changeWord =
      this.op === "c" && data === "w" && this.wordClass(this.pos()) !== 0;
    if (changeWord) {
      p = this.pos();
      for (let i = 0; i < Math.min(10000, n * this.opCount); i++) {
        const before: number = p;
        p = this.wordEnd(i === 0 ? p : this.wordNext(p));
        if (p >= this.getText().length || (i > 0 && p === before)) break;
      }
    }
    if (p !== undefined) {
      if (this.op) {
        if ((data === "j" || data === "k") && this.lineStart(p) === this.lineStart()) {
          this.op = "";
          this.prefix = "";
          this.register = '"';
          return;
        }
        if (data === "G" || data === "g" || data === "j" || data === "k") {
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
        const inclusive = data === "$" || data === "e" || changeWord;
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
      this.visualScroll = 0;
      this.mode = data === "v" ? "visual" : "line";
      this.anchor = this.pos();
      this.cursorShape();
      return;
    }
    if (data === "x") {
      this.apply("d", this.pos(), this.deleteEnd(n));
      return;
    }
    if (data === "D" || data === "C") {
      this.apply(data === "D" ? "d" : "c", this.pos(), this.lineEnd(), false, data === "C");
      return;
    }
    if (data === "p" || data === "P") {
      const r = this.registers.get(this.register);
      this.register = '"';
      if (r) {
        const t = this.getText();
        if (this.mode === "visual" || this.mode === "line") {
          const [a, b] = this.range();
          if (r.text.length * n + this.getExpandedText().length - expandPastes(this, t.slice(a, b)).length > MAX_DRAFT) return;
          let value = r.text.repeat(n), before = "", after = "";
          if (this.mode === "line") {
            if (t.slice(a, b).endsWith("\n") || value.endsWith("\n")) after = "\n";
          } else if (r.line) {
            if (a > this.lineStart(a)) before = "\n";
            if (b < t.length || value.endsWith("\n")) after = "\n";
          }
          if (after) value = value.replace(/\n$/, "");
          this.checkpoint();
          this.registers.set('"', { text: expandPastes(this, t.slice(a, b)), line: this.mode === "line" });
          this.writeText(t.slice(0, a) + before + collapsePaste(this, value) + after + t.slice(b));
          this.move(a);
          this.mode = "normal";
          this.anchor = 0;
          this.visualScroll = 0;
          this.cursorShape();
          return;
        }
        let p =
          data === "P"
            ? this.pos()
            : Math.min(this.lineEnd(), this.next(this.pos()));
        if (r.text.length * n + this.getExpandedText().length > MAX_DRAFT) return;
        this.checkpoint();
        let value = r.text.repeat(n), before = "", after = "";
        if (r.line) {
          p =
            data === "P"
              ? this.lineStart()
              : Math.min(t.length, this.lineEnd() + 1);
          if (p === t.length && t && !t.endsWith("\n"))
            before = "\n";
          else after = "\n";
          value = value.replace(/\n$/, "");
        }
        this.writeText(t.slice(0, p) + before + collapsePaste(this, value) + after + t.slice(p));
        this.move(p);
      }
      return;
    }
    if ("iaIAoO".includes(data) && data.length === 1) {
      if (data === "a")
        this.move(Math.min(this.lineEnd(), this.next(this.pos())));
      if (data === "I") this.move(this.lineTarget(this.getCursor().line + 1));
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
    if (data.length !== 1 || data.charCodeAt(0) < 32) this.baseInput(data);
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
    const pending = `${this.count}${this.op}${this.prefix}`;
    const label = truncateToWidth(
      ` ${this.mode.toUpperCase()}${pending ? ` ${pending}` : ""} `,
      width,
      "",
    );
    return super.renderBottomBorder(Math.max(0, width - visibleWidth(label)), hidden) + label;
  }
  render(width: number): string[] {
    if (this.mode !== "visual" && this.mode !== "line") {
      const lines = renderProjected(this, () => super.render(width));
      if (this.mode !== "insert" || !this.focused) return lines;
      // Keep the hardware cursor marker, but remove the base editor's fake
      // reverse-video cursor so the terminal's insert-mode beam is visible.
      return lines.map((line) => {
        const start = line.indexOf(CURSOR_MARKER + "\x1b[7m");
        if (start < 0) return line;
        const contentStart = start + CURSOR_MARKER.length + "\x1b[7m".length;
        const end = line.indexOf("\x1b[0m", contentStart);
        if (end < 0) return line;
        return line.slice(0, start) + CURSOR_MARKER +
          line.slice(contentStart, end) + line.slice(end + "\x1b[0m".length);
      });
    }
    const [rawStart, rawEnd] = this.range();
    const projection = projectDisplay(this.getText());
    const a = projection.offsets[rawStart],
      b = projection.offsets[rawEnd];
    const text = projection.text;
    const cursor = projection.offsets[this.pos()];
    const padding = Math.min(
      this.getPaddingX(),
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const layoutWidth = Math.max(1, width - 2 * padding - (padding ? 0 : 1));
    const rows: string[] = [];
    let row = "",
      cols = 0,
      cursorRow = 0;
    for (const { segment: char, index: i } of segmenter.segment(text)) {
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
      if (cols + w > layoutWidth) {
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
      if (cols >= layoutWidth) {
        rows.push(row);
        row = "";
      }
      cursorRow = rows.length;
      row += this.focused ? CURSOR_MARKER : "";
    }
    rows.push(row);
    const max = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
    if (cursorRow < this.visualScroll) this.visualScroll = cursorRow;
    if (cursorRow >= this.visualScroll + max)
      this.visualScroll = cursorRow - max + 1;
    const start = Math.max(0, Math.min(this.visualScroll, rows.length - max));
    return [
      this.renderTopBorder(width, start),
      ...rows
        .slice(start, start + max)
        .map((row) => " ".repeat(padding) + row + " ".repeat(padding)),
      this.renderBottomBorder(width, Math.max(0, rows.length - start - max)),
    ];
  }
}
