import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { Editor } from "@earendil-works/pi-tui";
/**
 * Editors that cache `getText()` publish this hook so the adapter can drop the
 * cache when it writes `state.lines` behind the editor's back.
 */
export const invalidateTextCache = Symbol("pi-interactive:vi-text-cache");

// Pi 0.85.1 has public cursor reads but no cursor setter. Keep this coupling here.
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
    throw new Error("Unsupported Pi editor cursor layout (expected Pi 0.85.1)");
  internal.state.cursorLine = line;
  internal.state.cursorCol = col;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
}
/** Counting newlines beats slicing and splitting a draft on every cursor move. */
export function placeCursor(editor: Editor, offset: number, text = editor.getText()): void {
  const end = Math.min(text.length, Math.max(0, offset) || 0);
  let line = 0,
    start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  setCursorPosition(editor, line, end - start);
}
/** Preserve raw pasted bytes that public setText otherwise normalizes. */
export function retainRawText(editor: Editor, text: string): void {
  const internal = editor as unknown as {
    state: {
      lines: string[];
    };
    [invalidateTextCache]?: () => void;
  };
  if (!Array.isArray(internal.state?.lines))
    throw new Error("Unsupported Pi editor text layout (expected Pi 0.85.1)");
  internal.state.lines = text.split("\n");
  internal[invalidateTextCache]?.();
}

/** Characters `projectDisplay` rewrites; anything else projects to itself. */
export const NEEDS_PROJECTION = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

/** Safe terminal text and a UTF-16 offset map back to the unchanged raw draft. */
export function projectDisplay(text: string): {
  text: string;
  offsets: number[];
} {
  let display = "";
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) display += "    ";
    else if (code === 10) display += "\n";
    else if (code < 32) display += String.fromCharCode(0x2400 + code);
    else if (code === 127) display += "␡";
    else if (code >= 128 && code < 160) display += `\\x${code.toString(16)}`;
    else display += text[i];
    offsets.push(display.length);
  }
  return { text: display, offsets };
}

/**
 * Editor rendering assumes normalized display text. Project only for this
 * synchronous render, then restore the byte-preserving draft in finally.
 * Keeping Pi's renderer retains completion lists, scrolling, and cursor markers.
 */
