import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  decodeKittyPrintable,
  CURSOR_MARKER,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  setCursorPosition,
  retainRawText,
  projectDisplay,
  renderProjected,
  clearBaseUndo,
  clampOffset,
  readPastes, writePastes, pasteMarkers, expandPastes, collapsePaste,
  type PasteState, installEditorHandoff, markViEditor, invalidateTextCache, NEEDS_PROJECTION,
} from "./adapter.ts";
let graphemes: Intl.Segmenter | undefined;
function segmenter(): Intl.Segmenter {
  return (graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));
}
const NEEDS_SEGMENTING = /[^\x20-\x7e\n\t]/;
const SPACE = /\s/u;
const WORD = /[\p{L}\p{N}\p{M}_]/u;
let asciiClasses: Uint8Array | undefined;
function buildAsciiClasses(): Uint8Array {
  const table = new Uint8Array(128);
  for (let code = 0; code < 128; code++) {
    const c = String.fromCharCode(code);
    table[code] = SPACE.test(c) ? 0 : WORD.test(c) ? 1 : 2;
  }
  return (asciiClasses = table);
}
const CLOSING: Record<string, string> = {
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
const OPENING: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const MAX_DRAFT = 1024 * 1024;
const CONTROLS_EXCEPT_TAB_LF_CR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const CONTROLS_EXCEPT_TAB_LF = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function safeDraft(text: string): string {
  return text.replace(CONTROLS_EXCEPT_TAB_LF_CR, "");
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
  private codeUnitBoundaries = true;
  private boundaryLength = 0;
  private markerText: string | undefined;
  private markerList: ReturnType<typeof pasteMarkers> = [];
  private lineStartsText: string | undefined;
  private lineStarts: number[] = [0];
  private scanText: string | undefined;
  private scanned = { project: false, segment: false };
  private draft: string | undefined;

  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    markViEditor(this);
    installEditorHandoff();
    this.previousHardwareCursor = this.tui.getShowHardwareCursor();
    this.tui.setShowHardwareCursor(true);
    this.cursorShape();
  }
  private resetPending(): void {
    this.op = "";
    this.prefix = "";
    this.count = "";
    this.registerPending = false;
  }
  private text(): string {
    return (this.draft ??= super.getText());
  }
  [invalidateTextCache](): void {
    this.draft = undefined;
  }
  private scan(): { project: boolean; segment: boolean } {
    const text = this.text();
    if (this.scanText !== text) {
      this.scanText = text;
      this.scanned = {
        project: NEEDS_PROJECTION.test(text),
        segment: NEEDS_SEGMENTING.test(text),
      };
    }
    return this.scanned;
  }
  private starts(): number[] {
    const text = this.text();
    if (this.lineStartsText !== text) {
      this.lineStartsText = text;
      const starts = [0];
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
        starts.push(i + 1);
      this.lineStarts = starts;
    }
    return this.lineStarts;
  }
  private markers(): ReturnType<typeof pasteMarkers> {
    const text = this.text();
    if (this.markerText !== text) {
      this.markerText = text;
      this.markerList = pasteMarkers(this, text);
    }
    return this.markerList;
  }
  private wordClass(p: number, text = this.text()): number {
    const code = text.codePointAt(p);
    if (code === undefined) return 0;
    if (code < 128) return (asciiClasses ?? buildAsciiClasses())[code];
    const c = String.fromCodePoint(code);
    return SPACE.test(c) ? 0 : WORD.test(c) ? 1 : 2;
  }
  private wordNext(p: number): number {
    const text = this.text(),
      kind = this.wordClass(p, text),
      end = text.length;
    while (p < end && this.wordClass(p, text) === kind) p = this.next(p);
    while (p < end && this.wordClass(p, text) === 0) p = this.next(p);
    return p;
  }
  private wordEnd(p: number): number {
    const text = this.text(),
      end = text.length;
    while (p < end && this.wordClass(p, text) === 0) p = this.next(p);
    const kind = this.wordClass(p, text);
    for (let after = this.next(p); after < end && this.wordClass(after, text) === kind; after = this.next(p))
      p = after;
    return p;
  }
  private baseInput(data: string): void {
    const submit = this.onSubmit;
    const before = this.mode === "insert" ? undefined : this.snapshot();
    const history = this.undoHistory;
    this.onSubmit = (expanded) => {
      this.setText("");
      submit?.(expanded.trim().replace(CONTROLS_EXCEPT_TAB_LF, ""));
    };
    try {
      super.handleInput(data);
      this.draft = undefined;
      const historyReset = history !== this.undoHistory;
      if (before && !historyReset && before.text !== this.text())
        this.checkpoint(before);
    } finally {
      this.draft = undefined;
      this.onSubmit = submit;
    }
  }
  override getExpandedText(): string {
    return expandPastes(this, super.getText());
  }
  override insertTextAtCursor(text: string): void {
    text = safeDraft(text);
    if (!text) return;
    this.checkpoint();
    const p = this.pos(),
      draft = this.text();
    this.writeText(draft.slice(0, p) + text + draft.slice(p));
    this.move(p + text.length);
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
    this.resetPending();
    writePastes(this, { pastes: new Map(), counter: 0 });
    this.writeText(collapsePaste(this, safeDraft(text)));
    this.move(this.text().length);
    clearBaseUndo(this);
    this.cursorShape();
  }
  private writeText(text: string): void {
    text = safeDraft(text);
    this.boundaryText = "";
    this.markerText = undefined;
    const payloads = readPastes(this);
    super.setText(text);
    this.draft = undefined;
    writePastes(this, payloads);
    clearBaseUndo(this);
    if (this.text() !== text) {
      retainRawText(this, text);
      this.onChange?.(text);
    }
  }
  private rebuildBoundaries(text: string): void {
    this.boundaryText = text;
    this.boundaryLength = text.length;
    const markers = this.markers();
    this.codeUnitBoundaries = markers.length === 0 && !this.scan().segment;
    if (this.codeUnitBoundaries) return;
    const boundaries: number[] = [];
    let m = 0;
    for (const { index } of segmenter().segment(text)) {
      while (m < markers.length && index >= markers[m].index + markers[m][0].length) m++;
      const marker = markers[m];
      if (marker && index > marker.index && index < marker.index + marker[0].length)
        continue;
      boundaries.push(index);
    }
    boundaries.push(text.length);
    this.boundaries = boundaries;
  }
  private boundaryIndex(p: number): number {
    const text = this.text();
    if (this.boundaryText !== text) this.rebuildBoundaries(text);
    if (this.codeUnitBoundaries)
      return p < 0 ? 0 : p > this.boundaryLength ? this.boundaryLength + 1 : p;
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
    if (this.codeUnitBoundaries) return Math.min(this.boundaryLength, i + 1);
    return this.boundaries[Math.min(this.boundaries.length - 1, i + 1)];
  }
  private previous(p: number): number {
    const index = this.boundaryIndex(p);
    if (this.codeUnitBoundaries) return Math.max(0, index - 1);
    return this.boundaries[Math.max(0, index - 1)];
  }
  private pos(): number {
    const c = this.getCursor();
    const starts = this.starts();
    return (c.line < starts.length ? starts[c.line] : this.text().length + 1) + c.col;
  }
  private snapshot(): Snapshot {
    return { text: this.text(), pos: this.pos(), payloads: readPastes(this) };
  }
  private checkpoint(s = this.snapshot()): void {
    this.undoHistory.push(s);
    if (this.undoHistory.length > 200) this.undoHistory.shift();
    this.redoHistory = [];
  }
  private restore(s: Snapshot): void {
    writePastes(this, s.payloads);
    this.writeText(s.text);
    this.cursorTo(s.pos);
  }
  private cursorTo(offset: number): void {
    const starts = this.starts();
    const end = clampOffset(offset, this.text().length);
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid] <= end) low = mid;
      else high = mid - 1;
    }
    setCursorPosition(this, low, end - starts[low]);
  }
  private onGrapheme(p: number): number {
    const end = this.lineEnd(p);
    return p >= end ? Math.max(this.lineStart(p), this.previous(end)) : p;
  }
  private move(p: number): void {
    const clamped = Math.max(0, Math.min(p, this.text().length));
    const i = this.boundaryIndex(clamped);
    this.cursorTo(
      this.codeUnitBoundaries || this.boundaries[i] === clamped
        ? clamped
        : this.boundaries[Math.max(0, i - 1)],
    );
  }
  private lineStart(p = this.pos()): number {
    return p <= 0 ? 0 : this.text().lastIndexOf("\n", p - 1) + 1;
  }
  private lineEnd(p = this.pos()): number {
    const text = this.text();
    const n = text.indexOf("\n", p);
    return n < 0 ? text.length : n;
  }
  private deleteEnd(n: number): number {
    let p = this.pos();
    const end = this.lineEnd();
    for (let i = 0; i < n && p < end; i++) p = this.next(p);
    return p;
  }
  private lineTarget(number: number): number {
    const text = this.text(),
      starts = this.starts();
    const line = Math.max(0, Math.min(number - 1, starts.length - 1));
    let p = starts[line];
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    while (p < end) {
      const code = text.charCodeAt(p);
      if (code !== 32 && code !== 9) break;
      p++;
    }
    return p;
  }
  private motion(key: string, n: number): number | undefined {
    let p = this.pos();
    n = Math.min(10000, n);
    if (key === "j" || key === "k") {
      const cursor = this.getCursor();
      this.preferredColumn ??= cursor.col;
      const starts = this.starts();
      const line = Math.max(
        0,
        Math.min(starts.length - 1, cursor.line + (key === "j" ? n : -n)),
      );
      const start = starts[line];
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
          Math.min(this.text().length, this.lineEnd(b) + 1),
        ]
      : [a, this.next(b)];
  }
  private apply(op: string, a: number, b: number, line = false, insertOnEmpty = false): void {
    this.preferredColumn = undefined;
    const text = this.text();
    for (const marker of this.markers()) {
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
      this.resetPending();
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
    this.move(op === "c" ? a : this.onGrapheme(a));
    this.mode = op === "c" ? "insert" : "normal";
    this.resetPending();
    this.cursorShape();
  }
  private put(key: string, n: number): void {
    const r = this.registers.get(this.register);
    this.register = '"';
    if (!r) return;
    const t = this.text();
    const visual = this.mode === "visual" || this.mode === "line";
    let a = 0,
      b = 0,
      value = "",
      before = "",
      after = "";
    if (visual) {
      [a, b] = this.range();
      const selected = expandPastes(this, t.slice(a, b));
      if (r.text.length * n + this.getExpandedText().length - selected.length > MAX_DRAFT) return;
      value = r.text.repeat(n);
      if (this.mode === "line") {
        if (t.slice(a, b).endsWith("\n") || value.endsWith("\n")) after = "\n";
      } else if (r.line) {
        if (a > this.lineStart(a)) before = "\n";
        if (b < t.length || value.endsWith("\n")) after = "\n";
      }
      if (after) value = value.replace(/\n$/, "");
      this.checkpoint();
      this.registers.set('"', { text: selected, line: this.mode === "line" });
    } else {
      a = b = key === "P" ? this.pos() : Math.min(this.lineEnd(), this.next(this.pos()));
      if (r.text.length * n + this.getExpandedText().length > MAX_DRAFT) return;
      this.checkpoint();
      value = r.text.repeat(n);
      if (r.line) {
        a = b = key === "P" ? this.lineStart() : Math.min(t.length, this.lineEnd() + 1);
        if (a === t.length && t && !t.endsWith("\n")) before = "\n";
        else after = "\n";
        value = value.replace(/\n$/, "");
      }
    }
    this.writeText(t.slice(0, a) + before + collapsePaste(this, value) + after + t.slice(b));
    this.move(a + before.length);
    if (visual) {
      this.mode = "normal";
      this.anchor = 0;
      this.visualScroll = 0;
      this.cursorShape();
    }
  }
  private object(key: string, around: boolean): [number, number] | undefined {
    const t = this.text(),
      p = this.pos();
    if (key === "w" || key === "W") {
      const wide = key === "W";
      const kindAt = (pos: number) => {
        const c = this.wordClass(pos, t);
        return wide ? (c === 0 ? 0 : 1) : c;
      };
      const kind = kindAt(p);
      let a = p,
        b = p;
      while (a > 0 && kindAt(this.previous(a)) === kind) a = this.previous(a);
      while (b < t.length && kindAt(b) === kind) b = this.next(b);
      if (around)
        while (b < t.length && this.wordClass(b, t) === 0) b = this.next(b);
      return [a, b];
    }
    const close = CLOSING[key];
    if (!close) return;
    const open = OPENING[key] ?? key;
    let a = -1,
      b = -1;
    if (open === close) {
      a = t.lastIndexOf(open, p);
      b = t.indexOf(close, a + 1);
    } else {
      const openCode = open.charCodeAt(0),
        closeCode = close.charCodeAt(0);
      let depth = 0;
      for (let i = p; i >= 0; i--) {
        const code = t.charCodeAt(i);
        if (code === closeCode && i !== p) depth++;
        if (code === openCode) {
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
          const code = t.charCodeAt(i);
          if (code === openCode) depth++;
          if (code === closeCode && --depth === 0) {
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
  override handleInput(data: string): void {
    if (this.pasteOpening) {
      data = this.pasteOpening + data;
      this.pasteOpening = "";
    }
    if (this.paste === undefined) {
      const opening = "\x1b[200~";
      const opener = data.indexOf(opening);
      if (opener > 0) {
        this.handleInput(data.slice(0, opener));
        this.handleInput(data.slice(opener));
        return;
      }
      if (opener < 0) {
        for (let length = Math.min(data.length, opening.length - 1); length > 1; length--) {
          if (!opening.startsWith(data.slice(-length))) continue;
          if (data.length > length) this.handleInput(data.slice(0, -length));
          this.pasteOpening = data.slice(-length);
          return;
        }
      }
    }
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
        if (this.insertion && this.insertion.text !== this.text())
          this.checkpoint(this.insertion);
        this.checkpoint();
        const [p, selectionEnd] =
          this.mode === "visual" || this.mode === "line"
            ? this.range()
            : [this.pos(), this.pos()];
        const text = this.text();
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
        this.insertion.text !== this.text()
      )
        this.checkpoint(this.insertion);
      if (this.mode === "insert")
        this.move(Math.max(this.lineStart(), this.previous(this.pos())));
      this.insertion = undefined;
      this.mode = "normal";
      this.resetPending();
      this.cursorShape();
      return;
    }
    if (this.mode === "insert") {
      this.insertion ??= this.snapshot();
      if (matchesKey(data, "backspace")) {
        const p = this.pos();
        const marker = this.markers().find((m) => m.index + m[0].length === p);
        if (marker) {
          const text = this.text();
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
      this.discardArgument = false;
      this.resetPending();
      this.register = '"';
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
      this.resetPending();
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
      this.resetPending();
      return;
    }
    if ("rmq".includes(data)) {
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
    if ("dcyx".includes(data) && (this.mode === "visual" || this.mode === "line")) {
      this.apply(
        data === "x" ? "d" : data,
        ...this.range(),
        this.mode === "line",
      );
      this.cursorShape();
      return;
    }
    if ("dcy".includes(data)) {
      if (this.op === data) {
        let b = this.pos();
        for (
          let i = 0;
          i < Math.min(10000, n * this.opCount) && b < this.text().length;
          i++
        )
          b = Math.min(this.text().length, this.lineEnd(b) + 1);
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
      p = this.lineTarget(this.prefixCount);
    } else if (data === "g") {
      this.prefix = "g";
      this.prefixCount = n;
      return;
    } else if (data === "G")
      p = this.lineTarget(hasCount ? n : this.starts().length);
    else
      p = this.motion(data, Math.min(10000, n * (this.op ? this.opCount : 1)));
    const changeWord =
      this.op === "c" && data === "w" && this.wordClass(this.pos()) !== 0;
    if (changeWord) {
      p = this.pos();
      for (let i = 0; i < Math.min(10000, n * this.opCount); i++) {
        const before: number = p;
        p = this.wordEnd(i === 0 ? p : this.wordNext(p));
        if (p >= this.text().length || (i > 0 && p === before)) break;
      }
    }
    if (p !== undefined) {
      if (this.op) {
        if ((data === "j" || data === "k") && this.lineStart(p) === this.lineStart()) {
          this.resetPending();
          this.register = '"';
          return;
        }
        if (data === "G" || data === "g" || data === "j" || data === "k") {
          this.apply(
            this.op,
            this.lineStart(Math.min(this.pos(), p)),
            Math.min(
              this.text().length,
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
            this.text().length,
            inclusive
              ? this.next(Math.max(this.pos(), p))
              : Math.max(this.pos(), p),
          ),
        );
      } else this.move(this.mode === "normal" ? this.onGrapheme(p) : p);
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
      this.put(data, n);
      return;
    }
    if ("iaIAoO".includes(data)) {
      if (data === "a")
        this.move(Math.min(this.lineEnd(), this.next(this.pos())));
      if (data === "I") this.move(this.lineTarget(this.getCursor().line + 1));
      if (data === "A") this.move(this.lineEnd());
      this.insertion = this.snapshot();
      if (data === "o" || data === "O") {
        const t = this.text();
        const p = data === "O" ? this.lineStart() : this.lineEnd();
        this.writeText(t.slice(0, p) + "\n" + t.slice(p));
        this.move(p + (data === "o" ? 1 : 0));
      }
      this.mode = "insert";
      this.cursorShape();
      return;
    }
    this.op = "";
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
  protected override renderBottomBorder(width: number, hidden: number): string {
    const pending = `${this.count}${this.op}${this.prefix}`;
    const label = truncateToWidth(
      ` ${this.mode.toUpperCase()}${pending ? ` ${pending}` : ""} `,
      width,
      "",
    );
    return super.renderBottomBorder(Math.max(0, width - visibleWidth(label)), hidden) + label;
  }
  override render(width: number): string[] {
    if (this.mode !== "visual" && this.mode !== "line") {
      const lines = this.scan().project
        ? renderProjected(this, () => super.render(width), this.text())
        : super.render(width);
      if (this.mode !== "insert" || !this.focused) return lines;
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
    const raw = this.text();
    const projection = this.scan().project ? projectDisplay(raw) : undefined;
    const display = (offset: number) => (projection ? projection.offsets[offset] : offset);
    const a = display(rawStart),
      b = display(rawEnd);
    const text = projection ? projection.text : raw;
    const cursor = display(this.pos());
    const padding = Math.min(
      this.getPaddingX(),
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const layoutWidth = Math.max(1, width - 2 * padding - (padding ? 0 : 1));
    const rows: string[] = [];
    const mark = this.focused ? CURSOR_MARKER : "";
    let row = "",
      cols = 0,
      cursorRow = 0;
    if (this.scan().segment) {
      for (const { segment: char, index: i } of segmenter().segment(text)) {
        if (char === "\n") {
          if (i === cursor) {
            cursorRow = rows.length;
            row += mark;
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
          (i === cursor ? mark : "") +
          (i >= a && i < b ? "\x1b[7m" + char + "\x1b[0m" : char);
        cols += w;
      }
    } else {
      for (let i = 0; i < text.length; ) {
        if (text.charCodeAt(i) === 10) {
          if (i === cursor) {
            cursorRow = rows.length;
            row += mark;
          }
          rows.push(row);
          row = "";
          cols = 0;
          i++;
          continue;
        }
        if (cols >= layoutWidth) {
          rows.push(row);
          row = "";
          cols = 0;
        }
        if (i === cursor) {
          cursorRow = rows.length;
          row += mark;
        }
        let limit = Math.min(text.length, i + layoutWidth - cols);
        const line = text.indexOf("\n", i);
        if (line >= 0 && line < limit) limit = line;
        if (cursor > i && cursor < limit) limit = cursor;
        if (a > i && a < limit) limit = a;
        if (b > i && b < limit) limit = b;
        if (i >= a && i < b)
          for (let k = i; k < limit; k++) row += "\x1b[7m" + text[k] + "\x1b[0m";
        else row += text.slice(i, limit);
        cols += limit - i;
        i = limit;
      }
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
