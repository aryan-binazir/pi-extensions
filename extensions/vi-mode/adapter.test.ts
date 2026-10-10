import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { editor, keys } from "./test-support.ts";
import {
  clearBaseUndo,
  collapsePaste,
  expandPastes,
  pasteMarkers,
  placeCursor,
  projectDisplay,
  readPastes,
  retainRawText,
  setCursorPosition,
  writePastes,
} from "./adapter.ts";

const PAYLOAD = "\tpasted line\r\n".repeat(20);

function pasted() {
  const e = editor();
  e.handleInput(`\x1b[200~${PAYLOAD}\x1b[201~`);
  return e;
}

test("setCursorPosition moves the cursor without rewriting the draft", () => {
  const e = editor(CustomEditor);
  e.setText("one\ntwo three");
  setCursorPosition(e, 1, 3);
  assert.deepEqual(e.getCursor(), { line: 1, col: 3 });
  assert.equal(e.getText(), "one\ntwo three");
});

test("setCursorPosition rejects an editor without Pi's cursor layout", () => {
  assert.throws(
    () => setCursorPosition({} as unknown as CustomEditor, 0, 0),
    /Unsupported Pi editor cursor layout/,
  );
});

test("placeCursor turns a draft offset into a line and column", () => {
  const e = editor(CustomEditor);
  e.setText("ab\ncdef\ng");
  placeCursor(e, 0);
  assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
  placeCursor(e, 3);
  assert.deepEqual(e.getCursor(), { line: 1, col: 0 });
  placeCursor(e, 6);
  assert.deepEqual(e.getCursor(), { line: 1, col: 3 });
  placeCursor(e, 8);
  assert.deepEqual(e.getCursor(), { line: 2, col: 0 });
});

test("placeCursor clamps offsets outside the draft, including NaN", () => {
  const e = editor(CustomEditor);
  e.setText("ab\ncd");
  placeCursor(e, 999);
  assert.deepEqual(e.getCursor(), { line: 1, col: 2 });
  placeCursor(e, -10);
  assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
  placeCursor(e, 4);
  placeCursor(e, Number.NaN);
  assert.deepEqual(e.getCursor(), { line: 0, col: 0 }, "a NaN offset means the start, not NaN");
});

test("placeCursor measures the text it is given rather than the live draft", () => {
  const e = editor(CustomEditor);
  e.setText("abcdef");
  placeCursor(e, 5, "ab\ncd\nef");
  assert.deepEqual(e.getCursor(), { line: 1, col: 2 });
});

test("retainRawText keeps bytes setText normalizes and drops the vi text cache", () => {
  const e = editor();
  e.setText("stale draft");
  e.handleInput("\x1b");
  assert.equal(e.getText(), "stale draft");
  retainRawText(e, "raw\ttext\r");
  assert.equal(e.getText(), "raw\ttext\r", "setText would expand the tab and drop the CR");
  keys(e, "0x");
  assert.equal(e.getText(), "aw\ttext\r", "vi edits start from the retained draft, not a cached one");
});

test("retainRawText also serves editors that publish no cache hook", () => {
  const e = editor(CustomEditor);
  e.setText("plain");
  retainRawText(e, "a\rb\tc");
  assert.equal(e.getText(), "a\rb\tc");
});

test("retainRawText rejects an editor without Pi's line layout", () => {
  assert.throws(
    () => retainRawText({} as unknown as CustomEditor, "x"),
    /Unsupported Pi editor text layout/,
  );
});

test("readPastes and writePastes copy the registry between editors", () => {
  const source = pasted();
  const marker = source.getText();
  const state = readPastes(source);
  assert.equal(state.pastes.size, 1);
  assert.ok(state.counter >= 1);

  const target = editor(CustomEditor);
  assert.equal(expandPastes(target, marker), marker, "an empty registry expands nothing");
  writePastes(target, state);
  assert.equal(expandPastes(target, marker), PAYLOAD);
  assert.deepEqual(readPastes(target), state);
});

test("a paste snapshot is detached from the editor it came from", () => {
  const e = pasted();
  const snapshot = readPastes(e);
  e.setText("");
  assert.equal(readPastes(e).pastes.size, 0, "a replaced draft drops its payloads");
  assert.equal(snapshot.pastes.size, 1);
  writePastes(e, snapshot);
  assert.equal(readPastes(e).pastes.size, 1);
});

test("pasteMarkers reports only markers the registry still knows", () => {
  const e = pasted();
  const marker = e.getText();
  const found = pasteMarkers(e);
  assert.equal(found.length, 1);
  assert.equal(found[0][0], marker);
  assert.equal(found[0].index, 0);
  assert.equal(pasteMarkers(e, `head ${marker} tail`)[0].index, 5);
  assert.deepEqual(pasteMarkers(e, "[paste #4242 +9 lines]"), []);
  writePastes(e, { pastes: new Map(), counter: 0 });
  assert.deepEqual(pasteMarkers(e, marker), [], "a cleared registry matches nothing");
});

test("expandPastes replaces a marker once and leaves other text literal", () => {
  const e = editor();
  const payload = "literal [paste #1] [paste #2]\n".repeat(20);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  const marker = e.getText();
  assert.equal(expandPastes(e, marker), payload, "payload markers are not expanded again");
  assert.equal(expandPastes(e, `head ${marker} tail`), `head ${payload} tail`);
  assert.equal(expandPastes(e, "[paste #4242 +9 lines]"), "[paste #4242 +9 lines]");
});

