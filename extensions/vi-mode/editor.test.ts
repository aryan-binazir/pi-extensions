import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import { editor, keys } from "./test-support.ts";
import type { ViEditor } from "./editor.ts";
/** A put must survive a full undo/redo round trip, payloads included. */
function undoRedoRestoresPut(e: ViEditor, before: string) {
  const visible = e.getText(),
    expanded = e.getExpandedText();
  keys(e, "u");
  assert.equal(e.getText(), before);
  keys(e, "\x12");
  assert.equal(e.getText(), visible);
  assert.equal(e.getExpandedText(), expanded);
}
test("mode label stays at the bottom right across widths and modes", () => {
  const e = editor();
  for (const [key, mode] of [["", "INSERT"], ["\x1b", "NORMAL"], ["v", "VISUAL"]]) {
    if (key) e.handleInput(key);
    for (const width of [8, 20, 80]) {
      const border = e.render(width).at(-1)!;
      assert.equal(visibleWidth(border), width);
      assert.ok(border.endsWith(` ${mode} `));
    }
  }
});

test("insert uses a hardware beam without a fake block; normal restores a block", () => {
  const e = editor();
  const tui = (e as unknown as { tui: import("@earendil-works/pi-tui").TUI }).tui;
  const writes: string[] = [];
  tui.terminal.write = (data) => { writes.push(data); };
  assert.equal(tui.getShowHardwareCursor(), true);
  e.focused = true;
  e.setText("hello");
  assert.ok(e.render(40).join("").includes(CURSOR_MARKER));
  assert.ok(!e.render(40).join("").includes("\x1b[7m"));
  e.handleInput("\x1b");
  assert.equal(writes.at(-1), "\x1b[2 q");
  assert.ok(e.render(40).join("").includes(CURSOR_MARKER + "\x1b[7m"));
  e.handleInput("i");
  assert.equal(writes.at(-1), "\x1b[6 q");
  assert.ok(!e.render(40).join("").includes("\x1b[7m"));
  e.dispose();
  assert.equal(tui.getShowHardwareCursor(), false);
  assert.equal(writes.at(-1), "\x1b[0 q");
});

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
  assert.equal(e.getExpandedText(), "draf" + payload + "t");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "draft");
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), "draf" + payload + "t");
});
test("an insert edit is one undo step", () => {
  const e = editor();
  e.setText("alpha beta");
  e.handleInput("\x1b");
  keys(e, "0cw");
  keys(e, "new");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "new beta");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "alpha beta");
});
test("an inner-bracket object takes the innermost pair", () => {
  const e = editor();
  e.setText("x (a (b) c) y");
  e.handleInput("\x1b");
  keys(e, "0wldi(");
  assert.equal(e.getExpandedText(), "x () y");
});
test("a counted dd yanks every deleted line for a later put", () => {
  const e = editor();
  e.setText("one\ntwo\nthree");
  e.handleInput("\x1b");
  keys(e, "gg2dd");
  assert.equal(e.getExpandedText(), "three");
  keys(e, "P");
  assert.equal(e.getExpandedText(), "one\ntwo\nthree");
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
test("unsafe terminal controls are removed before draft display", () => {
  const e = editor();
  const payload = "\x1b[31mred\x07\x9b0m";
  e.handleInput("\x1b[200~" + payload + "\x1b[201~");
  const rendered = e.render(50).join("\n");
  assert.equal(e.getExpandedText(), "[31mred0m");
  assert.ok(rendered.includes("[31mred0m"));
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
test("draft ingestion strips unsafe controls and submission also strips carriage returns", () => {
  const e = editor();
  const raw = "log \x1b]52;c;abc\x07 \x1b[2J\r\nend";
  e.handleInput("\x1b[200~" + raw + "\x1b[201~");
  assert.equal(e.getExpandedText(), "log ]52;c;abc [2J\r\nend");
  let sent = "";
  e.onSubmit = (text) => {
    sent = text;
  };
  e.handleInput("\r");
  assert.equal(sent, "log ]52;c;abc [2J\nend");
});
test("quote objects work and missing objects disarm operators without losing registers", () => {
  const e = editor();
  e.setText('say "hello" now');
  e.handleInput("\x1b");
  keys(e, '0wldi"');
  assert.equal(e.getExpandedText(), 'say "" now');
  e.setText("keep me\nsecond");
  keys(e, 'gg"ayy');
  keys(e, 'di"jw');
  assert.equal(e.getExpandedText(), "keep me\nsecond");
  keys(e, '"ap');
  assert.equal(e.getExpandedText(), "keep me\nsecond\nkeep me");
});
test("unicode word objects and cw edge positions respect word boundaries", () => {
  const e = editor();
  e.setText("café bar");
  e.handleInput("\x1b");
  keys(e, "0diw");
  assert.equal(e.getExpandedText(), " bar");
  e.setText("naïve test");
  keys(e, "0dw");
  assert.equal(e.getExpandedText(), "test");
  e.setText("alpha beta");
  keys(e, "04lcwX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "alphX beta");
  e.setText("alpha beta");
  keys(e, "05lcwX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "alphaXbeta");
});
test("line operators preserve line boundaries and delete the final line completely", () => {
  const e = editor();
  e.setText("one\ntwo\nthree");
  e.handleInput("\x1b");
  keys(e, "2GccX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "one\nX\nthree");
  e.setText("a\nb\nc");
  keys(e, "Gdd");
  assert.equal(e.getExpandedText(), "a\nb");
  keys(e, "dd");
  assert.equal(e.getExpandedText(), "a");
  e.setText("a\nb\nc");
  keys(e, "ggdj");
  assert.equal(e.getExpandedText(), "c");
  e.setText("a\nb\nc");
  keys(e, "ggcjX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "X\nc");
});
test("vertical motions retain preferred column and horizontal motions stay on characters", () => {
  const e = editor();
  e.setText("aaaaaaaa\nb\ncccccccc");
  e.handleInput("\x1b");
  keys(e, "gg$jj");
  assert.deepEqual(e.getCursor(), { line: 2, col: 7 });
  e.setText("ab\ncd");
  keys(e, "gg0lll");
  assert.deepEqual(e.getCursor(), { line: 0, col: 1 });
});
test("dd then p on an empty draft edits nothing", () => {
  const e = editor();
  e.setText("");
  e.handleInput("\x1b");
  keys(e, "ddp");
  assert.equal(e.getExpandedText(), "");
});
test("huge counted motions stop at boundaries and repeated paste remains bounded", () => {
  const e = editor();
  e.setText("a\nb\nc");
  e.handleInput("\x1b");
  keys(e, "gg9999d9999j");
  assert.equal(e.getExpandedText(), "");
  e.setText("x".repeat(2000));
  keys(e, "ggyy9999p");
  assert.equal(e.getExpandedText().length, 2000, "an oversized put is refused outright");
});
test("I inserts at the first non-blank character", () => {
  const e = editor();
  e.setText("  ab");
  e.handleInput("\x1b");
  keys(e, "IZ");
  assert.equal(e.getExpandedText(), "  Zab");
});
test("a paste over a visual selection replaces it", () => {
  const e = editor();
  e.setText("abcdef");
  e.handleInput("\x1b");
  keys(e, "0vll");
  e.handleInput("\x1b[200~X\x1b[201~");
  assert.equal(e.getExpandedText(), "Xdef");
});
test("native undo cannot restore a draft replaced from outside the editor", () => {
  const e = editor();
  e.setText("old");
  e.setText("new");
  e.handleInput("i");
  e.handleInput("\x1f");
  assert.equal(e.getExpandedText(), "new");
  assert.equal(visibleWidth(e.render(50).at(-1)!), 50, "the mode label still fills the border");
});
test("programmatic image-path insertion participates in vi undo", () => {
  const e = editor();
  e.setText("draft");
  e.handleInput("\x1b");
  e.insertTextAtCursor(" /tmp/image.png");
  assert.equal(e.getExpandedText(), "draf /tmp/image.pngt");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "draft");
});
test("an upward delete takes both whole lines", () => {
  const e = editor();
  e.setText("a\nb\nc");
  e.handleInput("\x1b");
  keys(e, "2Gdk");
  assert.equal(e.getExpandedText(), "c");
});
test("a downward yank puts back both whole lines", () => {
  const e = editor();
  e.setText("a\nb\nc");
  e.handleInput("\x1b");
  keys(e, "ggyjGp");
  assert.equal(e.getExpandedText(), "a\nb\nc\na\nb");
});
test("a counted cc replaces every counted line with one", () => {
  const e = editor();
  e.setText("one\ntwo\nthree");
  e.handleInput("\x1b");
  keys(e, "gg2ccX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "X\nthree");
});
test("dd on a trailing empty line keeps the line above", () => {
  const e = editor();
  e.setText("a\n");
  e.handleInput("\x1b");
  keys(e, "Gdd");
  assert.equal(e.getExpandedText(), "a");
});
test("streaming follow-up reads cannot export pasted terminal escape controls", () => {
  const e = editor();
  e.handleInput("\x1b[200~log \x1b]52;c;PAYLOAD\x07\x9b0m\t\r\nend\x1b[201~");
  let queued = "";
  e.onAction("app.message.followUp", () => { queued = e.getExpandedText(); });
  e.handleInput("\x1b\r");
  assert.equal(queued, "log ]52;c;PAYLOAD0m\t\r\nend");
  e.setText("external \x1b[2J\x07");
  assert.equal(e.getExpandedText(), "external [2J");
  e.insertTextAtCursor("\x1b]52;c;X\x07");
  assert.equal(e.getExpandedText(), "external [2J]52;c;X");
});
test("restoring another draft cancels visual and line selections", () => {
  for (const selection of ["v", "V"]) {
    const e = editor();
    e.setText("hello world");
    e.handleInput("\x1b");
    keys(e, "0" + selection + "lll");
    e.setText("short");
    assert.ok(e.render(40).at(-1)!.includes("NORMAL"));
    assert.ok(!e.render(40).join("\n").includes("\x1b[7ms"));
    keys(e, "d");
    assert.equal(e.getExpandedText(), "short");
  }
});
test("r, m and q name registers, and their unsupported command swallows its argument", () => {
  for (const name of ["r", "m", "q"]) {
    const e = editor();
    e.setText("keep me\nsecond");
    e.handleInput("\x1b");
    keys(e, 'gg"' + name + 'yyG"' + name + 'p');
    assert.equal(e.getExpandedText(), "keep me\nsecond\nkeep me");
    for (const argument of ["x", "a"]) {
      e.setText("alpha beta");
      keys(e, "0" + name + argument);
      assert.equal(e.getExpandedText(), "alpha beta", name + argument);
      keys(e, "x");
      assert.equal(e.getExpandedText(), "lpha beta", name + argument);
    }
    e.setText("alpha");
    keys(e, "0" + name);
    e.handleInput("\x1b");
    keys(e, "x");
    assert.equal(e.getExpandedText(), "lpha", "Escape cancels the pending argument");
  }
});
test("refused oversized put preserves the redo history", () => {
  const e = editor();
  e.setText("x".repeat(2000));
  e.handleInput("\x1b");
  keys(e, 'gg"ayyxu"a9999p');
  assert.equal(e.getExpandedText().length, 2000);
  e.handleInput("\x12");
  assert.equal(e.getExpandedText().length, 0); // Redo deletes the entire collapsed marker.
});
test("normal mode and pending vi arguments forward save and stash shortcuts to core and extensions", () => {
  for (const prefix of ["", "di", '"', "r", "vi"]) {
    for (const chord of ["\x13", "\x1b[115;5u", "\x1b[115;6u"]) {
      const e = editor();
      e.setText("keep draft");
      e.handleInput("\x1b");
      keys(e, prefix);
      let forwarded = "";
      e.onExtensionShortcut = (data) => { forwarded = data; return true; };
      e.handleInput(chord);
      assert.equal(forwarded, chord);
      assert.equal(e.getExpandedText(), "keep draft");
    }
  }
});
test("submitting a draft clears vi undo and insertion history", () => {
  for (const insert of [false, true]) {
    const e = editor();
    let sent = "";
    e.onSubmit = (text) => { sent = text; };
    keys(e, "first draft");
    e.handleInput("\x1b");
    keys(e, "0x");
    if (insert) keys(e, "i");
    e.handleInput("\r");
    assert.equal(sent, "irst draft");
    if (insert) e.handleInput("\x1b");
    keys(e, "u");
    assert.equal(e.getExpandedText(), "");
    e.handleInput("\x12");
    assert.equal(e.getExpandedText(), "");
  }
});
test("leaving insert mode places the normal cursor on the preceding grapheme", () => {
  const e = editor();
  keys(e, "abc");
  e.handleInput("\x1b");
  keys(e, "x");
  assert.equal(e.getExpandedText(), "ab");
  e.setText("old tail");
  keys(e, "0cwnew");
  e.handleInput("\x1b");
  keys(e, "x");
  assert.equal(e.getExpandedText(), "ne tail");
  e.setText("😀");
  keys(e, "A");
  e.handleInput("\x1b");
  keys(e, "x");
  assert.equal(e.getExpandedText(), "");
});
test("visual register puts replace selection and leave normal mode", () => {
  for (const put of ["p", "P"]) {
    const e = editor();
    e.setText("abc def");
    e.handleInput("\x1b");
    keys(e, "0yiwwvl" + put);
    assert.equal(e.getExpandedText(), "abc abcf");
    assert.ok(e.render(40).at(-1)!.includes("NORMAL"));
    keys(e, "u");
    assert.equal(e.getExpandedText(), "abc def");
  }
});

test("collapsed markers are atomic for motions, objects, visual edits, registers and undo", () => {
  const e = editor();
  const payload = "\t😀\r\npayload\rtext\n".repeat(100);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  const marker = e.getText();
  assert.match(marker, /^\[paste #\d+ \+\d+ lines\]$/);
  e.handleInput("z");
  e.handleInput("\x1b");
  keys(e, "0l");
  assert.equal(e.getCursor().col, marker.length);
  keys(e, "h");
  assert.equal(e.getCursor().col, 0);
  keys(e, 'v"ay');
  keys(e, "v");
  const rendered = e.render(12).join("");
  for (const char of marker) assert.ok(rendered.includes(`\x1b[7m${char}\x1b[0m`));
  keys(e, "x");
  assert.equal(e.getExpandedText(), "z");
  keys(e, "u");
  assert.equal(e.getText(), marker + "z");
  assert.equal(e.getExpandedText(), payload + "z");
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), "z");
  keys(e, '"aP');
  assert.equal(e.getExpandedText(), payload + "z");
  keys(e, "0di[");
  assert.equal(e.getExpandedText(), "z", "objects cannot leave a partial marker");
  keys(e, "u");
  assert.equal(e.getExpandedText(), payload + "z");
});

test("insert backspace and undo keep multiple collapsed payloads and IDs intact", () => {
  const e = editor();
  const first = "first\t\r\n".repeat(100), second = "second\n".repeat(100);
  e.handleInput(`\x1b[200~${first}\x1b[201~`);
  e.handleInput(`\x1b[200~${second}\x1b[201~`);
  const markers = e.getText();
  e.handleInput("\x7f");
  assert.equal(e.getExpandedText(), first);
  e.handleInput("\x1b");
  keys(e, "u");
  assert.equal(e.getText(), markers);
  assert.equal(e.getExpandedText(), first + second);
  e.handleInput("\x12");
  assert.equal(e.getExpandedText(), first);
  keys(e, "a");
  e.handleInput(`\x1b[200~${second}\x1b[201~`);
  assert.equal(e.getExpandedText(), first + second);
});

test("replacement collapses safe payloads, clears old history, and marker-like payload text stays literal", () => {
  const e = editor();
  const payload = "literal [paste #1] [paste #2]\t\r\n".repeat(100);
  e.setText(payload + "\x1b\x9b\x00");
  assert.match(e.getText(), /^\[paste #/);
  assert.equal(e.getExpandedText(), payload);
  const restored = editor();
  restored.setText(e.getExpandedText());
  assert.match(restored.getText(), /^\[paste #/);
  assert.equal(restored.getExpandedText(), payload);
  e.handleInput("\x1b");
  keys(e, "0x");
  e.setText("replacement");
  keys(e, "u");
  assert.equal(e.getExpandedText(), "replacement");
});

test("native forward delete and visual objects cannot split collapsed markers", () => {
  const first = "first\n".repeat(100), second = "second\n".repeat(100);
  const e = editor();
  e.handleInput(`\x1b[200~${first}\x1b[201~`);
  e.handleInput(`\x1b[200~${second}\x1b[201~`);
  e.handleInput("\x1b[H"); // Native Home reaches the first marker boundary.
  e.handleInput("\x1b[3~"); // Native Delete uses Pi's marker-aware segmenter.
  assert.equal(e.getExpandedText(), second);
  e.handleInput("\x1b");
  keys(e, "u");
  assert.equal(e.getExpandedText(), first + second);
  keys(e, "0vi[x");
  assert.equal(e.getExpandedText(), second);
  keys(e, "u");
  assert.equal(e.getExpandedText(), first + second);
});

test("submission expands once, preserves literal marker-shaped payloads and uses core trimming", () => {
  const e = editor();
  const first = " first\n".repeat(100), second = "literal [paste #1]\n".repeat(100);
  e.handleInput(`\x1b[200~${first}\x1b[201~`);
  e.handleInput(`\x1b[200~${second}\x1b[201~`);
  let submitted = "";
  e.onSubmit = (text) => { submitted = text; };
  e.handleInput("\r");
  assert.equal(submitted, (first + second).trim());
  assert.equal(e.getExpandedText(), "");
});

test("native editing in normal and pending modes participates in vi undo and redo", () => {
  const payload = "synthetic\n".repeat(100);
  for (const pending of ["", "di", '"', "r", "v", "V"])
    for (const [position, input] of [["0", "\x1b[3~"], ["0", "\x17"]]) {
      const e = editor();
      e.setText(payload);
      keys(e, "\x1b" + position + pending);
      if (input === "\x17") e.handleInput("\x1b[F");
      e.handleInput(input);
      assert.equal(e.getExpandedText(), "", `${pending} native edit`);
      e.handleInput("u");
      assert.equal(e.getExpandedText(), payload, `${pending} native undo`);
      e.handleInput("\x12");
      assert.equal(e.getExpandedText(), "");
    }
});

test("Kitty printables execute vi commands and encoded paste controls decode before filtering", () => {
  for (const input of ["\x1b[68;2u", "\x1b[100:68;2u"]) {
    const e = editor(); e.setText("alpha beta"); keys(e, "\x1b0");
    e.handleInput(input); assert.equal(e.getText(), "");
  }
  const e = editor(); e.setText("alpha\nbeta"); keys(e, "\x1bgg0");
  e.handleInput("\x1b[100u"); e.handleInput("\x1b[100u");
  assert.equal(e.getText(), "beta");
  e.setText("");
  e.handleInput("\x1b[200~one\x1b[106;5utwo\x1b[105;5uend\x1b[97;5u\x1b[201~");
  assert.equal(e.getExpandedText(), "one\ntwo\tend");
});

test("unsupported g commands consume their argument without editing", () => {
  for (const command of ["gD", "gC", "gx", "go", "gP", "gd", "gq"]) {
    const e = editor(); e.setText("alpha beta"); keys(e, "\x1b0" + command);
    assert.equal(e.getText(), "alpha beta", command);
    keys(e, "x"); assert.equal(e.getText(), "lpha beta", command + " is cancelled");
  }
});

test("confirming a slash completion submits the completed command", async () => {
  const e = editor();
  e.setAutocompleteProvider({
    async getSuggestions(lines, line, col) {
      const prefix = lines[line].slice(0, col);
      return prefix.startsWith("/") ? {prefix, items: [{value: "/btw", label: "/btw"}]} : null;
    },
    applyCompletion(lines, line, _col, item) {
      const next = [...lines]; next[line] = item.value + " ";
      return {lines: next, cursorLine: line, cursorCol: next[line].length};
    },
  });
  let sent = ""; e.onSubmit = text => { sent = text; };
  keys(e, "/bt");
  const deadline = Date.now() + 3000;
  while (!e.isShowingAutocomplete() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(e.isShowingAutocomplete(), true);
  e.handleInput("\r"); assert.equal(sent, "/btw");
});

for (const [command, before, after, expanded] of [
  ["ggp", "a\nb", "a\nMARKER\nb", "a\nPAYLOAD\nb"],
  ["GP", "a\nb", "a\nMARKER\nb", "a\nPAYLOAD\nb"],
  ["Gp", "a\nb", "a\nb\nMARKER", "a\nb\nPAYLOAD"],
  ["ggP", "a\nb", "MARKER\na\nb", "PAYLOAD\na\nb"],
]) test(`linewise collapsed put keeps its boundary: ${command}`, () => {
  const e = editor(), payload = "payload\n".repeat(30);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  keys(e, '\x1b0yy');
  e.setText(before);
  keys(e, command);
  assert.equal(e.getText().replace(/\[paste #[^\]]+\]/g, "MARKER"), after);
  assert.equal(e.getExpandedText(), expanded.replace("PAYLOAD", payload.slice(0, -1)));
  assert.deepEqual(e.getCursor(), { line: command === "Gp" ? 2 : command === "ggP" ? 0 : 1, col: 0 });
  undoRedoRestoresPut(e, before);
  keys(e, "dd");
  assert.equal(e.getExpandedText(), before);
});

test("linewise P separates two collapsed payloads", () => {
  const e = editor(), payload = "payload\n".repeat(30);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  keys(e, '\x1b0yyP');
  assert.match(e.getText(), /^\[paste #[^\]]+\]\n\[paste #[^\]]+\]$/);
  assert.equal(e.getExpandedText(), payload + payload);
  keys(e, "dd"); assert.equal(e.getExpandedText(), payload);
});

for (const [command, after, expanded] of [
  ["ggVp", "MARKER\nb", "PAYLOAD\nb"],
  ["gglvp", "a\nMARKER\nz\nb", "a\nPAYLOAD\nz\nb"],
]) test(`visual collapsed put keeps its boundaries: ${command}`, () => {
  const e = editor(), payload = "payload\n".repeat(30), before = "axz\nb";
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  keys(e, '\x1b0yy'); e.setText(before);
  keys(e, command);
  assert.equal(e.getText().replace(/\[paste #[^\]]+\]/g, "MARKER"), after);
  assert.equal(e.getExpandedText(), expanded.replace("PAYLOAD", payload.slice(0, -1)));
  assert.deepEqual(e.getCursor(), { line: command === "ggVp" ? 0 : 1, col: 0 });
  undoRedoRestoresPut(e, before);
  keys(e, "dd"); assert.equal(e.getText(), command === "ggVp" ? "b" : "a\nz\nb");
});

for (const visual of ["v", "V"]) {
  for (const redo of [false, true]) test(`history returns ${visual} to normal on ${redo ? "redo" : "undo"}`, () => {
    const e = editor(); e.setText("abc\ndef"); keys(e, "\x1b0x");
    if (redo) keys(e, "u");
    keys(e, "gg" + visual + "G" + (redo ? "\x12" : "u"));
    const restored = redo ? "abc\nef" : "abc\ndef";
    assert.equal(e.getText(), restored);
    assert.ok(e.render(40).at(-1)!.endsWith(" NORMAL "));
    keys(e, "d"); assert.equal(e.getText(), restored, "d waits for a motion");
    keys(e, "d"); assert.equal(e.getText(), "abc");
  });
  for (const history of ["u", "\x12"]) test(`empty history cancels ${visual} selection for ${JSON.stringify(history)}`, () => {
    const e = editor(); e.setText("abc"); keys(e, "\x1b0" + visual + "l" + history);
    assert.ok(e.render(40).at(-1)!.endsWith(" NORMAL "));
    keys(e, "d"); assert.equal(e.getText(), "abc");
  });
}

test("undo cancels pending operators and counts", () => {
  for (const pending of ["2d", "di", "g"]) {
    const e = editor(); e.setText("one two three"); keys(e, "\x1b0x" + pending + "u");
    assert.ok(e.render(40).at(-1)!.endsWith(" NORMAL "));
    keys(e, "w"); assert.equal(e.getText(), "one two three");
    assert.deepEqual(e.getCursor(), { line: 0, col: 4 });
  }
});

for (const change of ["C", "cc"]) {
  for (const before of ["", "a\n", "a\n\nb"]) test(`${change} inserts on an empty line in ${JSON.stringify(before)}`, () => {
    const e = editor(); e.setText(before); keys(e, "\x1b" + (before === "a\n\nb" ? "2G" : "G"));
    const cursor = e.getCursor();
    keys(e, change);
    assert.ok(e.render(40).at(-1)!.endsWith(" INSERT "));
    assert.deepEqual(e.getCursor(), cursor);
    keys(e, "X\x1b");
    assert.equal(e.getText(), before === "a\n\nb" ? "a\nX\nb" : before + "X");
    keys(e, "u"); assert.equal(e.getText(), before);
    keys(e, "\x12"); assert.ok(e.getText().includes("X"));
  });
  test(`empty ${change} preserves registers and adds no undo entry`, () => {
    const e = editor(); e.setText("a\nx"); keys(e, "\x1bGxggyyG" + change + "\x1b");
    keys(e, "u"); assert.equal(e.getText(), "a\nx");
    keys(e, "p"); assert.equal(e.getText(), "a\nx\na");
  });
}

for (const [position, motion] of [["G", "j"], ["gg", "k"]]) {
  for (const op of ["d", "c", "y"]) test(`failed ${op}${motion} preserves draft, cursor and register`, () => {
    const e = editor(); e.setText("a\nb\nc"); keys(e, "\x1b2Gyy" + position);
    const cursor = e.getCursor(); keys(e, op + motion);
    assert.equal(e.getText(), "a\nb\nc");
    assert.deepEqual(e.getCursor(), cursor);
    assert.ok(e.render(40).at(-1)!.endsWith(" NORMAL "));
    keys(e, "p");
    assert.equal(e.getText(), position === "G" ? "a\nb\nc\nb" : "a\nb\nb\nc");
  });
}

test("failed vertical deletion adds no history and compares lines rather than columns", () => {
  const e = editor(); e.setText("aaaa\nbbb"); keys(e, "\x1bgg$j");
  e.handleInput("\x1b[D");
  const cursor = e.getCursor(); keys(e, "dj");
  assert.equal(e.getText(), "aaaa\nbbb");
  assert.deepEqual(e.getCursor(), cursor);
  keys(e, "xdj"); assert.equal(e.getText(), "aaaa\nbb");
  keys(e, "u"); assert.equal(e.getText(), "aaaa\nbbb");
});

test("vertical operator rejection preserves valid line and counted motions", () => {
  for (const [command, expected] of [["GdG", "a\nb"], ["ggdgg", "b\nc"], ["gg99dj", ""], ["G99dk", ""]]) {
    const e = editor(); e.setText("a\nb\nc"); keys(e, "\x1b" + command);
    assert.equal(e.getText(), expected, command);
  }
  for (const command of ["dj", "dk", "cj", "ck"]) {
    const e = editor(); e.setText("x"); keys(e, "\x1b" + command);
    assert.equal(e.getText(), "x", command);
    assert.ok(e.render(40).at(-1)!.endsWith(" NORMAL "), command);
  }
});

test("word motions give every ASCII character the unicode rules' class", () => {
  const word = /[\p{L}\p{N}\p{M}_]/u;
  for (let code = 33; code < 127; code++) {
    const c = String.fromCharCode(code);
    const e = editor();
    // In "a<c>a b" the first w lands on c when c is punctuation and on b when
    // c keeps the run a word, which reads the class straight off the cursor.
    e.setText(`a${c}a b`);
    keys(e, "\x1b0w");
    assert.equal(e.getCursor().col, word.test(c) ? 4 : 1, `w over ${JSON.stringify(c)}`);
  }
  const e = editor();
  e.setText("one_two three-four");
  keys(e, "\x1b0w");
  assert.equal(e.getCursor().col, 8, "underscore keeps a word together");
  keys(e, "w");
  assert.equal(e.getCursor().col, 13, "a hyphen is its own punctuation word");
});

test("cursor placement stays exact across a long multi-line draft", () => {
  const e = editor();
  // insertTextAtCursor keeps the draft raw where setText would collapse it.
  const draft = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(i)}`).join("\n");
  e.insertTextAtCursor(draft);
  keys(e, "\x1bgg");
  assert.deepEqual(e.getCursor(), { line: 0, col: 0 });
  keys(e, "G");
  assert.deepEqual(e.getCursor(), { line: 39, col: 0 });
  keys(e, "$");
  assert.deepEqual(e.getCursor(), { line: 39, col: "line 39 ".length + 38 });
  keys(e, "20G");
  assert.deepEqual(e.getCursor(), { line: 19, col: 0 });
  keys(e, "$hh");
  assert.deepEqual(e.getCursor(), { line: 19, col: "line 19 ".length + 16 });
  assert.equal(e.getText(), draft, "motions never rewrite the draft");
});

test("gg, ^ and I land on the first non-blank of an indented line", () => {
  const e = editor();
  e.setText("    alpha\n\t beta\n\n   gamma");
  keys(e, "\x1bgg");
  assert.deepEqual(e.getCursor(), { line: 0, col: 4 });
  keys(e, "3G^");
  assert.deepEqual(e.getCursor(), { line: 2, col: 0 }, "a blank line has no non-blank");
  keys(e, "4G$^");
  assert.deepEqual(e.getCursor(), { line: 3, col: 3 });
  keys(e, "2G$I");
  assert.deepEqual(e.getCursor(), { line: 1, col: 2 }, "a tab counts as one blank");
});

test("visual highlighting wraps each selected character on its own", () => {
  const e = editor();
  e.setText("abcdef");
  keys(e, "\x1b0vll");
  const painted = e.render(40).join("\n");
  assert.ok(painted.includes("\x1b[7ma\x1b[0m\x1b[7mb\x1b[0m\x1b[7mc\x1b[0m"));
  assert.ok(!painted.includes("\x1b[7mabc\x1b[0m"));
  e.setText("héllo wörld");
  keys(e, "\x1b0vl");
  assert.ok(e.render(40).join("\n").includes("\x1b[7mh\x1b[0m\x1b[7mé\x1b[0m"));
});

test("visual rows reproduce the draft in order at every width", () => {
  for (const draft of ["abcdefghij", "ab\ncdef\n\nghi", "x".repeat(37) + "\nyz"]) {
    for (const width of [5, 8, 13, 40]) {
      const e = editor();
      e.insertTextAtCursor(draft);
      e.focused = false;
      keys(e, "\x1bggv");
      const rows = e
        .render(width)
        .slice(1, -1)
        .map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").trim());
      const where = `${JSON.stringify(draft)} @ ${width}`;
      for (const row of rows) assert.ok(visibleWidth(row) <= width, where);
      assert.ok(draft.replace(/\n/g, "").startsWith(rows.join("")), where);
      assert.ok(rows.join("").length > 0, where);
    }
  }
});

test("paste markers stay atomic for operators and backspace", () => {
  const e = editor();
  e.handleInput("\x1b[200~" + "payload\n".repeat(12) + "\x1b[201~");
  const marker = e.getText();
  assert.match(marker, /^\[paste #\d+ \+\d+ lines\]$/);
  e.handleInput("\x1b");
  keys(e, "0lx");
  assert.equal(e.getText(), "", "x inside a marker removes the whole marker");
  keys(e, "u");
  assert.equal(e.getText(), marker);
  keys(e, "A");
  e.handleInput("\x7f");
  assert.equal(e.getText(), "", "backspace at the marker end removes the whole marker");
});
