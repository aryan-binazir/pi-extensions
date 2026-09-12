import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import { editor } from "./test-support.ts";
import type { ViEditor } from "./editor.ts";
function keys(e: ViEditor, input: string) {
  for (const k of input) e.handleInput(k);
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
test("unsupported multi-key commands cannot reinterpret their argument destructively", () => {
  for (const command of ["rx", "ra", "ma", "qa"]) {
    const e = editor();
    e.setText("alpha beta");
    e.handleInput("\x1b");
    keys(e, "0" + command);
    assert.equal(e.getExpandedText(), "alpha beta");
    keys(e, "x");
    assert.equal(e.getExpandedText(), "lpha beta");
  }
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
  e.setText("");
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
  assert.ok(e.getExpandedText().length <= 1024 * 1024);
});
test("I uses first nonblank, visual paste replaces selection and native undo cannot restore another draft", () => {
  const e = editor();
  e.setText("  ab");
  e.handleInput("\x1b");
  keys(e, "IZ");
  assert.equal(e.getExpandedText(), "  Zab");
  e.handleInput("\x1b");
  e.setText("abcdef");
  keys(e, "0vll");
  e.handleInput("\x1b[200~X\x1b[201~");
  assert.equal(e.getExpandedText(), "Xdef");
  e.setText("new");
  e.handleInput("i");
  e.handleInput("\x1f");
  assert.equal(e.getExpandedText(), "new");
  assert.ok(!e.render(50).at(-1)!.includes("..."));
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
test("up/down yanks and counted line changes include complete lines without losing an empty final line", () => {
  const e = editor();
  e.setText("a\nb\nc");
  e.handleInput("\x1b");
  keys(e, "2Gdk");
  assert.equal(e.getExpandedText(), "c");
  e.setText("a\nb\nc");
  keys(e, "ggyjGp");
  assert.equal(e.getExpandedText(), "a\nb\nc\na\nb");
  e.setText("one\ntwo\nthree");
  keys(e, "gg2ccX");
  e.handleInput("\x1b");
  assert.equal(e.getExpandedText(), "X\nthree");
  e.setText("a\n");
  keys(e, "Gdd");
  assert.equal(e.getExpandedText(), "a");
});
test("streaming follow-up reads cannot export pasted terminal escape controls", () => {
  for (const normal of [false, true]) {
    const e = editor();
    if (normal) e.handleInput("\x1b");
    e.handleInput("\x1b[200~log \x1b]52;c;PAYLOAD\x07\x9b0m\t\r\nend\x1b[201~");
    let queued = "";
    e.onAction("app.message.followUp", () => { queued = e.getExpandedText(); });
    e.handleInput("\x1b\r");
    assert.equal(queued, "log ]52;c;PAYLOAD0m\t\r\nend");
    e.setText("external \x1b[2J\x07");
    assert.equal(e.getExpandedText(), "external [2J");
    e.insertTextAtCursor("\x1b]52;c;X\x07");
    assert.equal(e.getExpandedText(), "external [2J]52;c;X");
  }
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
test("named r m q registers work and Escape cancels unsupported command arguments", () => {
  for (const name of ["r", "m", "q"]) {
    const e = editor();
    e.setText("keep me\nsecond");
    e.handleInput("\x1b");
    keys(e, 'gg"' + name + 'yyG"' + name + 'p');
    assert.equal(e.getExpandedText(), "keep me\nsecond\nkeep me");
    e.setText("alpha");
    keys(e, "0" + name);
    e.handleInput("\x1b");
    keys(e, "x");
    assert.equal(e.getExpandedText(), "lpha");
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
test("pending vi arguments forward save and stash shortcuts to core and extensions", () => {
  for (const prefix of ["di", '"', "r", "vi"]) {
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
  keys(e, "/bt"); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(e.isShowingAutocomplete(), true);
  e.handleInput("\r"); assert.equal(sent, "/btw");
});
