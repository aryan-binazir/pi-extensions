import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { attachEditorInput, resetEditorInput, retireEditorInput } from "../editor-input.ts";
import {
  matchesKey,
  decodeKittyPrintable,
  CURSOR_MARKER,
  visibleWidth,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  setCursorPosition,
  retainRawText,
  projectDisplay,
  renderProjected,
  clearBaseUndo,
  cancelAutocomplete,
  clampOffset,
  readPastes, writePastes, pasteMarkers, expandPastes, collapsePaste,
  type PasteState, markViEditor, invalidateTextCache, NEEDS_PROJECTION,
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
const BRACKETS = "()[]{}";
const MAX_DRAFT = 1024 * 1024;
const MAX_SEARCH = 256;
const CONTROLS_EXCEPT_TAB_LF_CR = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const CONTROLS_EXCEPT_TAB_LF = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function safeDraft(text: string): string {
  return text.replace(CONTROLS_EXCEPT_TAB_LF_CR, "");
}
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
// Mirrors pi-tui's unexported decodePrintableKey: without Kitty, Pi enables xterm modifyOtherKeys.
function decodePrintable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  const match = kitty === undefined ? MODIFY_OTHER_KEYS.exec(data) : null;
  if (!match) return kitty;
  const modifier = (parseInt(match[1], 10) - 1) & ~(64 + 128);
  const codepoint = parseInt(match[2], 10);
  if ((modifier & ~1) !== 0 || !Number.isFinite(codepoint) || codepoint < 32) return undefined;
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}
function changeCase(op: string, text: string): string {
  let out = "";
  for (const c of text) {
    const upper = c.toUpperCase(),
      lower = c.toLowerCase();
    const changed = op === "gU" ? upper : op === "gu" ? lower : c === upper ? lower : upper;
    out += changed.length === 1 || (changed.length === 2 && changed.codePointAt(0)! > 0xffff) ? changed : c;
  }
  return out;
}
type Snapshot = {
  text: string;
  pos: number;
  payloads: PasteState;
};
class ViMode {
  private mode: "insert" | "normal" | "visual" | "line" = "insert";
  private previousHardwareCursor: boolean;
  private disposed = false;
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
  private op = "";
  private opCount = 1;
  private undoHistory: Snapshot[] = [];
  private redoHistory: Snapshot[] = [];
  private insertion?: Snapshot;
  private discardArgument = false;
  private argument = "";
  private argumentSurrogate = "";
  private argumentCount = 1;
  private lastFind: { command: string; char: string } | undefined;
  private search: string | undefined;
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
  private projection: ReturnType<typeof projectDisplay> | undefined;
  private visualLayout: {
    text: string;
    width: number;
    starts: number[];
    ends: number[];
    characters: number[] | undefined;
    cols: number;
  } | undefined;
  private draft: string | undefined;
  private handlingBaseInput = false;

