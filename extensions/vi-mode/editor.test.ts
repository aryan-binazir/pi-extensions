import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import { editor } from "./test-support.ts";
import type { ViEditor } from "./editor.ts";
function keys(e: ViEditor, input: string) {
  for (const k of input) e.handleInput(k);
}
test("normal counted operator deletes two words and undo/redo restores changes", () => {
  const e = editor();
  e.setText("one two three");
  e.handleInput("\x1b");
  keys(e, "02dw");
  assert.equal(e.getExpandedText(), "three");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "one two three");
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), "three");
});
test("visual selection, named registers and text objects operate on selected text", () => {
  const e = editor();
  e.setText("say (hello world) now");
  e.handleInput("\x1b");
  keys(e, '0wl"ayiw');
  keys(e, "di(");
  assert.equal(e.getExpandedText(), "say () now");
  keys(e, '"aP');
  assert.equal(e.getExpandedText(), "say (hello) now");
  e.setText("abc xyz");
  keys(e, "0vllx");
  assert.equal(e.getExpandedText(), " xyz");
  e.setText("one\ntwo\nthree");
  keys(e, "ggVjd");
  assert.equal(e.getExpandedText(), "three");
});
test("bracketed paste is one undo transaction and never interpreted as vi commands", () => {
  const e = editor();
  e.setText("draft");
  e.handleInput("\x1b");
  const payload = "i".repeat(5000) + "\nhello";
  e.handleInput("\x1b[200~" + payload.slice(0, 80));
  e.handleInput(payload.slice(80) + "\x1b[201~");
  assert.equal(e.getExpandedText(), "draft" + payload);
  keys(e, "u");
  assert.equal(e.getExpandedText(), "draft");
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), "draft" + payload);
});
test("insert edits, nested objects, and counted line changes preserve cursor and undo", () => {
  const e = editor();
  e.setText("alpha beta");
  e.handleInput("\x1b");
  keys(e, "0cw");
  keys(e, "new");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "new beta");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "alpha beta");
  e.setText("x (a (b) c) y");
  keys(e, "0wldi(");
  assert.equal(e.getExpandedText(), "x () y");
  e.setText("one\ntwo\nthree");
  keys(e, "gg2dd");
  assert.equal(e.getExpandedText(), "three");
  keys(e, "P");
  assert.equal(e.getExpandedText(), "one\ntwo\nthree");
});
test("visual rendering highlights the selected characters and normal forwards application shortcuts", () => {
  const e = editor();
  e.setText("abcd");
  e.handleInput("\x1b");
  keys(e, "0vl");
  assert.match(e.render(40).join("\n"), /\x1b\[7ma\x1b\[0m\x1b\[7mb/);
  e.handleInput("\x1b");
  let handled = false;
  e.onExtensionShortcut = () => {
    handled = true;
    return true;
  };
  e.handleInput("\x1b[83;6u");
  assert.equal(handled, true);
});
test("paste preserves tabs, CRLF, unicode, and split terminators as one edit", () => {
  const e = editor();
  e.handleInput("\x1b");
  const payload = "\t😀\r\nraw\rtext";
  e.handleInput("\x1b[200~" + payload + "\x1b[20");
  e.handleInput("1~");
  assert.equal(e.getExpandedText(), payload);
  keys(e, "u");
  assert.equal(e.getExpandedText(), "");
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), payload);
});
test("grapheme motions and deletion never split an emoji and external drafts reset undo", () => {
  const e = editor();
  e.setText("😀x");
  e.handleInput("\x1b");
  keys(e, "0lx");
  assert.equal(e.getExpandedText(), "😀");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "😀x");
  e.setText("new draft");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "new draft");
});
test("split opening marker and lifecycle disposal do not leak an unfinished paste", () => {
  const e = editor();
  e.handleInput("\x1b[20");
  e.handleInput("0~payload\x1b[201~");
  assert.equal(e.getExpandedText(), "payload");
  e.handleInput("\x1b[200~unfinished");
  e.dispose();
  e.setText("next");
  e.handleInput("!");
  assert.equal(e.getExpandedText(), "next!");
});
test("raw tabs and carriage returns render safely in insert, normal and wrapped visual selection", () => {
  const e = editor();
  const payload = "abc\t😀\rZ";
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  e.focused = true;
  for (const mode of ["insert", "normal", "visual"]) {
    if (mode === "normal") e.handleInput("\x1b");
    if (mode === "visual") keys(e, "0v$l");
    const rendered = e.render(8);
    assert.equal(
      e.getExpandedText(),
      payload,
      "rendering must not mutate the payload",
    );
    assert.ok(
      rendered.every((line) => !line.includes("\t") && !line.includes("\r")),
    );
    assert.ok(
      rendered.every((line) => visibleWidth(line) <= 8),
      "every wrapped row fits the terminal",
    );
    assert.ok(
      rendered.join("\n").includes("␍"),
      "CR has a visible, non-control representation",
    );
  }
  const selected = e.render(8).join("\n");
  assert.match(selected, /(?:\x1b\[7m \x1b\[0m){4}/);
});
test("display projection maps raw cursor positions and restores state when rendering fails", () => {
  const e = editor();
  e.setText("a\t😀\rZ");
  e.focused = true;
  e.handleInput("\x1b");
  keys(e, "0ll");
  const rawCursor = e.getCursor();
  const row = e.render(30).find((line) => line.includes(CURSOR_MARKER))!;
  assert.equal(visibleWidth(row.split(CURSOR_MARKER)[0]), 5);
  assert.deepEqual(e.getCursor(), rawCursor);
  assert.equal(e.getExpandedText(), "a\t😀\rZ");
  e.borderColor = () => {
    throw new Error("render failed");
  };
  assert.throws(() => e.render(30), /render failed/);
  assert.equal(e.getExpandedText(), "a\t😀\rZ");
  assert.deepEqual(e.getCursor(), rawCursor);
});
test("raw terminal controls in a paste display as symbols rather than escape instructions", () => {
  const e = editor();
  const payload = "\x1b[31mred\x07\x9b0m";
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  const rendered = e.render(50).join("\n");
  assert.equal(e.getExpandedText(), payload);
  assert.ok(rendered.includes("␛[31mred␇\\x9b0m"));
  assert.ok(!rendered.includes("\x1b[31m"));
});
test("end-of-line deletion and character selection preserve whole graphemes", () => {
  const e = editor();
  e.setText("ab😀");
  e.handleInput("\x1b");
  keys(e, "$x");
  assert.equal(e.getExpandedText(), "ab");
  e.setText("😀tail");
  keys(e, "0vd");
  assert.equal(e.getExpandedText(), "tail");
});
test("counts on G and gg jump to the requested logical line", () => {
  const e = editor();
  e.setText("one\ntwo\nthree\nfour");
  e.handleInput("\x1b");
  keys(e, "2G");
  assert.deepEqual(e.getCursor(), { line: 1, col: 0 });
  keys(e, "3gg");
  assert.deepEqual(e.getCursor(), { line: 2, col: 0 });
  keys(e, "G");
  assert.deepEqual(e.getCursor(), { line: 3, col: 0 });
  keys(e, "gg");
  assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
});
