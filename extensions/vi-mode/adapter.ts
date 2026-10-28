import type { Editor, TUI } from "@earendil-works/pi-tui";
export const invalidateTextCache = Symbol.for("pi-interactive:vi-text-cache");

export function setCursorPosition(editor: Editor, line: number, col: number): void {
  const internal = editor as unknown as {
    state: {
      cursorLine: number;
      cursorCol: number;
    };
    preferredVisualCol: number | null;
    snappedFromCursorCol: number | null;
  };
  if (!internal.state || typeof internal.state.cursorLine !== "number")
    throw new Error("Unsupported Pi editor cursor layout (tested with Pi 0.85.1 and 0.99.1)");
  internal.state.cursorLine = line;
  internal.state.cursorCol = col;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
}
export function openTranscriptSearch(tui: TUI): void {
  if (tui.mode !== "fullscreen") return;
  const internal = tui as unknown as { activeSearch?: unknown; toggleSearch?: () => void };
  if (typeof internal.toggleSearch !== "function")
    throw new Error("Unsupported Pi transcript search layout (tested with Pi 0.99.1 and 1.4.0)");
  if (!internal.activeSearch) internal.toggleSearch();
}
export function clampOffset(offset: number, length: number): number {
  const offsetOrZero = Number.isNaN(offset) ? 0 : offset;
  return Math.min(length, Math.max(0, offsetOrZero));
}
export function placeCursor(editor: Editor, offset: number, text = editor.getText()): void {
  const end = clampOffset(offset, text.length);
  let line = 0,
    start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  setCursorPosition(editor, line, end - start);
}
export function retainRawText(editor: Editor, text: string): void {
  const internal = editor as unknown as {
    state: {
      lines: string[];
    };
    [invalidateTextCache]?: () => void;
  };
  if (!Array.isArray(internal.state?.lines))
    throw new Error("Unsupported Pi editor text layout (tested with Pi 0.85.1 and 0.99.1)");
  internal.state.lines = text.split("\n");
  internal[invalidateTextCache]?.();
}

export const NEEDS_PROJECTION = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

export function projectDisplay(text: string): {
  text: string;
  offsets: Uint32Array;
  lines: string[];
} {
  let display = "";
  const offsets = new Uint32Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) display += "    ";
    else if (code === 10) display += "\n";
    else if (code < 32) display += String.fromCharCode(0x2400 + code);
    else if (code === 127) display += "␡";
    else if (code >= 128 && code < 160) display += `\\x${code.toString(16)}`;
    else display += text[i];
    offsets[i + 1] = display.length;
  }
  return { text: display, offsets, lines: display.split("\n") };
}

export function renderProjected(
  editor: Editor,
  render: () => string[],
  projection: ReturnType<typeof projectDisplay>,
  offset: number,
): string[] {
  const internal = editor as unknown as {
    state: { lines: string[]; cursorLine: number; cursorCol: number };
    preferredVisualCol: number | null;
  };
  const state = internal.state;
  if (!Array.isArray(state?.lines) || typeof state.cursorLine !== "number") {
    throw new Error(
      "Unsupported Pi editor rendering layout (tested with Pi 0.85.1 and 0.99.1)",
    );
  }
  const saved = { ...state };
  const preferred = internal.preferredVisualCol;
  const col = projection.offsets[offset] - projection.offsets[offset - state.cursorCol];
  state.lines = projection.lines;
  setCursorPosition(editor, state.cursorLine, col);
  try {
    return render();
  } finally {
    Object.assign(state, saved);
    internal.preferredVisualCol = preferred;
  }
}

export function clearBaseUndo(editor: Editor): void {
  const internal = editor as unknown as {
    undoStack: { clear(): void };
    snappedFromCursorCol: number | null;
  };
  if (typeof internal.undoStack?.clear !== "function")
    throw new Error("Unsupported Pi undo layout");
  internal.undoStack.clear();
  internal.snappedFromCursorCol = null;
}
// Also clears the pending debounce timer and aborts an in-flight suggestion request.
export function cancelAutocomplete(editor: Editor): void {
  const internal = editor as unknown as { cancelAutocomplete?: () => void };
  if (typeof internal.cancelAutocomplete !== "function")
    throw new Error("Unsupported Pi autocomplete layout");
  internal.cancelAutocomplete();
}