  private readonly tui: TUI;
  private readonly base;
  constructor(private readonly editor: CustomEditor) {
    const internal = editor as unknown as {
      tui: TUI;
      keybindings?: { matches(data: string, id: string): boolean; getResolvedBindings(): Record<string, unknown> };
      renderTopBorder(width: number, hidden: number): string;
      renderBottomBorder(width: number, hidden: number): string;
    };
    this.tui = internal.tui;
    this.base = {
      keybindings: internal.keybindings,
      getText: editor.getText.bind(editor),
      setText: editor.setText.bind(editor),
      handleInput: attachEditorInput(editor).bind(editor),
      render: editor.render.bind(editor),
      invalidate: editor.invalidate.bind(editor),
      renderTopBorder: internal.renderTopBorder.bind(editor),
      renderBottomBorder: internal.renderBottomBorder.bind(editor),
    };
    editor.getExpandedText = this.getExpandedText.bind(this);
    editor.setText = this.setText.bind(this);
    editor.insertTextAtCursor = this.insertTextAtCursor.bind(this);
    editor.render = this.render.bind(this);
    editor.invalidate = () => {
      this.base.invalidate();
      // Ghost's async invalidation does not schedule a repaint in compiled Pi.
      if (!this.disposed) this.tui.requestRender();
    };
    internal.renderBottomBorder = this.renderBottomBorder.bind(this);
    Object.defineProperty(editor, invalidateTextCache, { value: this[invalidateTextCache].bind(this) });
    markViEditor(editor);
    this.previousHardwareCursor = this.tui.getShowHardwareCursor();
    this.tui.setShowHardwareCursor(true);
    this.cursorShape();
    attachEditorInput(editor, { key: data => this.handleKey(data), paste: data => this.consumePaste(data), release: () => this.releaseCursor(), acquire: () => this.acquireCursor() });
  }
  private clearGhost(): void {
    (this.editor as CustomEditor & { forceClearGhost?: () => void }).forceClearGhost?.();
  }
  private resetPending(): void {
    this.op = "";
    this.prefix = "";
    this.count = "";
    this.registerPending = false;
    this.argument = "";
    this.argumentSurrogate = "";
    this.search = undefined;
  }
  private cancel(): void {
    this.resetPending();
    this.register = '"';
  }
  private text(): string {
    return (this.draft ??= this.base.getText());
  }
  [invalidateTextCache](): void {
    this.draft = undefined;
    this.visualLayout = undefined;
  }
  private scan(): { project: boolean; segment: boolean } {
    const text = this.text();
    if (this.scanText !== text) {
      this.scanText = text;
      this.projection = undefined;
      this.scanned = {
        project: NEEDS_PROJECTION.test(text),
        segment: NEEDS_SEGMENTING.test(text),
      };
    }
    return this.scanned;
  }
  private projected(): ReturnType<typeof projectDisplay> | undefined {
    return this.scan().project ? (this.projection ??= projectDisplay(this.text())) : undefined;
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
      this.markerList = pasteMarkers(this.editor, text);
    }
    return this.markerList;
  }
  private wordClass(p: number, text = this.text(), wide = false): number {
    const code = text.codePointAt(p);
    if (code === undefined) return 0;
    let c: number;
    if (code < 128) c = (asciiClasses ?? buildAsciiClasses())[code];
    else {
      const char = String.fromCodePoint(code);
      c = SPACE.test(char) ? 0 : WORD.test(char) ? 1 : 2;
    }
    return wide && c ? 1 : c;
  }
  private wordNext(p: number, wide = false, eol = false): number {
    const text = this.text(),
      kind = this.wordClass(p, text, wide),
      end = text.length;
    const lineBreak = (from: number, to: number) =>
      eol && (to >= end || text.charCodeAt(from) === 10 || text.charCodeAt(to) === 10);
    let q = this.next(p);
    if (q === p || lineBreak(p, q)) return q;
    while (kind && q < end && this.wordClass(q, text, wide) === kind) {
      const after = this.next(q);
      if (lineBreak(q, after)) return after;
      q = after;
    }
    while (q < end && this.wordClass(q, text, wide) === 0) {
      if (text.charCodeAt(q) === 10 && text.charCodeAt(q - 1) === 10) break;
      const after = this.next(q);
      if (lineBreak(q, after)) return after;
      q = after;
    }
    return q;
  }
  private wordEnd(p: number, wide = false): number {
    const text = this.text(),
      end = text.length;
    while (p < end && this.wordClass(p, text, wide) === 0) p = this.next(p);
    const kind = this.wordClass(p, text, wide);
    for (let after = this.next(p); after < end && this.wordClass(after, text, wide) === kind; after = this.next(p))
      p = after;
    return p;
  }
  private wordEndBack(p: number, wide: boolean): number {
    const text = this.text(),
      kind = this.wordClass(p, text, wide);
    if (p <= 0) return 0;
    p = this.previous(p);
    while (kind && p > 0 && this.wordClass(p, text, wide) === kind) p = this.previous(p);
    while (p > 0 && this.wordClass(p, text, wide) === 0) {
      if (text.charCodeAt(p) === 10 && text.charCodeAt(p - 1) === 10) break;
      p = this.previous(p);
    }
    return p;
  }
  private baseInput(data: string): void {
    const submit = this.editor.onSubmit;
    const before = this.mode === "insert" ? undefined : this.snapshot();
    const history = this.undoHistory;
    this.editor.onSubmit = (expanded) => {
      this.resetDraft("");
      submit?.(expanded.trim().replace(CONTROLS_EXCEPT_TAB_LF, ""));
    };
    try {
      this.handlingBaseInput = true;
      try { this.base.handleInput(data); }
      finally { this.handlingBaseInput = false; }
      if (this.mode !== "insert") this.clearGhost();
      this.draft = undefined;
      const historyReset = history !== this.undoHistory;
      if (before && !historyReset && before.text !== this.text()) {
        this.visualLayout = undefined;
        this.checkpoint(before);
        this.discardArgument = false;
        this.resetPending();
        this.register = '"';
      }
    } finally {
      this.draft = undefined;
      if (this.mode === "insert") this.visualLayout = undefined;
      this.editor.onSubmit = submit;
    }
  }
  getExpandedText(): string {
    return expandPastes(this.editor, this.base.getText());
  }
  insertTextAtCursor(text: string): void {
    text = safeDraft(text);
    if (!text) return;
    if (this.insertion && this.insertion.text !== this.text())
      this.checkpoint(this.insertion);
    this.checkpoint();
    const p = this.pos(),
      draft = this.text();
    this.writeText(draft.slice(0, p) + text + draft.slice(p));
    this.move(p + text.length);
    this.insertion = undefined;
  }

  setText(text: string): void {
    if (this.handlingBaseInput) {
      if (this.mode === "insert") {
        if (this.insertion && this.insertion.text !== this.text()) this.checkpoint(this.insertion);
        this.checkpoint();
      }
      this.insertion = undefined;
      this.writeText(text);
      this.move(this.text().length);
      return;
    }
    this.resetDraft(text);
  }
  private resetDraft(text: string): void {
    this.clearGhost();
    if (this.mode === "visual" || this.mode === "line") this.mode = "normal";
    this.anchor = 0;
    this.visualScroll = 0;
    this.preferredColumn = undefined;
    this.discardArgument = false;
    this.undoHistory = [];
    this.redoHistory = [];
    this.insertion = undefined;
    resetEditorInput(this.editor);
    this.resetPending();
    writePastes(this.editor, { pastes: new Map(), counter: 0 });
    this.writeText(collapsePaste(this.editor, safeDraft(text)));
    this.move(this.text().length);
    clearBaseUndo(this.editor);
    this.cursorShape();
  }
  private writeText(text: string): void {
    text = safeDraft(text);
    this.visualLayout = undefined;
    this.boundaryText = "";
    this.markerText = undefined;
    const payloads = readPastes(this.editor);
    this.base.setText(text);
    this.draft = undefined;
    writePastes(this.editor, payloads);
    clearBaseUndo(this.editor);
    if (this.text() !== text) {
      retainRawText(this.editor, text);
      this.editor.onChange?.(text);
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
    const c = this.editor.getCursor();
    const starts = this.starts();
    return (c.line < starts.length ? starts[c.line] : this.text().length + 1) + c.col;
  }
  private snapshot(): Snapshot {
    return { text: this.text(), pos: this.pos(), payloads: readPastes(this.editor) };
  }
  private checkpoint(s = this.snapshot()): void {
    this.undoHistory.push(s);
    if (this.undoHistory.length > 200) this.undoHistory.shift();
    this.redoHistory = [];
  }
  private restore(s: Snapshot): void {
    writePastes(this.editor, s.payloads);
    this.writeText(s.text);
    this.cursorTo(s.pos);
  }
  private cursorTo(offset: number): void {
    cancelAutocomplete(this.editor);
    const starts = this.starts();
    const end = clampOffset(offset, this.text().length);
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid] <= end) low = mid;
      else high = mid - 1;
    }
    setCursorPosition(this.editor, low, end - starts[low]);
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
  private countedLineEnd(n: number): number {
    const starts = this.starts();
    return this.lineEnd(starts[Math.min(starts.length - 1, this.editor.getCursor().line + n - 1)]);
  }
  private lines(op: string, count: number): void {
    const length = this.text().length;
    let b = this.pos();
    for (let i = 0; i < Math.min(10000, count) && b < length; i++) b = Math.min(length, this.lineEnd(b) + 1);
    this.apply(op, this.lineStart(), b, true, op === "c", this.lineTarget(this.editor.getCursor().line + 1));
  }
  private join(count: number): void {
    const text = this.text(),
      start = this.lineStart(),
      lines = Math.min(Math.max(2, count), this.starts().length - this.editor.getCursor().line);
    this.cancel();
    if (lines < 2) return;
    let end = this.lineEnd(),
      length = end,
      at = end,
      last = end > start ? text[end - 1] : "";
    const pieces = [text.slice(0, end)];
    for (let i = 1; i < lines; i++) {
      let next = end + 1;
      while (text[next] === " " || text[next] === "\t") next++;
      end = text.indexOf("\n", next);
      if (end < 0) end = text.length;
      const content = text.slice(next, end);
      const space = last && content && content[0] !== ")" && last !== " " && last !== "\t" ? " " : "";
      at = length;
      pieces.push(space, content);
      length += space.length + content.length;
      if (content) last = content[content.length - 1];
    }
    pieces.push(text.slice(end));
    this.checkpoint();
    this.writeText(pieces.join(""));
    this.move(this.onGrapheme(at));
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
      const cursor = this.editor.getCursor();
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
      else if (key === "$") {
        const end = this.countedLineEnd(n);
        return Math.max(this.lineStart(end), this.previous(end));
      }
      else if (key === "^") return this.lineTarget(this.editor.getCursor().line + 1);
      else if (key === "w" || key === "W") p = this.wordNext(p, key === "W", !!this.op && i === n - 1);
      else if (key === "e" || key === "E") p = this.wordEnd(this.next(p), key === "E");
      else if (key === "b" || key === "B") {
        const text = this.text(), wide = key === "B";
        p = this.previous(p);
        while (p > 0 && this.wordClass(p, text, wide) === 0) p = this.previous(p);
        const kind = this.wordClass(p, text, wide);
        while (p > 0 && this.wordClass(this.previous(p), text, wide) === kind)
          p = this.previous(p);
      } else return undefined;
      if (p === before) break;
    }
    return p;
  }
  private find(command: string, char: string, n: number, repeat: boolean): number | undefined {
    const text = this.text(),
      forward = command === "f" || command === "t",
      till = command === "t" || command === "T",
      start = this.lineStart(),
      end = this.lineEnd(),
      markers = new Set(this.markers().map((m) => m.index));
    let p = this.pos(),
      skip = repeat && till && n === 1;
    for (let found = 0; found < Math.min(10000, n); ) {
      if (forward) {
        p = this.next(p);
        if (p >= end) return;
      } else {
        if (p <= start) return;
        p = this.previous(p);
      }
      if (skip) skip = false;
      else if (!markers.has(p) && text.startsWith(char, p)) found++;
    }
    return till ? (forward ? this.previous(p) : this.next(p)) : p;
  }
  private target(p: number, inclusive: boolean, linewise = false): void {
    if (!this.op) {
      this.move(this.mode === "normal" ? this.onGrapheme(p) : p);
      return;
    }
    const pos = this.pos(),
      length = this.text().length;
    if (linewise) {
      this.apply(
        this.op,
        this.lineStart(Math.min(pos, p)),
        Math.min(length, this.lineEnd(Math.max(pos, p)) + 1),
        true,
        false,
        Math.min(pos, p),
      );
      return;
    }
    this.apply(
      this.op,
      Math.min(pos, p),
      Math.min(length, inclusive ? this.next(Math.max(pos, p)) : Math.max(pos, p)),
    );
  }
  private matchBracket(): number | undefined {
    const text = this.text(),
      lineEnd = this.lineEnd(),
      forward = new Map<number, number>(),
      backward = new Map<number, number>();
    for (const marker of this.markers()) {
      forward.set(marker.index, marker.index + marker[0].length);
      backward.set(marker.index + marker[0].length - 1, marker.index - 1);
    }
    let i = this.pos();
    while (i < lineEnd && (forward.has(i) || !BRACKETS.includes(text[i]))) i = forward.get(i) ?? i + 1;
    if (i >= lineEnd) return;
    const k = BRACKETS.indexOf(text[i]),
      open = BRACKETS[k & ~1],
      close = BRACKETS[k | 1],
      step = k & 1 ? -1 : 1,
      skip = step > 0 ? forward : backward;
    for (let j = i, depth = 0; j >= 0 && j < text.length; ) {
      const jump = skip.get(j);
      if (jump !== undefined) {
        j = jump;
        continue;
      }
      if (text[j] === open) depth += step;
      else if (text[j] === close) depth -= step;
      if (depth === 0) return j;
      j += step;
    }
  }
  private takeArgument(data: string): void {
    if (this.argumentSurrogate) {
      if (!/^[\udc00-\udfff]$/.test(data)) {
        this.cancel();
        return;
      }
      data = this.argumentSurrogate + data;
      this.argumentSurrogate = "";
    }
    if (/^[\ud800-\udbff]$/.test(data)) {
      this.argumentSurrogate = data;
      return;
    }
    const command = this.argument,
      n = this.argumentCount;
    this.argument = "";
    if (/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(data) || !this.oneGrapheme(data)) {
      this.cancel();
      return;
    }
    this.preferredColumn = undefined;
    if (command === "r") {
      this.replace(data, n);
      return;
    }
    this.lastFind = { command, char: data };
    const p = this.find(command, data, n, false);
    if (p === undefined) this.cancel();
    else this.target(p, command === "f" || command === "t");
  }
  private replace(char: string, n: number): void {
    const a = this.pos(),
      end = this.lineEnd(),
      text = this.text();
    let b = a,
      replaced = 0;
    for (; replaced < n && b < end; replaced++) b = this.next(b);
    const growth = char.length * n - expandPastes(this.editor, text.slice(a, b)).length;
    this.cancel();
    if (replaced < n || this.getExpandedText().length + growth > MAX_DRAFT) return;
    this.checkpoint();
    this.writeText(text.slice(0, a) + char.repeat(n) + text.slice(b));
    this.move(a + char.length * (n - 1));
  }
  private oneGrapheme(data: string): boolean {
    if (data.length === 1) return true;
    const segments = segmenter().segment(data)[Symbol.iterator]();
    return !segments.next().done && segments.next().done === true;
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
  private apply(op: string, a: number, b: number, line = false, insertOnEmpty = false, cursor = a): void {
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
      } else if (op[0] === "g") {
        this.mode = "normal";
        this.cursorShape();
      }
      this.resetPending();
      this.register = '"';
      return;
    }
    if (op[0] === "g") {
      let changed = text.slice(0, a),
        at = a;
      for (const marker of this.markers()) {
        if (marker.index < a || marker.index >= b) continue;
        changed += changeCase(op, text.slice(at, marker.index)) + marker[0];
        at = marker.index + marker[0].length;
      }
      changed += changeCase(op, text.slice(at, b)) + text.slice(b);
      if (changed !== text) {
        this.checkpoint();
        this.writeText(changed);
      }
      this.move(this.onGrapheme(cursor));
      this.mode = "normal";
      this.cancel();
      this.cursorShape();
      return;
    }
    const value = { text: expandPastes(this.editor, text.slice(a, b)), line };
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
    let a = key === "P" ? this.pos() : Math.min(this.lineEnd(), this.next(this.pos())),
      b = a;
    if (visual) [a, b] = this.range();
    const selected = visual ? expandPastes(this.editor, t.slice(a, b)) : "";
    const separator = r.line && r.text && !r.text.endsWith("\n") ? "\n" : "";
    const repeatedLength = r.text.length * n + separator.length * (n - 1);
    const remainingLength = this.getExpandedText().length - selected.length;
    if (remainingLength + repeatedLength > MAX_DRAFT) return;
    let value = (r.text + separator).repeat(n),
      before = "",
      after = "";
    if (separator) value = value.slice(0, -1);
    if (visual) {
      if (this.mode === "line") {
        if (t.slice(a, b).endsWith("\n") || value.endsWith("\n")) after = "\n";
      } else if (r.line) {
        if (a > this.lineStart(a)) before = "\n";
        if (b < t.length || value.endsWith("\n")) after = "\n";
      }
      if (after) value = value.replace(/\n$/, "");
    } else if (r.line) {
      a = b = key === "P" ? this.lineStart() : Math.min(t.length, this.lineEnd() + 1);
      if (a === t.length && t && !t.endsWith("\n")) before = "\n";
      else after = "\n";
      value = value.replace(/\n$/, "");
    }
    if (remainingLength + before.length + value.length + after.length > MAX_DRAFT) return;
    this.checkpoint();
    if (visual) this.registers.set('"', { text: selected, line: this.mode === "line" });
    this.writeText(t.slice(0, a) + before + collapsePaste(this.editor, value) + after + t.slice(b));
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
      const kindAt = (pos: number) => this.wordClass(pos, t, wide);
      const kind = kindAt(p);
      let a = p,
        b = p;
      while (a > 0 && kindAt(this.previous(a)) === kind) a = this.previous(a);
      while (b < t.length && kindAt(b) === kind) b = this.next(b);
      if (around)
        while (b < t.length && this.wordClass(b, t) === 0) b = this.next(b);
      return [a, b];
    }
    if (key === "b") key = "(";
    else if (key === "B") key = "{";
    const close = CLOSING[key];
    if (!close) return;
    const open = OPENING[key] ?? key;
    let a = -1,
      b = -1;
    if (open === close) {
      for (a = t.indexOf(open); a >= 0 && a <= p; a = t.indexOf(open, b + 1)) {
        b = t.indexOf(close, a + 1);
        if (b < 0) return;
        if (b >= p) break;
      }
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
  dispose(): void { this.clearGhost(); retireEditorInput(this.editor); }
  private acquireCursor(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.previousHardwareCursor = this.tui.getShowHardwareCursor();
    this.tui.setShowHardwareCursor(true);
    this.cursorShape();
  }
  private releaseCursor(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tui.setShowHardwareCursor(this.previousHardwareCursor);
    this.tui.terminal.write("\x1b[0 q");
  }
  private consumePaste(data: string): void {
    this.clearGhost();
    if (this.search !== undefined) {
      this.appendSearch(data.replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
      return;
    }
    const payload = safeDraft(data.replace(/\x1b\[(\d+);5u/g, (sequence, code: string) => {
      const cp = Number(code);
      return cp >= 97 && cp <= 122 ? String.fromCharCode(cp - 96)
        : cp >= 65 && cp <= 90 ? String.fromCharCode(cp - 64) : sequence;
    }));
    if (this.insertion && this.insertion.text !== this.text())
      this.checkpoint(this.insertion);
    this.checkpoint();
    const [p, selectionEnd] =
      this.mode === "visual" || this.mode === "line"
        ? this.range()
        : [this.pos(), this.pos()];
    const text = this.text();
    const visible = collapsePaste(this.editor, payload);
    this.writeText(text.slice(0, p) + visible + text.slice(selectionEnd));
    if (this.mode === "visual" || this.mode === "line") {
      this.mode = "normal";
      this.cursorShape();
    }
    this.insertion = undefined;
    this.move(p + visible.length);
  }
  private appendSearch(text: string): void {
    for (const { segment } of segmenter().segment(text)) {
      if (this.search!.length - 1 + segment.length > MAX_SEARCH) return;
      this.search += segment;
    }
  }
  private searchKey(data: string): void {
    const keybindings = this.base.keybindings;
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || keybindings?.matches(data, "tui.input.submit")) {
      this.search = undefined;
      return;
    }
    if (matchesKey(data, "backspace")) {
      const body = this.search!.slice(1);
      let last = 0;
      for (const { index } of segmenter().segment(body)) last = index;
      this.search = body ? this.search![0] + body.slice(0, last) : undefined;
      return;
    }
    if (matchesKey(data, "ctrl+r")) return;
    if (this.editor.onExtensionShortcut?.(data)) return;
    let application = !!keybindings?.matches(data, "app.clipboard.pasteImage");
    if (keybindings?.matches(data, "app.interrupt") && !this.editor.isShowingAutocomplete() &&
        (this.editor.onEscape || this.editor.actionHandlers.has("app.interrupt"))) application = true;
    if (keybindings?.matches(data, "app.exit") && !this.text()) application = true;
    if (!application && (keybindings?.matches(data, "tui.editor.historyPrevious") || keybindings?.matches(data, "tui.editor.historyNext"))) return;
    if (!application) {
      for (const action of this.editor.actionHandlers.keys()) {
        if (action !== "app.interrupt" && action !== "app.exit" && keybindings?.matches(data, action)) {
          application = true;
          break;
        }
      }
    }
    if (!application) {
      const key = decodePrintable(data) ?? data;
      if (!/[\x00-\x1f\x7f-\x9f]/.test(key)) {
        this.appendSearch(key);
        return;
      }
      if (Object.keys(keybindings?.getResolvedBindings() ?? {}).some(id => id.startsWith("tui.") && keybindings!.matches(data, id))) return;
    }
    const shortcut = this.editor.onExtensionShortcut;
    this.editor.onExtensionShortcut = undefined;
    try { this.baseInput(data); }
    finally { this.editor.onExtensionShortcut ??= shortcut; }
  }
  private handleKey(data: string): void {
    if (this.mode !== "insert" || matchesKey(data, "escape")) this.clearGhost();
    if (this.search !== undefined) {
      this.searchKey(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      const discarded = this.discardArgument;
      this.discardArgument = false;
      this.visualScroll = 0;
      if (this.mode === "normal" && !this.op && !this.prefix && !this.count && !discarded && !this.registerPending && !this.argument) {
        this.baseInput(data);
        return;
      }
      cancelAutocomplete(this.editor);
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
    if (this.argument && (matchesKey(data, "enter") || this.base.keybindings?.matches(data, "tui.input.submit"))) {
      this.cancel();
      return;
    }
    data = decodePrintable(data) ?? data;
    if (!/^[^\x00-\x1f]+$/u.test(data) && !matchesKey(data, "ctrl+r")) {
      this.baseInput(data);
      return;
    }
    if (this.discardArgument) {
      this.discardArgument = false;
      return;
    }
    if (this.argument) {
      this.takeArgument(data);
      return;
    }
    if (this.registerPending) {
      this.registerPending = false;
      if (/^[a-z"]$/.test(data)) this.register = data;
      else {
        this.resetPending();
        this.register = '"';
      }
      return;
    }
    if (data === "/" || data === "?") {
      this.cancel();
      this.search = data;
      return;
    }
    const visual = this.mode === "visual" || this.mode === "line";
    if ((data === "u" || data === "U" || data === "~") && this.prefix !== "i" && this.prefix !== "a") {
      const op = "g" + data;
      if (this.prefix === "g") {
        this.prefix = "";
        if (visual) this.apply(op, ...this.range(), this.mode === "line");
        else if (this.op === op) this.lines(op, this.prefixCount * this.opCount);
        else if (this.op) this.cancel();
        else {
          this.op = op;
          this.opCount = this.prefixCount;
        }
        return;
      }
      if (this.op === op) {
        this.lines(op, Number(this.count || 1) * this.opCount);
        return;
      }
      if (visual) {
        this.apply(op, ...this.range(), this.mode === "line");
        return;
      }
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
      this.resetPending();
      this.register = '"';
      this.cursorShape();
      return;
    }
    if (!/^[\x20-\x7e]$/.test(data)) {
      this.resetPending();
      this.register = '"';
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
    if (this.prefix === "g" && data !== "g" && data !== "e" && data !== "E") {
      this.resetPending();
      return;
    }
    if ("fFtT".includes(data) || (data === "r" && !this.op && this.mode === "normal")) {
      this.argument = data;
      this.argumentCount = Math.min(10000, Number(this.count || 1) * (this.op ? this.opCount : 1));
      this.count = "";
      return;
    }
    if ("rmq".includes(data)) {
      this.resetPending();
      this.register = '"';
      this.discardArgument = true;
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
    if (visual && (data === "o" || data === "O")) {
      const p = this.pos();
      this.move(this.anchor);
      this.anchor = p;
      return;
    }
    if (visual && "sXDYCS".includes(data)) {
      if (data === "s") this.apply("c", ...this.range(), this.mode === "line", true);
      else {
        const a = Math.min(this.anchor, this.pos()),
          b = Math.max(this.anchor, this.pos()),
          op = data === "Y" ? "y" : data === "C" || data === "S" ? "c" : "d";
        this.apply(op, this.lineStart(a), Math.min(this.text().length, this.lineEnd(b) + 1), true, op === "c");
      }
      this.cursorShape();
      return;
    }
    if (data === "J" && visual) {
      const a = Math.min(this.anchor, this.pos()),
        b = Math.max(this.anchor, this.pos());
      let count = 1;
      for (let i = this.text().indexOf("\n", a); i >= 0 && i < b; i = this.text().indexOf("\n", i + 1)) count++;
      this.move(a);
      this.mode = "normal";
      this.anchor = 0;
      this.visualScroll = 0;
      this.join(count);
      this.cursorShape();
      return;
    }
    if ("dcy".includes(data)) {
      if (this.op === data) this.lines(data, n * this.opCount);
      else {
        this.op = data;
        this.opCount = n;
      }
      return;
    }
    if (data === "%") {
      this.preferredColumn = undefined;
      const p = this.matchBracket();
      if (p === undefined) this.cancel();
      else this.target(p, true);
      return;
    }
    if (data === ";" || data === ",") {
      const last = this.lastFind;
      const reverse = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
      const command = last ? (data === ";" ? last.command : reverse(last.command)) : "";
      this.preferredColumn = undefined;
      const p = last && this.find(command, last.char, n * (this.op ? this.opCount : 1), true);
      if (p === undefined) this.cancel();
      else this.target(p, command === "f" || command === "t");
      return;
    }
    let p: number | undefined;
    if (data === "g" || data === "G") this.preferredColumn = undefined;
    if (this.prefix === "g") {
      this.prefix = "";
      if (data === "e" || data === "E") {
        this.preferredColumn = undefined;
        p = this.pos();
        for (let i = 0; i < Math.min(10000, this.prefixCount * (this.op ? this.opCount : 1)); i++) {
          const before: number = p;
          p = this.wordEndBack(p, data === "E");
          if (p === before) break;
        }
        if (p === this.pos()) {
          this.cancel();
          return;
        }
      } else p = this.lineTarget(this.prefixCount);
    } else if (data === "g") {
      this.prefix = "g";
      this.prefixCount = n;
      return;
    } else if (data === "G")
      p = this.lineTarget(hasCount ? n : this.starts().length);
    else
      p = this.motion(data, Math.min(10000, n * (this.op ? this.opCount : 1)));
    const wide = data === "W";
    const changeWord =
      this.op === "c" && (data === "w" || wide) && this.wordClass(this.pos()) !== 0;
    if (changeWord) {
      p = this.pos();
      for (let i = 0; i < Math.min(10000, n * this.opCount); i++) {
        const before: number = p;
        p = this.wordEnd(i === 0 ? p : this.wordNext(p, wide), wide);
        if (p >= this.text().length || (i > 0 && p === before)) break;
      }
    }
    if (p !== undefined) {
      if (this.op && (data === "j" || data === "k") && this.lineStart(p) === this.lineStart()) {
        this.cancel();
        return;
      }
      this.target(p, (data === "$" && p < this.lineEnd(p)) || data === "e" || data === "E" || changeWord, "Ggjk".includes(data));
      return;
    }
    if (data === "v" || data === "V") {
      const mode = data === "v" ? "visual" : "line";
      if (this.mode === mode) {
        this.mode = "normal";
        this.anchor = 0;
        this.visualScroll = 0;
        this.move(this.onGrapheme(this.pos()));
      } else {
        if (this.mode === "normal") {
          this.anchor = this.pos();
          this.visualScroll = 0;
        }
        this.mode = mode;
      }
      this.resetPending();
      this.cursorShape();
      return;
    }
    if (data === "x") {
      this.apply("d", this.pos(), this.deleteEnd(n));
      return;
    }
    if (data === "J") {
      this.join(n);
      return;
    }
    if (data === "~") {
      const b = this.deleteEnd(n);
      this.apply("g~", this.pos(), b, false, false, b);
      return;
    }
    if (data === "X") {
      let a = this.pos();
      const start = this.lineStart();
      for (let i = 0; i < n && a > start; i++) a = this.previous(a);
      this.apply("d", a, this.pos());
      return;
    }
    if (data === "s") {
      this.apply("c", this.pos(), this.deleteEnd(n), false, true);
      return;
    }
    if (data === "S") {
      this.lines("c", n);
      return;
    }
    if (data === "D" || data === "C" || data === "Y") {
      const op = data === "D" ? "d" : data === "C" ? "c" : "y";
      this.apply(op, this.pos(), this.countedLineEnd(n), false, op === "c");
      return;
    }
    if (data === "p" || data === "P") {
      this.put(data, n);
      return;
    }
    if ("iaIAoO".includes(data)) {
      if (data === "a")
        this.move(Math.min(this.lineEnd(), this.next(this.pos())));
      if (data === "I") this.move(this.lineTarget(this.editor.getCursor().line + 1));
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
  private renderBottomBorder(width: number, hidden: number): string {
    const pending = this.search ?? `${this.count}${this.op}${this.prefix}${this.argument}`;
    const label = truncateToWidth(
      ` ${this.mode.toUpperCase()}${pending ? ` ${pending}` : ""} `,
      width,
      "",
    );
    return this.base.renderBottomBorder(Math.max(0, width - visibleWidth(label)), hidden) + label;
  }
  render(width: number): string[] {
    if (this.mode !== "insert") this.clearGhost();
    if (this.editor.focused && !this.tui.getShowHardwareCursor()) {
      this.tui.setShowHardwareCursor(true);
      this.cursorShape();
    }
    if (this.mode !== "visual" && this.mode !== "line") {
      const projection = this.projected();
      const lines = projection
        ? renderProjected(this.editor, () => this.base.render(width), projection, this.pos())
        : this.base.render(width);
      if (this.mode !== "insert" || !this.editor.focused) return lines;
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
    const projection = this.projected();
    const display = (offset: number) => (projection ? projection.offsets[offset] : offset);
    const a = display(rawStart),
      b = display(rawEnd);
    const text = projection ? projection.text : raw;
    const cursor = display(this.pos());
    const padding = Math.min(
      this.editor.getPaddingX(),
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const layoutWidth = Math.max(1, width - 2 * padding - (padding ? 0 : 1));
    let layout = this.visualLayout;
    if (!layout || layout.text !== raw || layout.width !== layoutWidth) {
      const starts = [0], ends: number[] = [];
      const characters: number[] | undefined = this.scan().segment ? [] : undefined;
      let cols = 0;
      if (characters) {
        for (const { segment: char, index } of segmenter().segment(text)) {
          characters.push(index);
          if (char === "\n") {
            ends.push(index);
            starts.push(index + 1);
            cols = 0;
            continue;
          }
          const w = visibleWidth(char);
          if (cols + w > layoutWidth) {
            ends.push(index);
            starts.push(index);
            cols = 0;
          }
          cols += w;
        }
        characters.push(text.length);
      } else {
        for (let i = 0; i < text.length; i++) {
          if (text.charCodeAt(i) === 10) {
            ends.push(i);
            starts.push(i + 1);
            cols = 0;
          } else {
            if (cols >= layoutWidth) {
              ends.push(i);
              starts.push(i);
              cols = 0;
            }
            cols++;
          }
        }
      }
      ends.push(text.length);
      layout = this.visualLayout = { text: raw, width: layoutWidth, starts, ends, characters, cols };
    }
    const { starts, ends, characters } = layout;
    const extra = cursor === text.length && layout.cols >= layoutWidth;
    const rowCount = starts.length + (extra ? 1 : 0);
    let cursorRow = 0;
    let charIndex = 0;
    if (characters) {
      let low = 0, high = characters.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (characters[mid] < cursor) low = mid + 1;
        else high = mid;
      }
      charIndex = low;
    }
    if (!characters || characters[charIndex] === cursor) {
      let low = 0, high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >>> 1;
        if (starts[mid] <= cursor) low = mid;
        else high = mid - 1;
      }
      cursorRow = extra ? rowCount - 1 : low;
    }
    const max = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
    if (cursorRow < this.visualScroll) this.visualScroll = cursorRow;
    if (cursorRow >= this.visualScroll + max)
      this.visualScroll = cursorRow - max + 1;
    const start = Math.max(0, Math.min(this.visualScroll, rowCount - max));
    const rows: string[] = [];
    const mark = this.editor.focused ? CURSOR_MARKER : "";
    let character = 0;
    if (characters) {
      let low = 0, high = characters.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (characters[mid] < starts[start]) low = mid + 1;
        else high = mid;
      }
      character = low;
    }
    for (let r = start; r < Math.min(rowCount, start + max); r++) {
      const from = starts[r] ?? text.length, to = ends[r] ?? text.length;
      let row = "";
      for (let i = from; i < to; ) {
        const next = characters ? characters[++character] : i + 1;
        const char = text.slice(i, next);
        row += (i === cursor ? mark : "") + (i >= a && i < b ? "\x1b[7m" + char + "\x1b[0m" : char);
        i = next;
      }
      if (to === cursor && (text.charCodeAt(to) === 10 || (cursor === text.length && r === cursorRow))) row += mark;
      rows.push(" ".repeat(padding) + row + " ".repeat(padding));
      if (characters && text.charCodeAt(to) === 10) character++;
    }
    return [
      this.base.renderTopBorder(width, start),
      ...rows,
      this.renderBottomBorder(width, Math.max(0, rowCount - start - max)),
    ];
  }
}

const viDisposer = Symbol.for("pi-interactive:vi-disposer");

export function attachViMode(editor: CustomEditor): () => void {
  const shared = editor as CustomEditor & { [viDisposer]?: () => void };
  if (shared[viDisposer]) return shared[viDisposer];
  const mode = new ViMode(editor);
  const dispose = () => mode.dispose();
  Object.defineProperty(editor, viDisposer, { value: dispose });
  return dispose;
}

export class ViEditor extends CustomEditor {
  private readonly disposeVi: () => void;
  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
    this.disposeVi = attachViMode(this);
  }
  dispose(): void { this.disposeVi(); }
}
