import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { ViEditor } from "../vi-mode/editor.ts";
import { stashHost } from "./test-support.ts";

for (const EditorClass of [CustomEditor, ViEditor]) {
  test(`${EditorClass.name}: editor Ctrl+S stashes, restores, swaps collapsed pastes and clears on reload`, () => {
    const h = stashHost(EditorClass);
    const payload = "long pasted payload\n".repeat(1000);
    h.editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
    h.editor.handleInput("\x13");
    assert.equal(h.editor.getExpandedText(), "");
    assert.match(h.status!, /stash/i);
    // Reinstantiate the installed composing factory, as Pi does on replacement.
    h.ctx.ui.setEditorComponent(h.ctx.ui.getEditorComponent());
    h.editor.setText("second draft");
    h.editor.handleInput("\x13");
    assert.equal(h.editor.getExpandedText(), payload);
    assert.match(h.editor.getText(), /^\[paste #\d+/);
    assert.ok(h.editor.getText().length < 100);
    h.editor.handleInput("\x13");
    assert.equal(h.editor.getExpandedText(), "second draft");
    h.emit("session_shutdown");
    h.emit("session_start"); h.emit("resources_discover");
    h.editor.setText(""); h.editor.handleInput("\x13");
    assert.equal(h.editor.getExpandedText(), "");
    assert.equal(h.status, undefined);
    h.emit("session_shutdown");
  });
}

test("legacy and Kitty editor input stashes raw vi whitespace; other keys delegate", () => {
  const h = stashHost(ViEditor);
  const payload = "\t😀\r\nraw\rpayload";
  h.editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
  try {
    for (const kitty of [false, true]) {
      setKittyProtocolActive(kitty);
      h.editor.handleInput("\x13"); assert.equal(h.editor.getExpandedText(), "");
      h.editor.handleInput("\x13"); assert.equal(h.editor.getExpandedText(), payload);
    }
    setKittyProtocolActive(true);
    h.editor.handleInput("\x1b[115;6u"); assert.equal(h.editor.getExpandedText(), payload);
    h.editor.handleInput("\x1b[115;5u"); assert.equal(h.editor.getExpandedText(), "");
    h.editor.handleInput("\x1b[115;5u"); assert.equal(h.editor.getExpandedText(), payload);
    h.editor.setText(""); h.editor.handleInput("abc"); assert.equal(h.editor.getText(), "abc");
    let submitted = ""; h.editor.onSubmit = text => { submitted = text; };
    h.editor.handleInput("\r"); assert.equal(submitted, "abc");
  } finally { setKittyProtocolActive(false); h.emit("session_shutdown"); }
});

for (const payload of ["draft\x1b[201~suffix", "draft\x1b[200~\x01\x07suffix"]) {
  test(`stash preserves literal stock control bytes in ${JSON.stringify(payload)}`, () => {
    const h = stashHost();
    h.editor.insertTextAtCursor(payload);
    h.editor.handleInput("\x13"); assert.equal(h.editor.getExpandedText(), "");
    h.editor.handleInput("\x13"); assert.equal(h.editor.getExpandedText(), payload);
    h.emit("session_shutdown");
  });
}

test("Ctrl+S inside a paste split between chunks is payload, not a stash command", () => {
  const h = stashHost(ViEditor);
  h.editor.handleInput("\x1b[200~prefix"); h.editor.handleInput("\x13");
  h.editor.handleInput("suffix\x1b[201~");
  assert.equal(h.editor.getExpandedText(), "prefixsuffix");
  assert.equal(h.status, undefined);
  h.editor.handleInput("\x13"); assert.equal(h.editor.getText(), "");
  h.emit("session_shutdown");
});

test("the last delimiter in a chunk decides whether Ctrl+S is paste content", () => {
  const h = stashHost(ViEditor);
  // Several delimiters in one chunk, ending inside a paste: Ctrl+S is payload.
  h.editor.handleInput("\x1b[200~one\x1b[201~two\x1b[200~three");
  h.editor.handleInput("\x13");
  assert.equal(h.status, undefined);
  h.editor.handleInput("\x1b[201~");
  // The same chunk ending on a close delimiter leaves Ctrl+S a stash command.
  h.editor.setText("draft");
  h.editor.handleInput("\x1b[200~four\x1b[200~five\x1b[201~");
  h.editor.handleInput("\x13");
  assert.match(h.status!, /stash/i);
  assert.equal(h.editor.getExpandedText(), "");
  h.emit("session_shutdown");
});

test("repeated discovery does not stack wrappers; shutdown disables detached handlers", () => {
  const h = stashHost();
  const e = h.editor;
  h.emit("resources_discover"); h.emit("resources_discover");
  assert.equal(h.installs, 1);
  e.setText("saved"); e.handleInput("\x13");
  h.emit("session_shutdown");
  h.editor.setText("untouched"); e.handleInput("\x13");
  assert.equal(h.editor.getText(), "untouched"); assert.equal(h.status, undefined);
});

test("non-TUI lifecycle never installs an editor", () => {
  const h = stashHost(); h.emit("session_shutdown");
  for (const mode of ["rpc", "print", "json"] as const) {
    Object.assign(h.ctx, { mode, hasUI: mode === "rpc" });
    const before = h.installs;
    h.emit("session_start"); h.emit("resources_discover"); h.emit("session_shutdown");
    assert.equal(h.installs, before);
  }
});

test("a paste delimiter split mid-sequence still keeps Ctrl+S out of the stash", () => {
  const h = stashHost(ViEditor);
  for (const chunk of ["\x1b[20", "0~prefix", "\x13", "suffix\x1b[20", "1~"])
    h.editor.handleInput(chunk);
  assert.equal(h.editor.getExpandedText(), "prefixsuffix");
  assert.equal(h.status, undefined);
  h.editor.handleInput("\x13"); assert.equal(h.editor.getText(), "");
  h.emit("session_shutdown");
});

test("install and uninstall retain an existing stock collapsed paste", () => {
  const h = stashHost(); h.emit("session_shutdown");
  const payload = "existing stock paste\n".repeat(100);
  h.editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
  h.emit("session_start"); h.emit("resources_discover");
  assert.equal(h.editor.getExpandedText(), payload);
  assert.match(h.editor.getText(), /^\[paste #/);
  h.emit("session_shutdown");
  assert.equal(h.editor.getExpandedText(), payload);
  assert.match(h.editor.getText(), /^\[paste #/);
  assert.equal(h.ctx.ui.getEditorComponent(), undefined);
});

test("shutdown does not replace an editor installed by another extension", () => {
  const h = stashHost();
  const other = (...args: ConstructorParameters<typeof CustomEditor>) => new CustomEditor(...args);
  h.ctx.ui.setEditorComponent(other);
  const e = h.editor; e.setText("other draft");
  h.emit("session_shutdown");
  assert.equal(h.ctx.ui.getEditorComponent(), other);
  assert.equal(h.editor, e); assert.equal(e.getText(), "other draft");
});
