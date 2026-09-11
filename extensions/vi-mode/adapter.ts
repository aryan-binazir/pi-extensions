import type { Editor } from "@earendil-works/pi-tui";
// Pi 0.85.1 has public cursor reads but no cursor setter. Keep this coupling here.
export function placeCursor(editor: Editor, offset: number): void {
  const before = editor.getText().slice(0, Math.max(0, offset)).split("\n");
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
  internal.state.cursorLine = before.length - 1;
  internal.state.cursorCol = before.at(-1)!.length;
  internal.preferredVisualCol = null;
  internal.snappedFromCursorCol = null;
}
/** Preserve raw pasted bytes that public setText otherwise normalizes. */
export function retainRawText(editor: Editor, text: string): void {
  const internal = editor as unknown as {
    state: {
      lines: string[];
    };
  };
  if (!Array.isArray(internal.state?.lines))
    throw new Error("Unsupported Pi editor text layout (expected Pi 0.85.1)");
  internal.state.lines = text.split("\n");
}

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
): string[] {
  if (!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(editor.getText())) return render();
  const projection = projectDisplay(editor.getText());
  if (projection.text === editor.getText()) return render();
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
  placeCursor(editor, projection.offsets[offset]);
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
