// Lead-owned acceptance regression from Ar's original Vi-mode screenshot:
// "Treats collapsed paste payloads atomically so editing their visible markers
// does not corrupt the underlying pasted text." See the review contract's
// "Lead resolution of Codex R1 collapsed-paste uncertainty" section.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editor } from "../extensions/vi-mode/test-support.ts";

test("reference acceptance: large pasted payload stays collapsed and survives atomic marker edit/undo", () => {
  const e = editor();
  const payload = "Synthetic pasted line for collapsed-marker verification.\n".repeat(100);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  assert.equal(e.getExpandedText(), payload);
  assert.match(
    e.getText(),
    /\[paste #\d+/,
    "Ar's reference requires Pi's visible collapsed paste marker; expanded-only handling is insufficient",
  );
  assert.ok(e.getText().length < 100, "The editable draft should contain the marker, not all 100 lines");

  e.handleInput("\x1b");
  e.handleInput("0");
  e.handleInput("x");
  assert.equal(e.getExpandedText(), "", "Deleting the visible marker must remove the entire payload atomically");
  e.handleInput("u");
  assert.equal(e.getExpandedText(), payload, "Undo must restore the original payload, not merely its marker text");
  assert.match(e.getText(), /\[paste #\d+/);
});

test("collapsed payload survives the actual stash shortcut and editor replacement", async () => {
  const { stashHost } = await import("../extensions/prompt-stash/test-support.ts");
  const { ViEditor } = await import("../extensions/vi-mode/editor.ts");
  const h = stashHost(ViEditor);
  let e = h.e;
  const payload = "\tSynthetic\r\n😀\n".repeat(100);
  e.handleInput(`\x1b[200~${payload}\x1b[201~`);
  e.handleInput("\x13");
  assert.equal(e.getExpandedText(), "");
  // Reinstantiate the installed composing factory, as Pi does on replacement.
  h.ctx.ui.setEditorComponent(h.ctx.ui.getEditorComponent());
  e = h.e;
  e.handleInput("\x13");
  assert.equal(e.getExpandedText(), payload);
  assert.match(e.getText(), /^\[paste #/);
  e.handleInput("\x1b");
  e.handleInput("0");
  e.handleInput("x");
  assert.equal(e.getExpandedText(), "");
  e.handleInput("u");
  assert.equal(e.getExpandedText(), payload);
  h.emit("session_shutdown");
});