test("collapsePaste collapses only above the stock thresholds", () => {
  const e = editor(CustomEditor);
  const tenLines = "x\n".repeat(9) + "x";
  assert.equal(collapsePaste(e, tenLines), tenLines, "ten lines stay visible");
  assert.equal(collapsePaste(e, "y".repeat(1000)), "y".repeat(1000), "1000 characters stay visible");

  const elevenLines = "x\n".repeat(10) + "x";
  const lineMarker = collapsePaste(e, elevenLines);
  assert.match(lineMarker, /^\[paste #\d+ \+11 lines\]$/);
  assert.equal(expandPastes(e, lineMarker), elevenLines);

  const long = "y".repeat(1001);
  const charMarker = collapsePaste(e, long);
  assert.match(charMarker, /^\[paste #\d+ 1001 chars\]$/);
  assert.equal(expandPastes(e, charMarker), long);
  assert.notEqual(lineMarker, charMarker, "each payload gets its own id");
});

test("collapsePaste never reuses an id the draft or the payload already spells", () => {
  const e = editor(CustomEditor);
  const first = collapsePaste(e, "a\n".repeat(11));
  const id = Number(/#(\d+)/.exec(first)![1]);
  e.setText(first);
  const second = collapsePaste(e, `[paste #${id + 1}]\n`.repeat(11));
  assert.notEqual(second, first);
  assert.ok(Number(/#(\d+)/.exec(second)![1]) > id + 1, "the id claimed by the payload is skipped");
});

test("projectDisplay rewrites control characters and maps offsets back to the raw draft", () => {
  const raw = "a\tb\rc\x7f\x9b\n";
  const { text, offsets } = projectDisplay(raw);
  assert.equal(text, "a    b␍c␡\\x9b\n");
  assert.equal(offsets.length, raw.length + 1);
  assert.equal(offsets[0], 0);
  assert.equal(offsets[1], 1, "plain characters cost one column");
  assert.equal(offsets[2], 5, "a tab becomes four columns");
  assert.equal(text.slice(offsets[3], offsets[4]), "␍");
  assert.equal(offsets.at(-1), text.length);
});

test("projectDisplay leaves safe text and its offsets untouched", () => {
  const raw = "plain\ntext";
  const { text, offsets } = projectDisplay(raw);
  assert.equal(text, raw);
  assert.deepEqual(offsets, Array.from({ length: raw.length + 1 }, (_, i) => i));
});

test("clearBaseUndo drops the base editor's own undo history", () => {
  const e = editor(CustomEditor);
  e.setText("hello");
  e.handleInput("\x7f");
  assert.equal(e.getText(), "hell");
  clearBaseUndo(e);
  e.handleInput("\x1f");
  assert.equal(e.getText(), "hell", "a cleared history cannot restore the previous draft");
});

test("clearBaseUndo rejects an editor without Pi's undo stack", () => {
  assert.throws(
    () => clearBaseUndo({} as unknown as CustomEditor),
    /Unsupported Pi undo layout/,
  );
});

// Pi's loader evaluates every load, including each after /reload, in a fresh jiti without a module cache.
async function loadViMode() {
  const { extensions, errors } = await loadExtensions([fileURLToPath(new URL("./index.ts", import.meta.url))], process.cwd());
  assert.deepEqual(errors, []);
  return extensions[0];
}
// The first copy installs the once-per-process handoff; editors come from the second, as after /reload.
let reloaded: ReturnType<typeof loadViMode> | undefined;
async function reloadedHost() {
  reloaded ??= loadViMode().then(loadViMode);
  const start = (await reloaded).handlers.get("session_start")![0];
  initTheme("dark", false);
  const app = Object.assign(Object.create(InteractiveMode.prototype), {
    keybindings: new KeybindingsManager(),
    editorContainer: { clear() {}, addChild() {} },
    disposeActiveSelector() {},
    ui: {
      terminal: { rows: 30, columns: 80, write() {} },
      requestRender() {},
      setFocus() {},
      getShowHardwareCursor: () => false,
      setShowHardwareCursor() {},
    },
  });
  app.editor = app.defaultEditor = editor(CustomEditor);
  const ui = { setEditorComponent: (factory: unknown) => app.setCustomEditorComponent(factory) };
  return { app, start: () => start({ type: "session_start" }, { hasUI: true, ui } as any) };
}

test("a vi editor from a reloaded module edits the draft the handoff transferred", async () => {
  const h = await reloadedHost();
  h.app.editor.setText("keep this draft\nsecond line");
  h.start();
  const vi = h.app.editor;
  assert.notEqual(vi, h.app.defaultEditor);
  keys(vi, "\x1bggdd");
  assert.equal(vi.getText(), "second line", "vi edits the transferred draft, not a stale empty copy");
  keys(vi, "u");
  assert.equal(vi.getText(), "keep this draft\nsecond line");
});

test("a vi editor from a reloaded module edits the draft an inline dialog restored", async () => {
  const h = await reloadedHost();
  h.start();
  const vi = h.app.editor;
  keys(vi, "Explain this log: ");
  vi.handleInput(`\x1b[200~${Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")}\x1b[201~`);
  vi.handleInput("\x1b");
  const draft = vi.getExpandedText();
  await h.app.showExtensionCustom((_tui: unknown, _theme: unknown, _keys: unknown, done: () => void) => {
    setImmediate(done);
    return { render: () => [], handleInput() {}, invalidate() {} };
  }, { overlay: false });
  assert.equal(vi.getExpandedText(), draft);
  keys(vi, "dd");
  assert.equal(vi.getText(), "");
  keys(vi, "u");
  assert.equal(vi.getExpandedText(), draft, "undo restores the draft rather than a stale empty copy");
});