export function renderProjected(
  editor: Editor,
  render: () => string[],
  draft = editor.getText(),
): string[] {
  if (!NEEDS_PROJECTION.test(draft)) return render();
  const projection = projectDisplay(draft);
  if (projection.text === draft) return render();
  const internal = editor as unknown as {
    state: { lines: string[]; cursorLine: number; cursorCol: number };
    preferredVisualCol: number | null;
  };
  const state = internal.state;
  if (!Array.isArray(state?.lines) || typeof state.cursorLine !== "number") {
    throw new Error(
      "Unsupported Pi editor rendering layout (expected Pi 0.85.1)",
    );
  }
  const saved = { ...state };
  const preferred = internal.preferredVisualCol;
  const offset =
    state.lines
      .slice(0, state.cursorLine)
      .reduce((sum, line) => sum + line.length + 1, 0) + state.cursorCol;
  state.lines = projection.text.split("\n");
  placeCursor(editor, projection.offsets[offset], projection.text);
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

export type PasteState = { pastes: Map<number, string>; counter: number };
function pasteInternal(editor: Editor) {
  const internal = editor as unknown as {
    pastes: Map<number, string>;
    pasteCounter: number;
  };
  if (!(internal.pastes instanceof Map) || typeof internal.pasteCounter !== "number")
    throw new Error("Unsupported Pi paste registry (expected Pi 0.85.1)");
  return internal;
}
export function readPastes(editor: Editor): PasteState {
  const internal = pasteInternal(editor);
  return { pastes: new Map(internal.pastes), counter: internal.pasteCounter };
}
export function writePastes(editor: Editor, state: PasteState): void {
  const internal = pasteInternal(editor);
  internal.pastes = new Map(state.pastes);
  internal.pasteCounter = state.counter;
}
const MARKER = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
export function pasteMarkers(editor: Editor, text = editor.getText()): RegExpExecArray[] {
  const { pastes } = pasteInternal(editor);
  // An empty registry can never match, so skip scanning the draft entirely.
  if (pastes.size === 0) return [];
  return [...text.matchAll(MARKER)].filter((match) => pastes.has(Number(match[1])));
}
/** Replace once so marker-shaped text inside a payload remains literal. */
export function expandPastes(editor: Editor, text: string): string {
  const { pastes } = pasteInternal(editor);
  if (pastes.size === 0) return text;
  return text.replace(MARKER,
    (marker, id: string) => pastes.get(Number(id)) ?? marker);
}
/** Stock Pi thresholds/marker format with safe whitespace-preserving payloads. */
export function collapsePaste(editor: Editor, text: string): string {
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
  if (lines <= 10 && text.length <= 1000) return text;
  const internal = pasteInternal(editor);
  let id = internal.pasteCounter + 1;
  const reserved = editor.getText() + text;
  while (internal.pastes.has(id) || reserved.includes(`[paste #${id}`)) id++;
  internal.pasteCounter = id;
  internal.pastes.set(id, text);
  return lines > 10 ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${text.length} chars]`;
}

// Pi 0.85.1 copies getText() without its paste registry before extension shutdown.
// Keep this compatibility fix at that exact runtime boundary, including /reload.
const viEditor = Symbol.for("pi-interactive:vi-editor");
const handoffInstalled = Symbol.for("pi-interactive:editor-handoff");
export function installEditorHandoff(editor?: Editor): void {
  if (editor) {
  Object.defineProperty(editor, viEditor, { value: true });
  // Stock submission expands recursively; use the same single pass as draft reads.
  Object.defineProperty(editor, "expandPasteMarkers", {
    value: (text: string) => expandPastes(editor, text),
  });
  }
  const prototype = InteractiveMode.prototype as unknown as {
    [handoffInstalled]?: boolean;
    setCustomEditorComponent: (factory: unknown) => void;
    showExtensionCustom: (factory: unknown, options?: { overlay?: boolean }) => Promise<unknown>;
  };
  if (prototype[handoffInstalled]) return;
  const original = prototype.setCustomEditorComponent;
  if (typeof original !== "function") throw new Error("Unsupported Pi editor handoff layout");
  prototype.setCustomEditorComponent = function (this: { editor: Editor }, factory: unknown) {
    const source = this.editor;
    if (!((source as unknown as { pastes?: unknown }).pastes instanceof Map)) {
      original.call(this, factory);
      return;
    }
    const text = source.getText();
    const payloads = readPastes(source);
    original.call(this, factory);
    if (!(viEditor in source) && !(viEditor in this.editor) && payloads.pastes.size === 0) return;
    if (!((this.editor as unknown as { pastes?: unknown }).pastes instanceof Map)) {
      this.editor.setText(expandPastes(source, text));
      return;
    }
    // setText resets the destination's history; then restore the exact visible draft.
    if (viEditor in this.editor) {
      this.editor.setText("");
      retainRawText(this.editor, text);
    } else {
      // Stock rendering relies on setText's CRLF/tab normalization.
      this.editor.setText(text);
    }
    writePastes(this.editor, payloads);
    placeCursor(this.editor, this.editor.getText().length);
    if (viEditor in this.editor) this.editor.onChange?.(text);
  };
  // Inline custom UI also restores getText() via setText(), clearing paste data.
  const showCustom = prototype.showExtensionCustom;
  prototype.showExtensionCustom = async function (this: { editor: Editor }, factory, options) {
    const source = this.editor;
    if (options?.overlay || !(viEditor in source))
      return showCustom.call(this, factory, options);
    const text = source.getText();
    const payloads = readPastes(source);
    try {
      return await showCustom.call(this, factory, options);
    } finally {
      // Do not resurrect a draft after a session/editor replacement.
      if (this.editor === source && source.getText() === text) {
        writePastes(source, payloads);
        source.onChange?.(text);
      }
    }
  };
  Object.defineProperty(prototype, handoffInstalled, { value: true });
}