export type PasteState = { pastes: Map<number, string>; counter: number };
function pasteInternal(editor: Editor) {
  const internal = editor as unknown as {
    pastes: Map<number, string>;
    pasteCounter: number;
  };
  if (!(internal.pastes instanceof Map) || typeof internal.pasteCounter !== "number")
    throw new Error("Unsupported Pi paste registry (tested with Pi 0.85.1 and 0.99.1)");
  return internal;
}
export function readPastes(editor: Editor, text?: string): PasteState {
  const internal = pasteInternal(editor);
  const pastes = new Map(internal.pastes);
  if (text !== undefined && pastes.size) {
    const ids = new Set(pasteMarkers(editor, text).map(match => Number(match[1])));
    if (ids.size < pastes.size) {
      const { killRing } = editor as unknown as { killRing: { ring: string[] } };
      if (!Array.isArray(killRing?.ring)) throw new Error("Unsupported Pi kill ring layout");
      for (const entry of killRing.ring) {
        for (const match of pasteMarkers(editor, entry)) ids.add(Number(match[1]));
        if (ids.size === pastes.size) break;
      }
      for (const id of pastes.keys()) if (!ids.has(id)) pastes.delete(id);
    }
  }
  return { pastes, counter: internal.pasteCounter };
}
export function writePastes(editor: Editor, state: PasteState): void {
  const internal = pasteInternal(editor);
  internal.pastes = new Map(state.pastes);
  internal.pasteCounter = state.counter;
}
const MARKER = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
export function pasteMarkers(editor: Editor, text = editor.getText()): RegExpExecArray[] {
  const { pastes } = pasteInternal(editor);
  if (pastes.size === 0) return [];
  return [...text.matchAll(MARKER)].filter((match) => pastes.has(Number(match[1])));
}
export function expandPastes(editor: Editor, text: string): string {
  const { pastes } = pasteInternal(editor);
  if (pastes.size === 0) return text;
  return text.replace(MARKER,
    (marker, id: string) => pastes.get(Number(id)) ?? marker);
}
const STOCK_PASTE_LINE_LIMIT = 10;
const STOCK_PASTE_CHAR_LIMIT = 1000;
export function collapsePaste(editor: Editor, text: string): string {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
  if (lines <= STOCK_PASTE_LINE_LIMIT && text.length <= STOCK_PASTE_CHAR_LIMIT) return text;
  const internal = pasteInternal(editor);
  let id = internal.pasteCounter + 1;
  const reserved = editor.getText() + text;
  while (internal.pastes.has(id) || reserved.includes(`[paste #${id}`)) id++;
  internal.pasteCounter = id;
  internal.pastes.set(id, text);
  return lines > STOCK_PASTE_LINE_LIMIT ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${text.length} chars]`;
}

export function restoreRawDraft(editor: Editor, text: string, payloads: PasteState): void {
  const vi = viEditor in editor;
  if (!vi && editor.getText() === text) {
    const internal = editor as unknown as { pushUndoSnapshot?: unknown };
    if (typeof internal.pushUndoSnapshot !== "function")
      throw new Error("Unsupported Pi undo layout");
    internal.pushUndoSnapshot();
  }
  editor.setText(vi ? "" : text);
  retainRawText(editor, text);
  writePastes(editor, payloads);
  placeCursor(editor, text.length);
  editor.onChange?.(text);
}

export const viEditor = Symbol.for("pi-interactive:vi-editor");
const singlePassInstalled = Symbol.for("pi-interactive:single-pass-pastes");
export function installSinglePassPasteExpansion(editor: Editor): void {
  if (singlePassInstalled in editor) return;
  // Stock submission expands recursively; use the same single pass as draft reads.
  Object.defineProperty(editor, "expandPasteMarkers", {
    value: (text: string) => expandPastes(editor, text),
  });
  Object.defineProperty(editor, singlePassInstalled, { value: true });
}
export function markViEditor(editor: Editor): void {
  Object.defineProperty(editor, viEditor, { value: true });
  installSinglePassPasteExpansion(editor);
}
