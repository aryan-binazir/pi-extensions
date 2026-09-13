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
    h.e.handleInput(`\x1b[200~${payload}\x1b[201~`);
    h.e.handleInput("\x13");
    assert.equal(h.e.getExpandedText(), "");
    assert.match(h.status!, /stash/i);
    h.e.setText("second draft");
    h.e.handleInput("\x13");
    assert.equal(h.e.getExpandedText(), payload);
    assert.match(h.e.getText(), /^\[paste #\d+/);
    assert.ok(h.e.getText().length < 100);
    h.e.handleInput("\x13");
    assert.equal(h.e.getExpandedText(), "second draft");
    h.emit("session_shutdown");
    h.emit("session_start"); h.emit("resources_discover");
    h.e.setText(""); h.e.handleInput("\x13");
    assert.equal(h.e.getExpandedText(), "");
    assert.equal(h.status, undefined);
    h.emit("session_shutdown");
  });
}

test("legacy and Kitty editor input stashes raw vi whitespace; other keys delegate", () => {
  const h = stashHost(ViEditor);
  const payload = "\t😀\r\nraw\rpayload";
  h.e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  try {
    for (const kitty of [false, true]) {
      setKittyProtocolActive(kitty);
      h.e.handleInput("\x13"); assert.equal(h.e.getExpandedText(), "");
      h.e.handleInput("\x13"); assert.equal(h.e.getExpandedText(), payload);
    }
    setKittyProtocolActive(true);
    h.e.handleInput("\x1b[115;6u"); assert.equal(h.e.getExpandedText(), payload);
    h.e.handleInput("\x1b[115;5u"); assert.equal(h.e.getExpandedText(), "");
    h.e.handleInput("\x1b[115;5u"); assert.equal(h.e.getExpandedText(), payload);
    h.e.setText(""); h.e.handleInput("abc"); assert.equal(h.e.getText(), "abc");
    let submitted = ""; h.e.onSubmit = text => { submitted = text; };
    h.e.handleInput("\r"); assert.equal(submitted, "abc");
  } finally { setKittyProtocolActive(false); h.emit("session_shutdown"); }
});

for (const payload of ["draft\x1b[201~suffix", "draft\x1b[200~\x01\x07suffix"]) {
  test(`stash preserves literal stock control bytes in ${JSON.stringify(payload)}`, () => {
    const h = stashHost();
    h.e.insertTextAtCursor(payload);
    h.e.handleInput("\x13"); assert.equal(h.e.getExpandedText(), "");
    h.e.handleInput("\x13"); assert.equal(h.e.getExpandedText(), payload);
    h.emit("session_shutdown");
  });
}

test("split bracketed paste Ctrl+S is not a stash command", () => {
  const h = stashHost(ViEditor);
  h.e.handleInput("\x1b[200~prefix"); h.e.handleInput("\x13");
  h.e.handleInput("suffix\x1b[201~");
  assert.equal(h.e.getExpandedText(), "prefixsuffix");
  assert.equal(h.status, undefined);
  h.e.handleInput("\x13"); assert.equal(h.e.getText(), "");
  h.emit("session_shutdown");
});

test("repeated discovery does not stack wrappers; shutdown disables detached handlers", () => {
  const h = stashHost();
  const e = h.e;
  h.emit("resources_discover"); h.emit("resources_discover");
  assert.equal(h.installs, 1);
  e.setText("saved"); e.handleInput("\x13");
  h.emit("session_shutdown");
  h.e.setText("untouched"); e.handleInput("\x13");
  assert.equal(h.e.getText(), "untouched"); assert.equal(h.status, undefined);
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

test("split paste delimiters do not let Ctrl+S escape into stash", () => {
  const h = stashHost(ViEditor);
  for (const chunk of ["\x1b[20", "0~prefix", "\x13", "suffix\x1b[20", "1~"])
    h.e.handleInput(chunk);
  assert.equal(h.e.getExpandedText(), "prefixsuffix");
  assert.equal(h.status, undefined);
  h.e.handleInput("\x13"); assert.equal(h.e.getText(), "");
  h.emit("session_shutdown");
});

test("install and uninstall retain an existing stock collapsed paste", () => {
  const h = stashHost(); h.emit("session_shutdown");
  const payload = "existing stock paste\n".repeat(100);
  h.e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  h.emit("session_start"); h.emit("resources_discover");
  assert.equal(h.e.getExpandedText(), payload);
  assert.match(h.e.getText(), /^\[paste #/);
  h.emit("session_shutdown");
  assert.equal(h.e.getExpandedText(), payload);
  assert.match(h.e.getText(), /^\[paste #/);
  assert.equal(h.ctx.ui.getEditorComponent(), undefined);
});

test("shutdown does not replace an editor installed by another extension", () => {
  const h = stashHost();
  const other = (...args: ConstructorParameters<typeof CustomEditor>) => new CustomEditor(...args);
  h.ctx.ui.setEditorComponent(other);
  const e = h.e; e.setText("other draft");
  h.emit("session_shutdown");
  assert.equal(h.ctx.ui.getEditorComponent(), other);
  assert.equal(h.e, e); assert.equal(e.getText(), "other draft");
});
